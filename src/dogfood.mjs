// Same goal, two toolsets: learn every string in one frame and where it sits.
// Counts the tool calls each takes.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { parseFigFile, buildTree, collectFrames } from './parse.mjs';
import { toIR, symbolIndex, variableIndex } from './ir.mjs';

const FILE = 'samples/matsq.fig';
const FRAME = '97:3081';

if (!existsSync(FILE)) {
  // a skip and a pass are indistinguishable to anything reading the exit code
  console.log(`skip — ${FILE} not present`);
  process.exit(process.env.CI ? 1 : 0);
}

const { message } = parseFigFile(FILE);
const roots = buildTree(message.nodeChanges);
const ctx = { symbols: symbolIndex(roots), variables: variableIndex(message.nodeChanges) };
const ir = toIR(collectFrames(roots).find((f) => f.id === FRAME), message.blobs, ctx);
const wanted = new Set();
(function w(n) { if (n.text?.content) wanted.add(`${n.id}|${n.text.content}`); n.children?.forEach(w); })(ir);

const proc = spawn('node', [new URL('./mcp.mjs', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'inherit'] });
const seen = []; let buf = '';
proc.stdout.on('data', (d) => { buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0; ) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) seen.push(JSON.parse(l)); } });
let id = 0, calls = 0;
const rpc = async (m, p) => { const n = ++id;
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method: m, params: p }) + '\n');
  for (let i = 0; i < 900; i++) { const h = seen.find((x) => x.id === n); if (h) return h.result; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('timeout'); };
const call = async (name, args) => { calls += 1; return JSON.parse((await rpc('tools/call', { name, arguments: args })).content[0].text); };
await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dogfood', version: '1' } });

const collect = (node, got) => {
  if (node.text?.content) got.add(`${node.id}|${node.text.content}`);
  if (Array.isArray(node.children)) node.children.forEach((c) => collect(c, got));
};
const stubsIn = (node, out) => {
  if (typeof node.children === 'string') out.push(node.id);
  else if (Array.isArray(node.children)) {
    for (const c of node.children) {
      if (c.stub || c.text === undefined && c.children === undefined) out.push(c.id);
      stubsIn(c, out);
    }
  }
  return out;
};

// A — drilling with select, the way this was done before find_nodes
{
  calls = 0;
  const got = new Set();
  const queue = [undefined];
  const asked = new Set();
  while (queue.length && got.size < wanted.size && calls < 200) {
    const select = queue.shift();
    const res = await call('get_frame', select ? { file: FILE, frame: FRAME, select } : { file: FILE, frame: FRAME });
    collect(res, got);
    for (const id of stubsIn(res, [])) if (id && !asked.has(id)) { asked.add(id); queue.push(id); }
  }
  console.log(`A  drilling with select      ${calls} calls, ${got.size}/${wanted.size} strings`);
}

// B — one search, then nothing else is needed
{
  calls = 0;
  const got = new Set();
  const res = await call('find_nodes', { file: FILE, frame: FRAME, query: '', field: 'text', limit: 200 });
  for (const m of res.matches) got.add(`${m.id}|${m.text}`);
  console.log(`B  find_nodes                ${calls} calls, ${got.size}/${wanted.size} strings, truncated ${res.truncated ?? 0}`);
}
proc.kill();
