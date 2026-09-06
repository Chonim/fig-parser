import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { parseFigFile, buildTree } from './parse.mjs';
import { toIR, symbolIndex, variableIndex, extractTokens, readVariables } from './ir.mjs';
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
