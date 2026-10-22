// Supersample small text without allowing zoomed or cropped pages to allocate
// an unbounded bitmap. Text-layer geometry always stays in CSS pixels.
export function pdfCanvasSize(viewport, pixelRatio = window.devicePixelRatio || 1) {
  const target = Math.min(4, Math.max(2, Number(pixelRatio) || 1));
  const maxPixels = 8 * 1024 * 1024, maxSide = 8192;
  const scale = Math.min(target, Math.sqrt(maxPixels / (viewport.width * viewport.height)),
    maxSide / viewport.width, maxSide / viewport.height);
  const width = Math.max(1, Math.floor(viewport.width * scale));
  const height = Math.max(1, Math.floor(viewport.height * scale));
  return { width, height, scaleX: width / viewport.width, scaleY: height / viewport.height };
}

export function preparePdfCanvas(canvas, viewport) {
  const size = pdfCanvasSize(viewport);
  canvas.width = size.width; canvas.height = size.height;
  canvas.style.width = viewport.width + 'px'; canvas.style.height = viewport.height + 'px';
  return [size.scaleX, 0, 0, size.scaleY, 0, 0];
}
