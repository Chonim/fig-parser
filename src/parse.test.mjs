import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { parseFigFile, buildTree, decodePathBlob, collectFrames } from './parse.mjs';
import { toIR, extractTokens } from './ir.mjs';
import { renderHTML } from './html.mjs';

const SAMPLE = 'samples/kyowon-full.fig';
if (!existsSync(SAMPLE)) {
  // A skip and a pass are indistinguishable to anything reading the exit code, so
  // on CI an absent sample is a failure rather than a quiet green run.
  console.log(`skip — ${SAMPLE} not present`);
  process.exit(process.env.CI ? 1 : 0);
}

const { version, message } = parseFigFile(SAMPLE);
assert.equal(message.type, 'NODE_CHANGES');
assert.ok(version >= 100, `unexpected fig version ${version}`);

// --- tree ---
const roots = buildTree(message.nodeChanges);
const count = (list) => list.reduce((n, c) => n + 1 + count(c.children), 0);
assert.equal(count(roots), message.nodeChanges.length, 'buildTree lost nodes');

const canvas = roots.flatMap((r) => r.children).find((n) => n.type === 'CANVAS');
const positions = canvas.children.map((c) => c.parentIndex.position);
const byBytes = [...positions].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
assert.deepEqual(positions, byBytes, 'siblings out of fractional-index order');
// localeCompare disagrees with byte order on these strings — that difference is the bug this guards
assert.notDeepEqual(positions, [...positions].sort((a, b) => a.localeCompare(b)), 'sample no longer exercises the collation trap');

// --- path blobs ---
const geom = message.nodeChanges.find((n) => n.fillGeometry?.length)?.fillGeometry[0];
const parts = decodePathBlob(message.blobs[geom.commandsBlob].bytes);
// PATH_LETTER is exactly the set these are drawn from and unknown opcodes throw
// earlier, so asserting membership proves nothing. Assert the shape instead: real
// artwork has curves, and each command carries the argument count its opcode names.
const ARGC = { Z: 0, M: 2, L: 2, Q: 4, C: 6 };
assert.equal(parts[0].cmd, 'M', 'path must open with a moveTo');
assert.ok(parts.some((p) => p.cmd === 'C'), 'no curve decoded — opcodes are collapsing');
assert.ok(parts.every((p) => p.args.length === ARGC[p.cmd]), 'a command has the wrong argument count');
const decodedCmds = new Set(message.blobs.flatMap((b) => {
  try { return decodePathBlob(b.bytes).map((p) => p.cmd); } catch { return []; }
}));
assert.ok(decodedCmds.size >= 4, `only ${[...decodedCmds]} ever decoded`);

// --- IR ---
const frame = canvas.children.find((c) => c.name === '온라인학습_Login');
const ir = toIR(frame, message.blobs);
assert.equal(ir.role, 'frame');
assert.deepEqual(ir.box, { x: 0, y: 0, w: 1440, h: 960 });

const flat = [];
(function walk(n) { flat.push(n); n.children?.forEach(walk); })(ir);

const byRole = (r) => flat.filter((n) => n.role === r);
assert.ok(byRole('backdrop').length >= 1, 'full-bleed layer not marked as backdrop');
assert.ok(byRole('text').some((n) => n.text.content === '로그인'), 'login label missing');
assert.ok(byRole('image').length >= 1, 'no image node');

const icon = byRole('icon').sort((a, b) => b.asset.paths.length - a.asset.paths.length)[0];
assert.ok(icon?.asset.paths.length > 10, 'logo cluster did not collapse into an SVG');
assert.ok(icon.asset.paths.every((p) => p.d.startsWith('M')), 'bad path data');
/**
 * Path coordinates already sit in the node's own size space. Dividing them by
 * vectorData.normalizedSize shrinks the ink to a speck while every `transform`
 * offset stays put — so the offsets must be excluded, or the measurement tracks
 * placement instead of geometry and the bug walks straight through.
 * Measured floor across both samples' 1040 icons: 0.172.
 */
const inkRatio = (n) => {
  const spans = n.asset.paths.map((p) => {
    const v = (p.d.match(/-?[\d.]+/g) ?? []).map(Number);
    return v.length ? Math.max(...v) - Math.min(...v) : 0;
  });
  return Math.max(...spans) / Math.max(n.box.w, n.box.h, 1);
};
assert.ok(inkRatio(icon) > 0.05, `logo ink collapsed: ${inkRatio(icon)}`);

let thinnest = { ratio: Infinity };
let iconCount = 0;
for (const frame of collectFrames(roots)) {
  (function walk(n) {
    if (n.asset?.kind === 'svg') {
      iconCount++;
      const ratio = inkRatio(n);
      if (ratio < thinnest.ratio) thinnest = { ratio, where: `${frame.name}/${n.name}` };
    }
    n.children?.forEach(walk);
  })(toIR(frame, message.blobs) ?? { children: [] });
}
assert.ok(iconCount > 200, `expected many icons to measure, got ${iconCount}`);
assert.ok(thinnest.ratio > 0.05, `path ink collapsed at ${thinnest.where}: ${thinnest.ratio}`);

const label = byRole('text').find((n) => n.text.content === '로그인');
assert.equal(label.text.weight, 600, 'SemiBold should map to 600');
assert.match(label.text.color, /^#[0-9a-f]{6}$/);

// --- mixed-format text ---
const lq = canvas.children.find((c) => c.name === '온라인학습_LEARNING QUEST');
const lqIR = toIR(lq, message.blobs);
const lqText = [];
(function walk(n) { if (n.role === 'text') lqText.push(n); n.children?.forEach(walk); })(lqIR);

const percent = lqText.find((n) => n.text.content === '58%');
assert.deepEqual(percent.text.runs.map((r) => r.text), ['58', '%'], 'mixed run was flattened');
assert.ok(percent.text.runs[0].size > percent.text.runs[1].size, 'run font sizes lost');
// runs only carry what differs from the node style, so a uniform node has none
assert.ok(lqText.some((n) => !n.text.runs), 'every text node claims mixed formatting');
assert.ok(lqText.some((n) => n.text.verticalAlign === 'center'), 'vertical centring not detected');

const html5 = renderHTML(lqIR);
assert.ok(html5.includes('<span style="font-size:40px">58</span>'), 'run span not rendered');
assert.ok(html5.includes('Noto+Sans+KR'), 'font actually used was never linked');

// A text node centred vertically becomes a flex container, and every run inside it
// would become its own flex item — laid side by side, with the newlines between them
// dropped. The empty-state notice is two lines in one bold+regular string; as separate
// items it rendered as one line wide enough to be clipped at both ends.
const empty = collectFrames(roots).find((f) => f.id === '2097:918');
const emptyHTML = renderHTML(toIR(empty, message.blobs));
const notice = emptyHTML.match(/<p class="([^"]*배정된[^"]*)"[^>]*>((?:.|\n)*?)<\/p>/);
assert.ok(notice, 'the two-line empty-state notice is no longer in the render');
const noticeRules = emptyHTML.match(new RegExp(`\\.${notice[1]} \\{([^}]*)\\}`));
assert.match(noticeRules[1], /display: flex/, 'this text is no longer a flex container — pick another case');
// count what sits directly inside the <p>: anything past the first is another flex item
let depth = 0;
let topLevel = 0;
for (const tok of notice[2].split(/(<[^>]+>)/).filter((x) => x !== '')) {
  if (tok.startsWith('</')) depth -= 1;
  else if (tok.startsWith('<')) { if (depth === 0) topLevel += 1; depth += 1; }
  else if (depth === 0 && tok.trim()) topLevel += 1;
}
assert.equal(
  topLevel,
  1,
  'a vertically centred text put its runs directly in the flex container, so each became its own item and the line breaks between them were dropped',
);

// A tool that has both the IR and the DOM needs to say which element is which, but
// the baseline render should stay readable, so the ids are opt-in.
const plain = renderHTML(lqIR);
assert.ok(!plain.includes('data-id='), 'the baseline render is carrying node ids nobody asked for');
const tagged = renderHTML(lqIR, { nodeIds: true });
const tags = [...tagged.matchAll(/<(div|p|img|svg)\b/g)].map((m) => m[1]);
const ids = [...tagged.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]);
assert.equal(ids.length, tags.length, 'some element kinds render without their node id');
assert.equal(new Set(ids).size, ids.length, 'two elements claim the same node id');
assert.ok(ids.includes(lqIR.id), 'the frame itself is not tagged');

// --- transforms ---
// ARCHIVE carries rotated carets; identity nodes must stay untouched so that
// adding transform support cannot silently reflow everything else
const archive = canvas.children.find((c) => c.name === '온라인학습_ARCHIVE');
const archiveIR = toIR(archive, message.blobs);
const spun = [];
(function walk(n) { if (n.box?.transform) spun.push(n); n.children?.forEach(walk); })(archiveIR);
assert.ok(spun.length >= 5, `expected rotated nodes in ARCHIVE, found ${spun.length}`);
assert.ok(spun.every((n) => n.bounds), 'rotated node is missing its post-rotation bounds');
assert.ok(spun.some((n) => /^rotate\(-?\d/.test(n.box.transform)), 'no plain rotation was named as one');
assert.ok(flat.filter((n) => n.box.transform).length === 0, 'login frame should have no transforms at all');
assert.ok(flat.every((n) => n.bounds === undefined), 'bounds leaked onto untransformed nodes');

// Figma rotates about the unrotated box's top-left, which `transform-origin: 0 0`
// reproduces exactly — but only for a node whose left/top are that box. A node the
// flow places instead has no such anchor, and rotating it about its corner throws it
// a whole box-width clear of where the layout put it: the ARCHIVE row buttons' carets
// climbed out of the button and sat above its top-right corner.
const archiveHTML = renderHTML(archiveIR);
const originOf = (cls) => (archiveHTML.match(new RegExp(`\\.${cls} \\{([^}]*)\\}`))?.[1] ?? '').match(/transform-origin: ([^;]+);/)?.[1];
const flowSpun = [];
(function walk(n, parent) {
  if (n.box?.transform && parent && parent.layout?.mode !== 'absolute' && !n.flexChild?.absolute && n.role !== 'backdrop') flowSpun.push(n);
  n.children?.forEach((c) => walk(c, n));
})(archiveIR, null);
assert.ok(flowSpun.length > 0, 'no rotated node is laid out by the flow any more — pick another case');
assert.equal(originOf('vector-10'), '50% 50%', 'a rotated node the flow positions was spun about its corner, which moves it a whole box clear of its slot');
assert.equal(originOf('vector-10-13'), '0 0', "an absolutely-positioned rotated node must keep Figma's own corner origin");

// --- geometry-based nesting ---
// hand-drawn files leave a button's box and its label as siblings; nesting them has
// to be purely structural, so absolute positions must survive it untouched
/**
 * Nesting is structural only: a node's absolute position in the IR must equal the
 * one it has in the raw Figma tree. Comparing the IR against itself — the shape
 * this assertion used to have — cannot see a rebasing error at all.
 */
const absoluteIR = (root) => {
  const out = new Map();
  (function walk(n, ox, oy) {
    const x = ox + n.box.x;
    const y = oy + n.box.y;
    out.set(n.id, [x, y]);
    n.children?.forEach((c) => walk(c, x, y));
  })(root, 0, 0);
  return out;
};
const absoluteRaw = (node) => {
  const out = new Map();
  (function walk(n, ox, oy) {
    const x = ox + (n.transform?.m02 ?? 0);
    const y = oy + (n.transform?.m12 ?? 0);
    out.set(n.id, [x, y]);
    n.children?.forEach((c) => walk(c, x, y));
  })(node, -(node.transform?.m02 ?? 0), -(node.transform?.m12 ?? 0));
  return out;
};

// each rebase rounds to 2dp, so a deep node drifts a little. Measured worst case
// across both samples: 0.0189px. Anything past a twentieth of a pixel is a bug.
const DRIFT = 0.05;
const archiveNested = canvas.children.find((c) => c.id === '2102:20');
const nestedIR = toIR(archiveNested, message.blobs);
const labelled = [];
(function walk(n) { if (n.label) labelled.push(n); n.children?.forEach(walk); })(nestedIR);
assert.ok(labelled.length >= 3, `expected labelled containers, found ${labelled.length}`);
assert.ok(labelled.some((n) => n.label === 'LEARNING QUEST'), 'a nav tab was not paired with its label');
const tab = labelled.find((n) => n.label === 'LEARNING QUEST');
assert.ok(tab.style.fill, 'an unpainted group was treated as a container');
assert.ok(tab.children.some((c) => c.role === 'image'), 'the tab lost its icon when it gained its label');
// every child of a container has to sit inside it once rebased
assert.ok(
  tab.children.every((c) => c.box.x >= -1 && c.box.y >= -1 && c.box.x + c.box.w <= tab.box.w + 1),
  'adopted child was not rebased into its new parent',
);
// a container may not adopt across something drawn between them, or z-order flips
const bookshelf = nestedIR.children.find((c) => c.name === 'Group 4057');
assert.ok(bookshelf, 'a shelf was adopted past an overlapping sibling, which reorders painting');
// ids repeat inside expanded instances, so compare only the ones that are unique
const irPos = absoluteIR(nestedIR);
const rawPos = absoluteRaw(archiveNested);
let compared = 0;
for (const [id, [x, y]] of irPos) {
  if (!rawPos.has(id)) continue;
  compared++;
  const [rx, ry] = rawPos.get(id);
  const drift = Math.max(Math.abs(x - rx), Math.abs(y - ry));
  assert.ok(drift < DRIFT, `${id} moved ${drift.toFixed(3)}px: IR ${x},${y} vs source ${rx},${ry}`);
}
assert.ok(compared > 50, `only ${compared} nodes were position-checked`);

// --- repeated structure ---
const withRepeat = [];
(function walk(n) { if (n.layout?.repeat) withRepeat.push(n); n.children?.forEach(walk); })(lqIR);
assert.ok(withRepeat.length >= 2, `expected repeated groups in LEARNING QUEST, found ${withRepeat.length}`);

// Group 3095 is four identically sized cards stacked in a column
const column = withRepeat.find((n) => n.name === 'Group 3095');
assert.equal(column.layout.repeat.count, 4, 'card column repeat miscounted');
assert.deepEqual(
  { columns: column.layout.repeat.columns, rows: column.layout.repeat.rows },
  { columns: 1, rows: 4 },
  'a single stacked column was not measured as one',
);
assert.ok(column.children.some((c) => c.id === column.layout.repeat.like), 'repeat points at a node that is not a child');
const sizes = new Set(column.children.map((c) => `${c.box.w}x${c.box.h}`));
assert.equal(sizes.size, 1, 'repeat claimed for children of differing sizes');
assert.ok(!flat.some((n) => n.layout?.repeat), 'login frame has no list, but one was inferred');

// --- rows: sibling order is paint order, so reading order needs saying ---
const tableFrame = canvas.children.find((c) => c.id === '2097:1156');
const tableIR = toIR(tableFrame, message.blobs);

// --- stroke geometry arrives already outlined ---
// The 11 dividers in this table have no fillGeometry at all: their ink is entirely
// strokeGeometry, painted like a fill. Dropping that list leaves them empty, and
// only this frame notices — the components suite catches it by side effect.
const dividers = [];
(function walk(n) { if (/^Line /.test(n.name ?? '') && n.asset?.kind === 'svg') dividers.push(n); n.children?.forEach(walk); })(tableIR);
assert.ok(dividers.length >= 8, `expected stroke-only dividers, found ${dividers.length}`);
assert.ok(dividers.every((d) => d.asset.paths.length > 0), 'a stroke-only shape produced no path');
assert.ok(dividers.every((d) => d.asset.paths.every((p) => /^M/.test(p.d) && p.fill !== 'none')), 'divider ink is unpainted');
// a hairline's node box has no height; a viewBox taken from it cannot scale and
// the browser draws nothing, so those take their size from the ink instead
assert.ok(dividers.every((d) => d.box.h > 0), 'a divider still has a zero-height box');
assert.ok(dividers.every((d) => !/ 0$/.test(d.asset.viewBox)), 'a viewBox still has no height');
// everywhere else the box is kept and the outlined stroke is allowed to overflow
assert.match(renderHTML(tableIR), /<svg[^>]* overflow="visible"/, 'icons still clip to their viewBox');

let zeroSized = 0;
for (const frame of collectFrames(roots)) {
  (function walk(n) {
    if (n.asset?.kind === 'svg' && (n.box.w === 0 || n.box.h === 0)) zeroSized++;
    n.children?.forEach(walk);
  })(toIR(frame, message.blobs) ?? { children: [] });
}
assert.equal(zeroSized, 0, `${zeroSized} icons have a box that cannot render`);
assert.ok(!renderHTML(tableIR).includes('stroke:'), 'an outlined stroke was re-emitted as a CSS stroke');

const body = tableIR.children.find((c) => c.name === 'Rectangle 25');
assert.ok(body?.layout.rows?.length >= 10, `expected the table body to band into rows, got ${body?.layout.rows?.length}`);

const rowOf = (row) => row.split(' ').map((i) => body.children[Number(i)]);
assert.ok(body.layout.rows.every((r) => rowOf(r).every(Boolean)), 'a row index points past the children');
// every row mixes columns, and the first four are the cells a table needs
const first = rowOf(body.layout.rows[0]);
assert.ok(first.filter((n) => n.role === 'text').length >= 4, 'a table row came back without its cells');
assert.deepEqual(
  first.filter((n) => n.role === 'text').map((n) => n.box.x).slice(0, 4),
  [...first.filter((n) => n.role === 'text').map((n) => n.box.x).slice(0, 4)].sort((a, b) => a - b),
  'cells within a row are not left to right',
);
// bands themselves run down the page even though the children do not
const tops = body.layout.rows.map((r) => Math.min(...rowOf(r).map((n) => n.box.y)));
assert.deepEqual(tops, [...tops].sort((a, b) => a - b), 'rows are not top to bottom');
const shuffled = body.children.some((c, i) => i > 0 && c.box.y < body.children[i - 1].box.y - 1);
assert.ok(shuffled, 'this frame no longer exercises out-of-order children');
// the hint must stay a hint: it may not reorder or renest anything
// both sides were previously the same call on the same input. The control is an IR
// with the hint stripped: if `rows` ever reaches the renderer, these diverge.
const withoutRows = JSON.parse(JSON.stringify(tableIR), (k, v) => (k === 'rows' ? undefined : v));
assert.ok(JSON.stringify(tableIR).includes('"rows"'), 'nothing to strip — the control is vacuous');
assert.equal(renderHTML(tableIR), renderHTML(withoutRows), 'row hints changed the render');

// --- inferred flex has to reproduce the layout it replaces ---
// A flex container lays children out in tree order and puts every one of them on
// the cross axis the same way. Where the design does neither, calling it flex moves
// things: one node here had a child 1038px from where flex would place it.
for (const frame of collectFrames(roots)) {
  (function walk(n) {
    const l = n.layout;
    if (l?.mode === 'flex' && l.source === 'inferred') {
      const main = l.direction === 'row' ? 'x' : 'y';
      const cross = l.direction === 'row' ? 'y' : 'x';
      const size = l.direction === 'row' ? 'h' : 'w';
      const kids = n.children.filter((c) => c.role !== 'backdrop').map((c) => c.bounds ?? c.box);
      const mains = kids.map((b) => b[main]);
      assert.deepEqual(mains, [...mains].sort((a, b) => a - b), `${n.name}: flex would reorder its children`);
      const starts = kids.map((b) => b[cross]);
      const ends = kids.map((b) => b[cross] + b[size]);
      const centres = kids.map((b, i) => (starts[i] + ends[i]) / 2);
      const agree = (v) => Math.max(...v) - Math.min(...v) <= 1;
      assert.ok(
        agree(starts) || agree(ends) || agree(centres),
        `${n.name}: children share no cross-axis alignment, so align-items cannot place them`,
      );
    }
    n.children?.forEach(walk);
  })(toIR(frame, message.blobs) ?? { children: [] });
}

// --- row indices address the node's own children, everywhere ---
// Two callers used to hand rowBands different arrays — one pre-filtered, one not —
// so an index meant one child to the producer and another to whoever read it.
let rowNodes = 0;
for (const frame of collectFrames(roots)) {
  (function walk(n) {
    const rows = n.layout?.rows;
    if (rows) {
      rowNodes++;
      const listed = new Set();
      for (const row of rows) {
        const items = row.split(' ').map((i) => {
          const child = n.children[Number(i)];
          assert.ok(child, `${n.name}: row index ${i} is not a child`);
          listed.add(Number(i));
          return child.bounds ?? child.box;
        });
        // a band is one shared vertical interval, not a chain of pairwise overlaps
        if (items.length > 1) {
          const top = Math.max(...items.map((b) => b.y));
          const bottom = Math.min(...items.map((b) => b.y + b.h));
          assert.ok(top < bottom, `${n.name}: row members share no vertical interval`);
        }
        const xs = items.map((b) => b.x);
        assert.deepEqual(xs, [...xs].sort((a, b) => a - b), `${n.name}: row is not left to right`);
      }
      // every child that can sit in a row has to appear in one
      const missing = n.children.filter((c, i) => c.role !== 'backdrop' && c.box.h > 0 && !listed.has(i));
      assert.equal(missing.length, 0, `${n.name}: ${missing.length} children are in no row`);
    }
    n.children?.forEach(walk);
  })(toIR(frame, message.blobs) ?? { children: [] });
}
assert.ok(rowNodes > 20, `expected many banded nodes, got ${rowNodes}`);

// --- a group is not a frame, and does not clip ---
// A Figma GROUP is stored as a FRAME carrying resizeToFit, and it sizes itself to its
// contents rather than cropping them. Clipping one cuts off everything a child paints
// outside its own box: the My Page tool buttons are a circle with a 3px OUTSIDE white
// stroke, wrapped in a group exactly the circle's size, and the ring lost its right
// edge to the group's overflow.
const myPage = collectFrames(roots).find((f) => f.name === '온라인학습_My Page');
const myPageIR = toIR(myPage, message.blobs);
const ringAncestors = [];
assert.ok(
  (function find(n, chain) {
    if (n.name === 'Ellipse 56') { ringAncestors.push(...chain); return true; }
    return (n.children ?? []).some((c) => find(c, [...chain, n]));
  })(myPageIR, []),
  'the ringed tool button is gone — pick another case',
);
const clippingGroups = ringAncestors.filter((n) => n.style?.clip && /^Group /.test(n.name));
assert.equal(
  clippingGroups.map((n) => n.name).join(', '),
  '',
  'a group clipped its children, cropping whatever they paint outside their own box',
);

// --- gradients are tokens too ---
const archiveTokens = extractTokens(nestedIR);
const gradients = archiveTokens.colors.filter((c) => c.name.startsWith('--gradient'));
assert.ok(gradients.length >= 2, `expected the nav tab gradients as tokens, found ${gradients.length}`);
assert.ok(gradients.every((g) => g.value.includes('gradient(')), 'a non-gradient landed in the gradient group');
// url(#…) points into one icon's own <defs> and means nothing as a token
assert.ok(!archiveTokens.css.includes('url('), 'an SVG paint reference leaked into the token sheet');

// The sheet is meant to be pasted. Every value has to be a value, and every font
// needs something to fall back to — a border shorthand split on its own spaces used
// to yield `--border-transparency: 0.2);`, and a webfont with no generic family
// renders the whole page in the browser's default serif.
let malformed = 0;
let missingFallback = 0;
for (const frame of collectFrames(roots)) {
  const ir = toIR(frame, message.blobs);
  if (!ir) continue;
  const t = extractTokens(ir);
  malformed += t.colors.filter((c) => !/^(#|rgba\(|linear-gradient|radial-gradient)/.test(c.value)).length;
  if (t.text.length && !/sans-serif/.test(t.css)) missingFallback++;
}
assert.equal(malformed, 0, `${malformed} token values are not CSS values`);
assert.equal(missingFallback, 0, `${missingFallback} frames emit a font token with no fallback`);

// --- masks, blend modes, inner shadow ---
const archiveFlat = [];
(function walk(n) { archiveFlat.push(n); n.children?.forEach(walk); })(archiveIR);
// every frame clips now, so pick the one whose clipping came from a folded mask
const clipped = archiveFlat.find((n) => n.name === 'Mask group' && n.style?.clip);
assert.ok(clipped, 'mask was not folded into a clipping parent');
assert.ok(clipped.style.radius, 'clipping parent lost the mask radius');
// the consumed mask filled its parent exactly; no child should still do that
assert.ok(
  clipped.children.every((c) => !(c.box.x === 0 && c.box.y === 0 && c.box.w === clipped.box.w && c.box.h === clipped.box.h)),
  'mask shape is still being drawn as ink inside the clip',
);
assert.match(renderHTML(archiveIR), /overflow: hidden/, 'clip never reached the CSS');

// Figma's "clip content" is frameMaskDisabled inverted, and it decides whether a
// child that sticks out is drawn or cut. Only real containers clip — a group has no
// box of its own — and a frame that has clipping turned off must not.
let clipping = 0;
let wrongly = 0;
let groupsClipping = 0;
for (const frame of collectFrames(roots)) {
  const raw = new Map();
  (function walk(n) { raw.set(n.id, n); n.children?.forEach(walk); })(frame);
  (function walk(n) {
    const source = raw.get(n.id);
    if (n.style?.clip) {
      clipping++;
      if (source && source.frameMaskDisabled === true) wrongly++;
      // a group holding a folded mask clips for that reason, not for being a container
      const folded = (source?.children ?? []).some((c) => c.mask && c.visible !== false);
      if (source && source.resizeToFit === true && !folded) groupsClipping++;
    }
    n.children?.forEach(walk);
  })(toIR(frame, message.blobs) ?? { children: [] });
}
// this file is 13 frames and 521 groups, so a count in the hundreds means the groups
// are being clipped too — which is what it used to say before groups were told apart
assert.ok(clipping > 10 && clipping < 40, `${clipping} containers clip their contents`);
assert.equal(wrongly, 0, `${wrongly} containers clip although the design says not to`);
assert.equal(groupsClipping, 0, `${groupsClipping} groups clip, and a group has no box of its own to clip against`);

const blended = flat.find((n) => n.style?.blend);
assert.equal(blended?.style.blend, 'darken', 'blend mode dropped');
assert.match(flat.find((n) => n.style?.shadow?.includes('inset'))?.style.shadow, /^inset /, 'inner shadow lost its inset');

// --- HTML ---
const html = renderHTML(ir);
assert.ok(html.includes('<svg'), 'no inline svg');
// the root is a flex item; without this it shrinks below its declared width and
// the absolutely-positioned children stay put, tearing the design apart
assert.match(html, /body > \* \{ flex-shrink: 0; \}/, 'the root frame can be shrunk by a narrow viewport');
assert.ok(html.includes('로그인'), 'text content lost');
assert.equal((html.match(/position: absolute;\n  position: relative;/g) ?? []).length, 0, 'conflicting position rules');
// A class starting with a digit is not a valid CSS identifier: the rule is parsed
// away and every declaration for that node silently disappears. A class emitted
// twice is worse — both nodes get whichever rule came last.
for (const frame of collectFrames(roots)) {
  const page = renderHTML(toIR(frame, message.blobs));
  const selectors = [...page.matchAll(/^\.([^\s{]+)/gm)].map((m) => m[1]);
  const bad = selectors.filter((c) => /^[0-9-]/.test(c));
  assert.equal(bad.length, 0, `invalid CSS class selectors in ${frame.name}: ${bad.slice(0, 3)}`);
  const counts = new Map();
  for (const c of selectors) counts.set(c, (counts.get(c) ?? 0) + 1);
  const repeated = [...counts].filter(([, n]) => n > 1).map(([c]) => c);
  assert.equal(repeated.length, 0, `class selectors emitted twice in ${frame.name}: ${repeated.slice(0, 3)}`);
}

const openDivs = (html.match(/<div/g) ?? []).length;
assert.equal(openDivs, (html.match(/<\/div>/g) ?? []).length, 'unbalanced divs');

console.log(`ok — fig v${version}, ${message.nodeChanges.length} nodes, IR ${flat.length} nodes ` +
  `(${byRole('text').length} text, ${byRole('image').length} image, ${byRole('icon').length} icon), ${html.length} B html`);
