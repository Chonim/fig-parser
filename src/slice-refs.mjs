#!/usr/bin/env node
/**
 * Cut one canvas-wide Figma export into a reference per frame.
 *
 * Exporting 12 frames one at a time is tedious, and Figma will happily export the whole
 * page as a single PNG. The frames' own canvas coordinates say where each one sits in
 * that sheet, so this slices them out into the names `pnpm diff` looks for.
 *
 *   node src/slice-refs.mjs Export@1x.png [file.fig]
 *
 * The scale comes from the sheet: a page exported at 1x and one at 2x both work, and a
 * scale that is not a whole number means the export is not the page.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { parseFigFile, buildTree, collectFrames } from './parse.mjs';
import { PRODUCT, requireSamples } from './samples.mjs';

export function sliceRefs(sheetPath, sample, outDir) {
  const sheet = PNG.sync.read(readFileSync(sheetPath));
  const { message } = parseFigFile(sample);
  const frames = collectFrames(buildTree(message.nodeChanges));
  if (!frames.length) throw new Error(`${sample} has no frames`);

  const originX = Math.min(...frames.map((f) => f.transform.m02));
  const originY = Math.min(...frames.map((f) => f.transform.m12));
  const spanX = Math.max(...frames.map((f) => f.transform.m02 + f.size.x)) - originX;
  const scale = sheet.width / spanX;
  if (Math.abs(scale - Math.round(scale)) > 0.01) {
    throw new Error(`the sheet is ${sheet.width}px across a ${spanX.toFixed(1)}px page — ${scale.toFixed(3)}x is not a whole scale`);
  }

  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const f of frames) {
    const x = Math.round((f.transform.m02 - originX) * scale);
    const y = Math.round((f.transform.m12 - originY) * scale);
    const w = Math.round(f.size.x * scale);
    const h = Math.round(f.size.y * scale);
    if (x < 0 || y < 0 || x + w > sheet.width || y + h > sheet.height) {
      throw new Error(`${f.id} falls outside the sheet at ${x},${y} ${w}×${h}`);
    }
    const out = new PNG({ width: w, height: h });
    PNG.bitblt(sheet, out, x, y, w, h, 0, 0);
    const name = `${f.id.replace(/:/g, '-')}.png`;
    writeFileSync(join(outDir, name), PNG.sync.write(out));
    written.push({ name, w, h, x, y, frame: f.name || f.id });
  }
  return { scale, written };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [sheet, sample = PRODUCT] = process.argv.slice(2);
  // the sample check comes first so that a missing sample skips rather than complaining
  // about arguments — src/docs.test.mjs runs every command bare against an empty directory
  requireSamples(sample);
  if (!sheet) {
    console.error('usage: node src/slice-refs.mjs <page export.png> [file.fig]');
    process.exit(1);
  }
  const outDir = join('refs', sample.split('/').pop().replace(/\.fig$/, ''));
  const { scale, written } = sliceRefs(sheet, sample, outDir);
  console.log(`${sheet} → ${outDir}/  at ${Math.round(scale)}x`);
  for (const w of written) console.log(`  ${w.name.padEnd(16)} ${w.w}×${w.h}  ${w.frame}`);
}
