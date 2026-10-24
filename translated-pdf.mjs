import * as pdfjs from './vendor/pdf.mjs';
import { orderLines } from './pdf-reader.mjs';
import { paintFocus } from './focus.mjs';
import { preparePdfCanvas } from './pdf-rendering.mjs';

const middle = values => values.filter(n => n > 0).sort((a, b) => a - b)[Math.floor(values.filter(n => n > 0).length / 2)] || 10;
const intersects = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

// PDF text runs put superscripts/subscripts on separate baselines. Attach small
// runs to nearby prose before constructing regions, or the script's bounding
// box can make the entire translated paragraph look like overlapping artwork.
function layoutLines(items, width) {
  const lines = orderLines(items, width);
  const typical = middle(lines.map(line => line.h)), attached = new Set();
  for (const script of lines) {
    if (script.h > typical * .85 || script.tokens.map(t => t.str).join('').length > 32) continue;
    const body = lines.filter(line => line !== script && !attached.has(line)
      && script.h < line.h * .85 && line.h <= typical * 1.3
      && Math.abs(script.y - line.y) <= line.h * .85
      && script.x >= line.x - line.h * .2 && script.right <= line.right + line.h * .4
      && (line.tokens.map(t => t.str).join(' ').match(/[A-Za-z]{3,}/g) || []).length >= 4)
      .sort((a, b) => Math.abs(a.y - script.y) - Math.abs(b.y - script.y))[0];
    if (!body) continue;
    body.tokens.push(...script.tokens); body.tokens.sort((a, b) => a.x - b.x || b.y - a.y);
    body.right = Math.max(body.right, script.right); attached.add(script);
  }
  return lines.filter(line => !attached.has(line));
}

// Regions follow the source geometry. Translation groups keep their IDs even when
// their source spans more than one region, column, or page.
function pageRegions(content, page, units, viewport, divs, wrapper) {
  const origin = wrapper.getBoundingClientRect();
  const byItem = new Map(), byId = new Map(units.map(u => [u.source_id, u]));
  for (const unit of units) for (const anchor of unit.anchors) if (anchor.page === page) {
    const entries = byItem.get(anchor.itemIndex) || []; entries.push({ unit, anchor }); byItem.set(anchor.itemIndex, entries);
  }
  let index = 0;
  const items = content.items.filter(item => typeof item.str === 'string').map(item => ({ ...item, itemIndex: index++ }));
  const scale = viewport.scale, baseWidth = viewport.width / scale;
  const lines = layoutLines(items, baseWidth);
  const typical = middle(lines.map(l => l.h));
  const regions = [];
  const rectFor = (itemIndex, start, end) => {
    const text = divs[itemIndex]?.firstChild;
    if (!text || text.nodeType !== Node.TEXT_NODE || start >= end) return null;
    const range = document.createRange(); range.setStart(text, Math.min(start, text.length)); range.setEnd(text, Math.min(end, text.length));
    const r = range.getBoundingClientRect();
    return r.width && r.height ? { left: r.left - origin.left, top: r.top - origin.top, right: r.right - origin.left, bottom: r.bottom - origin.top } : null;
  };
  let prior = null;
  for (const line of lines) {
    const paragraphs = new Map();
    for (const token of line.tokens) for (const entry of byItem.get(token.itemIndex) || []) {
      const id = entry.unit.paragraph_id;
      const part = paragraphs.get(id) || { entries: [], tokens: [], rects: [] };
      const rect = rectFor(token.itemIndex, entry.anchor.start, entry.anchor.end);
      if (!rect) continue;
      rect.sourceId = entry.unit.source_id;
      part.entries.push(entry); part.tokens.push(token); part.rects.push(rect); paragraphs.set(id, part);
    }
    for (const [paragraph, part] of paragraphs) {
      const tokens = [...new Set(part.tokens)];
      const text = tokens.map(t => t.str).join(' ');
      const words = text.match(/[A-Za-z]{3,}/g) || [];
      const math = (text.match(/[=∑∏∫√±×∈∂∇≤≥∞∥∝]/g) || []).length;
      const formula = (math >= 1 && words.length < 3) || (math >= 3 && words.length < 6);
      const gap = prior ? prior.line.y - line.y : Infinity;
      const columnBreak = prior && line.column !== prior.line.column && line.column !== 'full' && prior.line.column !== 'full';
      const indent = prior && line.x - prior.line.x > typical * .65 && /[.!?:)]$/.test(prior.line.tokens.at(-1)?.str.trim() || '');
      const breakRegion = !prior || prior.paragraph !== paragraph || columnBreak || gap < line.h * .4 || gap > Math.max(19, line.h * 1.8)
        || indent || formula !== prior.formula || Math.max(line.h, prior.line.h) > Math.min(line.h, prior.line.h) * 1.25;
      let region = breakRegion ? null : regions.at(-1);
      if (!region) {
        region = { paragraph, rects: [], ids: new Set(), fragments: new Map(), lines: [], formula, fontSize: line.h * scale };
        regions.push(region);
      }
      region.rects.push(...part.rects); region.lines.push({ ...line, text, tokens });
      part.entries.forEach(e => region.ids.add(e.unit.source_id));
      for (const entry of part.entries) {
        const fragments = region.fragments.get(entry.unit.source_id) || [];
        const token = tokens.find(t => t.itemIndex === entry.anchor.itemIndex);
        fragments.push(token.str.slice(entry.anchor.start, entry.anchor.end)); region.fragments.set(entry.unit.source_id, fragments);
      }
      prior = { line, paragraph, formula };
    }
  }
  for (const region of regions) {
    const rects = region.rects;
    region.left = Math.min(...rects.map(r => r.left)); region.right = Math.max(...rects.map(r => r.right));
    region.top = Math.min(...rects.map(r => r.top)); region.bottom = Math.max(...rects.map(r => r.bottom));
    const text = region.lines.map(l => l.text).join(' ');
    const words = text.match(/[A-Za-z]{3,}/g) || [];
    const isHeading = /^(?:\d+(?:\.\d+)*\.?\s*)?(?:abstract|introduction|conclusion[s]?|discussion|references|acknowledg\w*|method\w*|result[s]?|experiment\w*|background|related work|appendix)\b/i.test(text.trim());
    // Small diagram labels, numeric tables, author names and display equations
    // remain in the original canvas; captions and prose are replaceable.
    region.replaceable = !region.formula && (words.length >= 6 || isHeading || (region.fontSize > typical * scale * 1.15 && words.length >= 3));
    region.heading = region.fontSize > typical * scale * 1.2 || isHeading && words.length < 7;
    const fontNames = region.lines.flatMap(l => l.tokens.map(t => t.fontName));
    region.fontNames = [...new Set(fontNames)];
    region.centered = region.fontSize > typical * scale * 1.3 && Math.abs((region.left + region.right) / 2 - viewport.width / 2) < viewport.width * .1;
    region.ids = [...region.ids].sort((a, b) => units.indexOf(byId.get(a)) - units.indexOf(byId.get(b)));
  }
  // Never place Chinese into a box occupied by another text region. This also
  // catches difficult table cells and interleaved equation baselines.
  for (const region of regions) if (region.replaceable) {
    if (regions.some(other => other !== region && intersects(region, other) &&
      Math.min(region.right, other.right) - Math.max(region.left, other.left) > region.fontSize * .7 &&
      Math.min(region.bottom, other.bottom) - Math.max(region.top, other.top) > region.fontSize * .3)) region.replaceable = false;
  }
  return regions;
}

export class TranslatedPdfPane {
  constructor(container, onSelect, onExpand) { this.container = container; this.onSelect = onSelect; this.onExpand = onExpand; this.token = 0; this.nodes = []; }
  clear() { this.token++; this.renderTask?.cancel(); this.nodes = []; this.wrapper = null; this.container.replaceChildren(); }
  highlight(ids) {
    const active = new Set(ids); let first;
    for (const node of this.nodes) {
      const on = node.sourceIds.some(id => active.has(id)); node.classList.toggle('linked', on); node.setAttribute('aria-pressed', String(on));
      if (on && !first) first = node.closest('.layout-overflow') || node;
    }
    this.activeIds = ids;
    if (this.wrapper) {
      const root = this.wrapper.getBoundingClientRect(), rects = [];
      for (const node of this.nodes.filter(n => n.sourceIds.some(id => active.has(id)))) {
        const clip = node.closest('.layout-region')?.getBoundingClientRect() || root;
        for (const r of node.getClientRects()) {
          const left = Math.max(r.left, clip.left), top = Math.max(r.top, clip.top), right = Math.min(r.right, clip.right), bottom = Math.min(r.bottom, clip.bottom);
          if (right > left && bottom > top) rects.push({ x: (left - root.left) / root.width, y: (top - root.top) / root.height, w: (right - left) / root.width, h: (bottom - top) / root.height });
        }
      }
      paintFocus(this.wrapper, rects, this.focus);
    }
    return first;
  }
  setFocus(enabled) { this.focus = enabled; this.highlight(this.activeIds || []); }
  async render(pdf, number, units, groups, zoom = 1) {
    const token = ++this.token;
    this.renderTask?.cancel(); this.nodes = []; this.container.replaceChildren();
    const page = await pdf.getPage(number); if (token !== this.token) return;
    const base = page.getViewport({ scale: 1 });
    // Rotation needs a different reading-order model; preserve the page and
    // provide linked full translations instead of misplacing replacement text.
    const rotated = page.rotate % 360 !== 0;
    const width = this.pageWidth || Math.max(280, this.container.clientWidth - 16) * zoom;
    const viewport = page.getViewport({ scale: width / base.width });
    const wrapper = this.wrapper = document.createElement('div'); wrapper.className = 'pdf-page translated-page'; wrapper.lang = 'zh-CN';
    wrapper.style.width = viewport.width + 'px'; wrapper.style.height = viewport.height + 'px'; wrapper.style.setProperty('--scale-factor', String(viewport.scale));
    const canvas = document.createElement('canvas'), transform = preparePdfCanvas(canvas, viewport);
    const measurement = document.createElement('div'); measurement.className = 'textLayer layout-measurement'; measurement.setAttribute('aria-hidden', 'true');
    wrapper.append(canvas, measurement); this.container.append(wrapper);
    const context = canvas.getContext('2d');
    this.renderTask = page.render({ canvasContext: context, viewport, transform });
    try { await this.renderTask.promise; } catch (error) { if (error.name === 'RenderingCancelledException') return; throw error; }
    if (token !== this.token) return;
    const content = await page.getTextContent();
    const textLayer = new pdfjs.TextLayer({ textContentSource: content, container: measurement, viewport }); await textLayer.render();
    if (token !== this.token) return;
    const regions = pageRegions(content, number, units, viewport, textLayer.textDivs, wrapper);
    const groupById = new Map(); groups.forEach(g => g.source_ids.forEach(id => groupById.set(id, g)));
    const firstRegion = new Map();
    for (const region of regions) if (region.replaceable && !rotated) for (const id of region.ids) {
      const group = groupById.get(id); if (!firstRegion.has(group)) firstRegion.set(group, region);
    }
    const stats = { replaced: 0, overflow: 0, retained: 0, retainedTranslated: 0, rotated, page: number };
    const retainedGroups = new Set();
    const attach = (node, ids) => {
      node.sourceIds = ids; node.dataset.layoutIds = ids.join(' '); node.type = 'button'; this.nodes.push(node);
      if (node.tagName !== 'BUTTON') { node.setAttribute('role', 'button'); node.tabIndex = 0; node.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); node.click(); } }); }
      node.addEventListener('pointerdown', () => document.getSelection()?.removeAllRanges());
      node.addEventListener('click', () => this.onSelect(ids));
    };
    for (const region of regions) {
      const regionGroups = [...new Set(region.ids.map(id => groupById.get(id)).filter(Boolean))];
      const translated = regionGroups.some(g => g.translation);
      if (!translated || !region.replaceable || rotated) {
        stats.retained++;
        // Preserve graphics and equations. Transparent hit areas still allow
        // reverse navigation to the original sentence/group.
        for (const box of region.rects) {
          const id = box.sourceId, unit = units.find(u => u.source_id === id), group = groupById.get(id);
          const hit = document.createElement('button'); hit.className = 'layout-original-hit';
          Object.assign(hit.style, { left: box.left + 'px', top: box.top + 'px', width: box.right - box.left + 'px', height: box.bottom - box.top + 'px' });
          hit.setAttribute('aria-label', group?.translation || unit.text); hit.title = group?.translation ? '此处已译，版式保留原样 · 点击查看完整中文' : '尚未翻译 · 点击定位原文';
          attach(hit, group?.source_ids || [id]);
          if (group?.translation) {
            hit.dataset.retainedTranslation = 'true'; retainedGroups.add(group);
            hit.addEventListener('click', () => this.onExpand(group.source_ids));
          }
          wrapper.append(hit);
        }
        continue;
      }
      stats.replaced++;
      // Erase only extracted text strokes, leaving the page's images, vector
      // diagrams and equations on the rendered canvas intact.
      context.save(); context.scale(transform[0], transform[3]); context.fillStyle = '#fff';
      for (const r of region.rects) context.fillRect(r.left - .35, r.top - .25, r.right - r.left + .7, r.bottom - r.top + .5);
      context.restore();
      const block = document.createElement('div'); block.className = 'layout-region' + (region.heading ? ' heading' : '');
      block.dataset.paragraph = region.paragraph;
      const height = Math.max(region.bottom - region.top, region.fontSize * 1.18);
      Object.assign(block.style, { left: region.left + 'px', top: region.top + 'px', width: region.right - region.left + 'px', height: height + 'px', textAlign: region.centered ? 'center' : 'left' });
      const flow = document.createElement('div'); flow.className = 'layout-flow';
      try { if (region.fontNames.some(name => /bold|black|medium/i.test(page.commonObjs.get(name)?.name || ''))) block.classList.add('bold'); } catch {}
      const pageIds = new Set(region.ids);
      for (const group of regionGroups) {
        const node = document.createElement('span'); node.className = 'layout-sentence';
        const groupUnits = units.filter(u => group.source_ids.includes(u.source_id));
        // A merged/cross-page group's Chinese is never divided by punctuation
        // or distributed to English fragments by length.
        const startsHere = groupUnits[0]?.anchors[0]?.page === number && firstRegion.get(group) === region;
        const isContinuation = group.translation && !startsHere;
        if (isContinuation) { node.textContent = '…'; node.classList.add('continuation'); node.setAttribute('aria-label', '跨栏或跨页的完整译文'); node.title = '点击在阅读区查看完整句组'; }
        else node.textContent = group.translation || groupUnits.filter(u => pageIds.has(u.source_id)).map(u => (region.fragments.get(u.source_id) || []).join(' ')).join(' ');
        if (!group.translation) { node.classList.add('untranslated'); node.title = '尚未翻译'; }
        attach(node, group.source_ids);
        if (isContinuation) node.addEventListener('click', () => this.onExpand(group.source_ids));
        flow.append(node, document.createTextNode(' '));
      }
      block.append(flow); wrapper.append(block);
      const maxSize = region.fontSize * (region.heading ? .96 : .94), minSize = region.fontSize * .74;
      const fits = size => { block.style.fontSize = size + 'px'; return flow.getBoundingClientRect().height <= height + .5 && flow.scrollWidth <= block.clientWidth + 1; };
      let low = minSize, high = maxSize;
      if (!fits(maxSize)) {
        for (let i = 0; i < 7; i++) { const mid = (low + high) / 2; if (fits(mid)) low = mid; else high = mid; }
        fits(low);
      }
      if (flow.getBoundingClientRect().height > height + .5 || flow.scrollWidth > block.clientWidth + 1) {
        stats.overflow++; block.classList.add('layout-overflow'); block.dataset.overflow = 'true';
        block.title = '译文超出原栏位；点击句子，在右侧阅读区完整阅读';
        for (const node of flow.querySelectorAll('.layout-sentence')) node.addEventListener('click', () => this.onExpand(node.sourceIds));
      }
    }
    stats.retainedTranslated = retainedGroups.size;
    measurement.remove(); if (token !== this.token) return;
    wrapper.dataset.layoutReady = String(number); return stats;
  }
}
