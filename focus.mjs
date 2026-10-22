let serial = 0;
// A veil above the PDF leaves holes over the selected glyphs. The underlying
// page remains intact, including formulas, figures and the native text layer.
export function paintFocus(wrapper, rectangles, enabled) {
  wrapper?.querySelector(':scope > .pdf-focus-veil')?.remove();
  if (!enabled || !wrapper) return;
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.classList.add('pdf-focus-veil'); svg.setAttribute('viewBox', '0 0 1000 1000'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('aria-hidden', 'true');
  const makeRect = (x, y, width, height, fill) => {
    const rect = document.createElementNS(ns, 'rect');
    for (const [key, value] of Object.entries({ x, y, width, height, fill })) rect.setAttribute(key, value);
    return rect;
  };
  const defs = document.createElementNS(ns, 'defs'), mask = document.createElementNS(ns, 'mask'), id = 'focus-' + ++serial;
  mask.id = id; mask.setAttribute('maskUnits', 'userSpaceOnUse'); mask.setAttribute('x', '0'); mask.setAttribute('y', '0'); mask.setAttribute('width', '1000'); mask.setAttribute('height', '1000');
  mask.append(makeRect(0, 0, 1000, 1000, 'white'));
  for (const r of rectangles) mask.append(makeRect(r.x * 1000 - 1, r.y * 1000 - 1, r.w * 1000 + 2, r.h * 1000 + 2, 'black'));
  defs.append(mask); const veil = makeRect(0, 0, 1000, 1000, 'white'); veil.setAttribute('mask', `url(#${id})`); veil.setAttribute('opacity', '.57');
  svg.append(defs, veil); wrapper.append(svg);
}
