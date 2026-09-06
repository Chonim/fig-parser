#!/usr/bin/env node
/**
 * How much of a frame a model actually gets from one `get_frame` call.
 *
 * The 30KB budget means a large frame cannot come back whole, and what it drops is
 * the number that says whether the budget is being spent well. A figure nobody can
 * re-measure is not a baseline, so this is a command rather than a note in a file.
 *
 *   pnpm reach [file.fig]
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { parseFigFile, buildTree, collectFrames } from './parse.mjs';
import { toIR, symbolIndex, variableIndex } from './ir.mjs';

const BUDGET = 30_000;

const kids = (n) => (Array.isArray(n.children) ? n.children : []);
const countText = (n) => (n.text?.content ? 1 : 0) + kids(n).reduce((s, c) => s + countText(c), 0);
const countNodes = (n) => 1 + kids(n).reduce((s, c) => s + countNodes(c), 0);

/** one stdio MCP client, alive for the length of the measurement */
function client() {
  const proc = spawn('node', [new URL('./mcp.mjs', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'inherit'] });
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
  let id = 0;
  const rpc = async (method, params) => {
    const n = ++id;
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    for (let i = 0; i < 1200; i++) {
      const hit = seen.find((m) => m.id === n);
      if (hit) return hit.result;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timeout waiting for ${method}`);
  };
  return { rpc, stop: () => proc.kill() };
}

export async function measureReach(file) {
  const { message } = parseFigFile(file);
  const roots = buildTree(message.nodeChanges);
  const frames = collectFrames(roots);
  const ctx = { symbols: symbolIndex(roots), variables: variableIndex(message.nodeChanges) };

  const { rpc, stop } = client();
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'reach', version: '1' } });
  const out = { file, frames: frames.length, text: 0, textTotal: 0, nodes: 0, nodeTotal: 0, truncated: 0, slack: 0, slackFrames: [], maxBytes: 0, over: [] };
  try {
    for (const frame of frames) {
      const whole = toIR(frame, message.blobs, ctx);
      out.textTotal += countText(whole);
      out.nodeTotal += countNodes(whole);
      const res = await rpc('tools/call', { name: 'get_frame', arguments: { file, frame: frame.id } });
      const body = res.content[0].text;
      out.maxBytes = Math.max(out.maxBytes, body.length);
      if (body.length > BUDGET) out.over.push({ id: frame.id, name: frame.name, bytes: body.length });
      const got = JSON.parse(body);
      out.text += countText(got);
      out.nodes += countNodes(got);
      if (countNodes(got) < countNodes(whole)) {
        out.truncated += 1;
        // a frame that was cut while leaving half the budget unspent is the budget
        // being handed out badly, not a frame that is simply too big
        if (body.length < BUDGET / 2) {
          out.slack += 1;
          out.slackFrames.push({ id: frame.id, name: frame.name || '(unnamed)', bytes: body.length });
        }
      }
    }
  } finally {
    stop();
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2);
  const targets = files.length ? files : ['samples/kyowon-full.fig', 'samples/matsq.fig'];
  let any = false;
  for (const file of targets) {
    if (!existsSync(file)) {
      console.log(`skip — ${file} not present`);
      continue;
    }
    any = true;
    const r = await measureReach(file);
    console.log(
      `\n${r.file} — ${r.frames} frames\n` +
      `  text reached in one call   ${r.text}/${r.textTotal}\n` +
      `  nodes reached in one call  ${r.nodes}/${r.nodeTotal}\n` +
      `  frames truncated           ${r.truncated}/${r.frames}   (under half the budget: ${r.slack})\n` +
      `  largest response           ${r.maxBytes} B` + (r.over.length ? `  — ${r.over.length} over budget` : ''),
    );
    for (const f of r.slackFrames) console.log(`    ${f.id}  ${f.name}  ${f.bytes} B`);
  }
  // a skip and a pass look identical to anything reading the exit code
  if (!any) process.exit(process.env.CI ? 1 : 0);
}
