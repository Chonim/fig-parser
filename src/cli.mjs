#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFigFile, buildTree } from './parse.mjs';
import { toIR } from './ir.mjs';
import { renderHTML } from './html.mjs';

const [figPath, frameName, outDir = 'out'] = process.argv.slice(2);
if (!figPath) {
  console.error('usage: node src/cli.mjs <file.fig> [frameName] [outDir]');
  process.exit(1);
}

const { message, readImage } = parseFigFile(figPath);
const roots = buildTree(message.nodeChanges);
const frames = [];
(function collect(list) {
  for (const n of list) {
    if (n.type === 'CANVAS') frames.push(...n.children.filter((c) => c.type === 'FRAME'));
    else collect(n.children);
  }
})(roots);

if (!frameName) {
  for (const f of frames) console.log(`${f.id}\t${f.name}\t${Math.round(f.size.x)}x${Math.round(f.size.y)}`);
  process.exit(0);
}

const frame = frames.find((f) => f.name === frameName || f.id === frameName);
if (!frame) throw new Error(`frame not found: ${frameName}\navailable: ${frames.map((f) => f.name).join(', ')}`);

const ir = toIR({ ...frame, transform: { m02: 0, m12: 0 } }, message.blobs);
mkdirSync(join(outDir, 'assets'), { recursive: true });

const written = new Set();
(function saveAssets(node) {
  if (node.asset?.kind === 'image' && !written.has(node.asset.hash)) {
    written.add(node.asset.hash);
    try {
      writeFileSync(join(outDir, 'assets', `${node.asset.hash}.png`), readImage(node.asset.hash));
    } catch (e) {
      console.warn(`! asset ${node.asset.hash}: ${e.message}`);
    }
  }
  node.children?.forEach(saveAssets);
})(ir);

writeFileSync(join(outDir, 'ir.json'), JSON.stringify(ir, null, 2));
writeFileSync(join(outDir, 'index.html'), renderHTML(ir));
console.log(`${outDir}/index.html  (${written.size} assets, ${JSON.stringify(ir).length} B of IR)`);
