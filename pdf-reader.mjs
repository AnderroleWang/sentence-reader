import * as pdfjs from './vendor/pdf.mjs';
import { unitsFromParagraphs } from './alignment.mjs';
import { paintFocus } from './focus.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.mjs', import.meta.url).href;

export async function loadPdf(blob) {
  const data = new Uint8Array(await blob.arrayBuffer());
  return pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true,
    standardFontDataUrl: new URL('./vendor/standard_fonts/', import.meta.url).href }).promise;
}

const median = values => { const sorted = values.filter(x => x > 0).sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] || 10; };

export function orderLines(items, width) {
  const tokens = items.filter(item => item.str.trim() && Math.abs(Math.atan2(item.transform[1], item.transform[0])) < .12).map(item => ({ ...item,
    x: item.transform[4], y: item.transform[5], h: Math.abs(item.transform[3]) || item.height || 10 }));
  const typical = median(tokens.map(t => t.h));
  const rows = [];
  for (const token of tokens.sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.find(r => Math.abs(r.y - token.y) <= Math.max(2, Math.min(r.h, token.h) * .32));
    if (row) { row.tokens.push(token); row.h = Math.max(row.h, token.h); }
    else rows.push({ y: token.y, h: token.h, tokens: [token] });
  }
  // A narrow column gutter can be smaller than two font sizes. Infer a
  // repeated central gap before joining tokens into a line.
  const centralGaps = [];
  for (const row of rows) {
    const sorted = row.tokens.toSorted((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i++) {
      const left = sorted[i - 1].x + sorted[i - 1].width, right = sorted[i].x;
      const center = (left + right) / 2;
      if (right - left > Math.max(typical * .85, width * .012) && center > width * .38 && center < width * .62) centralGaps.push({ left, right, center });
    }
  }
  const gutter = centralGaps.length >= 4 ? median(centralGaps.map(g => g.center)) : null;
  const hasGutter = gutter && centralGaps.filter(g => g.left <= gutter && g.right >= gutter).length >= 4;
  const lines = [];
  for (const row of rows) {
    const sorted = row.tokens.sort((a, b) => a.x - b.x);
    let chunk = [];
    function flush() {
      if (!chunk.length) return;
      const x = chunk[0].x, right = Math.max(...chunk.map(t => t.x + t.width));
      lines.push({ tokens: chunk, x, right, y: row.y, h: row.h,
        column: x < width / 2 - 5 && right > width / 2 + 5 ? 'full' : x < width / 2 ? 'left' : 'right' });
      chunk = [];
    }
    for (const token of sorted) {
      const prior = chunk.at(-1);
      const gap = prior ? token.x - (prior.x + prior.width) : 0;
      if (gap > Math.max(typical * 2, width * .035) || (hasGutter && prior && prior.x + prior.width <= gutter && token.x >= gutter && gap > typical * .6)) flush();
      chunk.push(token);
    }
    flush();
  }
  lines.sort((a, b) => b.y - a.y || a.x - b.x);
  const bothColumns = lines.filter(l => l.column === 'left').length >= 4 && lines.filter(l => l.column === 'right').length >= 4;
  if (!bothColumns) return lines;
  const ordered = [], band = [];
  function flushBand() {
    ordered.push(...band.filter(l => l.column === 'left'), ...band.filter(l => l.column === 'right'));
    band.length = 0;
  }
  for (const line of lines) {
    if (line.column === 'full') { flushBand(); ordered.push(line); }
    else band.push(line);
  }
  flushBand();
  return ordered;
}

function appendLine(paragraph, line, pageNumber) {
  for (const [i, token] of line.tokens.entries()) {
    let value = token.str;
    const lead = value.length - value.trimStart().length;
    value = value.trim();
    if (!value) continue;
    const compound = /^(?:[a-z]+-[a-z]|(?:based|level|wise|time|term|dimensional|specific|scale|to|of|and)\b)/.test(value);
    if (i === 0 && /[A-Za-z]-$/.test(paragraph.text) && /^[a-z]/.test(value) && !compound) {
      paragraph.text = paragraph.text.slice(0, -1);
      const run = paragraph.runs.at(-1);
      if (run) run.end--;
    } else if (paragraph.text && !/\s$/.test(paragraph.text) && !/^[,.;:!?\])}]/.test(value)) {
      const prior = line.tokens[i - 1];
      const adjacent = prior && token.x - (prior.x + prior.width) < token.h * .13;
      if (!adjacent) paragraph.text += ' ';
    }
    const start = paragraph.text.length;
    paragraph.text += value;
    paragraph.runs.push({ start, end: paragraph.text.length, page: pageNumber, itemIndex: token.itemIndex, itemStart: lead });
  }
}

export async function extractPdf(pdf, onProgress = () => {}) {
  const allPages = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number);
    const content = await page.getTextContent();
    let itemIndex = 0;
    const items = content.items.filter(item => typeof item.str === 'string').map(item => ({ ...item, itemIndex: itemIndex++ }));
    const viewport = page.getViewport({ scale: 1 });
    allPages.push({ number, lines: orderLines(items, viewport.width), height: viewport.height });
    onProgress(number, pdf.numPages);
  }
  // Only remove headers/footers whose text repeats on several pages.
  const repeated = new Map();
  const lineText = line => line.tokens.map(t => t.str).join(' ').trim();
  for (const page of allPages) {
    for (const line of page.lines.filter(l => l.y < 40 || l.y > page.height - 40)) {
      const key = lineText(line).replace(/\b\d+\b/g, '#');
      const pages = repeated.get(key) || new Set(); pages.add(page.number); repeated.set(key, pages);
    }
  }
  const paragraphs = [];
  for (const page of allPages) {
    let paragraph = null, prior = null;
    const typical = median(page.lines.map(l => l.h));
    for (const line of page.lines) {
      const repeatedPages = repeated.get(lineText(line).replace(/\b\d+\b/g, '#'));
      if ((line.y < 40 || line.y > page.height - 40) && (repeatedPages?.size >= Math.max(2, Math.ceil(pdf.numPages * .4)) || /^\d+$/.test(lineText(line)))) continue;
      const gap = prior ? prior.y - line.y : Infinity;
      const heading = line.h > typical * 1.2;
      const columnBreak = prior && line.column !== prior.column && line.column !== 'full' && prior.column !== 'full' && Math.abs(line.x - prior.x) > typical * 3;
      const newParagraph = !paragraph || !prior || columnBreak || gap < -2 || gap > Math.max(typical * 1.65, 19)
        || heading || prior.h > typical * 1.2 || (line.x - prior.x > typical * 1.3 && /[.!?:]$/.test(paragraph.text));
      if (newParagraph) {
        paragraph = { text: '', runs: [], body: !heading, fontSize: line.h };
        paragraphs.push(paragraph);
      }
      appendLine(paragraph, line, page.number);
      prior = line;
    }
  }
  const joined = [];
  for (const paragraph of paragraphs.filter(p => p.text.trim())) {
    const prior = joined.at(-1);
    const adjacentPage = prior && prior.runs.at(-1)?.page + 1 === paragraph.runs[0]?.page;
    const sameBody = prior?.body && paragraph.body && Math.abs(prior.fontSize - paragraph.fontSize) < prior.fontSize * .2;
    const unfinished = prior && /[A-Za-z0-9,\-)\]]$/.test(prior.text) && !/[.!?]["')\]]?$/.test(prior.text);
    const continuation = /^[A-Za-z("“[]/.test(paragraph.text) && !/^(?:\d+(?:\.\d+)*\s|abstract\b|references\b|appendix\b|figure\s+\d|table\s+\d)/i.test(paragraph.text);
    if (adjacentPage && sameBody && unfinished && continuation && prior.text.length >= 35) {
      const dehyphenate = /[A-Za-z]-$/.test(prior.text) && /^[a-z]/.test(paragraph.text) && !/^(?:[a-z]+-[a-z]|(?:based|level|wise|time|term|dimensional|specific|scale|to|of|and)\b)/.test(paragraph.text);
      if (dehyphenate) { prior.text = prior.text.slice(0, -1); prior.runs.at(-1).end--; }
      const separator = dehyphenate ? '' : ' ', offset = prior.text.length + separator.length;
      prior.text += separator + paragraph.text;
      prior.runs.push(...paragraph.runs.map(run => ({ ...run, start: run.start + offset, end: run.end + offset })));
    } else joined.push(paragraph);
  }
  const units = unitsFromParagraphs(joined);
  if (!units.length || units.reduce((n, u) => n + u.text.length, 0) < 30) throw new Error('这份 PDF 没有提取到足够的文字，可能是扫描件。第一版暂不支持 OCR，可改为粘贴识别后的正文。');
  return units;
}

export class PdfPane {
  constructor(container, onSelect) { this.container = container; this.onSelect = onSelect; this.token = 0; }
  async render(pdf, number, units, zoom = 1, crop = null) {
    const token = ++this.token;
    this.renderTask?.cancel(); this.textLayer?.cancel(); this.container.replaceChildren();
    const page = await pdf.getPage(number);
    if (token !== this.token) return;
    const base = page.getViewport({ scale: 1 });
    const width = this.pageWidth || Math.max(280, this.container.clientWidth - 16) * zoom;
    crop = crop || { x: 0, y: 0, w: 1, h: 1 };
    const scale = width / (base.width * crop.w), viewport = page.getViewport({ scale });
    const wrapper = document.createElement('div'); wrapper.className = 'pdf-page';
    Object.assign(wrapper.style, { width: viewport.width * crop.w + 'px', height: viewport.height * crop.h + 'px', overflow: 'hidden' });
    wrapper.style.setProperty('--scale-factor', String(scale));
    const surface = document.createElement('div'); surface.className = 'pdf-crop-surface';
    Object.assign(surface.style, { position: 'relative', width: viewport.width + 'px', height: viewport.height + 'px', left: -viewport.width * crop.x + 'px', top: -viewport.height * crop.y + 'px' });
    const canvas = document.createElement('canvas'), density = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(viewport.width * density); canvas.height = Math.floor(viewport.height * density);
    canvas.style.width = viewport.width + 'px'; canvas.style.height = viewport.height + 'px';
    const layer = document.createElement('div'); layer.className = 'textLayer';
    const highlights = document.createElement('div'); highlights.className = 'pdf-coordinate-highlights'; highlights.setAttribute('aria-hidden', 'true');
    surface.append(canvas, layer); wrapper.append(surface, highlights); this.container.append(wrapper);
    this.renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: [density, 0, 0, density, 0, 0] });
    try { await this.renderTask.promise; } catch (error) { if (error.name === 'RenderingCancelledException') return; throw error; }
    if (token !== this.token) return;
    const content = await page.getTextContent();
    const textLayer = this.textLayer = new pdfjs.TextLayer({ textContentSource: content, container: layer, viewport });
    try { await textLayer.render(); } catch (error) { if (token !== this.token) return; throw error; }
    if (token !== this.token) return;
    this.divs = textLayer.textDivs; this.units = units; this.pageNumber = number; this.wrapper = wrapper; this.highlightLayer = highlights;
    this.divs.forEach((div, i) => { div.dataset.pdfItem = String(i); });
    // Save exact character rectangles once. Caret APIs snap whitespace to nearby
    // lines and can silently select the other column; geometry must win.
    const root = wrapper.getBoundingClientRect();
    this.boxes = [];
    for (const unit of units) {
      const explicit = (unit.pdfBoxes || []).filter(b => b.page === number);
      for (const box of explicit) this.boxes.push({ ...box, id: unit.source_id, explicit: true });
      if (explicit.length) continue;
      for (const anchor of (unit.anchors || []).filter(a => a.page === number)) {
        const range = this.anchorRange(anchor); if (!range) continue;
        for (const rect of range.getClientRects()) if (rect.width > 0 && rect.height > 0) this.boxes.push({
          page: number, x: (rect.left - root.left) / root.width, y: (rect.top - root.top) / root.height,
          w: rect.width / root.width, h: rect.height / root.height, id: unit.source_id
        });
      }
    }
    wrapper.dataset.pdfReady = String(number);
    wrapper.addEventListener('pointerdown', event => {
      if (event.button === 0 && !event.shiftKey) document.getSelection()?.removeAllRanges();
    });
    wrapper.addEventListener('pointerup', event => {
      if (event.button !== 0) return;
      const selection = document.getSelection();
      if (selection && !selection.isCollapsed && (this.selectionRoot || wrapper).contains(selection.anchorNode)) {
        if (this.onSelection) this.onSelection(selection); else this.readSelection(selection);
        return;
      }
      const bounds = wrapper.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width, y = (event.clientY - bounds.top) / bounds.height;
      const candidates = this.boxes.filter(b => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);
      candidates.sort((a, b) => {
        if (!a.explicit && !b.explicit) {
          const distance = Math.abs(y - a.y - a.h / 2) - Math.abs(y - b.y - b.h / 2);
          if (Math.abs(distance) > .001) return distance;
        }
        return a.w * a.h - b.w * b.h;
      });
      if (candidates.length) this.onSelect([candidates[0].id]);
    });
  }
  anchorRange(anchor) {
    const text = this.divs?.[anchor.itemIndex]?.firstChild;
    if (!text || text.nodeType !== Node.TEXT_NODE) return null;
    const start = Math.max(0, Math.min(anchor.start, text.length)), end = Math.max(0, Math.min(anchor.end, text.length));
    if (end <= start) return null;
    const range = document.createRange(); range.setStart(text, start); range.setEnd(text, end); return range;
  }
  selectionIds(selection) {
    if (!this.divs || !selection.rangeCount || selection.isCollapsed) return [];
    const selected = selection.getRangeAt(0), ids = new Set(), root = this.wrapper.getBoundingClientRect();
    for (let item = 0; item < this.divs.length; item++) {
      const div = this.divs[item], text = div.firstChild;
      if (!text || text.nodeType !== Node.TEXT_NODE || !selected.intersectsNode(text)) continue;
      const part = document.createRange(); part.selectNodeContents(text);
      if (text === selected.startContainer) part.setStart(text, selected.startOffset);
      if (text === selected.endContainer) part.setEnd(text, selected.endOffset);
      // Ancestor endpoints (e.g. Select All) are handled by range intersection;
      // only the actual text runs contribute boxes, never ancestor rectangles.
      if (part.collapsed) continue;
      const start = part.startOffset, end = part.endOffset;
      for (const unit of this.units) if ((unit.anchors || []).some(a => a.page === this.pageNumber && a.itemIndex === item && a.start < end && a.end > start)) ids.add(unit.source_id);
      for (const rect of part.getClientRects()) for (const box of this.boxes.filter(b => b.explicit)) {
        const left = root.left + box.x * root.width, top = root.top + box.y * root.height;
        if (Math.min(rect.right, left + box.w * root.width) - Math.max(rect.left, left) > .5 && Math.min(rect.bottom, top + box.h * root.height) - Math.max(rect.top, top) > Math.min(rect.height, box.h * root.height) * .45) ids.add(box.id);
      }
    }
    return [...ids];
  }
  readSelection(selection) { const ids = this.selectionIds(selection); if (ids.length) this.onSelect(ids); }
  highlight(ids) {
    if (!this.highlightLayer) return;
    this.highlightLayer.replaceChildren(); let first;
    for (const box of this.boxes || []) if (ids.includes(box.id)) {
      const node = document.createElement('div'); node.className = 'pdf-coordinate-highlight'; node.dataset.linkedId = box.id;
      Object.assign(node.style, { left: box.x * 100 + '%', top: box.y * 100 + '%', width: box.w * 100 + '%', height: box.h * 100 + '%' });
      this.highlightLayer.append(node); first ||= node;
    }
    this.activeIds = ids;
    paintFocus(this.wrapper, (this.boxes || []).filter(b => ids.includes(b.id)), this.focus);
    return first;
  }
  setFocus(enabled) { this.focus = enabled; if (this.highlightLayer) this.highlight(this.activeIds || []); }
  clear() {
    this.token++; this.renderTask?.cancel(); this.textLayer?.cancel();
    this.divs = null; this.boxes = []; this.container.replaceChildren(); this.highlightLayer = null;
  }
}
