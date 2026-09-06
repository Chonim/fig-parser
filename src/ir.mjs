import { decodePathBlob, pathToSvg, hashHex } from './parse.mjs';

/**
 * IR node — the shape handed to the renderer and to the MCP layer.
 *
 * {
 *   id, name,
 *   role:   'frame' | 'text' | 'image' | 'icon' | 'shape',
 *   box:    { x, y, w, h }            // relative to parent
 *   layout: { mode: 'flex', direction, gap, padding, align }  |  { mode: 'absolute' }
 *   style:  { fill, radius, border, shadow, opacity }
 *   text:   { content, family, size, weight, lineHeight, letterSpacing, color, align }
 *   asset:  { kind: 'image', hash } | { kind: 'svg', viewBox, paths: [{ d, fill }] }
 *   children: IRNode[]
 * }
 */

const VECTOR_TYPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'LINE', 'STAR', 'REGULAR_POLYGON']);
const WEIGHTS = { Thin: 100, ExtraLight: 200, Light: 300, Regular: 400, Medium: 500, SemiBold: 600, Bold: 700, ExtraBold: 800, Black: 900 };

const round = (v) => Math.round(v * 100) / 100;
const chan = (v) => Math.round(v * 255);

function cssColor(color, opacity = 1) {
  const a = round((color.a ?? 1) * opacity);
  return a >= 1 ? `#${[color.r, color.g, color.b].map((c) => chan(c).toString(16).padStart(2, '0')).join('')}`
                : `rgba(${chan(color.r)}, ${chan(color.g)}, ${chan(color.b)}, ${a})`;
}

function solidFill(node) {
  const paint = node.fillPaints?.find((p) => p.visible !== false && p.type === 'SOLID');
  return paint && cssColor(paint.color, paint.opacity ?? 1);
}

const stopList = (paint) =>
  (paint.stops ?? [])
    .map((s) => `${cssColor(s.color, paint.opacity ?? 1)} ${round(s.position * 100)}%`)
    .join(', ');

/**
 * Figma stores a gradient as the affine transform taking the shape's unit square into
 * gradient space, where the ramp runs (0,0)->(1,0). Invert it to get the ramp back in
 * shape space, then express that direction as a CSS angle (0deg = up, clockwise).
 */
function linearGradient(paint, size) {
  const m = paint.transform;
  if (!m) return `linear-gradient(180deg, ${stopList(paint)})`;
  const det = m.m00 * m.m11 - m.m01 * m.m10;
  if (!det) return `linear-gradient(180deg, ${stopList(paint)})`;
  const inv = (x, y) => ({
    x: (m.m11 * (x - m.m02) - m.m01 * (y - m.m12)) / det,
    y: (-m.m10 * (x - m.m02) + m.m00 * (y - m.m12)) / det,
  });
  const a = inv(0, 0);
  const b = inv(1, 0);
  const dx = (b.x - a.x) * (size?.x ?? 1);
  const dy = (b.y - a.y) * (size?.y ?? 1);
  const deg = round((Math.atan2(dx, -dy) * 180) / Math.PI);
  return `linear-gradient(${deg}deg, ${stopList(paint)})`;
}

/** any visible fill as a CSS background value: solid, linear gradient, or a radial approximation */
function fillOf(node) {
  const paint = node.fillPaints?.find((p) => p.visible !== false && p.type !== 'IMAGE');
  if (!paint) return undefined;
  if (paint.type === 'SOLID') return cssColor(paint.color, paint.opacity ?? 1);
  if (paint.type === 'GRADIENT_LINEAR') return linearGradient(paint, node.size);
  if (paint.type?.startsWith('GRADIENT')) return `radial-gradient(circle, ${stopList(paint)})`;
  return undefined;
}

function imageFill(node) {
  const paint = node.fillPaints?.find((p) => p.visible !== false && p.type === 'IMAGE' && p.image?.hash);
  return paint && { hash: hashHex(paint.image.hash), scaleMode: paint.imageScaleMode ?? 'FILL' };
}

function border(node) {
  const paint = node.strokePaints?.find((p) => p.visible !== false && p.type === 'SOLID');
  if (!paint) return undefined;
  return `${round(node.strokeWeight ?? 1)}px solid ${cssColor(paint.color, paint.opacity ?? 1)}`;
}

function shadow(node) {
  const effects = (node.effects ?? []).filter((e) => e.visible !== false && e.type === 'DROP_SHADOW');
  if (!effects.length) return undefined;
  return effects
    .map((e) => `${round(e.offset?.x ?? 0)}px ${round(e.offset?.y ?? 0)}px ${round(e.radius ?? 0)}px ${cssColor(e.color ?? { r: 0, g: 0, b: 0, a: 0.25 })}`)
    .join(', ');
}

function radius(node) {
  if (node.type === 'ELLIPSE') return '50%';
  if (node.rectangleCornerRadiiIndependent) {
    const r = [node.rectangleTopLeftCornerRadius, node.rectangleTopRightCornerRadius, node.rectangleBottomRightCornerRadius, node.rectangleBottomLeftCornerRadius];
    return r.map((v) => `${round(v ?? 0)}px`).join(' ');
  }
  return node.cornerRadius ? `${round(node.cornerRadius)}px` : undefined;
}

function textStyle(node) {
  const lh = node.lineHeight;
  // PERCENT/RAW are both relative to font size; PIXELS is absolute.
  const lineHeight = !lh ? undefined
    : lh.units === 'PIXELS' ? `${round(lh.value)}px`
    : lh.units === 'PERCENT' ? round(lh.value / 100)
    : round(lh.value);
  const ls = node.letterSpacing;
  return {
    content: node.textData.characters,
    family: node.fontName?.family,
    size: round(node.fontSize ?? 16),
    weight: WEIGHTS[node.fontName?.style?.replace(/\s|Italic/g, '')] ?? 400,
    italic: /Italic/.test(node.fontName?.style ?? '') || undefined,
    lineHeight,
    letterSpacing: ls?.value ? (ls.units === 'PERCENT' ? `${round(ls.value / 100)}em` : `${round(ls.value)}px`) : undefined,
    color: solidFill(node) ?? '#000000',
    align: (node.textAlignHorizontal ?? 'LEFT').toLowerCase(),
  };
}

/** every leaf under `node` is vector-ish -> collapse the whole subtree into one SVG */
function isIconCluster(node) {
  if (node.type === 'TEXT' || node.textData) return false;
  if (VECTOR_TYPES.has(node.type)) return true;
  if (!node.children?.length) return false;
  return node.children.every(isIconCluster);
}

const strokeColor = (node) => {
  const paint = node.strokePaints?.find((p) => p.visible !== false && p.type === 'SOLID');
  return paint && cssColor(paint.color, paint.opacity ?? 1);
};

function collectPaths(node, blobs, dx, dy, out) {
  const x = dx + (node.transform?.m02 ?? 0);
  const y = dy + (node.transform?.m12 ?? 0);
  const transform = x || y ? `translate(${round(x)} ${round(y)})` : undefined;

  // Figma stores strokes already outlined into fillable regions, so both geometries
  // are painted the same way — only the paint they take differs.
  const geometries = [
    // no paint at all -> the shape is a bounds/mask helper, not ink
    [node.fillGeometry, solidFill(node) ?? (node.fillPaints?.some((f) => f.visible !== false) ? 'currentColor' : 'none')],
    [node.strokeGeometry, strokeColor(node) ?? 'none'],
  ];

  for (const [list, fill] of geometries) {
    if (fill === 'none') continue;
    for (const geom of list ?? []) {
      const blob = blobs[geom.commandsBlob];
      if (!blob) continue;
      try {
        out.push({
          d: pathToSvg(decodePathBlob(blob.bytes)),
          fill,
          transform,
          rule: geom.windingRule === 'ODD' ? 'evenodd' : undefined,
        });
      } catch {
        // vector-network-only shape, nothing renderable here — skip it
      }
    }
  }
  for (const child of node.children ?? []) collectPaths(child, blobs, x, y, out);
}

/**
 * Full-bleed children of the frame itself are page backdrops. Deeper down the same
 * shape is just a card's fill rect, so the rule only applies at the top level.
 */
const isBackdrop = (child, parent) =>
  parent.size && child.box.w >= parent.size.x * 0.98 && child.box.h >= parent.size.y * 0.98;

const span = (a, b) => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));

/**
 * Figma files drawn without auto-layout carry no stackMode, so infer one:
 * children that tile cleanly along an axis with a consistent gap become flex.
 */
function inferLayout(node, kids) {
  if (node.stackMode === 'HORIZONTAL' || node.stackMode === 'VERTICAL') {
    return {
      mode: 'flex',
      direction: node.stackMode === 'HORIZONTAL' ? 'row' : 'column',
      gap: round(node.stackSpacing ?? 0),
      padding: { t: round(node.stackVerticalPadding ?? 0), r: round(node.stackHorizontalPadding ?? 0), b: round(node.stackVerticalPadding ?? 0), l: round(node.stackHorizontalPadding ?? 0) },
      source: 'auto-layout',
    };
  }
  const flow = kids.filter((k) => k.role !== 'backdrop');
  if (flow.length < 2) return { mode: 'absolute' };

  for (const [dir, main, cross] of [['row', 'x', 'y'], ['column', 'y', 'x']]) {
    const size = main === 'x' ? 'w' : 'h';
    const crossSize = main === 'x' ? 'h' : 'w';
    const sorted = [...flow].sort((a, b) => a.box[main] - b.box[main]);
    const overlapsCross = sorted.every((k) =>
      span([k.box[cross], k.box[cross] + k.box[crossSize]], [sorted[0].box[cross], sorted[0].box[cross] + sorted[0].box[crossSize]]) > 0);
    if (!overlapsCross) continue;
    const gaps = sorted.slice(1).map((k, i) => k.box[main] - (sorted[i].box[main] + sorted[i].box[size]));
    if (gaps.some((g) => g < -1)) continue; // overlapping along the main axis: not a stack
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    if (gaps.some((g) => Math.abs(g - avg) > 2)) continue; // irregular spacing: keep absolute
    const bounds = (k) => [k.box[cross], k.box[cross] + k.box[crossSize]];
    const starts = sorted.map((k) => bounds(k)[0]);
    const ends = sorted.map((k) => bounds(k)[1]);
    return {
      mode: 'flex',
      direction: dir,
      gap: round(Math.max(0, avg)),
      padding: {
        t: round(main === 'x' ? Math.min(...starts) : sorted[0].box.y),
        l: round(main === 'x' ? sorted[0].box.x : Math.min(...starts)),
        r: round(main === 'x' ? node.size.x - (sorted.at(-1).box.x + sorted.at(-1).box.w) : node.size.x - Math.max(...ends)),
        b: round(main === 'x' ? node.size.y - Math.max(...ends) : node.size.y - (sorted.at(-1).box.y + sorted.at(-1).box.h)),
      },
      align: Math.max(...ends) - Math.min(...starts) < 2 ? 'stretch' : 'flex-start',
      source: 'inferred',
    };
  }
  return { mode: 'absolute' };
}

export function toIR(node, blobs, isRoot = true) {
  const t = node.transform ?? {};
  const box = { x: round(t.m02 ?? 0), y: round(t.m12 ?? 0), w: round(node.size?.x ?? 0), h: round(node.size?.y ?? 0) };
  const base = { id: node.id, name: node.name, box };

  if (node.visible === false) return null;

  if (node.textData) {
    return { ...base, role: 'text', text: textStyle(node), style: { opacity: node.opacity ?? 1 }, children: [] };
  }

  if (isIconCluster(node)) {
    const paths = [];
    // paths are collected in the cluster's own coordinate space, so cancel its transform
    collectPaths(node, blobs, -(t.m02 ?? 0), -(t.m12 ?? 0), paths);
    if (!paths.length) return null;
    return { ...base, role: 'icon', asset: { kind: 'svg', viewBox: `0 0 ${box.w} ${box.h}`, paths }, style: { opacity: node.opacity ?? 1 }, children: [] };
  }

  const image = imageFill(node);
  const style = {
    fill: image ? undefined : fillOf(node),
    radius: radius(node),
    border: border(node),
    shadow: shadow(node),
    opacity: node.opacity ?? 1,
  };

  const kids = (node.children ?? []).map((c) => toIR(c, blobs, false)).filter(Boolean);
  if (isRoot) for (const k of kids) if (isBackdrop(k, node)) k.role = 'backdrop';

  if (image && !kids.length) {
    return { ...base, role: 'image', asset: { kind: 'image', ...image }, style, children: [] };
  }

  return { ...base, role: 'frame', style, asset: image ? { kind: 'image', ...image } : undefined, layout: inferLayout(node, kids), children: kids };
}

/** collect repeated colors and text styles from an IR tree as CSS custom properties */
export function extractTokens(ir) {
  const colors = new Map();
  const fonts = new Map();
  const bump = (map, key, value) => {
    const hit = map.get(key) ?? { ...value, count: 0 };
    hit.count++;
    map.set(key, hit);
  };

  (function walk(node) {
    if (node.style?.fill) bump(colors, node.style.fill, { value: node.style.fill, use: 'fill' });
    for (const p of node.asset?.paths ?? []) if (p.fill?.startsWith('#')) bump(colors, p.fill, { value: p.fill, use: 'icon' });
    if (node.text) {
      bump(colors, node.text.color, { value: node.text.color, use: 'text' });
      const key = `${node.text.family}-${node.text.weight}-${node.text.size}`;
      bump(fonts, key, { family: node.text.family, weight: node.text.weight, size: node.text.size, lineHeight: node.text.lineHeight });
    }
    node.children?.forEach(walk);
  })(ir);

  const byUse = [...colors.values()].sort((a, b) => b.count - a.count);
  const css = [
    ':root {',
    ...byUse.map((c, i) => `  --color-${i + 1}: ${c.value}; /* ${c.use}, ${c.count}x */`),
    ...[...fonts.values()]
      .sort((a, b) => b.count - a.count)
      .map((f, i) => `  --text-${i + 1}: ${f.weight} ${f.size}px${f.lineHeight ? `/${f.lineHeight}` : ''} "${f.family}"; /* ${f.count}x */`),
    '}',
  ].join('\n');

  return { colors: byUse, text: [...fonts.values()], css };
}
