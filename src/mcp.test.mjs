import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const SAMPLE = 'samples/kyowon-full.fig';
const FRAME = '온라인학습_Login';
if (!existsSync(SAMPLE)) {
  console.log(`skip — ${SAMPLE} not present`);
  process.exit(0);
}

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

const tools = (await rpc('tools/list')).tools.map((t) => t.name);
assert.deepEqual(tools.sort(), ['export_assets', 'get_frame', 'get_html', 'get_tokens', 'get_variables', 'list_frames']);

// this sample barely uses variables; the catalogue still has to come back well-formed
const vars = json(await call('get_variables', { file: SAMPLE }));
assert.ok(vars.variables.length >= 1, 'no variables read');
assert.ok(vars.variables.every((v) => v.token.startsWith('--') && v.type), 'variable entry is missing token or type');
assert.match(vars.css, /^:root \{/, 'variable CSS has no root block');

const frames = json(await call('list_frames', { file: SAMPLE }));
assert.ok(frames.some((f) => f.name === FRAME), 'login frame missing from list_frames');
assert.ok(frames.every((f) => f.id && f.w && f.h));

const full = await call('get_frame', { file: SAMPLE, frame: FRAME });
const withPaths = await call('get_frame', { file: SAMPLE, frame: FRAME, includePaths: true });
assert.ok(full.content[0].text.length * 3 < withPaths.content[0].text.length, 'path stripping barely helped');
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

const hint = truncatedFrame.body.match(/select: [^\d]*(\d+:\d+)/);
assert.ok(hint, 'truncation marker does not name an id to drill into');
const drilled = json(await call('get_frame', { file: SAMPLE, frame: truncatedFrame.fr.id, select: hint[1] }));
assert.equal(drilled.id, hint[1], 'select returned the wrong node');
assert.ok(drilled.children.length > 0, 'drilled subtree came back empty');

const html = (await call('get_html', { file: SAMPLE, frame: FRAME })).content[0].text;
assert.ok(html.startsWith('<!doctype html>') && html.includes('로그인'));

const escaped = await call('get_frame', { file: '../../../etc/hosts', frame: 'x' });
assert.equal(escaped.isError, true);
assert.match(escaped.content[0].text, /escapes FIG_ROOT/);

const missing = await call('get_frame', { file: SAMPLE, frame: 'no-such-frame' });
assert.equal(missing.isError, true);
assert.match(missing.content[0].text, /frame not found/);

proc.kill();
console.log(`ok — ${tools.length} tools, ${frames.length} frames, IR ${full.content[0].text.length} B ` +
  `(vs ${withPaths.content[0].text.length} B with paths), ${files.length} assets`);
