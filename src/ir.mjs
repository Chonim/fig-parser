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

/**
 * What this layer can express today. census.mjs reads these instead of keeping its
 * own copy, so the report cannot drift away from what the code actually does.
 * `approximated` means it renders, but not faithfully yet.
 */
export const HANDLED = {
  nodeTypes: new Set([...VECTOR_TYPES, 'DOCUMENT', 'CANVAS', 'SECTION', 'FRAME', 'GROUP', 'TEXT', 'RECTANGLE', 'ROUNDED_RECTANGLE', 'ELLIPSE', 'SYMBOL', 'INSTANCE']),
  fillPaints: { handled: new Set(['SOLID', 'GRADIENT_LINEAR', 'IMAGE']), approximated: new Set(['GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND']) },
  strokePaints: { handled: new Set(['SOLID', 'GRADIENT_LINEAR']), approximated: new Set(['GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND']) },
  effects: { handled: new Set(['DROP_SHADOW', 'INNER_SHADOW']), approximated: new Set() },
  blendModes: new Set(['NORMAL', 'PASS_THROUGH']),
  imageScaleModes: new Set(['FILL', 'FIT', 'STRETCH', 'TILE']),
};
const WEIGHTS = { Thin: 100, ExtraLight: 200, Light: 300, Regular: 400, Medium: 500, SemiBold: 600, Bold: 700, ExtraBold: 800, Black: 900 };

const round = (v) => Math.round(v * 100) / 100;

// Figma transforms are 2x3 affine: [m00 m01 m02 / m10 m11 m12].
const IDENTITY = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
// matrices arrive as float32, so an unrotated node reads as 0.99999994 rather than 1
const EPS = 1e-5;
const isIdentity = (m) =>
  !m || (Math.abs(m.m00 - 1) < EPS && Math.abs(m.m01) < EPS && Math.abs(m.m10) < EPS && Math.abs(m.m11 - 1) < EPS);

const matMul = (a, b) => ({
  m00: a.m00 * b.m00 + a.m01 * b.m10,
  m01: a.m00 * b.m01 + a.m01 * b.m11,
  m02: a.m00 * b.m02 + a.m01 * b.m12 + a.m02,
  m10: a.m10 * b.m00 + a.m11 * b.m10,
  m11: a.m10 * b.m01 + a.m11 * b.m11,
  m12: a.m10 * b.m02 + a.m11 * b.m12 + a.m12,
});

const matInv = (m) => {
  const det = m.m00 * m.m11 - m.m01 * m.m10;
  if (!det) return { ...IDENTITY };
  return {
    m00: m.m11 / det,
    m01: -m.m01 / det,
    m02: (m.m01 * m.m12 - m.m11 * m.m02) / det,
    m10: -m.m10 / det,
    m11: m.m00 / det,
    m12: (m.m10 * m.m02 - m.m00 * m.m12) / det,
  };
};

const num = (v) => Math.round(v * 10000) / 10000;

/**
 * A plain rotation is by far the common case and reads far better as an angle than
 * as four matrix cells, so name it when the matrix is one; fall back to the matrix
 * for skew, scale and flips.
 */
function transformCss(m) {
  if (isIdentity(m)) return undefined;
  const isRotation = Math.abs(m.m00 - m.m11) < 1e-6 && Math.abs(m.m01 + m.m10) < 1e-6
    && Math.abs(m.m00 * m.m00 + m.m01 * m.m01 - 1) < 1e-6;
  if (isRotation) return `rotate(${round((Math.atan2(m.m10, m.m00) * 180) / Math.PI)}deg)`;
  return `matrix(${[m.m00, m.m10, m.m01, m.m11, 0, 0].map(num).join(', ')})`;
}

/** axis-aligned bounds of a box once its own transform is applied, for layout inference */
function transformedBounds(box, m) {
  if (isIdentity(m)) return box;
  const corners = [[0, 0], [box.w, 0], [box.w, box.h], [0, box.h]].map(([x, y]) => ({
    x: box.x + m.m00 * x + m.m01 * y,
    y: box.y + m.m10 * x + m.m11 * y,
  }));
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}
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

/** one paint as a CSS value: solid colour, linear gradient, or a radial approximation */
function paintCss(paint, size) {
  if (paint.type === 'SOLID') return cssColor(paint.color, paint.opacity ?? 1);
  if (paint.type === 'GRADIENT_LINEAR') return linearGradient(paint, size);
  if (paint.type?.startsWith('GRADIENT')) return `radial-gradient(circle, ${stopList(paint)})`;
  return undefined;
}

const fillOf = (node) => {
  const paint = node.fillPaints?.find((p) => p.visible !== false && p.type !== 'IMAGE');
  return paint && paintCss(paint, node.size);
};

function imageFill(node) {
  const paint = node.fillPaints?.find((p) => p.visible !== false && p.type === 'IMAGE' && p.image?.hash);
  return paint && { hash: hashHex(paint.image.hash), scaleMode: paint.imageScaleMode ?? 'FILL' };
}

function border(node) {
  const paint = node.strokePaints?.find((p) => p.visible !== false);
  if (!paint) return undefined;
  const width = round(node.strokeWeight ?? 1);
  if (paint.type === 'SOLID') return { css: `${width}px solid ${cssColor(paint.color, paint.opacity ?? 1)}` };
  // a gradient cannot go in `border`, so the renderer paints it as a border-box
  // background layer under a transparent border — which keeps border-radius working
  const image = paintCss(paint, node.size);
  return image && { width, image };
}

/** wrap a solid colour so it can sit in `background` next to real gradient layers */
export const asImageLayer = (fill) => (fill?.startsWith('#') || fill?.startsWith('rgba') ? `linear-gradient(${fill}, ${fill})` : fill);

const SHADOW_TYPES = { DROP_SHADOW: '', INNER_SHADOW: 'inset ' };

function shadow(node) {
  const effects = (node.effects ?? []).filter((e) => e.visible !== false && e.type in SHADOW_TYPES);
  if (!effects.length) return undefined;
  return effects
    .map((e) => SHADOW_TYPES[e.type] +
      `${round(e.offset?.x ?? 0)}px ${round(e.offset?.y ?? 0)}px ${round(e.radius ?? 0)}px` +
      (e.spread ? ` ${round(e.spread)}px` : '') +
      ` ${cssColor(e.color ?? { r: 0, g: 0, b: 0, a: 0.25 })}`)
    .join(', ');
}

const blendOf = (node) =>
  node.blendMode && !HANDLED.blendModes.has(node.blendMode) ? node.blendMode.toLowerCase().replace(/_/g, '-') : undefined;

/**
 * A Figma mask clips the siblings drawn above it. When the mask shape is just the
 * parent's own box (the shape every mask in this file takes), that is exactly
 * overflow:hidden with the mask's corner radius, and the mask itself is not ink.
 */
function clippingMask(node) {
  const mask = (node.children ?? []).find((c) => c.mask && c.visible !== false);
  if (!mask) return undefined;
  const near = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) < 1;
  const fits = near(mask.transform?.m02, 0) && near(mask.transform?.m12, 0)
    && near(mask.size?.x, node.size?.x) && near(mask.size?.y, node.size?.y);
  return fits ? mask : undefined;
}

function radius(node) {
  if (node.type === 'ELLIPSE') return '50%';
  if (node.rectangleCornerRadiiIndependent) {
    const r = [node.rectangleTopLeftCornerRadius, node.rectangleTopRightCornerRadius, node.rectangleBottomRightCornerRadius, node.rectangleBottomLeftCornerRadius];
    return r.map((v) => `${round(v ?? 0)}px`).join(' ');
  }
  return node.cornerRadius ? `${round(node.cornerRadius)}px` : undefined;
}

const CASE_CSS = { UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize' };
const DECORATION_CSS = { UNDERLINE: 'underline', STRIKETHROUGH: 'line-through' };

const weightOf = (font) => WEIGHTS[font?.style?.replace(/\s|Italic/g, '')] ?? 400;

/**
 * A TEXT node can mix styles: characterStyleIDs assigns every character an entry in
 * styleOverrideTable (id 0 meaning the node's own style). Group runs of equal id so
 * the renderer can emit one span each instead of flattening the whole string.
 *
 * Indices are UTF-16 code units, so split('') rather than [...] keeps them aligned;
 * surrogate halves always share a style, so pairs survive the regrouping intact.
 */
function textRuns(node, base) {
  const { characters, characterStyleIDs = [], styleOverrideTable = [] } = node.textData;
  if (!styleOverrideTable.length) return undefined;
  const table = new Map(styleOverrideTable.map((o) => [o.styleID, o]));

  const runs = [];
  characters.split('').forEach((ch, i) => {
    const styleID = characterStyleIDs[i] ?? 0;
    const last = runs.at(-1);
    if (last?.styleID === styleID) last.text += ch;
    else runs.push({ styleID, text: ch });
  });
  if (runs.length < 2) return undefined;

  return runs.map(({ styleID, text }) => {
    const o = table.get(styleID);
    const run = { text };
    if (o?.fontSize && round(o.fontSize) !== base.size) run.size = round(o.fontSize);
    if (o?.fontName) {
      if (o.fontName.family !== base.family) run.family = o.fontName.family;
      if (weightOf(o.fontName) !== base.weight) run.weight = weightOf(o.fontName);
    }
    const color = o?.fillPaints && solidFill({ fillPaints: o.fillPaints });
    if (color && color !== base.color) run.color = color;
    return run;
  });
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
    weight: weightOf(node.fontName),
    italic: /Italic/.test(node.fontName?.style ?? '') || undefined,
    lineHeight,
    letterSpacing: ls?.value ? (ls.units === 'PERCENT' ? `${round(ls.value / 100)}em` : `${round(ls.value)}px`) : undefined,
    color: solidFill(node) ?? '#000000',
    align: (node.textAlignHorizontal ?? 'LEFT').toLowerCase(),
    verticalAlign: node.textAlignVertical === 'CENTER' ? 'center' : node.textAlignVertical === 'BOTTOM' ? 'flex-end' : undefined,
    // WIDTH_AND_HEIGHT means the box was sized to hug one line; letting it wrap
    // would reflow text Figma never wrapped
    nowrap: node.textAutoResize === 'WIDTH_AND_HEIGHT' || undefined,
    textCase: CASE_CSS[node.textCase],
    decoration: DECORATION_CSS[node.textDecoration],
  };
}

/** every leaf under `node` is vector-ish -> collapse the whole subtree into one SVG */
export function isIconCluster(node) {
  if (node.type === 'TEXT' || node.textData) return false;
  if (VECTOR_TYPES.has(node.type)) return true;
  if (!node.children?.length) return false;
  return node.children.every(isIconCluster);
}

/**
 * SVG cannot take a CSS gradient string, so a gradient inside an icon cluster has to
 * become a <defs> entry the path references by id.
 */
function svgPaint(paint, defs) {
  if (!paint) return undefined;
  if (paint.type === 'SOLID') return cssColor(paint.color, paint.opacity ?? 1);
  if (!paint.stops?.length) return undefined;
  const id = `g${defs.length}`;
  const stops = paint.stops
    .map((st) => `<stop offset="${round(st.position * 100)}%" stop-color="${cssColor(st.color)}"${(st.color.a ?? 1) < 1 ? ` stop-opacity="${round(st.color.a)}"` : ''}/>`)
    .join('');
  // gradient space runs (0,0)->(1,0); invert the transform to place it on the shape
  const m = paint.transform ? matInv(paint.transform) : IDENTITY;
  const at = (x, y) => ({ x: num(m.m00 * x + m.m01 * y + m.m02), y: num(m.m10 * x + m.m11 * y + m.m12) });
  const a = at(0, 0);
  const b = at(1, 0);
  const shape = paint.type === 'GRADIENT_LINEAR'
    ? `<linearGradient id="${id}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}">${stops}</linearGradient>`
    : `<radialGradient id="${id}">${stops}</radialGradient>`;
  defs.push(shape);
  return `url(#${id})`;
}

const visiblePaint = (list) => list?.find((p) => p.visible !== false && p.type !== 'IMAGE');

function collectPaths(node, blobs, parent, out, defs) {
  const m = matMul(parent, node.transform ?? IDENTITY);
  const transform = isIdentity(m)
    ? (m.m02 || m.m12 ? `translate(${round(m.m02)} ${round(m.m12)})` : undefined)
    : `matrix(${[m.m00, m.m10, m.m01, m.m11, m.m02, m.m12].map(num).join(' ')})`;

  // Figma stores strokes already outlined into fillable regions, so both geometries
  // are painted the same way — only the paint they take differs.
  const geometries = [
    // no paint at all -> the shape is a bounds/mask helper, not ink
    [node.fillGeometry, svgPaint(visiblePaint(node.fillPaints), defs) ?? (node.fillPaints?.some((f) => f.visible !== false) ? 'currentColor' : 'none')],
    [node.strokeGeometry, svgPaint(visiblePaint(node.strokePaints), defs) ?? 'none'],
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
  for (const child of node.children ?? []) collectPaths(child, blobs, m, out, defs);
}

/**
 * Full-bleed children of the frame itself are page backdrops. Deeper down the same
 * shape is just a card's fill rect, so the rule only applies at the top level.
 */
const isBackdrop = (child, parent) =>
  parent.size && child.box.w >= parent.size.x * 0.98 && child.box.h >= parent.size.y * 0.98;

const span = (a, b) => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));

const PRIMARY_ALIGN = { MIN: undefined, CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between', SPACE_EVENLY: 'space-evenly' };
const COUNTER_ALIGN = { MIN: undefined, CENTER: 'center', MAX: 'flex-end', BASELINE: 'baseline' };

/** what a node asks of the auto-layout parent it sits in */
function flexChild(node) {
  const child = {};
  if (node.stackPositioning === 'ABSOLUTE') child.absolute = true;
  if (node.stackChildAlignSelf) child.alignSelf = COUNTER_ALIGN[node.stackChildAlignSelf] ?? node.stackChildAlignSelf.toLowerCase();
  if (node.stackChildPrimaryGrow) child.grow = node.stackChildPrimaryGrow;
  return Object.keys(child).length ? child : undefined;
}

/** rough shape of a node: same role, same size, same immediate child roles */
const signature = (n) =>
  [n.role, Math.round(n.box.w), Math.round(n.box.h), (n.children ?? []).map((c) => c.role).sort().join('.')].join('|');

/**
 * Three or more siblings of the same shape are a list, and saying so is worth more
 * to whoever writes the markup than any amount of per-card geometry.
 */
function repeatHint(kids) {
  const groups = new Map();
  for (const k of kids) {
    const sig = signature(k);
    (groups.get(sig) ?? groups.set(sig, []).get(sig)).push(k);
  }
  const best = [...groups.values()].sort((a, b) => b.length - a.length)[0];
  if (!(best?.length >= 3)) return undefined;

  // how the repeats are actually arranged, measured rather than guessed: distinct
  // start positions on each axis, within a tolerance that ignores hand-placement drift
  const buckets = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.filter((v, i) => i === 0 || v - sorted[i - 1] > 8).length;
  };
  const columns = buckets(best.map((k) => k.box.x));
  const rows = buckets(best.map((k) => k.box.y));
  return { count: best.length, like: best[0].id, columns, rows };
}

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
      // horizontal/vertical padding are the left and top edges; right and bottom
      // have fields of their own and are not always the same value
      padding: {
        t: round(node.stackVerticalPadding ?? 0),
        r: round(node.stackPaddingRight ?? node.stackHorizontalPadding ?? 0),
        b: round(node.stackPaddingBottom ?? node.stackVerticalPadding ?? 0),
        l: round(node.stackHorizontalPadding ?? 0),
      },
      justify: PRIMARY_ALIGN[node.stackPrimaryAlignItems],
      align: COUNTER_ALIGN[node.stackCounterAlignItems],
      hug: {
        main: node.stackPrimarySizing?.startsWith('RESIZE_TO_FIT') || undefined,
        cross: node.stackCounterSizing?.startsWith('RESIZE_TO_FIT') || undefined,
      },
      source: 'auto-layout',
      repeat: repeatHint(kids.filter((k) => k.role !== 'backdrop')),
    };
  }
  const flow = kids.filter((k) => k.role !== 'backdrop').map((k) => (k.bounds ? { ...k, box: k.bounds } : k));
  const repeat = repeatHint(flow);
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
      repeat,
    };
  }
  return repeat ? { mode: 'absolute', repeat } : { mode: 'absolute' };
}

const guidKey = (g) => `${g.sessionID}:${g.localID}`;

/**
 * Every SYMBOL master in the document, so INSTANCE nodes can be expanded.
 * Takes the built tree, not raw nodeChanges — a master is only useful with its
 * children attached, and buildTree is what attaches them.
 */
export function symbolIndex(roots) {
  const index = new Map();
  (function walk(list) {
    for (const n of list) {
      if (n.type === 'SYMBOL') index.set(guidKey(n.guid), n);
      walk(n.children ?? []);
    }
  })(roots);
  return index;
}

/**
 * An INSTANCE carries no children of its own — just a symbolID and a list of
 * overrides addressing nodes inside the master by guid path. Expanding it means
 * walking the master's subtree and patching the addressed nodes on the way past.
 */
function expandInstance(node, symbols) {
  const master = symbols?.get(guidKey(node.symbolData.symbolID));
  if (!master) return undefined;
  const patches = new Map(
    (node.symbolData.symbolOverrides ?? []).map((o) => {
      const { guidPath, ...fields } = o;
      return [guidKey(guidPath.guids.at(-1)), fields];
    }),
  );
  const apply = (n) => ({ ...n, ...(patches.get(guidKey(n.guid)) ?? {}), children: (n.children ?? []).map(apply) });
  // the instance decides where it sits; the master only supplies its contents
  return { ...apply(master), guid: node.guid, id: node.id, name: node.name, transform: node.transform, size: node.size };
}

export function toIR(node, blobs, options = {}) {
  const { isRoot = true, symbols } = typeof options === 'boolean' ? { isRoot: options } : options;
  if (node.type === 'INSTANCE' && node.symbolData) {
    const expanded = expandInstance(node, symbols);
    if (expanded) return toIR(expanded, blobs, { isRoot, symbols, instanceOf: node.symbolData.symbolID });
  }
  // the rendered root is placed at the origin; kiwi may also omit matrix cells,
  // so fill in identity defaults rather than trusting the struct to be complete
  const t = { ...IDENTITY, ...node.transform, ...(isRoot ? { m02: 0, m12: 0 } : {}) };
  const box = { x: round(t.m02), y: round(t.m12), w: round(node.size?.x ?? 0), h: round(node.size?.y ?? 0) };
  const transform = transformCss(t);
  const base = { id: node.id, name: node.name, box };
  if (options.instanceOf) base.component = { name: node.name, instanceOf: guidKey(options.instanceOf) };
  const inParent = flexChild(node);
  if (inParent) base.flexChild = inParent;
  if (transform) {
    // width/height stay in the element's own frame; `bounds` is the footprint it
    // actually occupies once rotated, which is what layout reasoning needs
    box.transform = transform;
    const b = transformedBounds(box, t);
    base.bounds = { x: round(b.x), y: round(b.y), w: round(b.w), h: round(b.h) };
  }

  if (node.visible === false) return null;

  if (node.textData) {
    const text = textStyle(node);
    const runs = textRuns(node, text);
    if (runs) text.runs = runs;
    return { ...base, role: 'text', text, style: { opacity: node.opacity ?? 1 }, children: [] };
  }

  if (isIconCluster(node)) {
    const paths = [];
    const defs = [];
    // paths are collected in the cluster's own coordinate space, so cancel its transform
    collectPaths(node, blobs, matInv(node.transform ?? IDENTITY), paths, defs);
    if (!paths.length) return null;
    const asset = { kind: 'svg', viewBox: `0 0 ${box.w} ${box.h}`, paths };
    if (defs.length) asset.defs = defs;
    return { ...base, role: 'icon', asset, style: { opacity: node.opacity ?? 1 }, children: [] };
  }

  const image = imageFill(node);
  const mask = clippingMask(node);
  const style = {
    fill: image ? undefined : fillOf(node),
    radius: radius(node) ?? (mask ? radius(mask) : undefined),
    border: border(node),
    shadow: shadow(node),
    blend: blendOf(node),
    clip: mask ? true : undefined,
    opacity: node.opacity ?? 1,
  };

  const kids = (node.children ?? []).filter((c) => c !== mask).map((c) => toIR(c, blobs, { isRoot: false, symbols })).filter(Boolean);
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

  const seeColor = (value, use) => {
    if (!value?.startsWith('#') && !value?.startsWith('rgba')) return; // gradients are not tokens
    const hit = colors.get(value) ?? { value, count: 0, uses: new Set() };
    hit.count++;
    hit.uses.add(use);
    colors.set(value, hit);
  };

  (function walk(node) {
    if (node.style?.fill) seeColor(node.style.fill, 'surface');
    if (node.style?.border?.css) seeColor(node.style.border.css.split(' ').pop(), 'border');
    for (const p of node.asset?.paths ?? []) seeColor(p.fill, 'icon');
    if (node.text) {
      seeColor(node.text.color, 'text');
      for (const run of node.text.runs ?? []) seeColor(run.color, 'text');
      const key = `${node.text.family}-${node.text.weight}-${node.text.size}`;
      const hit = fonts.get(key) ?? { ...node.text, count: 0 };
      hit.count++;
      fonts.set(key, hit);
    }
    node.children?.forEach(walk);
  })(ir);

  // a colour only ever used behind text is a text colour; name it for what it does
  const groupOf = (uses) => (uses.size === 1 ? [...uses][0] : uses.has('surface') ? 'surface' : 'color');
  const byUse = [...colors.values()].sort((a, b) => b.count - a.count);
  const nth = new Map();
  for (const c of byUse) {
    const group = groupOf(c.uses);
    const n = (nth.get(group) ?? 0) + 1;
    nth.set(group, n);
    c.name = n === 1 ? `--${group}` : `--${group}-${n}`;
    c.uses = [...c.uses];
  }

  const text = [...fonts.values()].sort((a, b) => b.count - a.count);
  text.forEach((f, i) => { f.name = i === 0 ? '--font' : `--font-${i + 1}`; });

  const css = [
    ':root {',
    ...byUse.map((c) => `  ${c.name}: ${c.value}; /* ${c.uses.join('+')}, ${c.count}x */`),
    ...text.map((f) => `  ${f.name}: ${f.weight} ${f.size}px${f.lineHeight ? `/${f.lineHeight}` : ''} "${f.family}"; /* ${f.count}x */`),
    '}',
  ].join('\n');

  return { colors: byUse, text, css };
}
