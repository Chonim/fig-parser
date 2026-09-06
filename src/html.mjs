const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const px = (v) => `${v}px`;

/** stable, readable class name from the Figma layer name */
function className(node, seen) {
  const base = (node.name || node.role)
    .normalize('NFC')
    .replace(/[^\w가-힣-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || node.role;
  const n = (seen.get(base) ?? 0) + 1;
  seen.set(base, n);
  return n === 1 ? base : `${base}-${n}`;
}

function boxRules(node, parentLayout) {
  const rules = [];
  const positioned = node.role === 'backdrop' || parentLayout?.mode === 'absolute';
  if (positioned) {
    rules.push(['position', 'absolute'], ['left', px(node.box.x)], ['top', px(node.box.y)]);
  }
  node.positioned = positioned;
  rules.push(['width', px(node.box.w)], ['height', px(node.box.h)]);
  return rules;
}

function styleRules(node, parentLayout, assetUrl) {
  const rules = boxRules(node, parentLayout);
  const s = node.style ?? {};
  if (s.fill) rules.push(['background', s.fill]);
  if (node.asset?.kind === 'image' && node.role !== 'image') {
    rules.push(['background-image', `url(${assetUrl(node.asset.hash)})`], ['background-size', 'cover'], ['background-position', 'center']);
  }
  if (s.radius) rules.push(['border-radius', s.radius]);
  if (s.border) rules.push(['border', s.border], ['box-sizing', 'border-box']);
  if (s.shadow) rules.push(['box-shadow', s.shadow]);
  if (s.opacity != null && s.opacity < 1) rules.push(['opacity', String(s.opacity)]);
  // Figma rotates about the top-left of the unrotated box, unlike CSS's default centre
  if (node.box.transform) rules.push(['transform', node.box.transform], ['transform-origin', '0 0']);

  if (node.role === 'text') {
    const t = node.text;
    rules.push(['font-family', `"${t.family}", sans-serif`], ['font-size', px(t.size)], ['font-weight', String(t.weight)], ['color', t.color]);
    if (t.italic) rules.push(['font-style', 'italic']);
    if (t.lineHeight) rules.push(['line-height', String(t.lineHeight)]);
    if (t.letterSpacing) rules.push(['letter-spacing', t.letterSpacing]);
    if (t.align !== 'left') rules.push(['text-align', t.align]);
    rules.push(['white-space', 'pre-wrap']);
  }

  const l = node.layout;
  if (l?.mode === 'flex') {
    rules.push(['display', 'flex'], ['flex-direction', l.direction]);
    if (l.gap) rules.push(['gap', px(l.gap)]);
    if (l.align) rules.push(['align-items', l.align]);
    const p = l.padding;
    if (p && (p.t || p.r || p.b || p.l)) rules.push(['padding', [p.t, p.r, p.b, p.l].map(px).join(' ')], ['box-sizing', 'border-box']);
  } else if (node.children?.length && !node.positioned) {
    // absolutely-positioned boxes already establish a containing block
    rules.push(['position', 'relative']);
  }
  return rules;
}

export function renderHTML(root, { assetUrl = (h) => `assets/${h}.png`, title = root.name } = {}) {
  const sheet = [];
  const seen = new Map();

  const walk = (node, parentLayout, depth) => {
    const cls = className(node, seen);
    const rules = styleRules(node, parentLayout, assetUrl);
    sheet.push(`.${cls} {\n${rules.map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}`);
    const pad = '  '.repeat(depth + 2);

    if (node.role === 'text') return `${pad}<p class="${cls}">${esc(node.text.content)}</p>`;
    if (node.role === 'image') return `${pad}<img class="${cls}" src="${assetUrl(node.asset.hash)}" alt="${esc(node.name)}">`;
    if (node.role === 'icon') {
      const paths = node.asset.paths
        .map((p) => `<path d="${p.d}" fill="${p.fill}"${p.transform ? ` transform="${p.transform}"` : ''}${p.rule ? ` fill-rule="${p.rule}"` : ''}/>`)
        .join('');
      return `${pad}<svg class="${cls}" viewBox="${node.asset.viewBox}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(node.name)}">${paths}</svg>`;
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
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css">
<style>
* { margin: 0; padding: 0; }
body { background: #f4f4f4; display: flex; justify-content: center; }
${sheet.join('\n')}
</style>
</head>
<body>
${body}
</body>
</html>
`;
}
