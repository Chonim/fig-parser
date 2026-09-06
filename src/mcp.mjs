#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { mkdirSync, writeFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, join, isAbsolute, dirname } from 'node:path';
import { parseFigFile, buildTree, collectFrames } from './parse.mjs';
import { toIR, extractTokens, symbolIndex, variableIndex, readVariables } from './ir.mjs';
import { renderHTML } from './html.mjs';

const ROOT = resolve(process.env.FIG_ROOT ?? process.cwd());

const REAL_ROOT = (() => { try { return realpathSync(ROOT); } catch { return ROOT; } })();

/**
 * Keep reads and writes inside FIG_ROOT — these paths come from the model, not the
 * user. Comparing the resolved string is not enough: a symlink inside the root
 * points wherever it likes and `..` never appears, so the real path is taken, and
 * for a path being created, the real path of the nearest ancestor that exists.
 */
function safePath(p) {
  const full = isAbsolute(p) ? resolve(p) : resolve(ROOT, p);
  let probe = full;
  let tail = '';
  for (;;) {
    try {
      statSync(probe);
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) throw new Error(`path escapes FIG_ROOT (${ROOT}): ${p}`);
      tail = tail ? join(relative(parent, probe), tail) : relative(parent, probe);
      probe = parent;
    }
  }
  const real = join(realpathSync(probe), tail);
  const rel = relative(REAL_ROOT, real);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path escapes FIG_ROOT (${ROOT}): ${p}`);
  return real;
}

const cache = new Map();
function load(file) {
  const path = safePath(file);
  // a path is not an identity: the file behind it can be replaced while the server runs
  const { mtimeMs, size } = statSync(path);
  const stamp = `${mtimeMs}:${size}`;
  if (cache.get(path)?.stamp !== stamp) {
    const doc = parseFigFile(path);
    const roots = buildTree(doc.message.nodeChanges);
    cache.set(path, {
      ...doc,
      path,
      stamp,
      frames: collectFrames(roots),
      symbols: symbolIndex(roots),
      variables: variableIndex(doc.message.nodeChanges),
    });
  }
  return cache.get(path);
}

const framesOf = (doc) => doc.frames;

function frameIR(file, frame) {
  const doc = load(file);
  const found = framesOf(doc).find((f) => f.name === frame || f.id === frame);
  if (!found) {
    // 19 frames in the design system have no name at all, so listing names alone
    // answers a failed lookup with a row of blanks
    const available = framesOf(doc).map((f) => `${f.id}${f.name ? ` (${f.name})` : ''}`).join(', ');
    throw new Error(`frame not found: ${frame}\navailable: ${available}`);
  }
  return { doc, node: found, ir: toIR(found, doc.message.blobs, { symbols: doc.symbols, variables: doc.variables }) };
}

/**
 * The renderer wants every bezier; the model wants to know a logo is there.
 * Strip path data (it dwarfs everything else) and cut off past `depth`.
 */
/**
 * What survives the cut. Geometry alone is not enough to write markup from: a text
 * node without its string looks like a finished leaf, and nothing said it had been
 * trimmed. Content and identity stay; typography and paint are what get dropped.
 */
const stub = (node) => ({
  id: node.id,
  name: node.name,
  role: node.role,
  box: node.box,
  ...(node.text ? { text: { content: node.text.content, truncated: `style dropped — get_frame(select: "${node.id}")` } } : {}),
  ...(node.label ? { label: node.label } : {}),
  ...(node.component ? { component: node.component } : {}),
  ...(node.asset ? { asset: { kind: node.asset.kind } } : {}),
  ...(node.children?.length ? { children: `… ${node.children.length} children — get_frame(select: "${node.id}")` } : {}),
});

/** identity, geometry and content — everything a stub keeps, but with real children */
const leanNode = (node) => ({
  id: node.id,
  name: node.name,
  role: node.role,
  box: node.box,
  ...(node.bounds ? { bounds: node.bounds } : {}),
  ...(node.text ? { text: { content: node.text.content, truncated: `style dropped — get_frame(select: "${node.id}")` } } : {}),
  ...(node.label ? { label: node.label } : {}),
  ...(node.component ? { component: node.component } : {}),
  ...(node.asset ? { asset: { kind: node.asset.kind, ...(node.asset.hash ? { hash: node.asset.hash } : {}) } } : {}),
  ...(node.layout ? { layout: node.layout } : {}),
});

function forModel(node, depth, keepPaths, lean) {
  const asset = node.asset?.kind === 'svg' && !keepPaths
    ? { kind: 'svg', viewBox: node.asset.viewBox, pathCount: node.asset.paths.length, note: 'run export_assets to get the .svg file' }
    : node.asset;
  const out = { ...node, ...(asset ? { asset } : {}) };
  // at the cut, keep every child as a stub with its id: a frame with a hundred shallow
  // children stays navigable instead of collapsing to a single unusable line
  if (depth <= 1) return { ...out, children: (node.children ?? []).map(stub) };
  return { ...out, children: (node.children ?? []).map((c) => forModel(c, depth - 1, keepPaths, lean)) };
}

/** biggest tree that stays inside the context budget, shallowest cut that fits */
const BUDGET = 30_000;

/**
 * Give back as much of the tree as the budget allows, dropping the cheapest thing
 * first: typography and paint go before any node disappears, because a node that is
 * not listed cannot be asked about, while one listed without its font still carries
 * its string.
 *
 * Below that, the budget is divided among subtrees rather than the depth being
 * capped for the whole frame. One deep branch used to set the cut for everything —
 * an archive frame came back at 3.5KB of its 30KB allowance because a single child
 * would not fit at depth two.
 */
function allot(root, budget, lean) {
  // Breadth-first: take nodes in level order until the budget runs out, so every
  // branch is described to a similar depth. Capping depth for the whole frame let
  // one deep child decide the cut for all of them, and an archive frame came back
  // using 3.5KB of its 30KB.
  // Keeping a node means its siblings get emitted as stubs too, so that cost is
  // charged when the parent is taken. Counting only the kept nodes made the estimate
  // jump whenever a wide parent came in, and the search settled far below budget.
  // The response is indented, and every line of a node costs two spaces per level of
  // depth on top of its own text. Costing nodes without that ran the estimate a third
  // light on a deep frame, so the allowance had to be searched for and the search kept
  // landing short. Charging the indentation makes the estimate track the real size.
  const sizeAt = (obj, depth) => {
    const text = serialize(obj);
    return text.length + 2 * depth * (text.split('\n').length);
  };
  const stubCost = (n, depth) => sizeAt(stub(n), depth);
  const keep = new Set([root]);
  let spent = sizeAt(lean ? leanNode(root) : root, 0)
    + (root.children ?? []).reduce((a, c) => a + stubCost(c, 1), 0);
  const queue = (root.children ?? []).map((c) => [c, 1]);
  while (queue.length) {
    const [node, depth] = queue.shift();
    const kids = node.children ?? [];
    // upgrading a stub to a listed node, plus stubs for everything beneath it
    const cost = sizeAt(lean ? leanNode(node) : stub(node), depth) - stubCost(node, depth)
      + kids.reduce((a, c) => a + stubCost(c, depth + 1), 0);
    if (spent + cost > budget) continue; // skip this one, a cheaper sibling may still fit
    keep.add(node);
    spent += cost;
    queue.push(...kids.map((c) => [c, depth + 1]));
  }

  return { tree: buildFrom(root, keep, lean), keep };
}

/** the response for a given set of kept nodes; everything else becomes a stub */
function buildFrom(root, keep, lean) {
  const build = (node) => {
    const self = lean ? leanNode(node) : forModel(node, 1, false, false);
    const kids = node.children ?? [];
    if (!kids.length) return self;
    if (!kids.some((c) => keep.has(c))) {
      return { ...self, children: `… ${kids.length} children — get_frame(select: "${node.id}")` };
    }
    return { ...self, children: kids.map((c) => (keep.has(c) ? build(c) : stub(c))) };
  };
  return build(root);
}

/**
 * Whatever budget the estimate left on the table, spent one node at a time against the
 * real size. On a wide frame the next node the estimate would admit can cost 23KB, so
 * there is nothing between 7377 B and over budget — but individual nodes deeper in
 * still fit, and this finds them.
 */
function topUp(root, keep, lean, probes = 60) {
  let out = buildFrom(root, keep, lean);
  let size = serialize(out).length;
  const queue = [];
  (function collect(n) {
    for (const c of n.children ?? []) {
      if (keep.has(c)) collect(c);
      else queue.push(c);
    }
  })(root);
  // cheapest first, so the leftover buys as many nodes as it can
  queue.sort((a, b) => serialize(stub(a)).length - serialize(stub(b)).length);
  for (const node of queue.slice(0, probes)) {
    keep.add(node);
    const candidate = buildFrom(root, keep, lean);
    const grown = serialize(candidate).length;
    if (grown > BUDGET) { keep.delete(node); continue; }
    out = candidate;
    size = grown;
  }
  return out;
}

function fit(ir) {
  for (const lean of [false, true]) {
    const whole = forModel(ir, Infinity, false, lean);
    if (serialize(whole).length <= BUDGET) return whole;
  }
  // allot costs each node on its own while the response pays for indentation that
  // grows with depth, so its estimate runs light and the allowance it is given has to
  // be searched. That search used to bisect, which assumes a bigger allowance yields a
  // bigger response — and it does not. Skipping a node keeps its whole subtree out of
  // the queue, so a little more room can admit one wide child that crowds out many
  // cheap ones: a component catalogue came back at 11725 B on a 30000 allowance and
  // 13498 B on 12000. Bisection followed that curve downhill and settled far short.
  //
  // So walk the allowances and keep the response that describes the most of the frame,
  // rather than the largest allowance that fits. Bytes are the wrong thing to maximise:
  // one arrangement can be fatter and still name fewer nodes.
  // Scored on what the frame actually says — its strings first, since a stub carries
  // none and counting nodes alone rewards an arrangement of many stubs over one that
  // names fewer nodes properly — then on how many nodes are described at all.
  const score = (node) => {
    const kids = Array.isArray(node.children) ? node.children : [];
    return kids.reduce((a, c) => {
      const s = score(c);
      return [a[0] + s[0], a[1] + s[1]];
    }, [node.text?.content ? 1 : 0, 1]);
  };
  // Size breaks a tie because the topping-up below grows whatever it is handed, and a
  // fuller seed has more room to grow into: two candidates here both named 21 strings
  // across 23 nodes, and the smaller one topped up to 7377 B while the larger reached
  // 29724 of the same 30000 budget.
  const better = (a, b) => a[0] > b[0]
    || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])));
  // The allowance is not the response size — allot charges stubs for children it may
  // never list — so the search runs past the budget rather than stopping at it.
  const CEILING = BUDGET * 2;
  const STEPS = 48;
  const first = allot(ir, 0, true);
  let best = first.tree;
  let bestKeep = first.keep;
  let bestScore = [...score(best), serialize(best).length];
  let bestAt = 0;
  const probe = (allowance) => {
    const { tree, keep } = allot(ir, Math.round(allowance), true);
    if (serialize(tree).length > BUDGET) return;
    const s = [...score(tree), serialize(tree).length];
    if (better(s, bestScore)) { best = tree; bestScore = s; bestAt = allowance; bestKeep = keep; }
  };
  for (let i = 1; i <= STEPS; i++) probe((CEILING * i) / STEPS);
  // and the points a bisection would have visited, so this can never come out worse
  // than the search it replaces
  for (let lo = 0, hi = CEILING, i = 0; i < 12 && lo < hi; i++) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (serialize(allot(ir, mid, true).tree).length <= BUDGET) { probe(mid); lo = mid; } else hi = mid - 1;
  }
  // the coarse pass lands in the right neighbourhood; the response only changes where
  // one more node is admitted, so close in on that step rather than sampling the
  // whole range finely
  for (let span = CEILING / STEPS; span >= 4; span /= 2) {
    probe(bestAt + span / 2);
    probe(bestAt - span / 2);
  }
  return topUp(ir, bestKeep, true);
}

/** the node named by an id or a name, searched depth-first from the frame root */
function selectNode(ir, select) {
  const stack = [ir];
  while (stack.length) {
    const n = stack.shift();
    if (n.id === select || n.name === select) return n;
    stack.unshift(...(n.children ?? []));
  }
  throw new Error(`no node matching "${select}" in this frame`);
}

const svgOf = (node) =>
  // width/height as well as viewBox: an <img> with only a viewBox has no intrinsic
  // size and browsers fall back to 300x150
  `<svg width="${node.box.w}" height="${node.box.h}" viewBox="${node.asset.viewBox}" xmlns="http://www.w3.org/2000/svg">` +
  (node.asset.defs ? `<defs>${node.asset.defs.join('')}</defs>` : '') +
  node.asset.paths
    .map((p) => `<path d="${p.d}" fill="${p.fill}"${p.transform ? ` transform="${p.transform}"` : ''}${p.rule ? ` fill-rule="${p.rule}"` : ''}/>`)
    .join('') +
  '</svg>';

/** the exact bytes a tool result carries — fit() has to measure this, not compact JSON */
const serialize = (s) => (typeof s === 'string' ? s : JSON.stringify(s, null, 2));
const text = (s) => ({ content: [{ type: 'text', text: serialize(s) }] });
const wrap = (fn) => async (args) => {
  try {
    return text(await fn(args));
  } catch (e) {
    return { ...text(`error: ${e.message}`), isError: true };
  }
};

/**
 * A parameter's description is the only manual a model gets, and nothing used to read
 * it: get_frame's said `depth: 1 = this node only` while it returned the node with its
 * children as stubs. So a claim is data — a case, what it does, and a call that shows
 * it — the sentence is generated from the cases, and mcp.test.mjs runs them. Editing
 * the sentence means editing a case, and a case that lies fails.
 */
const claim = (schema, lead, cases = [], tail) => {
  const spelled = cases.map((c) => `${c.when} = ${c.then}`).join('; ');
  const out = schema.describe([lead, spelled, tail].filter(Boolean).join(spelled ? '; ' : ''));
  out.claims = cases;
  return out;
};

// named once, so the sentence a model reads and the value the code uses cannot differ
const FIND_DEFAULTS = { field: 'both', limit: 40 };
const HTML_DEFAULTS = { assetDir: 'assets' };
const LOGIN = '2063:280';
const SAMPLE = 'samples/kyowon-full.fig';
const isStub = (c) => typeof c === 'object' && c !== null && !('style' in c) && !('layout' in c);

// shared, and deliberately claim-free: a claim is a call, and the same call cannot be
// meaningful for seven different tools. Each tool states its own below.
const file = z.string().describe('.fig file path, relative to FIG_ROOT');
const frame = z.string().describe('frame name or id from list_frames');

const server = new McpServer({ name: 'fig-parser', version: '0.1.0' });

/**
 * Every tool, defined once. The list used to exist three times — here, as an array
 * typed out by hand in the test, and as a count in the README — so adding one meant
 * remembering all three. Tests read this; the server registers from it.
 */
export const TOOLS = [];
const tool = (name, meta, run) => {
  TOOLS.push({ name, ...meta, run });
  server.registerTool(name, meta, run);
};

tool(
  'list_frames',
  {
    title: 'List frames',
    description: 'Top-level frames in a .fig file: id, page, name, size. Start here — never load a whole file blindly.',
    inputSchema: { file },
  },
  wrap(({ file }) =>
    framesOf(load(file)).map((f) => ({
      id: f.id,
      page: f.page,
      name: f.name,
      w: Math.round(f.size.x),
      h: Math.round(f.size.y),
      ...(f.visible === false ? { hidden: true } : {}),
    }))),
);

tool(
  'get_frame',
  {
    title: 'Get frame IR',
    description:
      'Normalized IR for one frame: role, box, inferred layout, style, text, and assets. ' +
      'Icon clusters are collapsed into single SVG nodes, so this is 100-200x smaller than the raw node tree. ' +
      'A painted box holding exactly one piece of text carries that text as `label` — a button, a tab, a chip; ' +
      '`interactions` reports what the designer wired to it, so an ON_CLICK beside a label is a button on evidence rather than on a guess. ' +
      'Children are in paint order, not reading order: `layout.rows` groups them into visual rows, ' +
      'top to bottom and left to right, as space-separated indices into that node\'s own children. ' +
      'Large frames come back truncated; the placeholder text names the id to pass back as `select` to go deeper.',
    inputSchema: {
      file: claim(z.string(), '.fig file path, relative to FIG_ROOT', [
        { when: 'a path that climbs out of FIG_ROOT', then: 'refused',
          run: { file: '../../../etc/passwd', frame: LOGIN }, check: (v) => Boolean(v.error) },
      ]),
      frame: claim(z.string(), 'frame name or id from list_frames', [
        { when: 'an id', then: 'that frame', run: { file: SAMPLE, frame: LOGIN }, check: (v) => v.id === LOGIN },
        { when: 'a name', then: 'the same frame', run: { file: SAMPLE, frame: '온라인학습_Login' }, check: (v) => v.id === LOGIN },
      ]),
      select: claim(z.string(), 'id or name of a node to return instead of the whole frame', [
        { when: 'the id of a node inside the frame', then: 'that node, as the root of the answer',
          run: { file: SAMPLE, frame: LOGIN, select: '2063:289' }, check: (v) => v.id === '2063:289' },
      ]).optional(),
      depth: claim(z.number().int().min(1), 'levels of nesting to describe', [
        { when: '1', then: 'this node with its children listed as stubs',
          run: { file: SAMPLE, frame: LOGIN, depth: 1 },
          check: (v) => Array.isArray(v.children) && v.children.length > 0 && v.children.every(isStub) },
      ], 'omit for as deep as the budget allows').optional(),
      includePaths: claim(z.boolean(), 'inline raw SVG path data (large; usually you want export_assets instead)', [
        { when: 'true', then: 'every bezier in the response, so it far outgrows the summary',
          run: { file: SAMPLE, frame: LOGIN, includePaths: true },
          check: (v, body) => body.includes('"d":') && body.length > 40_000 },
      ]).optional(),
    },
  },
  wrap(({ file, frame, select, depth, includePaths = false }) => {
    const root = frameIR(file, frame).ir;
    const node = select ? selectNode(root, select) : root;
    // without an explicit depth, cut deep enough to stay usable in context —
    // except when paths were explicitly asked for, where truncating defeats the point
    if (depth) return forModel(node, depth, includePaths, false);
    return includePaths ? forModel(node, Infinity, true, false) : fit(node);
  }),
);

tool(
  'find_nodes',
  {
    title: 'Find nodes',
    defaults: FIND_DEFAULTS,
    description:
      'Nodes whose text or name contains a string, across one frame or the whole file. '
      + 'Returns the id to pass to get_frame(select:), the ancestors that lead to it, and its box — '
      + 'so "where is the thing that says X" costs one call instead of paging through a frame.',
    inputSchema: {
      file,
      query: claim(z.string(), 'substring to look for, case-insensitive', [
        { when: 'a string the design contains', then: 'the nodes carrying it, with the id to select and the ancestors that lead there',
          run: { file: SAMPLE, query: '로그인' },
          check: (v) => v.matches.length > 0 && v.matches.every((m) => m.id && Array.isArray(m.path)) },
        { when: 'different casing', then: 'the same matches',
          run: { file: SAMPLE, query: 'RECTANGLE', field: 'name' }, check: (v) => v.matches.length > 0 },
      ]),
      frame: claim(z.string(), 'one frame', [
        { when: 'given', then: 'only that frame is searched',
          run: { file: SAMPLE, query: 'Rectangle', field: 'name', frame: LOGIN },
          check: (v) => v.matches.every((m) => m.frame === LOGIN) },
      ], 'omit to search the whole file').optional(),
      field: claim(z.enum(['text', 'name', 'both']), 'what to match against', [
        { when: "'name'", then: 'layer names only, never the text in the design',
          run: { file: SAMPLE, query: '로그인', field: 'name' },
          check: (v) => v.matches.every((m) => m.name.includes('로그인')) },
      ], `default ${FIND_DEFAULTS.field}`).optional(),
      limit: claim(z.number().int().positive(), 'most matches to return', [
        { when: 'a number', then: 'at most that many, with the rest counted as truncated',
          run: { file: SAMPLE, query: 'e', limit: 3 },
          check: (v) => v.matches.length <= 3 && v.truncated > 0 },
        { when: 'omitted', then: `${FIND_DEFAULTS.limit}`,
          run: { file: SAMPLE, query: 'e' },
          check: (v) => v.matches.length === FIND_DEFAULTS.limit && v.truncated > 0 },
      ], `default ${FIND_DEFAULTS.limit}`).optional(),
    },
  },
  wrap(({ file, query, frame: only, field = FIND_DEFAULTS.field, limit = FIND_DEFAULTS.limit }) => {
    const doc = load(file);
    const needle = query.toLowerCase();
    const frames = only
      ? [framesOf(doc).find((f) => f.name === only || f.id === only)].filter(Boolean)
      : framesOf(doc);
    if (only && !frames.length) throw new Error(`frame not found: ${only}`);
    const matches = [];
    let found = 0;
    for (const f of frames) {
      const ir = toIR(f, doc.message.blobs, { symbols: doc.symbols, variables: doc.variables });
      (function walk(node, path) {
        const content = node.text?.content;
        const hit = (field !== 'name' && content?.toLowerCase().includes(needle))
          || (field !== 'text' && node.name?.toLowerCase().includes(needle));
        if (hit) {
          found += 1;
          if (matches.length < limit) {
            matches.push({
              id: node.id,
              name: node.name,
              role: node.role,
              frame: f.id,
              // the ancestors, so a match can be read in context without another call
              path,
              box: { x: node.box.x, y: node.box.y, w: node.box.w, h: node.box.h },
              ...(content ? { text: content.length > 120 ? `${content.slice(0, 120)}…` : content } : {}),
            });
          }
        }
        for (const child of node.children ?? []) walk(child, [...path, node.name || node.id]);
      })(ir, []);
    }
    return { query, matches, ...(found > matches.length ? { truncated: found - matches.length } : {}) };
  }),
);

tool(
  'get_html',
  {
    title: 'Get reference HTML',
    defaults: HTML_DEFAULTS,
    description:
      'Render the frame to standalone HTML + CSS straight from the IR. This is the geometric baseline: ' +
      'pixel-accurate but structurally naive. Use it to check your own markup against, not to ship.',
    inputSchema: {
      file,
      frame,
      assetDir: claim(z.string(), 'href prefix for images', [
        { when: 'a prefix', then: 'every image src starts with it',
          run: { file: SAMPLE, frame: LOGIN, assetDir: 'img' },
          check: (v, body) => body.includes('src="img/') && !body.includes('src="assets/') },
        { when: 'omitted', then: HTML_DEFAULTS.assetDir,
          run: { file: SAMPLE, frame: LOGIN },
          check: (v, body) => body.includes(`src="${HTML_DEFAULTS.assetDir}/`) },
      ], `default ${HTML_DEFAULTS.assetDir}`).optional(),
    },
  },
  wrap(({ file, frame, assetDir = HTML_DEFAULTS.assetDir }) => {
    const { ir } = frameIR(file, frame);
    return renderHTML(ir, { assetUrl: (h) => `${assetDir}/${h}.png` });
  }),
);

tool(
  'export_assets',
  {
    title: 'Export frame images',
    description: 'Write the frame\'s raster images (<hash>.png) and collapsed icon clusters (<name>.svg) to outDir, and return the paths.',
    inputSchema: {
      file,
      frame,
      outDir: claim(z.string(), 'output directory, relative to FIG_ROOT', [
        { when: 'a directory', then: 'a file per asset, keyed by hash, each saying which nodes wanted it',
          run: { file: SAMPLE, frame: LOGIN, outDir: 'out/claim-check' },
          check: (v) => Object.values(v).every((a) => a.file?.startsWith('out/claim-check/') && Array.isArray(a.usedBy)) },
      ]),
    },
  },
  wrap(({ file, frame, outDir }) => {
    const { doc, ir } = frameIR(file, frame);
    const dir = safePath(outDir);
    mkdirSync(dir, { recursive: true });
    const written = new Map();
    const slug = (name, n) => `${(name || 'icon').replace(/[^\w가-힣-]+/g, '-').replace(/^-+|-+$/g, '') || 'icon'}-${n}`;
    // a bare hash says nothing about where the file belongs, so every entry names
    // the nodes that use it — the same image can appear in several places
    const note = (key, file, node) => {
      const hit = written.get(key) ?? { file, usedBy: [] };
      hit.usedBy.push({ id: node.id, name: node.name });
      written.set(key, hit);
    };
    (function walk(node) {
      if (node.asset?.kind === 'image') {
        const out = join(dir, `${node.asset.hash}.png`);
        if (!written.has(node.asset.hash)) {
          try {
            writeFileSync(out, doc.readImage(node.asset.hash));
          } catch (e) {
            written.set(node.asset.hash, { file: `FAILED: ${e.message}`, usedBy: [] });
          }
        }
        if (!written.get(node.asset.hash)?.file.startsWith('FAILED')) note(node.asset.hash, relative(ROOT, out), node);
      }
      if (node.asset?.kind === 'svg') {
        const key = slug(node.name, written.size);
        const out = join(dir, `${key}.svg`);
        writeFileSync(out, svgOf(node));
        note(key, relative(ROOT, out), node);
      }
      node.children?.forEach(walk);
    })(ir);
    return Object.fromEntries(written);
  }),
);

tool(
  'get_variables',
  {
    title: 'Get design variables',
    description:
      "The design system's own variable definitions — every set, its modes, and each variable's value per mode, " +
      'as CSS custom properties with a block per extra mode (light/dark, responsive breakpoints). ' +
      'Semantic variables that point at primitives come back as var() references rather than flattened values. ' +
      'This is what the author declared; get_tokens reports what one frame actually uses.',
    inputSchema: {
      file,
      set: claim(z.string(), 'only variables from this set (substring, case-insensitive)', [
        { when: 'a set name', then: 'nothing from any other set',
          run: { file: 'samples/matsq.fig', set: 'color' },
          check: (v) => v.variables.length > 0 && v.variables.every((x) => /color/i.test(x.set)) },
      ]).optional(),
      frame: claim(z.string(), 'only variables this frame actually binds', [
        { when: 'a frame', then: 'fewer than the whole file declares',
          run: { file: 'samples/matsq.fig', frame: '43:783' },
          check: (v) => v.variables.length > 0 && v.variables.length < 581 },
      ]).optional(),
    },
  },
  wrap(({ file, set, frame }) => {
    const doc = load(file);
    const all = readVariables(doc.message.nodeChanges);
    if (!all.variables.length) return 'this file defines no variables';

    let { sets, variables, css } = all;
    // narrowing has to narrow the stylesheet too, or the filtered answer still
    // carries every declaration in the file and blows the budget on its own
    const narrow = (kept) => {
      const tokens = new Set(kept.map((v) => v.token));
      const blocks = css.split('\n\n').map((block) => {
        const [head, ...lines] = block.split('\n');
        const body = lines.filter((l) => tokens.has(l.trim().split(':')[0]));
        return body.length ? [head, ...body, '}'].join('\n') : undefined;
      });
      css = blocks.filter(Boolean).join('\n\n');
    };
    if (set) {
      const match = set.toLowerCase();
      sets = sets.filter((s) => s.name.toLowerCase().includes(match));
      variables = variables.filter((v) => v.set?.toLowerCase().includes(match));
      narrow(variables);
    }
    if (frame) {
      // only what this frame binds, which is usually a handful out of hundreds
      const ir = frameIR(file, frame).ir;
      const used = new Set();
      (function walk(n) {
        for (const t of [n.style?.fillToken, n.style?.borderToken, n.text?.colorToken]) if (t) used.add(t);
        for (const p of n.asset?.paths ?? []) if (p.fillToken) used.add(p.fillToken);
        n.children?.forEach(walk);
      })(ir);
      variables = variables.filter((v) => used.has(v.name));
      css = undefined;
    }

    // the whole catalogue runs to 159KB on this file; the same budget applies here
    const out = { sets, variables, ...(css ? { css } : {}) };
    if (serialize(out).length <= BUDGET) return out;

    const listing = variables.map((v) => ({ name: v.name, token: v.token, type: v.type, set: v.set }));
    const lean = { sets, variables: listing };
    if (serialize(lean).length <= BUDGET) {
      return { ...lean, truncated: `values omitted — narrow with \`set\` or \`frame\` to get them` };
    }
    // still too many to even name: keep the sets, which is what a caller narrows by
    return {
      sets,
      variables: listing.slice(0, 100),
      truncated: `${listing.length} variables in ${sets.length} sets — showing 100; narrow with \`set\` or \`frame\``,
    };
  }),
);

tool(
  'get_tokens',
  {
    title: 'Get design tokens',
    description: 'Colors and text styles used in a frame (or the whole file), deduped and ranked by usage, as CSS custom properties.',
    inputSchema: {
      file,
      frame: claim(z.string(), 'one frame', [
        { when: 'given', then: 'only what that frame uses',
          run: { file: SAMPLE, frame: LOGIN },
          check: (v) => v.colors.length > 0 && v.colors.length < 40 },
      ], 'omit for the whole file').optional(),
    },
  },
  wrap(({ file, frame }) => {
    if (frame) return extractTokens(frameIR(file, frame).ir);
    const doc = load(file);
    const merged = { role: 'frame', children: framesOf(doc).map((f) => toIR(f, doc.message.blobs, { symbols: doc.symbols, variables: doc.variables })) };
    return extractTokens(merged);
  }),
);

// importing this file gives a tool a way to measure the budget without a server
if (import.meta.url === `file://${process.argv[1]}`) await server.connect(new StdioServerTransport());

export { allot, buildFrom, topUp, fit, forModel, BUDGET };
