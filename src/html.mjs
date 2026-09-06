import { asImageLayer } from './ir.mjs';

/** Figma image scale modes as CSS background sizing */
const backgroundFit = (mode) => {
  if (mode === 'TILE') return [['background-repeat', 'repeat']];
  const size = { FIT: 'contain', STRETCH: '100% 100%' }[mode] ?? 'cover';
  return [['background-size', size], ['background-position', 'center'], ['background-repeat', 'no-repeat']];
};

/** mixed-format text becomes spans carrying only what differs from the node's own style */
const RUN_CSS = { size: (v) => `font-size:${v}px`, weight: (v) => `font-weight:${v}`, family: (v) => `font-family:"${v}"`, color: (v) => `color:${v}` };

function textBody(text) {
  if (!text.runs) return esc(text.content);
  return text.runs
    .map((run) => {
      const style = Object.entries(RUN_CSS)
        .filter(([k]) => run[k] !== undefined)
        .map(([k, fn]) => fn(run[k]))
        .join(';');
      return style ? `<span style="${style}">${esc(run.text)}</span>` : esc(run.text);
    })
    .join('');
}

const OBJECT_FIT = { FIT: 'contain', STRETCH: 'fill', TILE: 'none' };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const px = (v) => `${v}px`;

/** stable, readable class name from the Figma layer name */
function className(node, seen) {
  const base = (node.name || node.role)
    .normalize('NFC')
    .replace(/[^\w가-힣-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || node.role;
  // a CSS identifier may not start with a digit: `.2026-01-01` silently matches
  // nothing, and every rule written for that node is dropped
  const safe = /^[a-z_\u00a0-\uffff]/i.test(base) ? base : `n${base}`;
  // Reserving only the unsuffixed base let the tenth `Vector` mint `vector-10`,
  // which a layer actually called `Vector 10` then claimed as well — one selector,
  // two rules, and the later one won for both elements. Every name handed out is
  // reserved, and a suffix keeps counting until it lands on a free one.
  let name = safe;
  for (let n = 2; seen.has(name); n++) name = `${safe}-${n}`;
  seen.add(name);
  return name;
}

function boxRules(node, parentLayout) {
  const rules = [];
  const positioned = node.role === 'backdrop' || parentLayout?.mode === 'absolute' || node.flexChild?.absolute;
  if (positioned) {
    rules.push(['position', 'absolute'], ['left', px(node.box.x)], ['top', px(node.box.y)]);
  }
  node.positioned = positioned;
  // Sizes stay as Figma measured them, even where layout.hug says the frame sizes
  // itself: fit-content collapses multi-line fields that Figma had resolved larger.
  // That makes flex-grow and align-self inert here, which is the honest trade for a
  // renderer whose job is to reproduce the design rather than to be responsive.
  rules.push(['width', px(node.box.w)], ['height', px(node.box.h)]);
  return rules;
}

function styleRules(node, parentLayout, assetUrl) {
  const rules = boxRules(node, parentLayout);
  const s = node.style ?? {};
  if (s.fill && !s.border?.image) rules.push(['background', s.fill]);
  if (node.asset?.kind === 'image' && node.role !== 'image') {
    rules.push(['background-image', `url(${assetUrl(node.asset.hash)})`], ...backgroundFit(node.asset.scaleMode));
  }
  if (s.radius) rules.push(['border-radius', s.radius]);
  if (s.border?.css) rules.push(['border', s.border.css], ['box-sizing', 'border-box']);
  if (s.border?.image) {
    // fill clipped to the padding box, stroke gradient to the border box
    const layers = [s.fill && `${asImageLayer(s.fill)} padding-box`, `${s.border.image} border-box`].filter(Boolean);
    rules.push(['background', layers.join(', ')], ['border', `${s.border.width}px solid transparent`], ['box-sizing', 'border-box']);
  }
  if (s.shadow) rules.push(['box-shadow', s.shadow]);
  if (s.blend) rules.push(['mix-blend-mode', s.blend]);
  if (s.clip) rules.push(['overflow', 'hidden']);
  if (s.opacity != null && s.opacity < 1) rules.push(['opacity', String(s.opacity)]);
  // Figma rotates about the top-left of the unrotated box, unlike CSS's default centre
  if (node.box.transform) rules.push(['transform', node.box.transform], ['transform-origin', '0 0']);

  if (node.flexChild?.alignSelf) rules.push(['align-self', node.flexChild.alignSelf]);
  if (node.flexChild?.grow) rules.push(['flex-grow', String(node.flexChild.grow)]);

  if (node.role === 'image') {
    rules.push(['object-fit', OBJECT_FIT[node.asset.scaleMode] ?? 'cover']);
  }

  if (node.role === 'text') {
    const t = node.text;
    rules.push(['font-family', `"${t.family}", sans-serif`], ['font-size', px(t.size)], ['font-weight', String(t.weight)], ['color', t.color]);
    if (t.italic) rules.push(['font-style', 'italic']);
    if (t.lineHeight) rules.push(['line-height', String(t.lineHeight)]);
    if (t.letterSpacing) rules.push(['letter-spacing', t.letterSpacing]);
    if (t.align !== 'left') rules.push(['text-align', t.align]);
    if (t.textCase) rules.push(['text-transform', t.textCase]);
    if (t.decoration) rules.push(['text-decoration', t.decoration]);
    // a flex container with only text still aligns that text as one anonymous item,
    // but text-align no longer positions it, so mirror it onto the main axis
    if (t.verticalAlign) {
      rules.push(['display', 'flex'], ['align-items', t.verticalAlign]);
      if (t.align !== 'left') rules.push(['justify-content', t.align === 'right' ? 'flex-end' : t.align]);
    }
    rules.push(['white-space', t.nowrap ? 'pre' : 'pre-wrap']);
  }

  const l = node.layout;
  if (l?.mode === 'flex') {
    rules.push(['display', 'flex'], ['flex-direction', l.direction]);
    if (l.gap) rules.push(['gap', px(l.gap)]);
    if (l.justify) rules.push(['justify-content', l.justify]);
    if (l.align) rules.push(['align-items', l.align]);
    const p = l.padding;
    if (p && (p.t || p.r || p.b || p.l)) rules.push(['padding', [p.t, p.r, p.b, p.l].map(px).join(' ')], ['box-sizing', 'border-box']);
  } else if (node.children?.length && !node.positioned) {
    // absolutely-positioned boxes already establish a containing block
    rules.push(['position', 'relative']);
  }
  return rules;
}

// Google Fonts covers most design libraries; Pretendard is not on it
const FONT_OVERRIDES = { Pretendard: 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css' };

/**
 * Ask for the weights the frame uses, plus 400. A css2 request in which no named
 * weight exists for that family fails outright — Lato publishes no 600, so a lone
 * :wght@600 takes the whole font down — and 400 is the one weight always there.
 */
const fontHref = (family, weights) =>
  FONT_OVERRIDES[family]
  ?? `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}`
     + `:wght@${[...new Set([400, ...weights])].sort((a, b) => a - b).join(';')}&display=swap`;

export function renderHTML(root, { assetUrl = (h) => `assets/${h}.png`, title = root.name } = {}) {
  const sheet = [];
  const seen = new Set();
  const families = new Map();
  (function collectFonts(n) {
    const note = (family, weight) => {
      if (!family) return;
      if (!families.has(family)) families.set(family, new Set());
      families.get(family).add(weight ?? 400);
    };
    note(n.text?.family, n.text?.weight);
    for (const run of n.text?.runs ?? []) note(run.family ?? n.text?.family, run.weight ?? n.text?.weight);
    n.children?.forEach(collectFonts);
  })(root);

  const walk = (node, parentLayout, depth) => {
    const cls = className(node, seen);
    const rules = styleRules(node, parentLayout, assetUrl);
    sheet.push(`.${cls} {\n${rules.map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}`);
    const pad = '  '.repeat(depth + 2);

    if (node.role === 'text') return `${pad}<p class="${cls}">${textBody(node.text)}</p>`;
    if (node.role === 'image') return `${pad}<img class="${cls}" src="${assetUrl(node.asset.hash)}" alt="${esc(node.name)}">`;
    if (node.role === 'icon') {
      const defs = node.asset.defs ? `<defs>${node.asset.defs.join('')}</defs>` : '';
      const paths = node.asset.paths
        .map((p) => `<path d="${p.d}" fill="${p.fill}"${p.transform ? ` transform="${p.transform}"` : ''}${p.rule ? ` fill-rule="${p.rule}"` : ''}/>`)
        .join('');
      return `${pad}<svg class="${cls}" viewBox="${node.asset.viewBox}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(node.name)}">${defs}${paths}</svg>`;
    }
    const kids = node.children.map((c) => walk(c, node.layout, depth + 1)).join('\n');
    return `${pad}<div class="${cls}">\n${kids}\n${pad}</div>`;
  };

  const body = walk(root, null, 0);
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${[...families].map(([f, w]) => `<link rel="stylesheet" href="${fontHref(f, w)}">`).join('\n')}
<style>
* { margin: 0; padding: 0; }
body { background: #f4f4f4; display: flex; justify-content: center; }
/* The frame is a flex item, and a flex item shrinks below its width by default.
   Its children are absolutely positioned and keep their left/top, so any viewport
   narrower than the design tears it apart — a 1440 window with a scrollbar is
   already narrower. */
body > * { flex-shrink: 0; }
${sheet.join('\n')}
</style>
</head>
<body>
${body}
</body>
</html>
`;
}
