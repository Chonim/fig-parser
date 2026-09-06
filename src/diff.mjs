#!/usr/bin/env node
/**
 * Pixel comparison against what Figma itself draws.
 *
 * Everything else in this repo checks the render against invariants, a browser sweep
 * or someone's eye, and all three have missed defects a person later found by zooming
 * in. A reference image is the only check that does not share their blind spot.
 *
 *   pnpm diff [file.fig]           compare every frame that has a reference
 *
 * References live at refs/<sample>/<frameId>.png, exported from Figma at 2x, with the
 * frame id's colon written as a dash: refs/kyowon-full/2063-280.png. A frame without
 * one is skipped and counted; with none at all the command skips entirely, and CI=1
 * turns that skip into a failure, since a skip and a pass look identical to anything
 * reading the exit code.
 *
 * Fonts matter: the render links its faces from Google Fonts and jsdelivr, so a machine
 * offline substitutes a fallback and every glyph becomes a difference that says nothing
 * about this code. The run probes whether they actually applied and says so, rather than
 * letting the number look like a finding.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { parseFigFile, buildTree, collectFrames } from './parse.mjs';
import { BOTH, requireSamples } from './samples.mjs';
import { toIR, symbolIndex, variableIndex } from './ir.mjs';
import { renderHTML } from './html.mjs';

// The reference decides the scale: a frame exported at 1x and one at 2x are both
// usable, but shooting at the wrong one only ever reports a size mismatch.
const DEFAULT_SCALE = 2;
// pixelmatch's own default. Named here because a threshold that drifts turns "the
// render changed" into "someone widened the tolerance".
const THRESHOLD = 0.1;

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p));

const refDir = (file) => join('refs', file.split('/').pop().replace(/\.fig$/, ''));
const refPath = (file, id) => join(refDir(file), `${id.replace(/:/g, '-')}.png`);

/**
 * Whether the webfonts the render links actually applied. They come from Google Fonts
 * and jsdelivr over the network, so a machine offline — or a screenshot taken before
 * they arrive — silently substitutes a fallback and every glyph becomes a difference
 * that says nothing about this code. Shooting the same frame with the links stripped
 * answers it: if that changes nothing, the fonts were never there.
 */
function webfontsApplied(html, w, h, dir, scale) {
  const linked = /<link rel="stylesheet"/.test(html);
  if (!linked) return { linked: false, applied: false };
  const withFonts = shoot(html, w, h, dir, scale);
  const without = shoot(html.replace(/<link rel="stylesheet"[^>]*>/g, ''), w, h, dir, scale);
  const out = new PNG({ width: withFonts.width, height: withFonts.height });
  const bad = pixelmatch(withFonts.data, without.data, out.data, withFonts.width, withFonts.height, { threshold: THRESHOLD });
  return { linked: true, applied: bad > 0 };
}

function shoot(html, w, h, dir, scale = DEFAULT_SCALE) {
  const page = join(dir, 'page.html');
  const shot = join(dir, 'shot.png');
  writeFileSync(page, html);
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
    // without this the screenshot is taken before the webfonts arrive and every
    // glyph is a fallback: removing the font links changed nothing until it was set
    '--virtual-time-budget=8000',
    `--screenshot=${shot}`, `--window-size=${Math.round(w)},${Math.round(h)}`,
    `--force-device-scale-factor=${scale}`, '--default-background-color=00000000',
    `file://${resolve(page)}`,
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  return PNG.sync.read(readFileSync(shot));
}

/** where the differing pixels are, so a number points at a place on the screen */
function bboxOf(diff, w, h, scale = DEFAULT_SCALE) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // pixelmatch paints differences red and leaves matches grey
      if (diff[i] > 200 && diff[i + 1] < 100) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: Math.round(x0 / scale), y: Math.round(y0 / scale), w: Math.round((x1 - x0 + 1) / scale), h: Math.round((y1 - y0 + 1) / scale) };
}

export function diffFile(file, { outDir = 'out/diff' } = {}) {
  if (!CHROME) throw new Error('no Chrome or Chromium found to render with');
  const { message, readImage } = parseFigFile(file);
  const roots = buildTree(message.nodeChanges);
  const frames = collectFrames(roots);
  const ctx = { symbols: symbolIndex(roots), variables: variableIndex(message.nodeChanges) };

  const work = mkdtempSync(join(tmpdir(), 'figdiff-'));
  mkdirSync(join(work, 'assets'), { recursive: true });
  mkdirSync(outDir, { recursive: true });
  const rows = [];
  let fonts = null;
  try {
    for (const frame of frames) {
      const ref = refPath(file, frame.id);
      if (!existsSync(ref)) { rows.push({ id: frame.id, name: frame.name, skipped: true }); continue; }
      const ir = toIR(frame, message.blobs, ctx);
      (function saveAssets(n) {
        if (n.asset?.kind === 'image') {
          try { writeFileSync(join(work, 'assets', `${n.asset.hash}.png`), readImage(n.asset.hash)); } catch { /* absent */ }
        }
        n.children?.forEach(saveAssets);
      })(ir);
      const html = renderHTML(ir);
      const want = PNG.sync.read(readFileSync(ref));
      const scale = Math.round(want.width / frame.size.x) || DEFAULT_SCALE;
      // one probe per file: it costs two more screenshots, not two per frame
      if (!fonts) fonts = webfontsApplied(html, frame.size.x, frame.size.y, work, scale);
      const shot = shoot(html, frame.size.x, frame.size.y, work, scale);
      const row = { id: frame.id, name: frame.name };
      if (shot.width !== want.width || shot.height !== want.height) {
        rows.push({ ...row, sizeMismatch: `${shot.width}×${shot.height} vs ${want.width}×${want.height}` });
        continue;
      }
      const out = new PNG({ width: shot.width, height: shot.height });
      const bad = pixelmatch(shot.data, want.data, out.data, shot.width, shot.height, { threshold: THRESHOLD });
      const total = shot.width * shot.height;
      if (bad > 0) writeFileSync(join(outDir, `${frame.id.replace(/:/g, '-')}.png`), PNG.sync.write(out));
      rows.push({ ...row, bad, pct: (bad / total) * 100, scale, bbox: bad ? bboxOf(out.data, shot.width, shot.height, scale) : null });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return { rows, fonts };
}

function report(file, rows, fonts) {
  const compared = rows.filter((r) => !r.skipped);
  console.log(`\n${file} — ${compared.length} compared, ${rows.length - compared.length} without a reference`);
  if (!compared.length) return 0;
  const w = Math.max(...compared.map((r) => (r.name || r.id).length), 5);
  console.log(`${'frame'.padEnd(w)}  ${'diff px'.padStart(9)}  ${'%'.padStart(6)}  where`);
  console.log(`${'-'.repeat(w)}  ${'-'.repeat(9)}  ${'-'.repeat(6)}  -----`);
  let worst = 0;
  for (const r of [...compared].sort((a, b) => (b.bad ?? 0) - (a.bad ?? 0))) {
    if (r.sizeMismatch) { console.log(`${(r.name || r.id).padEnd(w)}  ${'size'.padStart(9)}  ${''.padStart(6)}  ${r.sizeMismatch}`); continue; }
    worst = Math.max(worst, r.pct);
    const where = r.bbox ? `${r.bbox.w}×${r.bbox.h} at ${r.bbox.x},${r.bbox.y}` : 'identical';
    console.log(`${(r.name || r.id).padEnd(w)}  ${String(r.bad).padStart(9)}  ${r.pct.toFixed(3).padStart(6)}  ${where}`);
  }
  if (fonts && fonts.linked && !fonts.applied) {
    console.log('\n⚠ the linked webfonts did not apply — every glyph here is a fallback and the text pixels mean nothing.');
  }
  return worst;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2);
  const targets = files.length ? files : BOTH;
  requireSamples(targets);
  let compared = 0;
  for (const file of targets) {
    if (!existsSync(refDir(file))) { console.log(`skip — no references in ${refDir(file)}/`); continue; }
    const { rows, fonts } = diffFile(file);
    report(file, rows, fonts);
    compared += rows.filter((r) => !r.skipped).length;
  }
  if (!compared) {
    console.log('\nNothing compared. Export frames from Figma at 2x into refs/<sample>/<frameId>.png');
    process.exit(process.env.CI ? 1 : 0);
  }
}
