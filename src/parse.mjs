import { inflateRawSync } from 'node:zlib';
import { decompress as zstdDecompress } from 'fzstd';
import { decodeBinarySchema, compileSchema } from 'kiwi-schema';
import { execFileSync } from 'node:child_process';

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** canvas.fig (fig-kiwi archive) -> { version, schema, message } */
export function parseCanvasFig(buf) {
  if (buf.subarray(0, 8).toString() !== 'fig-kiwi') throw new Error('not a fig-kiwi archive');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = dv.getUint32(8, true);

  const chunks = [];
  for (let off = 12; off + 4 <= buf.length; ) {
    const size = dv.getUint32(off, true);
    off += 4;
    const raw = buf.subarray(off, off + size);
    off += size;
    // schema chunk is deflate-raw; message chunk switched to zstd around fig version ~100
    chunks.push(ZSTD_MAGIC.every((b, i) => raw[i] === b) ? Buffer.from(zstdDecompress(raw)) : inflateRawSync(raw));
  }

  const schema = decodeBinarySchema(chunks[0]);
  return { version, schema, message: compileSchema(schema).decodeMessage(chunks[1]) };
}

/** .fig (zip) -> parsed canvas + image lookup by hex hash */
export function parseFigFile(path) {
  const canvas = execFileSync('unzip', ['-p', path, 'canvas.fig'], { maxBuffer: 1 << 30 });
  const { version, message } = parseCanvasFig(canvas);
  const readImage = (hash) =>
    execFileSync('unzip', ['-p', path, `images/${typeof hash === 'string' ? hash : hashHex(hash)}`], { maxBuffer: 1 << 30 });
  return { version, message, readImage };
}

/** image paint hash is a byte map { "0": 186, ... } matching images/<hex> in the zip */
export const hashHex = (hash) =>
  Object.keys(hash)
    .map(Number)
    .sort((a, b) => a - b)
    .map((k) => hash[k].toString(16).padStart(2, '0'))
    .join('');

/**
 * nodeChanges is a FLAT list. Rebuild the tree:
 * guid = {sessionID, localID}; parentIndex = {guid, position} where position is a
 * fractional index string that sorts siblings lexicographically.
 */
export function buildTree(nodeChanges) {
  const key = (g) => `${g.sessionID}:${g.localID}`;
  const byId = new Map(nodeChanges.map((n) => [key(n.guid), { ...n, id: key(n.guid), children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    const parent = node.parentIndex && byId.get(key(node.parentIndex.guid));
    (parent ? parent.children : roots).push(node);
  }
  const sort = (list) => {
    list.sort((a, b) => (a.parentIndex?.position ?? '').localeCompare(b.parentIndex?.position ?? ''));
    list.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

/**
 * fillGeometry/strokeGeometry commandsBlob: u8 command + float32 args, packed.
 * 0=close(0) 1=moveTo(2) 2=lineTo(2) 3=quadTo(4) 4=cubicTo(6)
 * (vectorNetworkBlob is a different, unrelated format — not decoded here.)
 */
const PATH_ARGS = [0, 2, 2, 4, 6];
const PATH_LETTER = ['Z', 'M', 'L', 'Q', 'C'];

export function decodePathBlob(bytes) {
  const buf = Buffer.from(bytes);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const parts = [];
  for (let off = 0; off < buf.length; ) {
    const cmd = dv.getUint8(off++);
    const argc = PATH_ARGS[cmd];
    if (argc === undefined) throw new Error(`unknown path command ${cmd} at ${off - 1}`);
    const args = [];
    for (let i = 0; i < argc; i++, off += 4) args.push(dv.getFloat32(off, true));
    parts.push({ cmd: PATH_LETTER[cmd], args });
  }
  return parts;
}

/** decoded parts -> SVG `d`, scaled from the node's normalizedSize into its real size */
export function pathToSvg(parts, scaleX = 1, scaleY = 1) {
  const num = (v) => Math.round(v * 1000) / 1000;
  return parts
    .map(({ cmd, args }) => cmd + args.map((v, i) => num(v * (i % 2 ? scaleY : scaleX))).join(' '))
    .join('');
}
