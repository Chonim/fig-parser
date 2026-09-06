import assert from 'node:assert/strict';
import { PRODUCT, LIBRARY as MATSQ, requireSamples } from './samples.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { measureReach } from './reach.mjs';
import { TOOLS } from './mcp.mjs';

const SAMPLE = PRODUCT;
const FRAME = '온라인학습_Login';
// the other sample is the only one with components and variables, and mcp.mjs
// builds both indexes itself — nothing else here would notice if it built them
// from the wrong thing, or dropped one entirely
const LIBRARY = MATSQ;
requireSamples(SAMPLE, MATSQ);

const proc = spawn('node', ['src/mcp.mjs'], { stdio: ['pipe', 'pipe', 'inherit'] });
const seen = [];
let buf = '';
proc.stdout.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0; ) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) seen.push(JSON.parse(line));
  }
});

const send = (o) => proc.stdin.write(JSON.stringify(o) + '\n');
let nextId = 0;
async function rpc(method, params) {
  const id = ++nextId;
  send({ jsonrpc: '2.0', id, method, params });
  for (let i = 0; i < 400; i++) {
    const hit = seen.find((m) => m.id === id);
    if (hit) return hit.result;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for ${method}`);
}
const call = (name, args) => rpc('tools/call', { name, arguments: args });
const json = (res) => JSON.parse(res.content[0].text);

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });

// The list lived here as an array typed out by hand, so adding a tool meant editing
// three places and the count in the README was a fourth. The definitions are the one
// source; this reads them.
const tools = (await rpc('tools/list')).tools.map((t) => t.name);
assert.deepEqual(tools.sort(), TOOLS.map((t) => t.name).sort(), 'the server exposes something other than the defined tools');
// how many there are is the README's business, checked by src/docs.test.mjs against
// this same array — writing the number here too is the duplication this item removed

// this sample barely uses variables; the catalogue still has to come back well-formed
const vars = json(await call('get_variables', { file: SAMPLE }));
assert.ok(vars.variables.length >= 1, 'no variables read');
assert.ok(vars.variables.every((v) => v.token.startsWith('--') && v.type), 'variable entry is missing token or type');
assert.match(vars.css, /^:root \{/, 'variable CSS has no root block');

const frames = json(await call('list_frames', { file: SAMPLE }));
assert.ok(frames.some((f) => f.name === FRAME), 'login frame missing from list_frames');
assert.ok(frames.every((f) => f.id && f.w && f.h));

const full = await call('get_frame', { file: SAMPLE, frame: FRAME });
// Path data dwarfs everything else, which is why it is the first thing dropped. Asked
// for on a subtree small enough to hold it, the difference is the whole point of
// dropping it; asked for on the frame, the budget still wins — see below.
const ICON = '2063:301';   // three paths, small enough that they fit
const logo = await call('get_frame', { file: SAMPLE, frame: FRAME, select: ICON });
const logoPaths = await call('get_frame', { file: SAMPLE, frame: FRAME, select: ICON, includePaths: true });
// the summary names the path count and carries no path data; asking for it adds more
// bytes of `d` than the rest of the node costs, which is why it is the first thing cut
assert.ok(!logo.content[0].text.includes('"d":'), 'path data is in the summary after all');
assert.match(logo.content[0].text, /"pathCount": \d+/, 'the summary does not say how many paths there are');
assert.match(logoPaths.content[0].text, /"d": "/, 'asking for the paths did not produce any');
// how far path data outweighs the rest is carried by the logo below: its 63 paths are
// 39941 B on their own, which is why the answer for them cannot be sent at all
// the logo's 63 paths are 39941 B on their own, so asking for them cannot be honoured
const logoAsked = json(await call('get_frame', { file: SAMPLE, frame: FRAME, select: '2067:2', includePaths: true }));
assert.ok(logoAsked.truncated, 'a request too big for the budget came back without saying so');
const withPaths = logoPaths;
const ir = json(full);
assert.equal(ir.box.w, 1440);
const icons = [];
(function walk(n) { if (n.asset?.kind === 'svg') icons.push(n); n.children?.forEach?.((c) => typeof c === 'object' && walk(c)); })(ir);
assert.ok(icons.every((i) => i.asset.pathCount > 0 && !i.asset.paths), 'svg path data leaked into the model IR');

const shallow = json(await call('get_frame', { file: SAMPLE, frame: FRAME, depth: 1 }));
// at the cut, children survive as stubs carrying an id to drill into
assert.ok(shallow.children.every((c) => c.id && !Array.isArray(c.children)), 'depth cutoff did not stub children');
assert.ok(shallow.children.some((c) => typeof c.children === 'string' && c.children.includes('select')), 'stub carries no drill-down hint');

const assets = json(await call('export_assets', { file: SAMPLE, frame: FRAME, outDir: 'out/assets' }));
const entries = Object.values(assets);
const files = entries.map((e) => e.file);
assert.ok(files.some((f) => f.endsWith('.png')) && files.some((f) => f.endsWith('.svg')));
assert.ok(files.every((f) => existsSync(f)), 'export_assets reported a file it did not write');
// a bare hash cannot be placed in markup; every asset has to say which nodes use it
assert.ok(entries.every((e) => e.usedBy.length > 0), 'an asset came back with no node using it');
assert.ok(entries.every((e) => e.usedBy.every((u) => u.id && u.name)), 'usedBy entry is missing id or name');

const tokens = json(await call('get_tokens', { file: SAMPLE, frame: FRAME }));
assert.ok(tokens.colors.length > 5 && tokens.css.startsWith(':root {'));
// tokens are named for what they do, not numbered arbitrarily
assert.ok(
  tokens.colors.every((c) => /^--(surface|text|icon|border|gradient|color)(-\d+)?$/.test(c.name) || c.uses.length === 0),
  `token names are not semantic: ${tokens.colors.map((c) => c.name).filter((n) => !/^--(surface|text|icon|border|gradient|color)(-\d+)?$/.test(n))}`,
);
assert.ok(tokens.colors.some((c) => c.uses.includes('text')), 'usage context lost');

// --- every frame has to fit in context, and stay navigable when it does not ---
const BUDGET = 30_000;
let truncatedFrame;
for (const fr of frames) {
  const body = (await call('get_frame', { file: SAMPLE, frame: fr.id })).content[0].text;
  assert.ok(body.length <= BUDGET, `${fr.name} returned ${body.length} B, over the ${BUDGET} B budget`);
  if (body.includes('get_frame(select')) truncatedFrame ??= { fr, body };
}
assert.ok(truncatedFrame, 'no frame was large enough to exercise truncation');

// A trimmed text node used to come back with no `text` at all, looking like a
// finished leaf: whoever was writing markup got geometry and no words. Content is
// the last thing dropped now, and a trimmed node says it was trimmed.
const textNodes = [];
(function walk(n) { if (n.role === 'text') textNodes.push(n); if (Array.isArray(n.children)) n.children.forEach(walk); })(JSON.parse(truncatedFrame.body));
assert.ok(textNodes.length > 0, 'no text nodes survived truncation at all');
assert.ok(textNodes.every((n) => n.text?.content !== undefined), 'a text node came back without its string');
assert.ok(textNodes.some((n) => n.text.truncated), 'nothing marked itself as trimmed');

// What matters is how much of the design one call actually describes. Before the
// budget was spent breadth-first and content was dropped before geometry, a single
// get_frame per frame surfaced 35 of this file's 211 strings. The measurement lives
// in reach.mjs so `pnpm reach` and this assertion cannot drift apart — a test that
// re-counts it here would only ever agree with itself.

const hint = truncatedFrame.body.match(/select: [^\d]*(\d+:\d+)/);
assert.ok(hint, 'truncation marker does not name an id to drill into');
const drilled = json(await call('get_frame', { file: SAMPLE, frame: truncatedFrame.fr.id, select: hint[1] }));
assert.equal(drilled.id, hint[1], 'select returned the wrong node');
// a hint is worth following only if what comes back says more than the stub did:
// a container gets its children, a text node gets the style that was dropped
assert.ok(
  drilled.children?.length > 0 || drilled.text?.family || drilled.style,
  'drilling into the hint returned no more than the stub',
);

const html = (await call('get_html', { file: SAMPLE, frame: FRAME })).content[0].text;
assert.ok(html.startsWith('<!doctype html>') && html.includes('로그인'));

// --- the server's own indexes, which only the design-system file exercises ---
if (existsSync(LIBRARY)) {
  const libFrames = json(await call('list_frames', { file: LIBRARY }));
  assert.ok(libFrames.length > 90, `sections not traversed through the server: ${libFrames.length} frames`);

  const tag = libFrames.find((f) => f.name === 'Tag-solid');
  const tagIR = json(await call('get_frame', { file: LIBRARY, frame: tag.id }));
  const flatten = (root) => {
    const out = [];
    (function walk(n) { out.push(n); if (Array.isArray(n.children)) n.children.forEach(walk); })(root);
    return out;
  };
  // truncation currently reduces deep nodes to id/name/role/box, dropping `component`
  // along with everything else, so ask for a subtree that comes back whole. That
  // isolates what this is testing — how the server builds its indexes — from P2-1.
  const branch = tagIR.children.find((c) => Array.isArray(c.children) && c.children.length);
  const subtree = json(await call('get_frame', { file: LIBRARY, frame: tag.id, select: branch.id }));

  // symbolIndex built from the wrong source expands every instance to an empty shell
  const components = flatten(subtree).filter((n) => n.component);
  assert.ok(components.length >= 2, `instances did not expand through the server: ${components.length}`);
  assert.ok(components.some((n) => n.asset?.pathCount > 0 || n.children?.length), 'expanded instance has no content');

  // variables dropped on the way in means invented token names instead of authored ones
  const tokens = json(await call('get_tokens', { file: LIBRARY, frame: tag.id }));
  assert.ok(tokens.colors.some((c) => c.authored), 'no colour reached the server with its authored name');

  // 581 variables is 159KB unabridged, so the catalogue answers within the same
  // budget as everything else and says how to narrow it
  const vars = json(await call('get_variables', { file: LIBRARY }));
  assert.ok(vars.sets.length > 10, `sets missing from the catalogue: ${vars.sets.length}`);
  assert.ok(vars.truncated, 'the whole catalogue came back unabridged');
  const scoped = json(await call('get_variables', { file: LIBRARY, set: 'Size' }));
  assert.ok(scoped.variables.length > 10, `narrowing by set returned ${scoped.variables.length}`);
  assert.ok(scoped.variables.some((v) => v.values), 'narrowed variables came back without their values');

  // scoping to a frame answers with what that frame actually binds
  const tagVars = json(await call('get_variables', { file: LIBRARY, frame: tag.id }));
  assert.ok(tagVars.variables.length > 0 && tagVars.variables.length < 50,
    `frame scoping returned ${tagVars.variables.length} variables`);
}

const escaped = await call('get_frame', { file: '../../../etc/hosts', frame: 'x' });
assert.equal(escaped.isError, true);
assert.match(escaped.content[0].text, /escapes FIG_ROOT/);

const missing = await call('get_frame', { file: SAMPLE, frame: 'no-such-frame' });
assert.equal(missing.isError, true);
assert.match(missing.content[0].text, /frame not found/);
// nineteen frames in the design system have no name, so a list of names alone
// answers a failed lookup with a row of blanks
assert.match(missing.content[0].text, /\d+:\d+/, 'the error names no id to retry with');

// A path is not an identity. The server caches a parsed document, and the file
// behind the path can be replaced while it runs.
mkdirSync('out', { recursive: true });
copyFileSync(SAMPLE, 'out/swap.fig');
const before = json(await call('list_frames', { file: 'out/swap.fig' })).length;
if (existsSync(LIBRARY)) {
  await new Promise((r) => setTimeout(r, 10));
  copyFileSync(LIBRARY, 'out/swap.fig');
  const after = json(await call('list_frames', { file: 'out/swap.fig' })).length;
  assert.notEqual(after, before, `the cache served ${before} frames from a file that had been replaced`);
}

// A symlink inside FIG_ROOT points wherever it likes and never contains `..`, so
// comparing resolved strings lets it through. `out/` is gitignored, which makes it
// the one place a test may leave a link behind.
mkdirSync('out', { recursive: true });
try { symlinkSync(tmpdir(), 'out/escape-probe'); } catch { /* already there */ }
for (const target of ['out/escape-probe/anything.fig', 'out/escape-probe']) {
  const viaLink = await call('get_frame', { file: target, frame: 'x' });
  assert.equal(viaLink.isError, true, `a symlink got out of FIG_ROOT: ${target}`);
  assert.match(viaLink.content[0].text, /escapes FIG_ROOT/, `wrong refusal for ${target}`);
}
const viaLinkWrite = await call('export_assets', { file: SAMPLE, frame: FRAME, outDir: 'out/escape-probe/pwn' });
assert.equal(viaLinkWrite.isError, true, 'a symlink got out of FIG_ROOT for writing');

// --- finding a node without walking the tree ---
// Dogfooding this server, every question of the shape "where is the thing that says
// X" was answered by paging through get_frame with select. The tool that answers it
// directly returns the id to select, the path that gets there, and the box.
const hits = json(await call('find_nodes', { file: SAMPLE, query: '로그인' }));
assert.ok(hits.matches.length > 0, 'nothing matched a string the file definitely contains');
const first = hits.matches[0];
assert.match(first.id, /^\d+:\d+/, 'a match has no id to select');
assert.ok(Array.isArray(first.path) && first.path.length > 0, 'a match has no ancestor path');
assert.ok(first.frame, 'a match does not say which frame it is in');
assert.equal(typeof first.box.x, 'number', 'a match has no box');
assert.ok(hits.matches.some((m) => m.text?.includes('로그인')), 'no match carries the string it matched');

// the id it hands back has to be the one get_frame(select:) takes
const selected = json(await call('get_frame', { file: SAMPLE, frame: first.frame, select: first.id }));
assert.equal(selected.id, first.id, 'the id from find_nodes does not select');

// matching a name rather than a string in the design
const byName = json(await call('find_nodes', { file: SAMPLE, query: 'Rectangle', field: 'name' }));
assert.ok(byName.matches.length > 0, 'no node matched by name');
assert.ok(byName.matches.every((m) => /rectangle/i.test(m.name)), 'a name search returned something else');

// and it has to stay inside the budget like everything else
const many = await call('find_nodes', { file: LIBRARY, query: 'a' });
assert.ok(many.content[0].text.length <= BUDGET, `find_nodes returned ${many.content[0].text.length} B`);
assert.ok(json(many).truncated === undefined || json(many).truncated > 0, 'a truncated result does not say so');

// --- the descriptions a model reads are an interface, so run them ---
// get_frame's schema said `depth: 1 = this node only` while it returned the node with
// its children as stubs. Nothing looked at that sentence. Each parameter now carries
// its claims as data — the sentence is generated from them and this executes them, so
// the two cannot drift apart without one of them failing.
// .optional() wraps the schema, and both the description and the claims sit inside
const core = (schema) => (schema?.claims || schema?.description ? schema : schema?.unwrap?.() ?? schema);
const claims = TOOLS.flatMap((t) =>
  Object.entries(t.inputSchema).flatMap(([param, schema]) =>
    (core(schema).claims ?? []).map((c) => ({ tool: t.name, param, ...c }))));
assert.ok(claims.length >= 12, `only ${claims.length} parameter claims are runnable`);
for (const t of TOOLS) {
  assert.ok(t.title, `${t.name} has no title`);
  assert.ok(t.description?.length > 40, `${t.name}'s description is ${t.description?.length ?? 0} characters`);
  const params = Object.entries(t.inputSchema);
  assert.ok(params.length > 0, `${t.name} declares no inputs, not even file`);
  for (const [param, schema] of params) {
    assert.ok(core(schema).description, `${t.name}.${param} has no description for a model to read`);
  }
  // file is the one parameter every tool takes, and the confinement rides on it
  assert.ok(t.inputSchema.file, `${t.name} does not take a file`);
}
// A default spelled out by hand can disagree with the code even when the behaviour is
// asserted, so the numbers in the sentences have to come from the tool's own defaults.
for (const t of TOOLS) {
  for (const [param, schema] of Object.entries(t.inputSchema)) {
    for (const m of (core(schema).description ?? '').matchAll(/default ([^;)\]]+)/g)) {
      const declared = Object.values(t.defaults ?? {}).map(String);
      assert.ok(
        declared.includes(m[1].trim()),
        `${t.name}.${param} advertises "default ${m[1].trim()}" and the tool's defaults are ${JSON.stringify(t.defaults ?? null)}`,
      );
    }
  }
}

// Whatever the arguments, a response has to fit the context it is going into. depth
// and includePaths used to walk straight past the budget — 297366 B against 30000 —
// which is not a switch a caller can be expected to know the cost of.
for (const args of [{}, { depth: 99 }, { includePaths: true }, { depth: 99, includePaths: true }]) {
  const res = await call('get_frame', { file: LIBRARY, frame: '2313:1353', ...args });
  assert.ok(
    res.content[0].text.length <= BUDGET,
    `get_frame(${JSON.stringify(args)}) returned ${res.content[0].text.length} B, over the ${BUDGET} B budget`,
  );
}

for (const c of claims) {
  const res = await call(c.tool, c.run);
  const body = res.content[0].text;
  const value = res.isError ? { error: body } : (() => { try { return JSON.parse(body); } catch { return body; } })();
  assert.equal(
    c.then(value, body),
    c.says,
    `${c.tool}.${c.param} — the description says "${c.when} = ${c.says}"`,
  );
}

proc.kill();

// --- what one call actually reaches ---
// The 30KB budget cannot hold a large frame, so the number that matters is how much
// of one comes back. Pinning it here is what makes a change to the allocator show up
// as a failure rather than as quietly less of the design arriving.
const reach = await measureReach(SAMPLE);
assert.ok(reach.text >= 87, `text reached fell to ${reach.text}/${reach.textTotal}, was 87`);
assert.ok(reach.nodes >= 794, `nodes reached fell to ${reach.nodes}/${reach.nodeTotal}, was 794`);
assert.ok(reach.truncated <= 7, `${reach.truncated} frames truncated, was 7`);

console.log(`ok — ${tools.length} tools, ${frames.length} frames, IR ${full.content[0].text.length} B ` +
  `(one icon is ${logo.content[0].text.length} B, ${withPaths.content[0].text.length} B with its paths), ${files.length} assets, ` +
  `reach ${reach.text}/${reach.textTotal} text ${reach.nodes}/${reach.nodeTotal} nodes`);
