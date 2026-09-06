#!/usr/bin/env node
/**
 * Census of everything the IR layer currently drops or approximates.
 *
 * The point is to replace guesswork with a number: every row either maps to a task
 * in TASKS.md or is listed as deliberately ignored, and a row reaching 0 is what
 * "done" means for that task.
 */
import { parseFigFile, buildTree, decodePathBlob, collectFrames } from './parse.mjs';
import { toIR, isIconCluster, HANDLED, symbolIndex, variableIndex } from './ir.mjs';

const FILE = process.argv[2] ?? 'samples/kyowon-full.fig';

const IGNORED = {
  'invisible nodes (visible: false)': 'deliberate — nothing to render',
  'vector-network-only blobs': 'deliberate — duplicate of fill/stroke geometry (see TASKS.md)',
};

const maskFitsParent = new Set();

const tally = new Map();
const bump = (row, n = 1) => tally.set(row, (tally.get(row) ?? 0) + n);

const { message } = parseFigFile(FILE);
const { blobs, nodeChanges } = message;

// --- blobs: which fail to decode, and does any node depend only on a failing one? ---
const badBlob = new Set();
blobs.forEach((b, i) => {
  try {
    decodePathBlob(b.bytes);
  } catch {
    badBlob.add(i);
  }
});

const roots = buildTree(nodeChanges);
const symbols = symbolIndex(roots);
const frames = collectFrames(roots);

let rawTotal = 0;
let irTotal = 0;
let collapsedTotal = 0;
let invisibleTotal = 0;
let consumedTotal = 0;

const subtreeSize = (n) => 1 + (n.children ?? []).reduce((a, c) => a + subtreeSize(c), 0);

// mirror ir.mjs's rule for which masks collapse into overflow:hidden
(function findMasks(node) {
  const near = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) < 1;
  for (const c of node.children ?? []) {
    if (c.mask && near(c.transform?.m02, 0) && near(c.transform?.m12, 0)
      && near(c.size?.x, node.size?.x) && near(c.size?.y, node.size?.y)) maskFitsParent.add(c);
    findMasks(c);
  }
})({ children: frames });

for (const frame of frames) {
  rawTotal += subtreeSize(frame);

  // --- raw pass: count what we are handed, and what we throw away ---
  // walking stops at icon clusters and hidden nodes, so their subtrees are tallied
  // whole rather than visited — the totals below have to add back up to rawTotal
  (function walk(raw) {
    // an instance is a stand-in for its master: everything below is about what
    // actually renders, so swap in the master before counting anything
    const master = raw.type === 'INSTANCE' && raw.symbolData
      && symbols.get(`${raw.symbolData.symbolID.sessionID}:${raw.symbolData.symbolID.localID}`);
    if (master) rawTotal += subtreeSize(master) - 1;
    const node = master ? { ...master, transform: raw.transform, size: raw.size, visible: raw.visible } : raw;

    if (node.visible === false) {
      invisibleTotal += subtreeSize(node);
      bump('invisible nodes (visible: false)');
      return;
    }

    if (!HANDLED.nodeTypes.has(node.type)) bump(`node type ${node.type} — no explicit handling`);

    for (const [key, caps] of [['fill', HANDLED.fillPaints], ['stroke', HANDLED.strokePaints]]) {
      for (const p of node[`${key}Paints`] ?? []) {
        if (p.visible === false) continue;
        if (caps.handled.has(p.type)) continue;
        bump(caps.approximated.has(p.type) ? `${key} paint ${p.type} — approximated` : `${key} paint ${p.type} — dropped`);
      }
    }

    for (const e of node.effects ?? []) {
      if (e.visible === false || HANDLED.effects.handled.has(e.type)) continue;
      bump(`effect ${e.type} — dropped`);
    }



    const image = node.fillPaints?.find((p) => p.visible !== false && p.type === 'IMAGE');
    if (image && image.imageScaleMode && !HANDLED.imageScaleModes.has(image.imageScaleMode)) {
      bump(`image scaleMode ${image.imageScaleMode} — always rendered as cover`);
    }

    // a mask whose shape is not simply the parent's box still has no representation
    if (node.mask && !maskFitsParent.has(node)) bump('mask with a shape of its own — not clipped');

    // a node whose only geometry is an undecodable blob is genuinely unrenderable
    const geoms = [...(node.fillGeometry ?? []), ...(node.strokeGeometry ?? [])];
    if (geoms.length && geoms.every((g) => badBlob.has(g.commandsBlob))) {
      bump(`unrenderable: ${node.type} references only failing blobs`);
    }

    if (maskFitsParent.has(node)) {
      consumedTotal += subtreeSize(node); // folded into the parent's overflow:hidden
      return;
    }

    if (isIconCluster(node)) {
      collapsedTotal += subtreeSize(node) - 1;
      return; // the whole subtree becomes one SVG; its descendants are not "lost"
    }
    (node.children ?? []).forEach(walk);
  })(frame);

  // --- IR pass: how many nodes actually survive ---
  const ir = toIR(frame, blobs, { symbols, variables: variableIndex(nodeChanges) });
  (function count(n) {
    irTotal++;
    (n.children ?? []).forEach(count);
  })(ir);
}

bump('vector-network-only blobs', badBlob.size);

const reached = irTotal + collapsedTotal + invisibleTotal + consumedTotal;
const lost = rawTotal - reached;
if (lost > 0) bump('nodes that vanished between raw tree and IR', lost);

// --- report ---
const rows = [...tally.entries()].sort((a, b) => b[1] - a[1]);
const width = Math.max(...rows.map(([k]) => k.length));
const note = (k) => IGNORED[k] ?? (k.includes('vanished') ? 'investigate — should be 0' : 'see TASKS.md');

console.log(`\n${FILE} — ${frames.length} frames, ${rawTotal} raw nodes, ${irTotal} IR nodes ` +
  `(${collapsedTotal} collapsed into icons, ${consumedTotal} folded into masks, ${invisibleTotal} invisible)\n`);
console.log(`${'finding'.padEnd(width)}  count  note`);
console.log(`${'-'.repeat(width)}  -----  ----`);
for (const [k, v] of rows) console.log(`${k.padEnd(width)}  ${String(v).padStart(5)}  ${note(k)}`);
console.log();
