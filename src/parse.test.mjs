import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { parseFigFile, buildTree, decodePathBlob } from './parse.mjs';
import { toIR } from './ir.mjs';
import { renderHTML } from './html.mjs';

const SAMPLE = 'samples/kyowon-full.fig';
if (!existsSync(SAMPLE)) {
  console.log(`skip — ${SAMPLE} not present`);
  process.exit(0);
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
assert.equal(parts[0].cmd, 'M', 'path must open with a moveTo');
assert.ok(parts.every((p) => 'MLQCZ'.includes(p.cmd)));

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
// paths live in the cluster's own space, so they must fill its viewBox rather than
// hide in a corner — the failure mode when path coords get scaled by normalizedSize
const extent = icon.asset.paths.flatMap((p) => {
  const [ox = 0, oy = 0] = (p.transform?.match(/-?[\d.]+/g) ?? []).map(Number);
  const nums = p.d.match(/-?[\d.]+/g).map(Number);
  return nums.map((v, i) => (i % 2 ? v + oy : v + ox));
});
const reach = Math.max(...extent);
const span = Math.max(icon.box.w, icon.box.h);
assert.ok(reach <= span + 1, `icon paths escape their viewBox (${reach} > ${span})`);
assert.ok(reach > span * 0.5, `icon paths collapsed into a corner (${reach} of ${span})`);

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

// --- masks, blend modes, inner shadow ---
const archiveFlat = [];
(function walk(n) { archiveFlat.push(n); n.children?.forEach(walk); })(archiveIR);
const clipped = archiveFlat.find((n) => n.style?.clip);
assert.ok(clipped, 'mask was not folded into a clipping parent');
assert.ok(clipped.style.radius, 'clipping parent lost the mask radius');
// the consumed mask filled its parent exactly; no child should still do that
assert.ok(
  clipped.children.every((c) => !(c.box.x === 0 && c.box.y === 0 && c.box.w === clipped.box.w && c.box.h === clipped.box.h)),
  'mask shape is still being drawn as ink inside the clip',
);
assert.match(renderHTML(archiveIR), /overflow: hidden/, 'clip never reached the CSS');

const blended = flat.find((n) => n.style?.blend);
assert.equal(blended?.style.blend, 'darken', 'blend mode dropped');
assert.match(flat.find((n) => n.style?.shadow?.includes('inset'))?.style.shadow, /^inset /, 'inner shadow lost its inset');

// --- HTML ---
const html = renderHTML(ir);
assert.ok(html.includes('<svg'), 'no inline svg');
assert.ok(html.includes('로그인'), 'text content lost');
assert.equal((html.match(/position: absolute;\n  position: relative;/g) ?? []).length, 0, 'conflicting position rules');
const openDivs = (html.match(/<div/g) ?? []).length;
assert.equal(openDivs, (html.match(/<\/div>/g) ?? []).length, 'unbalanced divs');

console.log(`ok — fig v${version}, ${message.nodeChanges.length} nodes, IR ${flat.length} nodes ` +
  `(${byRole('text').length} text, ${byRole('image').length} image, ${byRole('icon').length} icon), ${html.length} B html`);
