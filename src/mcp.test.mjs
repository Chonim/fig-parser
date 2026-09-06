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
assert.deepEqual(tools.sort(), ['export_assets', 'get_frame', 'get_html', 'get_tokens', 'list_frames']);

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
assert.ok(shallow.children.some((c) => typeof c === 'string' && c.includes('children')), 'depth cutoff not applied');

const assets = json(await call('export_assets', { file: SAMPLE, frame: FRAME, outDir: 'out/assets' }));
const files = Object.values(assets);
assert.ok(files.some((f) => f.endsWith('.png')) && files.some((f) => f.endsWith('.svg')));
assert.ok(files.every((f) => existsSync(f)), 'export_assets reported a file it did not write');

const tokens = json(await call('get_tokens', { file: SAMPLE, frame: FRAME }));
assert.ok(tokens.colors.length > 5 && tokens.css.startsWith(':root {'));

const html = (await call('get_html', { file: SAMPLE, frame: FRAME })).content[0].text;
assert.ok(html.startsWith('<!doctype html>') && html.includes('로그인'));

const escaped = await call('get_frame', { file: '../../../etc/hosts', frame: 'x' });
assert.equal(escaped.isError, true);
assert.match(escaped.content[0].text, /escapes FIG_ROOT/);

const missing = await call('get_frame', { file: SAMPLE, frame: 'no-such-frame' });
assert.equal(missing.isError, true);
assert.match(missing.content[0].text, /frame not found/);

proc.kill();
console.log(`ok — 5 tools, ${frames.length} frames, IR ${full.content[0].text.length} B ` +
  `(vs ${withPaths.content[0].text.length} B with paths), ${files.length} assets`);
