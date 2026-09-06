import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { parseFigFile, buildTree } from './parse.mjs';
import { toIR, symbolIndex } from './ir.mjs';
import { renderHTML } from './html.mjs';

// The other sample has no components and no auto-layout, so these paths need
// a design-system file to be checked against at all.
const SAMPLE = 'samples/matsq.fig';
if (!existsSync(SAMPLE)) {
  console.log(`skip — ${SAMPLE} not present`);
  process.exit(0);
}

const { message } = parseFigFile(SAMPLE);
const roots = buildTree(message.nodeChanges);
const symbols = symbolIndex(roots);
assert.ok(symbols.size > 100, `expected many symbol masters, found ${symbols.size}`);

const canvases = [];
(function collect(list) {
  for (const n of list) (n.type === 'CANVAS' ? canvases.push(n) : collect(n.children ?? []));
})(roots);

// frames also live inside sections; missing those hid nearly half this file
const frames = [];
(function collectFrames(list) {
  for (const n of list) {
    if (n.type === 'FRAME') frames.push(n);
    else if (n.type === 'SECTION') collectFrames(n.children ?? []);
  }
})(canvases.flatMap((c) => c.children));
const topLevel = canvases.flatMap((c) => c.children.filter((n) => n.type === 'FRAME'));
assert.ok(frames.length > topLevel.length, 'section traversal found nothing extra');

const tag = frames.find((f) => f.name === 'Tag-solid');
const bare = toIR(tag, message.blobs);
const full = toIR(tag, message.blobs, { symbols });

// --- instances resolve against their master ---
const flatten = (ir) => { const out = []; (function w(n) { out.push(n); n.children?.forEach(w); })(ir); return out; };
const components = flatten(full).filter((n) => n.component);
assert.ok(components.length >= 10, `expected instances to expand, found ${components.length}`);
assert.ok(components.every((c) => c.component.instanceOf), 'component hint does not name its master');
assert.equal(flatten(bare).filter((n) => n.component).length, 0, 'components appeared without a symbol index');

// an instance of an icon master must arrive with real geometry, not an empty box
const icon = components.find((c) => c.role === 'icon');
assert.ok(icon?.asset.paths.length, 'expanded instance produced no drawable content');
assert.ok(renderHTML(full).includes('<svg'), 'expanded instance never reached the HTML');

// --- auto-layout ---
const auto = flatten(full).filter((n) => n.layout?.source === 'auto-layout');
assert.ok(auto.length > 10, `expected auto-layout frames, found ${auto.length}`);
assert.ok(auto.every((n) => n.layout.direction === 'row' || n.layout.direction === 'column'));
// per-side padding: horizontal/vertical are left/top only, right and bottom are separate fields
assert.ok(auto.some((n) => n.layout.padding.r !== n.layout.padding.l || n.layout.padding.t !== n.layout.padding.b)
  || auto.some((n) => n.layout.justify || n.layout.align), 'no auto-layout alignment or padding was read');

const notification = frames.find((f) => f.name === 'Notification');
const notifCss = renderHTML(toIR(notification, message.blobs, { symbols }));
assert.match(notifCss, /display: flex/, 'auto-layout never reached the CSS');

console.log(`ok — ${symbols.size} masters, ${frames.length} frames (${frames.length - topLevel.length} inside sections), ` +
  `${components.length} instances expanded in Tag-solid, ${auto.length} auto-layout frames`);
