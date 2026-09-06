import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { parseFigFile, buildTree, collectFrames } from './parse.mjs';
import { toIR, symbolIndex, variableIndex, extractTokens, readVariables } from './ir.mjs';
import { renderHTML } from './html.mjs';

// The other sample has no components and no auto-layout, so these paths need
// a design-system file to be checked against at all.
const SAMPLE = 'samples/matsq.fig';
if (!existsSync(SAMPLE)) {
  // A skip and a pass are indistinguishable to anything reading the exit code, so
  // on CI an absent sample is a failure rather than a quiet green run.
  console.log(`skip — ${SAMPLE} not present`);
  process.exit(process.env.CI ? 1 : 0);
}

const { message } = parseFigFile(SAMPLE);
const roots = buildTree(message.nodeChanges);
const symbols = symbolIndex(roots);
assert.ok(symbols.size > 100, `expected many symbol masters, found ${symbols.size}`);

const canvases = [];
(function collect(list) {
  for (const n of list) (n.type === 'CANVAS' ? canvases.push(n) : collect(n.children ?? []));
})(roots);

// Frames also live inside sections, and missing those hid nearly half this file.
// The assertion has to run against the production collector — a copy of the
// traversal written here would only ever agree with itself.
const frames = collectFrames(roots);
const topLevel = canvases.flatMap((c) => c.children.filter((n) => n.type === 'FRAME'));
assert.ok(frames.length > topLevel.length + 40, `section traversal found ${frames.length - topLevel.length} extra frames`);
assert.ok(frames.every((f) => f.page), 'a frame came back without its page');

const tag = frames.find((f) => f.name === 'Tag-solid');
const bare = toIR(tag, message.blobs);
const variables = variableIndex(message.nodeChanges);
assert.ok(variables.size > 100, `expected design variables, found ${variables.size}`);
const full = toIR(tag, message.blobs, { symbols, variables });

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

// --- an instance keeps its own properties; the master only supplies content ---
// The expansion used to take the master wholesale and put back five fields, so an
// instance's own visibility, paints, radii, stack settings and stroke weights were
// all replaced by the master's.
const rawInstances = [];
(function walk(l) { for (const n of l) { if (n.type === 'INSTANCE') rawInstances.push(n); walk(n.children ?? []); } })(roots);
const hidden = rawInstances.filter((n) => n.visible === false);
assert.ok(hidden.length > 50, `expected hidden instances to test with, found ${hidden.length}`);

const survivors = new Set();
for (const f of frames) {
  const ir = toIR(f, message.blobs, { symbols, variables });
  if (!ir) continue;
  (function walk(n) { survivors.add(n.id); n.children?.forEach(walk); })(ir);
}
const rendered = hidden.filter((n) => survivors.has(n.id));
assert.equal(rendered.length, 0, `${rendered.length} hidden instances rendered, e.g. ${rendered[0]?.name}`);

// every own field an instance carries has to reach the expansion
const CONTENT = new Set(['type', 'children', 'symbolData', 'derivedSymbolData', 'symbolLinks']);
const tagIRFull = toIR(tag, message.blobs, { symbols, variables });
const byId = new Map();
(function walk(n) { byId.set(n.id, n); n.children?.forEach(walk); })(tagIRFull);
let checked = 0;
for (const inst of rawInstances) {
  const out = byId.get(inst.id);
  if (!out || out.role === 'icon') continue; // icon clusters collapse their properties away
  checked++;
  for (const k of ['visible', 'opacity', 'stackMode', 'stackChildPrimaryGrow']) {
    if (inst[k] === undefined) continue;
    assert.ok(out.__own === undefined || out.__own[k] === inst[k], `${inst.name}: ${k} lost in expansion`);
  }
}

// --- a hidden frame is still a frame when you ask for it by name ---
// toIR returned null for a hidden root and every caller dereferenced it, so any
// tool handed one of these crashed.
const hiddenFrames = [];
(function walk(l) { for (const n of l) { if (n.type === 'FRAME' && n.visible === false) hiddenFrames.push(n); walk(n.children ?? []); } })(roots);
assert.ok(hiddenFrames.length > 50, `expected hidden frames to test with, found ${hiddenFrames.length}`);
for (const hf of hiddenFrames.slice(0, 20)) {
  const ir = toIR(hf, message.blobs, { symbols, variables });
  assert.ok(ir, `${hf.name}: hidden frame converted to null`);
  assert.match(renderHTML(ir), /<html/, `${hf.name}: hidden frame did not render`);
}
// hidden children are still dropped from a visible parent
const visibleParent = hiddenFrames.map((h) => roots.flat()).length && frames.find((f) => f.name === 'Tag-solid');
const visibleIR = toIR(visibleParent, message.blobs, { symbols, variables });
const idsIn = new Set();
(function walk(n) { idsIn.add(n.id); n.children?.forEach(walk); })(visibleIR);
const hiddenInside = [];
(function walk(n) { if (n.visible === false) hiddenInside.push(n); n.children?.forEach(walk); })(visibleParent);
assert.ok(hiddenInside.every((n) => !idsIn.has(n.id)), 'a hidden child survived into a visible parent');

// --- auto-layout ---
const auto = flatten(full).filter((n) => n.layout?.source === 'auto-layout');
assert.ok(auto.length > 10, `expected auto-layout frames, found ${auto.length}`);
assert.ok(auto.every((n) => n.layout.direction === 'row' || n.layout.direction === 'column'));
// per-side padding: horizontal/vertical are left/top only, right and bottom are separate fields
assert.ok(auto.some((n) => n.layout.padding.r !== n.layout.padding.l || n.layout.padding.t !== n.layout.padding.b)
  || auto.some((n) => n.layout.justify || n.layout.align), 'no auto-layout alignment or padding was read');

// --- tokens carry the names their author gave them ---
const tokens = extractTokens(full);
const authored = tokens.colors.filter((c) => /^--(background|text|border|icon)-[a-z]/.test(c.name) && c.name.split('-').length > 3);
assert.ok(authored.length >= 5, `expected variable-named tokens, found ${authored.length}`);
assert.ok(tokens.css.includes('--background-brand-default'), 'a known design variable never surfaced');
// without the index the same colours fall back to usage-based names
assert.ok(!extractTokens(bare).css.includes('--background-brand-default'), 'token name appeared without the variable index');

// --- colour bindings reach strokes and icon paths, not just fills ---
const everyFrame = frames.map((f) => toIR(f, message.blobs, { symbols, variables })).filter(Boolean);
const allNodes = everyFrame.flatMap(flatten);
assert.ok(allNodes.some((n) => n.style?.borderToken), 'stroke colour bindings were not read');
assert.ok(allNodes.some((n) => n.asset?.paths?.some((p) => p.fillToken)), 'icon path colour bindings were not read');
// the literal colour still has to render; the token is extra information
const boundPath = allNodes.flatMap((n) => n.asset?.paths ?? []).find((p) => p.fillToken);
assert.match(boundPath.fill, /^(#|rgba|url\(#)/, 'a bound path lost its rendered colour');

// a hidden frame converts to null, and the token pass has to survive that
assert.doesNotThrow(() => extractTokens(null));

// --- a clip or group wrapper must not hide the shape it wraps ---
const repeats = allNodes.filter((n) => n.layout?.repeat);
assert.ok(repeats.length > 50, `expected repeated structures, found ${repeats.length}`);
const throughWrapper = repeats.find((n) =>
  n.children.some((c) => c.children?.length === 1 && !c.style?.fill && !c.style?.border));
assert.ok(throughWrapper, 'no repeat was found across a wrapped sibling');
assert.ok(throughWrapper.layout.repeat.count >= 3, 'repeat below its own threshold');

// --- ids stay unique once instances are expanded ---
// A copy of a master keeps the master's node ids, so three instances of the same
// component put three nodes with id 289:287 in one frame and selectNode silently
// answered with whichever came first.
let framesWithDuplicates = 0;
let duplicateIds = 0;
for (const f of frames) {
  const ir = toIR(f, message.blobs, { symbols, variables });
  if (!ir) continue;
  const counts = new Map();
  (function walk(n) { counts.set(n.id, (counts.get(n.id) ?? 0) + 1); n.children?.forEach(walk); })(ir);
  const repeats = [...counts.values()].filter((v) => v > 1).length;
  if (repeats) { framesWithDuplicates++; duplicateIds += repeats; }
}
assert.equal(duplicateIds, 0, `${duplicateIds} ids are ambiguous across ${framesWithDuplicates} frames`);

// --- tokens have to reach inside an expanded instance ---
// The recursive call rebuilt its options object and left `variables` out, so every
// node under a component came back with invented colour names instead of the
// author's, which is exactly what CLAUDE.md warns about.
let insideInstance = 0;
let tokenedInside = 0;
for (const f of frames) {
  const ir = toIR(f, message.blobs, { symbols, variables });
  if (!ir) continue;
  (function walk(n, within) {
    if (within) {
      insideInstance++;
      if (n.style?.fillToken || n.style?.borderToken || n.text?.colorToken) tokenedInside++;
    }
    n.children?.forEach((c) => walk(c, within || Boolean(n.component)));
  })(ir, false);
}
assert.ok(insideInstance > 300, `expected many nodes inside instances, found ${insideInstance}`);
assert.ok(tokenedInside > 100, `only ${tokenedInside} of ${insideInstance} nodes inside instances carry a token`);

// --- the variable catalogue: sets, modes, aliases ---
const catalogue = readVariables(message.nodeChanges);
assert.ok(catalogue.variables.length > 500, `expected a full variable catalogue, found ${catalogue.variables.length}`);
assert.ok(catalogue.sets.some((s) => s.modes.length > 1), 'no multi-mode set found');

const types = new Set(catalogue.variables.map((v) => v.type));
for (const t of ['COLOR', 'FLOAT', 'STRING']) assert.ok(types.has(t), `${t} variables were dropped`);

// lengths carry a unit, weights must not
assert.match(catalogue.css, /--radius-sm: \d+px;/, 'numeric length lost its unit');
assert.match(catalogue.css, /--font-weight-regular: 400;/, 'a unitless number was given px');
// a semantic variable pointing at a primitive stays a reference
assert.match(catalogue.css, /: var\(--[\w-]+\);/, 'aliases were flattened instead of referenced');
// extra modes get their own block rather than overwriting the base
const blocks = catalogue.css.split('\n\n');
assert.ok(blocks.length > 1 && blocks.slice(1).every((b) => b.startsWith('[data-')), 'mode blocks missing or malformed');
assert.ok(blocks.slice(1).some((b) => b.split('\n').length > 50), 'the dark mode block came back nearly empty');

const notification = frames.find((f) => f.name === 'Notification');
const notifCss = renderHTML(toIR(notification, message.blobs, { symbols, variables }));
assert.match(notifCss, /display: flex/, 'auto-layout never reached the CSS');

// --- fonts: this library is set in Inter and Lato, neither of which was ever linked ---
const hrefs = new Set();
for (const f of frames) {
  const html = renderHTML(toIR(f, message.blobs, { symbols, variables }));
  for (const m of html.matchAll(/href="([^"]+)"/g)) hrefs.add(m[1]);
}
const google = [...hrefs].filter((h) => h.includes('fonts.googleapis.com'));
assert.ok(google.length >= 3, `expected several font families to be linked, got ${google.length}`);
assert.ok(google.some((h) => h.includes('family=Inter')), 'Inter was never linked');
// Lato publishes no 600; a request naming only weights it lacks returns 400 and
// drops the whole family, so every request has to include 400 as a floor
assert.ok(google.every((h) => /wght@(400|400;)/.test(h)), 'a font request omitted weight 400');

console.log(`ok — ${symbols.size} masters, ${frames.length} frames (${frames.length - topLevel.length} inside sections), ` +
  `${components.length} instances expanded in Tag-solid, ${auto.length} auto-layout frames, ` +
  `${authored.length} tokens named from variables, ${catalogue.variables.length} variables in ${catalogue.sets.length} sets`);
