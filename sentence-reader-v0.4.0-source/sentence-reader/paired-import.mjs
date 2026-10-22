// Interoperable coordinate formats documented by SideBySide PDF Translation
// Reader and Zotero Bilingual. No sentence links are inferred during import.
import { newProject } from './alignment.mjs';

const fail = message => { throw new Error('对读包：' + message); };
const finite = value => typeof value === 'number' && Number.isFinite(value);
const filename = name => String(name || '').split(/[\\/]/).at(-1);
function pageNumber(value) { if (!Number.isInteger(value) || value < 1 || value > 10000) fail('映射页码无效。'); return value; }
function boxes(values, page) {
  if (!Array.isArray(values) || !values.length || values.length > 10000) fail('对应区域缺少坐标。');
  return values.map(box => {
    if (!box || !['x','y','w','h'].every(key => finite(box[key])) || box.x < -.001 || box.y < -.001 || box.w <= 0 || box.h <= 0 || box.x + box.w > 1.001 || box.y + box.h > 1.001) fail('坐标必须在页面内，且是 0–1 的归一化坐标。');
    return { page: pageNumber(page), x: Math.max(0, box.x), y: Math.max(0, box.y), w: Math.min(box.w, 1 - Math.max(0, box.x)), h: Math.min(box.h, 1 - Math.max(0, box.y)) };
  });
}
function text(value, fallback) { if (value != null && typeof value !== 'string') fail('原文或译文必须是文字。'); if (value?.length > 50000) fail('单个对应单元过长。'); return value?.trim() || fallback; }
function fileByName(files, name) {
  const matches = files.filter(file => file.name === filename(name));
  if (matches.length !== 1) fail('请同时选择文件，且文件名不能重复：' + filename(name));
  return matches[0];
}
function assemble(rows, title, extra) {
  if (!rows.length || rows.length > 100000) fail('映射中没有可用的双向对应区域，或数量过多。');
  const units = rows.map((row, i) => ({ source_id: 's' + String(i + 1).padStart(6, '0'), paragraph_id: row.paragraph || 'p' + i,
    text: row.en, anchors: [], pdfBoxes: row.source, targetBoxes: row.target, pairId: row.id, pairLevel: row.level }));
  const value = newProject(title, units, { sourceType: 'pdf', view: 'pdf', targetView: 'layout', externalLayout: true, ...extra });
  value.groups = rows.map((row, i) => ({ source_ids: [units[i].source_id], translation: row.zh, needs_review: true, reviewed: false,
    note: row.score != null ? `外部坐标映射 · 语义相似度 ${row.score.toFixed(3)}，不代表准确率，请人工核对` : '外部坐标映射 · 对应关系来自文件，尚未人工核对' }));
  return value;
}
export function fromSideBySide(data, files) {
  if (!Array.isArray(data.pairs) || !data.source_file || !data.translated_file) fail('缺少 source_file、translated_file 或 pairs。');
  const seen = new Set();
  const rows = data.pairs.map((pair, i) => {
    if (!pair || typeof pair.id !== 'string' || !pair.id || seen.has(pair.id)) fail('对应区域的编号为空或重复。'); seen.add(pair.id);
    if (!pair.source || !pair.target) fail('对应区域缺少原文或译文。');
    return { id: pair.id, paragraph: 'p' + i, level: pair.level === 'sentence' ? 'sentence' : 'region',
      en: text(pair.source.text, '原文区域（图表或公式）'), zh: text(pair.target.text, '译文区域（图表或公式，见 PDF）'),
      source: boxes(pair.source.boxes, pair.source.page), target: boxes(pair.target.boxes, pair.target.page) };
  });
  return assemble(rows, filename(data.source_file).replace(/\.pdf$/i, ''), { pairFormat: 'SideBySide alignment.json',
    pdfBlob: fileByName(files, data.source_file), translatedPdfBlob: fileByName(files, data.translated_file) });
}
export function fromZotero(data, files) {
  if (![2,3,4].includes(data.version) || !Array.isArray(data.pages) || !Array.isArray(data.segments)) fail('支持带明确 sentencePairs 的 Zotero 映射 v2–v4。');
  const pages = new Map(), sourceCrops = {}, targetCrops = {};
  for (const page of data.pages) {
    if (!Number.isInteger(page.pageIndex) || page.pageIndex < 0 || !finite(page.width) || !finite(page.height) || page.height <= 0 || !finite(page.rightOffset) || page.rightOffset <= 0 || page.rightOffset >= page.width || pages.has(page.pageIndex)) fail('双语 PDF 页面尺寸无效。');
    if (page.leftLanguage != null && !['en','zh'].includes(page.leftLanguage)) fail('不支持的页面语言方向。');
    const left = { x: 0, y: 0, w: page.rightOffset / page.width, h: 1 }, right = { x: left.w, y: 0, w: 1 - left.w, h: 1 };
    const englishLeft = page.leftLanguage === 'en';
    sourceCrops[page.pageIndex + 1] = englishLeft ? left : right; targetCrops[page.pageIndex + 1] = englishLeft ? right : left;
    pages.set(page.pageIndex, page);
  }
  const normalized = (rects, page, crop) => {
    if (!Array.isArray(rects) || !rects.length) fail('句子对应关系缺少矩形坐标。');
    return boxes(rects.map(rect => {
      if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(finite)) fail('PDF 坐标无效。');
      const x0 = Math.min(rect[0], rect[2]), x1 = Math.max(rect[0], rect[2]);
      const y0 = Math.min(rect[1], rect[3]), y1 = Math.max(rect[1], rect[3]);
      return { x: (x0 / page.width - crop.x) / crop.w, y: (page.height - y1) / page.height, w: (x1 - x0) / page.width / crop.w, h: (y1 - y0) / page.height };
    }), page.pageIndex + 1);
  };
  const rows = [], seen = new Set();
  for (const [segmentIndex, segment] of data.segments.entries()) {
    const page = pages.get(segment.pageIndex); if (!page) fail('段落引用了不存在的页面。');
    // Prefer explicit sentence pairs; older paragraph-only maps remain honest
    // region links. Never use proportional sentence-index matching.
    const pairs = segment.sentencePairs?.length ? segment.sentencePairs : [{ enText: segment.en, zhText: segment.zh, enRects: segment.enBox && [segment.enBox], zhRects: segment.zhBox && [segment.zhBox] }];
    for (const [i, pair] of pairs.entries()) {
      const id = `${segment.id || segmentIndex}:${pair.pairIndex ?? i}`;
      if (seen.has(id)) fail('句子对应编号重复。'); seen.add(id);
      rows.push({ id, paragraph: 'p' + segmentIndex, level: segment.sentencePairs?.length ? 'sentence' : 'region',
        en: text(pair.enText, '原文区域'), zh: text(pair.zhText, '译文区域'),
        source: normalized(pair.enRects || (pair.enBox && [pair.enBox]), page, sourceCrops[page.pageIndex + 1]),
        target: normalized(pair.zhRects || (pair.zhBox && [pair.zhBox]), page, targetCrops[page.pageIndex + 1]),
        score: finite(pair.semanticScore) ? pair.semanticScore : null });
    }
  }
  const pdfFiles = files.filter(file => /\.pdf$/i.test(file.name));
  const file = data.compareFile ? fileByName(files, data.compareFile) : pdfFiles.length === 1 ? pdfFiles[0] : fail('请选择映射对应的那一份双语 PDF。');
  return assemble(rows, file.name.replace(/\.pdf$/i, ''), { pairFormat: 'Zotero Bilingual map v' + data.version,
    pdfBlob: file, translatedPdfBlob: file, sourceCrops, targetCrops });
}
export async function importPairedFiles(files) {
  files = Array.from(files);
  if (files.length < 2 || files.length > 10) fail('请选择一个对读包中的 PDF 和 JSON 文件。');
  const maps = files.filter(file => /\.json$/i.test(file.name));
  if (maps.length !== 1 || maps[0].size > 15 * 1024 * 1024) fail('请只选择一个对应关系 JSON（不超过 15 MB）。');
  const data = JSON.parse(await maps[0].text());
  if (!data || typeof data !== 'object') fail('对应关系不是有效的 JSON 对象。');
  const value = Array.isArray(data.pairs) ? fromSideBySide(data, files) : fromZotero(data, files);
  for (const blob of [value.pdfBlob, value.translatedPdfBlob]) {
    if (blob.size > 60 * 1024 * 1024) fail('每个 PDF 需要在 60 MB 以内。');
    if (!new TextDecoder().decode(await blob.slice(0, 1024).arrayBuffer()).includes('%PDF-')) fail(blob.name + ' 不是有效的 PDF 文件。');
  }
  return value;
}
