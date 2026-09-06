#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, join, isAbsolute } from 'node:path';
import { parseFigFile, buildTree, collectFrames } from './parse.mjs';
import { toIR, extractTokens, symbolIndex, variableIndex, readVariables } from './ir.mjs';
import { renderHTML } from './html.mjs';

const ROOT = resolve(process.env.FIG_ROOT ?? process.cwd());

/** keep .fig reads inside FIG_ROOT — these paths come from the model, not the user */
function safePath(p) {
  const full = isAbsolute(p) ? resolve(p) : resolve(ROOT, p);
  const rel = relative(ROOT, full);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path escapes FIG_ROOT (${ROOT}): ${p}`);
  return full;
}

const cache = new Map();
function load(file) {
  const path = safePath(file);
  if (!cache.has(path)) {
    const doc = parseFigFile(path);
    const roots = buildTree(doc.message.nodeChanges);
    cache.set(path, {
      ...doc,
      path,
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
  if (!found) throw new Error(`frame not found: ${frame}\navailable: ${framesOf(doc).map((f) => f.name).join(', ')}`);
  return { doc, node: found, ir: toIR(found, doc.message.blobs, { symbols: doc.symbols, variables: doc.variables }) };
}

/**
 * The renderer wants every bezier; the model wants to know a logo is there.
 * Strip path data (it dwarfs everything else) and cut off past `depth`.
 */
const stub = (node) => ({
  id: node.id,
  name: node.name,
  role: node.role,
  box: node.box,
  ...(node.children?.length ? { children: `… ${node.children.length} children — get_frame(select: "${node.id}")` } : {}),
});

function forModel(node, depth, keepPaths) {
  const asset = node.asset?.kind === 'svg' && !keepPaths
    ? { kind: 'svg', viewBox: node.asset.viewBox, pathCount: node.asset.paths.length, note: 'run export_assets to get the .svg file' }
    : node.asset;
  const out = { ...node, ...(asset ? { asset } : {}) };
  // at the cut, keep every child as a stub with its id: a frame with a hundred shallow
  // children stays navigable instead of collapsing to a single unusable line
  if (depth <= 1) return { ...out, children: (node.children ?? []).map(stub) };
  return { ...out, children: (node.children ?? []).map((c) => forModel(c, depth - 1, keepPaths)) };
}

/** biggest tree that stays inside the context budget, shallowest cut that fits */
const BUDGET = 30_000;

function fit(ir) {
  const full = forModel(ir, Infinity, false);
  if (serialize(full).length <= BUDGET) return full;
  let depth = 1;
  for (let d = 2; d < 30; d++) {
    if (serialize(forModel(ir, d, false)).length > BUDGET) break;
    depth = d;
  }
  return forModel(ir, depth, false);
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

const file = z.string().describe('.fig file path, relative to FIG_ROOT');
const frame = z.string().describe('frame name or id from list_frames');

const server = new McpServer({ name: 'fig-parser', version: '0.1.0' });

server.registerTool(
  'list_frames',
  {
    title: 'List frames',
    description: 'Top-level frames in a .fig file: id, page, name, size. Start here — never load a whole file blindly.',
    inputSchema: { file },
  },
  wrap(({ file }) =>
    framesOf(load(file)).map((f) => ({ id: f.id, page: f.page, name: f.name, w: Math.round(f.size.x), h: Math.round(f.size.y) }))),
);

server.registerTool(
  'get_frame',
  {
    title: 'Get frame IR',
    description:
      'Normalized IR for one frame: role, box, inferred layout, style, text, and assets. ' +
      'Icon clusters are collapsed into single SVG nodes, so this is 100-200x smaller than the raw node tree. ' +
      'Children are in paint order, not reading order: `layout.rows` groups them into visual rows, ' +
      'top to bottom and left to right, as space-separated indices into that node\'s own children. ' +
      'Large frames come back truncated; the placeholder text names the id to pass back as `select` to go deeper.',
    inputSchema: {
      file,
      frame,
      select: z.string().optional().describe('id or name of a node to return instead of the whole frame'),
      depth: z.number().int().min(1).optional().describe('max nesting depth, 1 = this node only (default: as deep as fits)'),
      includePaths: z.boolean().optional().describe('inline raw SVG path data (large; usually you want export_assets instead)'),
    },
  },
  wrap(({ file, frame, select, depth, includePaths = false }) => {
    const root = frameIR(file, frame).ir;
    const node = select ? selectNode(root, select) : root;
    // without an explicit depth, cut deep enough to stay usable in context —
    // except when paths were explicitly asked for, where truncating defeats the point
    if (depth) return forModel(node, depth, includePaths);
    return includePaths ? forModel(node, Infinity, true) : fit(node);
  }),
);

server.registerTool(
  'get_html',
  {
    title: 'Get reference HTML',
    description:
      'Render the frame to standalone HTML + CSS straight from the IR. This is the geometric baseline: ' +
      'pixel-accurate but structurally naive. Use it to check your own markup against, not to ship.',
    inputSchema: { file, frame, assetDir: z.string().optional().describe('href prefix for images (default: assets)') },
  },
  wrap(({ file, frame, assetDir = 'assets' }) => {
    const { ir } = frameIR(file, frame);
    return renderHTML(ir, { assetUrl: (h) => `${assetDir}/${h}.png` });
  }),
);

server.registerTool(
  'export_assets',
  {
    title: 'Export frame images',
    description: 'Write the frame\'s raster images (<hash>.png) and collapsed icon clusters (<name>.svg) to outDir, and return the paths.',
    inputSchema: { file, frame, outDir: z.string().describe('output directory, relative to FIG_ROOT') },
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

server.registerTool(
  'get_variables',
  {
    title: 'Get design variables',
    description:
      "The design system's own variable definitions — every set, its modes, and each variable's value per mode, " +
      'as CSS custom properties with a block per extra mode (light/dark, responsive breakpoints). ' +
      'Semantic variables that point at primitives come back as var() references rather than flattened values. ' +
      'This is what the author declared; get_tokens reports what one frame actually uses.',
    inputSchema: { file, set: z.string().optional().describe('only variables from this set (substring, case-insensitive)') },
  },
  wrap(({ file, set }) => {
    const all = readVariables(load(file).message.nodeChanges);
    if (!all.variables.length) return 'this file defines no variables';
    if (!set) return all;
    const match = set.toLowerCase();
    return {
      sets: all.sets.filter((s) => s.name.toLowerCase().includes(match)),
      variables: all.variables.filter((v) => v.set?.toLowerCase().includes(match)),
    };
  }),
);

server.registerTool(
  'get_tokens',
  {
    title: 'Get design tokens',
    description: 'Colors and text styles used in a frame (or the whole file), deduped and ranked by usage, as CSS custom properties.',
    inputSchema: { file, frame: frame.optional() },
  },
  wrap(({ file, frame }) => {
    if (frame) return extractTokens(frameIR(file, frame).ir);
    const doc = load(file);
    const merged = { role: 'frame', children: framesOf(doc).map((f) => toIR(f, doc.message.blobs, { symbols: doc.symbols, variables: doc.variables })) };
    return extractTokens(merged);
  }),
);

await server.connect(new StdioServerTransport());
