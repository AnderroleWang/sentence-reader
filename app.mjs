import { APP_VERSION, textToUnits, newProject, demoProject, validateProject, mergeGroups, replaceGroups, planBatches } from './alignment.mjs';
import { loadPdf, extractPdf, PdfPane } from './pdf-reader.mjs';
import { TranslatedPdfPane } from './translated-pdf.mjs';
import { PdfDocumentPane } from './pdf-document.mjs';
import { importPairedFiles } from './paired-import.mjs';
import { ReadingTools } from './reading-tools.mjs';
import { termsFor, alignmentIssues } from './reading-data.mjs';

const $ = id => document.getElementById(id);
const defaultSettings = { protocol: 'compatible', baseUrl: '', model: '', domain: '', batch: 8, theme: 'paper', fontSize: 19, focus: true };
let settings = { ...defaultSettings };
try { settings = { ...settings, ...JSON.parse(localStorage.getItem('sentence-reader-settings') || '{}') }; } catch {}
let secret = '', project = null, pdf = null, translatedPdf = null, db = null, library = [];
const modelSessions = new Map();
let availableModels = [], modelsRequest = 0, modelsController = null;
let busy = false, translating = false, stopRequested = false, saveTimer, toastTimer, editMode = '', editGroupIndex = -1;
const readingBlocked = () => busy && !translating;
let sourceNodes = new Map(), targetNodes = new Map(), pdfRenderId = 0;
let selectionRequest = 0, pageRequest = 0;
const documentError = error => showError(new Error('PDF 显示失败：' + error.message));
const pdfPane = new PdfDocumentPane($('pdf-container'), host => new PdfPane(host, ids => selectIds(ids, 'pdf')), {
  onVisible: number => { if (project?.view === 'pdf') { project.page = number; updatePageControls(); saveSoon(); } }, onError: documentError
});
const translatedPane = new PdfDocumentPane($('translated-pdf-container'), host => new TranslatedPdfPane(host, ids => selectIds(ids, 'layout'), ids => expandLayout(ids)), {
  preview: true, onVisible: updateLayoutStatus, onRendered: updateLayoutStatus, onError: documentError
});
const pairedPane = new PdfDocumentPane($('translated-pdf-container'), host => new PdfPane(host, ids => selectIds(ids, 'layout')), {
  onVisible: number => { if (project && translatedPdf) { project.targetPage = number; saveSoon(); } }, onError: documentError
});
let targetRenderId = 0, targetRenderPromise = Promise.resolve();
for (const pane of [$('source-scroll'), $('target-scroll')]) for (const event of ['wheel', 'touchstart']) {
  pane.addEventListener(event, () => { selectionRequest++; pageRequest++; }, { passive: true });
}
const isLayout = () => !!pdf && project?.view === 'pdf' && project?.targetView === 'layout' && (!project.externalLayout || !!translatedPdf);
const sourcePages = unit => [...unit.anchors, ...(unit.pdfBoxes || [])];
const firstPage = unit => unit && sourcePages(unit)[0]?.page;

const readingTools = new ReadingTools({
  get: () => ({ project, pdf, translatedPdf, busy, domain: settings.domain, config: modelConfig() }),
  select: selectIds, save: saveSoon, toast, error: showError, targetView: setTargetView,
  refresh: (geometry = false) => {
    if (geometry) { pdfPane.invalidate(); pairedPane.invalidate(); }
    renderSource(); renderTargets(); renderHeader();
    if (project.view === 'pdf') renderPdf();
    selectIds(project.activeIds, 'restore', false);
  }
});

function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500); }
function showError(error) { $('error-message').textContent = error?.message || String(error); $('error-banner').hidden = false; }
function clearError() { $('error-banner').hidden = true; }
function activity(message) { $('activity').textContent = message; }
function persistSettings() {
  const safe = Object.fromEntries(Object.keys(defaultSettings).map(key => [key, settings[key]]));
  try { localStorage.setItem('sentence-reader-settings', JSON.stringify(safe)); } catch { toast('浏览器禁止保存设置；本次阅读仍可继续。'); }
  applyAppearance();
}
function applyAppearance() {
  document.documentElement.dataset.theme = ['paper', 'light', 'dark'].includes(settings.theme) ? settings.theme : 'paper';
  const fontSize = Math.min(28, Math.max(15, Number(settings.fontSize) || 19));
  document.documentElement.style.setProperty('--reading-size', fontSize + 'px');
  $('focus-mode').checked = !!settings.focus;
  $('reading-panes').classList.toggle('focus-reading', !!settings.focus);
  for (const pane of [pdfPane, translatedPane, pairedPane]) pane.setFocus(!!settings.focus);
}

async function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('sentence-reader', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('projects', { keyPath: 'id' });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}
function database(method, value) {
  if (!db) return Promise.resolve(method === 'getAll' ? [] : undefined);
  return new Promise((resolve, reject) => {
    const tx = db.transaction('projects', method === 'put' ? 'readwrite' : 'readonly');
    const request = tx.objectStore('projects')[method](value);
    let result;
    request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
async function saveProject() {
  clearTimeout(saveTimer);
  if (!project) return;
  if (!db) { $('save-state').textContent = '自动保存不可用，请导出档案'; return; }
  project.updatedAt = new Date().toISOString();
  if (project.view === 'pdf') {
    project.sourcePosition = pdfPane.capturePosition() || project.sourcePosition;
    if (isLayout()) project.targetPosition = (translatedPdf ? pairedPane : translatedPane).capturePosition() || project.targetPosition;
  }
  const snapshot = structuredClone(project);
  try {
    await database('put', snapshot);
    try { localStorage.setItem('sentence-reader-last', snapshot.id); } catch {}
    $('save-state').textContent = '已保存在此浏览器';
    const meta = { ...snapshot, pdfBlob: undefined, translatedPdfBlob: undefined };
    const old = library.findIndex(x => x.id === meta.id);
    if (old >= 0) library[old] = meta; else library.push(meta);
    renderLibrary();
  } catch { $('save-state').textContent = '自动保存失败，请导出档案'; showError(new Error('浏览器空间不足或无法保存，请先导出阅读档案。')); }
}
function saveSoon() { clearTimeout(saveTimer); $('save-state').textContent = '正在保存…'; saveTimer = setTimeout(saveProject, 500); }

function renderLibrary() {
  $('library').replaceChildren();
  const mobile = $('mobile-library'); mobile.replaceChildren();
  for (const item of [...library].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const button = document.createElement('button'); button.className = 'library-item' + (item.id === project?.id ? ' active' : '');
    button.disabled = busy;
    const title = document.createElement('strong'); title.textContent = item.title;
    const meta = document.createElement('small');
    const completed = item.groups.filter(g => g.translation).reduce((n, g) => n + g.source_ids.length, 0);
    meta.textContent = `${item.sourceType === 'pdf' ? 'PDF' : '正文'} · ${completed}/${item.units.length} 已译`;
    button.append(title, meta); button.addEventListener('click', () => switchProject(item.id).catch(showError)); $('library').append(button);
    const option = document.createElement('option'); option.value = item.id; option.textContent = item.title; mobile.append(option);
  }
  mobile.value = project?.id || ''; mobile.disabled = busy;
}
async function switchProject(id) {
  if (busy || id === project?.id) return;
  await saveProject();
  const value = await database('get', id);
  if (!value) return;
  await activateProject(value);
}
async function activateProject(value, alreadyLoadedPdf = null, alreadyLoadedTranslation = null) {
  clearError(); selectionRequest++; pageRequest++; pdfPane.clear(); translatedPane.clear(); pairedPane.clear(); pdfRenderId++; targetRenderId++;
  if (pdf && pdf !== alreadyLoadedPdf) await pdf.destroy();
  if (translatedPdf && translatedPdf !== alreadyLoadedTranslation) await translatedPdf.destroy();
  project = validateProject(value); pdf = alreadyLoadedPdf;
  translatedPdf = alreadyLoadedTranslation;
  if (project.pdfBlob && !pdf) {
    activity('正在打开原版 PDF…');
    try { pdf = await loadPdf(project.pdfBlob); } catch (error) { project.view = 'text'; showError(new Error('原版 PDF 无法打开，已保留正文和译文：' + error.message)); }
  }
  if (project.translatedPdfBlob && !translatedPdf) {
    try { translatedPdf = await loadPdf(project.translatedPdfBlob); }
    catch (error) { showError(new Error('中文 PDF 无法打开，已保留对应文字：' + error.message)); }
  }
  if (!pdf) project.view = 'text';
  if (!['text', 'reader', 'layout'].includes(project.targetView)) project.targetView = pdf ? 'layout' : 'text';
  const validIds = new Set(project.units.map(u => u.source_id));
  project.activeIds = (project.activeIds || []).filter(id => validIds.has(id));
  if (!project.activeIds.length) project.activeIds = [project.units[0].source_id];
  readingTools.update(true);
  renderSource(); renderTargets(); renderHeader(); renderLibrary();
  await setView(project.view || 'text', false);
  selectIds(project.activeIds, 'restore', false);
  activity(project.externalLayout ? '已打开外部排版 PDF · 双向对应关系来自映射文件，请核对语义' : project.isDemo ? '预置交互示例 · 第 4 句演示一句英文对应两句中文' : '已打开 · 翻译前请先检查原文顺序与分句');
  await saveProject();
}

function renderHeader() {
  $('paper-title').textContent = project.title; document.title = project.title + ' · 句读';
  $('paper-meta').textContent = `${project.sourceType === 'pdf' ? `${project.pageCount} 页 PDF` : '粘贴的正文'} · ${project.units.length} 个原文单元${project.isDemo ? ' · 自拟示例，译文已预置' : ''}`;
  $('view-pdf').hidden = !pdf;
  $('target-view-switch').hidden = !pdf;
  updateSummary();
}
function renderSource() {
  sourceNodes = new Map(); $('source-text').replaceChildren();
  let paragraph, currentParagraph = null;
  for (const unit of project.units) {
    if (unit.paragraph_id !== currentParagraph) {
      currentParagraph = unit.paragraph_id;
      paragraph = document.createElement('p'); paragraph.className = 'source-paragraph';
      if (firstPage(unit)) {
        const tag = document.createElement('button'); tag.className = 'page-tag'; tag.textContent = '第 ' + firstPage(unit) + ' 页';
        tag.addEventListener('click', async () => { project.page = firstPage(unit); await setView('pdf'); selectIds([unit.source_id], 'nav'); }); paragraph.append(tag);
      }
      $('source-text').append(paragraph);
    }
    const node = document.createElement('button'); node.className = 'source-sentence'; node.type = 'button'; node.dataset.sourceId = unit.source_id;
    node.textContent = unit.text; node.disabled = readingBlocked(); node.setAttribute('aria-label', '原文第 ' + (sourceNodes.size + 1) + ' 句：' + unit.text);
    node.addEventListener('pointerdown', () => document.getSelection()?.removeAllRanges());
    node.addEventListener('click', event => {
      if (event.detail === 0) document.getSelection()?.removeAllRanges();
      if (!readSourceSelection()) selectIds([unit.source_id], 'source');
    });
    paragraph.append(node, document.createTextNode(' ')); sourceNodes.set(unit.source_id, node);
  }
}
function renderTargets() {
  targetNodes = new Map(); $('target-text').replaceChildren();
  const checks = new Map(alignmentIssues(project).map(issue => [issue.ids[0], issue.reasons]));
  $('open-alignment').textContent = '对齐检查' + (checks.size ? ` · ${checks.size}` : '');
  const indices = new Map(project.units.map((u, i) => [u.source_id, i + 1]));
  for (const group of project.groups) {
    const article = document.createElement('article'); article.className = 'translation-group';
    article.dataset.groupId = group.source_ids[0];
    const meta = document.createElement('div'); meta.className = 'group-meta';
    const first = indices.get(group.source_ids[0]), last = indices.get(group.source_ids.at(-1));
    const where = document.createElement('span'); where.textContent = first === last ? `第 ${first} 句` : `第 ${first}–${last} 句 · 句组`; meta.append(where);
    const status = document.createElement('span');
    if (!group.translation) status.textContent = '待翻译';
    else if (group.reviewed) { status.textContent = '✓ 已人工核对'; status.className = 'reviewed-label'; }
    else if (group.needs_review) { status.textContent = '待核对'; status.className = 'warning-label'; }
    else status.textContent = '已生成';
    meta.append(status);
    if (group.translation && checks.has(group.source_ids[0]) && !group.needs_review) {
      const warning = document.createElement('span'); warning.className = 'warning-label'; warning.textContent = '检查提示'; warning.title = checks.get(group.source_ids[0]).join('；'); meta.append(warning);
    }
    const src = project.units.filter(u => group.source_ids.includes(u.source_id)).map(u => u.text).join(' ');
    article.classList.toggle('reader-heading', src.length < 100 && /^(?:\d+(?:\.\d+)*\.?\s+)?(?:abstract|introduction|conclusion[s]?|discussion|references|methods?|results?|\d+\.?\s)/i.test(src));
    article.dataset.paragraphId = project.units.find(u => u.source_id === group.source_ids[0])?.paragraph_id || '';
    const text = document.createElement('button'); text.type = 'button'; text.className = 'translation-content' + (group.translation ? '' : ' pending');
    text.disabled = readingBlocked(); text.textContent = group.translation || '等待翻译…';
    text.addEventListener('pointerdown', () => document.getSelection()?.removeAllRanges());
    text.addEventListener('click', () => selectIds(group.source_ids, 'target'));
    article.append(meta, text); $('target-text').append(article);
    for (const id of group.source_ids) targetNodes.set(id, article);
  }
  updateSummary(); updateHighlights(); readingTools.update(true);
  if (isLayout()) { translatedPane.invalidate(); renderTranslatedPdf(); }
}
function updateSummary() {
  const translated = project.groups.filter(g => g.translation).reduce((n, g) => n + g.source_ids.length, 0);
  const pendingReview = project.groups.filter(g => g.translation && g.needs_review && !g.reviewed).length;
  $('translation-summary').textContent = `已译 ${translated}/${project.units.length}${pendingReview ? ` · ${pendingReview} 组待核对` : ''}`;
  $('translation-summary').title = '已译表示已收到译文；论文版式中的公式或复杂区域可能保留原样，点击可查看完整中文。';
  $('translate').textContent = translated === project.units.length ? '全部已译' : '翻译未完成部分';
  $('translate').disabled = busy || project.externalLayout || translated === project.units.length;
}
function selectedGroups() { const ids = new Set(project.activeIds); return project.groups.filter(g => g.source_ids.some(id => ids.has(id))); }
function updateHighlights() {
  if (!project) return;
  const active = new Set(project.activeIds);
  const groupsById = new Map(project.groups.map(g => [g.source_ids[0], g]));
  for (const [id, node] of sourceNodes) { const on = active.has(id); node.classList.toggle('linked', on); node.setAttribute('aria-pressed', String(on)); node.disabled = readingBlocked(); }
  for (const node of new Set(targetNodes.values())) {
    const group = groupsById.get(node.dataset.groupId);
    const on = group.source_ids.some(id => active.has(id)); node.classList.toggle('linked', on);
    node.querySelector('button').setAttribute('aria-pressed', String(on)); node.querySelector('button').disabled = readingBlocked();
  }
  if (project.view === 'pdf') pdfPane.highlight(project.activeIds);
  if (isLayout()) { if (translatedPdf) pairedPane.highlight(project.activeIds); else translatedPane.highlight(project.activeIds); }
  const indices = project.activeIds.map(id => project.units.findIndex(u => u.source_id === id)).filter(n => n >= 0).sort((a, b) => a - b);
  const first = indices[0], last = indices.at(-1);
  $('position-label').textContent = `${first === last ? first + 1 : `${first + 1}–${last + 1}`} / ${project.units.length}`;
  $('previous-sentence').disabled = first <= 0; $('next-sentence').disabled = last >= project.units.length - 1;
  const groups = selectedGroups(), group = groups[0];
  $('selection-label').textContent = project.externalLayout ? `对应单元 ${first === last ? first + 1 : `${first + 1}–${last + 1}`} · ${project.units[first]?.pairLevel === 'region' ? '区域' : '句子 / 句组'}` : groups.length === 1 ? (first === last ? `原文第 ${first + 1} 句` : `原文第 ${first + 1}–${last + 1} 句`) : `已选择 ${indices.length} 个原文单元`;
  $('selection-note').textContent = groups.length > 1 ? '选择单个译文组可编辑对应关系。' : group?.reviewed ? '已人工核对' : group?.note || (group?.translation ? '编号已检查 · 语义尚未人工核对' : '尚未翻译');
  const editable = groups.length === 1 && !busy && !project.externalLayout;
  $('edit-translation').disabled = !editable;
  $('correct-source').disabled = !editable;
  $('review-group').disabled = groups.length !== 1 || busy || !group?.translation;
  $('review-group').textContent = group?.reviewed ? '取消核对标记' : '标记已核对';
  const index = project.groups.indexOf(group);
  $('merge-next').disabled = !editable || !group?.translation || !project.groups[index + 1]?.translation;
  $('split-group').hidden = !(group?.source_ids.length > 1);
  $('split-group').disabled = !editable;
  $('retranslate-group').disabled = !editable;
  readingTools.update();
}
async function selectIds(ids, origin = 'source', save = true) {
  if (!project) return;
  const selected = new Set(ids);
  for (const group of project.groups) if (group.source_ids.some(id => selected.has(id))) for (const id of group.source_ids) selected.add(id);
  const activeIds = project.units.filter(u => selected.has(u.source_id)).map(u => u.source_id);
  if (!activeIds.length) return;
  project.activeIds = activeIds; updateHighlights();
  const request = ++selectionRequest, current = project;
  const valid = () => request === selectionRequest && project === current;
  // Restoring, editing and resizing only repaint highlights. They must never
  // steal the reader's scroll position or complete an older navigation.
  if (origin !== 'restore') {
    const first = activeIds[0], jobs = [];
    if (isLayout()) {
      if (origin !== 'layout') jobs.push((async () => {
        await targetRenderPromise;
        if (valid()) await (translatedPdf ? pairedPane : translatedPane).reveal(activeIds, valid, origin === 'nav');
      })());
    } else if (origin !== 'target') targetNodes.get(first)?.scrollIntoView({ block: origin === 'nav' ? 'center' : 'nearest', behavior: 'instant' });
    if (origin !== 'source' && origin !== 'pdf') {
      if (project.view === 'pdf' && pdf) jobs.push(pdfPane.reveal(activeIds, valid, origin === 'nav'));
      else sourceNodes.get(first)?.scrollIntoView({ block: origin === 'nav' ? 'center' : 'nearest', behavior: 'instant' });
    }
    await Promise.all(jobs);
    if (valid() && isLayout() && !translatedPdf && $('reader-desk').hidden) {
      const retained = [...$('translated-pdf-container').querySelectorAll('[data-retained-translation]')].some(node => node.dataset.layoutIds.split(' ').some(id => activeIds.includes(id)));
      const clipped = settings.focus && [...$('translated-pdf-container').querySelectorAll('.layout-sentence')].some(node => node.dataset.layoutIds.split(' ').some(id => activeIds.includes(id)) && (node.closest('.layout-overflow') || node.classList.contains('continuation')));
      if (retained || clipped) readingTools.open('reading');
    }
  }
  if (save && valid()) saveSoon();
}
function readSourceSelection() {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
  const anchor = selection.anchorNode;
  if (!$('source-text').contains(anchor)) return false;
  const range = selection.getRangeAt(0), ids = [];
  for (const [id, node] of sourceNodes) if (range.intersectsNode(node)) ids.push(id);
  if (!ids.length) return false;
  selectIds(ids, 'source'); return true;
}
let selectionFrame;
document.addEventListener('selectionchange', () => {
  cancelAnimationFrame(selectionFrame); selectionFrame = requestAnimationFrame(() => {
    if (!project) return;
    const selection = document.getSelection();
    if (selection && !selection.isCollapsed && $('source-text').contains(selection.anchorNode)) readSourceSelection();
  });
});

function updatePageControls() {
  if (!pdf || !project) return;
  if (document.activeElement !== $('page-number')) $('page-number').value = project.page;
  $('page-number').max = pdf.numPages; $('page-total').textContent = '/ ' + pdf.numPages;
  $('pdf-zoom').value = String(project.pdfZoom || 1);
  $('previous-page').disabled = project.page <= 1; $('next-page').disabled = project.page >= pdf.numPages;
}
async function renderPdf() {
  if (!pdf || project.view !== 'pdf') return;
  const token = ++pdfRenderId, opening = !pdfPane.pdf;
  project.page = Math.max(1, Math.min(pdf.numPages, Number(project.page) || 1)); updatePageControls();
  const position = project.sourcePosition;
  try {
    await Promise.all([pdfPane.render(pdf, project.page, project.units, Number(project.pdfZoom) || 1, project.sourceCrops), renderTranslatedPdf()]);
    if (token !== pdfRenderId) return;
    if (opening && position) pdfPane.restorePosition(position);
    pdfPane.highlight(project.activeIds);
  } catch (error) { if (token === pdfRenderId) documentError(error); }
}
function renderTranslatedPdf() {
  if (!isLayout()) return Promise.resolve();
  const token = ++targetRenderId, position = project.targetPosition;
  $('layout-status').textContent = '连续阅读 · 正在打开中文页面…';
  targetRenderPromise = (async () => {
    try {
      const pane = translatedPdf ? pairedPane : translatedPane, opening = !pane.pdf;
      if (translatedPdf) {
        project.targetPage = Math.max(1, Math.min(translatedPdf.numPages, Number(project.targetPage) || 1));
        await pairedPane.render(translatedPdf, project.targetPage, project.units.map(u => ({ ...u, anchors: [], pdfBoxes: u.targetBoxes })), Number(project.pdfZoom) || 1, project.targetCrops);
      } else await translatedPane.render(pdf, project.page, project.units, Number(project.pdfZoom) || 1, null, project.groups);
      if (token !== targetRenderId) return;
      if (opening && position) pane.restorePosition(position);
      pane.highlight(project.activeIds);
      updateLayoutStatus();
    } catch (error) { if (token === targetRenderId) showError(new Error('中文版式显示失败，可切换“逐句”阅读：' + error.message)); }
  })();
  return targetRenderPromise;
}
function updateLayoutStatus() {
  if (!isLayout()) return;
  if (translatedPdf) { $('layout-status').textContent = '中文 PDF · 连续滚动 · 双向句子定位'; return; }
  const number = translatedPane.visiblePage || project.page || 1;
  const stats = translatedPane.records[number - 1]?.stats;
  $('layout-status').textContent = stats?.retainedTranslated
    ? `第 ${number} 页 · ${stats.retainedTranslated} 处已译内容保留原样，点击查看中文`
    : '连续滚动 · 图表与公式保留 · 放不下的译文可展开';
}
async function jumpPage(number) {
  if (!pdf || readingBlocked() || project?.view !== 'pdf') return;
  const request = ++pageRequest, current = project; selectionRequest++;
  number = Math.max(1, Math.min(pdf.numPages, Number(number) || 1));
  const valid = () => request === pageRequest && project === current;
  const jobs = [pdfPane.jump(number, valid)];
  if (isLayout()) {
    const unit = project.units.find(u => sourcePages(u).some(a => a.page === number));
    const targetPage = translatedPdf ? unit?.targetBoxes?.[0]?.page : number;
    if (targetPage) jobs.push((translatedPdf ? pairedPane : translatedPane).jump(targetPage, valid));
  }
  await Promise.all(jobs); if (valid()) { project.page = number; updatePageControls(); saveSoon(); }
}
function updateTargetView() {
  const layout = isLayout();
  $('target-text').hidden = layout; $('translated-pdf-container').hidden = !layout; $('layout-note').hidden = !layout;
  $('source-layout-note').hidden = !layout;
  $('target-text').classList.toggle('flow-reading', project.targetView === 'reader');
  for (const [id, on] of [['target-view-text', !layout && project.targetView !== 'reader'], ['target-view-reader', !layout && project.targetView === 'reader'], ['target-view-layout', layout]]) { $(id).classList.toggle('selected', on); $(id).setAttribute('aria-pressed', String(on)); }
  if (!layout) { targetRenderId++; translatedPane.clear(); pairedPane.clear(); }
}
async function setTargetView(view) {
  project.targetView = view === 'layout' && pdf ? 'layout' : view === 'reader' ? 'reader' : 'text';
  if (project.targetView === 'layout' && project.view !== 'pdf') await setView('pdf', false);
  else { updateTargetView(); await renderTranslatedPdf(); }
  selectIds(project.activeIds, 'restore', false); saveSoon();
}
function expandLayout(ids = project.activeIds) {
  if (ids.join('|') !== project.activeIds.join('|')) selectIds(ids, 'layout', false);
  readingTools.open('reading');
}
async function setView(view, save = true) {
  project.view = view === 'pdf' && pdf ? 'pdf' : 'text';
  $('source-text').hidden = project.view !== 'text'; $('pdf-container').hidden = project.view !== 'pdf'; $('pdf-navigation').hidden = project.view !== 'pdf';
  $('view-text').classList.toggle('selected', project.view === 'text'); $('view-text').setAttribute('aria-pressed', String(project.view === 'text'));
  $('view-pdf').classList.toggle('selected', project.view === 'pdf'); $('view-pdf').setAttribute('aria-pressed', String(project.view === 'pdf'));
  updateTargetView();
  if (project.view === 'pdf') await renderPdf(); else { pdfPane.clear(); updateHighlights(); }
  if (save) { selectIds(project.activeIds, 'nav'); saveSoon(); }
}

function setBusy(value) {
  busy = value;
  for (const id of ['import-pdf', 'import-text', 'import-project', 'import-paired', 'compact-pdf', 'compact-text', 'compact-paired', 'export-project', 'open-settings']) $(id).disabled = value;
  renderLibrary(); updateSummary(); updateHighlights();
}
function openSettings() {
  $('setting-protocol').value = settings.protocol; $('setting-url').value = settings.baseUrl;
  $('setting-model').value = settings.model; $('setting-key').value = secret; $('setting-domain').value = settings.domain;
  $('setting-batch').value = String(settings.batch); $('setting-theme').value = settings.theme; $('connection-result').textContent = '';
  resetModelList();
  $('settings-dialog').showModal();
}
function resetModelList() {
  modelsRequest++; modelsController?.abort(); modelsController = null; availableModels = [];
  $('setting-model-list').replaceChildren(); $('setting-model-list').hidden = true;
  $('setting-model-filter').value = ''; $('setting-model-filter').hidden = true; $('setting-model').hidden = false;
  $('load-models').disabled = false; $('load-models').textContent = '读取模型列表';
  $('model-list-status').textContent = '填写服务地址与密钥后读取；也可手动输入模型名称。';
}
function renderModelList() {
  const query = $('setting-model-filter').value.trim().toLowerCase(), current = $('setting-model').value.trim();
  const matches = availableModels.filter(name => name.toLowerCase().includes(query));
  const manual = document.createElement('option'); manual.value = ''; manual.textContent = '选择模型，或手动输入…';
  $('setting-model-list').replaceChildren(manual, ...matches.map(name => { const option = document.createElement('option'); option.value = name; option.textContent = name; return option; }));
  $('setting-model-list').value = matches.includes(current) ? current : '';
  $('setting-model').hidden = !!$('setting-model-list').value;
  $('model-list-status').textContent = query ? `匹配 ${matches.length} / ${availableModels.length} 个模型；可选择或手动输入。` : `已读取 ${availableModels.length} 个模型，请从列表选择；也可手动输入。`;
}
async function loadModelList() {
  if (!$('setting-url').value.trim()) { $('model-list-status').textContent = '请先填写服务地址。'; $('setting-url').focus(); return; }
  resetModelList(); const request = modelsRequest, controller = modelsController = new AbortController();
  $('load-models').disabled = true; $('load-models').textContent = '正在读取…'; $('model-list-status').textContent = '正在读取模型列表…';
  try {
    const response = await fetch('/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ config: modelConfig(formConfig()) }) });
    const result = await response.json();
    if (request !== modelsRequest) return;
    if (response.status === 404) throw new Error('请重启新版启动程序并刷新页面，再读取模型列表。');
    if (!response.ok) throw new Error(result.error || '读取失败，仍可手动输入模型名称。');
    if (!Array.isArray(result.models) || !result.models.every(name => typeof name === 'string' && name.trim())) throw new Error('模型列表格式暂不支持，仍可手动输入模型名称。');
    availableModels = result.models;
    if (!availableModels.length) { $('model-list-status').textContent = '服务返回了空列表，仍可手动输入模型名称。'; return; }
    $('setting-model-list').hidden = false; $('setting-model-filter').hidden = false; renderModelList();
  } catch (error) {
    if (request === modelsRequest && error.name !== 'AbortError') $('model-list-status').textContent = error.message || '读取失败，仍可手动输入模型名称。';
  } finally {
    if (request === modelsRequest) { modelsController = null; $('load-models').disabled = false; $('load-models').textContent = '重新读取'; }
  }
}
function formConfig() {
  return { protocol: $('setting-protocol').value, baseUrl: $('setting-url').value.trim(), model: $('setting-model').value.trim(), apiKey: $('setting-key').value.trim() };
}
function modelConfig(override = null) {
  const id = project?.id || 'connection-test';
  if (!modelSessions.has(id)) modelSessions.set(id, crypto.randomUUID());
  return { ...(override || { protocol: settings.protocol, baseUrl: settings.baseUrl, model: settings.model, apiKey: secret }), sessionId: modelSessions.get(id) };
}
async function requestTranslation(units, config = null) {
  const first = project.units.findIndex(u => u.source_id === units[0].source_id), last = first + units.length;
  const response = await fetch('/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceUnits: units.map(({ source_id, paragraph_id, text }) => ({ source_id, paragraph_id, text })),
      contextBefore: first >= 0 ? project.units.slice(Math.max(0, first - 4), first).map(u => u.text).join(' ') : '',
      contextAfter: first >= 0 ? project.units.slice(last, last + 4).map(u => u.text).join(' ') : '',
      domain: [settings.domain, ...termsFor(project, readingTools.personal).filter(t => !t.builtin).map(t => t.term + ' = ' + t.chinese + (t.meaning ? '（' + t.meaning + '）' : ''))].filter(Boolean).join('\n'), config: modelConfig(config) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '翻译失败');
  return result;
}
async function runTranslation(onlyGroup = null) {
  if (busy || project.externalLayout) return;
  if (!settings.baseUrl || !settings.model) { openSettings(); toast('先填写翻译服务地址和模型名称。'); return; }
  clearError(); stopRequested = false; translating = true; setBusy(true); $('stop-translate').hidden = false; $('stop-translate').disabled = false; $('stop-translate').textContent = '完成本批后停止';
  const batches = onlyGroup ? [project.units.filter(u => onlyGroup.source_ids.includes(u.source_id))] : planBatches(project, Number(settings.batch));
  let finished = 0;
  try {
    for (const batch of batches) {
      activity(`正在翻译 · 第 ${finished + 1}/${batches.length} 批 · 本批 ${batch.length} 个原文单元`);
      const result = await requestTranslation(batch);
      readingTools.record('AI 翻译');
      replaceGroups(project, batch.map(u => u.source_id), result.groups);
      renderTargets(); await selectIds(project.activeIds, 'restore', false); await saveProject();
      finished++;
      if (stopRequested) break;
    }
    activity(stopRequested ? '已暂停 · 已生成的译文已保留，可继续翻译未完成部分' : '本轮翻译完成 · 编号检查通过，语义仍需核对');
  } catch (error) { showError(error); activity('翻译已停止 · 已完成的批次保留，未通过检查的批次未写入'); }
  finally { translating = false; setBusy(false); $('stop-translate').hidden = true; }
}

async function importPdf(file) {
  if (!file || busy) return;
  if (file.size > 60 * 1024 * 1024) return showError(new Error('第一版支持 60 MB 以内的 PDF。'));
  await saveProject(); clearError(); setBusy(true);
  let loaded;
  try {
    activity('正在解析 PDF…'); loaded = await loadPdf(file);
    if (loaded.numPages > 250) throw new Error('第一版支持 250 页以内的 PDF。请先截取需要阅读的部分。');
    const units = await extractPdf(loaded, (page, total) => activity(`提取 PDF 正文 · ${page}/${total} 页`));
    const value = newProject(file.name.replace(/\.pdf$/i, ''), units, { sourceType: 'pdf', pdfBlob: file, pageCount: loaded.numPages, view: 'pdf' });
    await activateProject(value, loaded);
    activity(`已导入 ${loaded.numPages} 页、${units.length} 个原文单元 · 请先检查双栏顺序、公式附近文字，再翻译`);
    toast('PDF 已保存在此浏览器，可切换原版 / 正文检查识别结果。');
  } catch (error) { if (loaded && loaded !== pdf) await loaded.destroy(); showError(error); activity('PDF 导入失败，原有文档保留'); }
  finally { setBusy(false); $('pdf-file').value = ''; }
}

async function importPaired(files) {
  if (busy || !files.length) return;
  await saveProject(); clearError(); setBusy(true);
  let sourceDoc, targetDoc;
  try {
    activity('正在打开已排版 PDF 与坐标映射…');
    const value = await importPairedFiles(files);
    sourceDoc = await loadPdf(value.pdfBlob); targetDoc = await loadPdf(value.translatedPdfBlob);
    if (Math.max(sourceDoc.numPages, targetDoc.numPages) > 250) throw new Error('本版支持每份 PDF 250 页以内的对读包。');
    if (value.units.some(u => u.pdfBoxes.some(b => b.page > sourceDoc.numPages) || u.targetBoxes.some(b => b.page > targetDoc.numPages))) throw new Error('对应坐标引用的页码超出了 PDF 总页数，请检查是否选错文件。');
    value.pageCount = sourceDoc.numPages; value.targetPageCount = targetDoc.numPages;
    value.page = value.units[0].pdfBoxes[0].page; value.targetPage = value.units[0].targetBoxes[0].page;
    await activateProject(value, sourceDoc, targetDoc);
    activity(`已导入 ${value.units.length} 个对应单元 · ${value.pairFormat} · 请核对语义`);
    toast('已按 PDF 原始版式打开，可以双向点选对应区域。');
  } catch (error) {
    if (sourceDoc && sourceDoc !== pdf) await sourceDoc.destroy();
    if (targetDoc && targetDoc !== translatedPdf) await targetDoc.destroy();
    showError(error); activity('对读包未导入，请检查所选文件');
  } finally { setBusy(false); $('paired-files').value = ''; }
}

function openEditor(mode) {
  const groups = selectedGroups(); if (busy || project.externalLayout || groups.length !== 1) return;
  editMode = mode; const group = groups[0]; editGroupIndex = project.groups.indexOf(group);
  const units = project.units.filter(u => group.source_ids.includes(u.source_id));
  $('edit-source').textContent = units.map(u => u.text).join('\n'); $('edit-fields').replaceChildren();
  $('edit-title').textContent = mode === 'source' ? '修正识别的原文' : mode === 'split' ? '按原文拆分译文组' : '编辑译文';
  $('edit-reviewed-row').hidden = mode === 'source'; $('edit-reviewed').checked = !!group.reviewed;
  function field(label, value, sourceId, hint = '') {
    const wrapper = document.createElement('label'); wrapper.className = 'field'; const name = document.createElement('span'); name.textContent = label;
    const input = document.createElement('textarea'); input.rows = mode === 'split' ? 3 : 6; input.value = value; input.dataset.sourceId = sourceId || ''; input.required = true;
    wrapper.append(name, input); if (hint) { const small = document.createElement('small'); small.textContent = hint; wrapper.append(small); }
    $('edit-fields').append(wrapper);
  }
  if (mode === 'source') {
    units.forEach(u => field('原文 ' + (project.units.indexOf(u) + 1), u.text, u.source_id));
    const note = document.createElement('p'); note.className = 'muted'; note.textContent = '原版 PDF 的定位保留。保存修改后，本组旧译文会清空，需要重新翻译。'; $('edit-fields').prepend(note);
  } else if (mode === 'split') {
    units.forEach((u, i) => field('原文第 ' + (project.units.indexOf(u) + 1) + ' 句的译文', i === 0 ? group.translation : '', u.source_id, u.text));
  } else field('对应译文（可以包含多个中文句子）', group.translation, '');
  $('edit-dialog').showModal();
}

async function exportProject() {
  await saveProject();
  const value = structuredClone(project); delete value.pdfBlob; delete value.translatedPdfBlob;
  for (const [blobKey, base64Key] of [['pdfBlob', 'pdfBase64'], ['translatedPdfBlob', 'translatedPdfBase64']]) if (project[blobKey]) {
    if (blobKey === 'translatedPdfBlob' && project.sourceCrops) { value.sharedPdf = true; continue; }
    const bytes = new Uint8Array(await project[blobKey].arrayBuffer()); let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    value[base64Key] = btoa(binary);
  }
  const text = JSON.stringify({ format: 'sentence-reader-project', version: APP_VERSION, project: value });
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = project.title.replace(/[<>:"/\\|?*]/g, '_') + '.句读.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('档案已导出，包含原文、译文和对应关系；不包含密钥。');
}
async function importProject(file) {
  if (!file || busy) return;
  try {
    if (file.size > 200 * 1024 * 1024) throw new Error('档案过大，本版支持 200 MB 以内的档案。');
    const value = JSON.parse(await file.text());
    if (value.format !== 'sentence-reader-project' || value.version !== APP_VERSION) throw new Error('不是支持的句读阅读档案。');
    const imported = validateProject(value.project);
    for (const [blobKey, base64Key] of [['pdfBlob', 'pdfBase64'], ['translatedPdfBlob', 'translatedPdfBase64']]) if (imported[base64Key]) {
      const binary = atob(imported[base64Key]); const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
      imported[blobKey] = new Blob([bytes], { type: 'application/pdf' }); delete imported[base64Key];
    }
    if (imported.sharedPdf) imported.translatedPdfBlob = imported.pdfBlob;
    imported.id = crypto.randomUUID(); imported.title += '（导入）';
    await saveProject(); await activateProject(imported); toast('档案已导入。');
  } catch (error) { showError(error); }
  finally { $('project-file').value = ''; }
}

$('dismiss-error').onclick = clearError;
for (const button of document.querySelectorAll('.close-dialog')) button.addEventListener('click', () => button.closest('dialog').close());
$('import-pdf').onclick = $('compact-pdf').onclick = () => $('pdf-file').click();
$('import-text').onclick = $('compact-text').onclick = () => $('text-dialog').showModal();
$('import-paired').onclick = $('compact-paired').onclick = () => $('paired-dialog').showModal();
$('choose-paired').onclick = () => { $('paired-dialog').close(); $('paired-files').click(); };
$('open-layout-demo').onclick = async () => {
  $('paired-dialog').close();
  try { const response = await fetch('examples/layout-demo.句读.json'); if (!response.ok) throw new Error('版式演示文件未找到。'); await importProject(new File([await response.blob()], 'layout-demo.句读.json')); }
  catch (error) { showError(error); }
};
$('paired-files').onchange = () => importPaired($('paired-files').files);
$('import-project').onclick = () => $('project-file').click();
$('pdf-file').onchange = () => importPdf($('pdf-file').files[0]);
$('project-file').onchange = () => importProject($('project-file').files[0]);
$('open-settings').onclick = openSettings;
$('show-help').onclick = () => $('help-dialog').showModal();
$('export-project').onclick = () => exportProject().catch(showError);
$('mobile-library').onchange = () => switchProject($('mobile-library').value).catch(showError);
$('view-text').onclick = () => setView('text'); $('view-pdf').onclick = () => setView('pdf');
$('target-view-text').onclick = () => setTargetView('text'); $('target-view-layout').onclick = () => setTargetView('layout'); $('target-view-reader').onclick = () => setTargetView('reader');
$('layout-read').onclick = () => expandLayout();
$('previous-page').onclick = () => jumpPage(project.page - 1).catch(showError);
$('next-page').onclick = () => jumpPage(project.page + 1).catch(showError);
$('page-number').onchange = () => jumpPage($('page-number').value).catch(showError);
$('pdf-zoom').onchange = () => { project.pdfZoom = Number($('pdf-zoom').value); renderPdf(); saveSoon(); };
$('previous-sentence').onclick = () => { document.getSelection()?.removeAllRanges(); const first = project.units.findIndex(u => u.source_id === project.activeIds[0]); if (first > 0) selectIds([project.units[first - 1].source_id], 'nav'); };
$('next-sentence').onclick = () => { document.getSelection()?.removeAllRanges(); const last = project.units.findIndex(u => u.source_id === project.activeIds.at(-1)); if (last < project.units.length - 1) selectIds([project.units[last + 1].source_id], 'nav'); };
$('previous-sentence').title = '上一句 · ↑ / ← / K'; $('next-sentence').title = '下一句 · ↓ / → / J'; $('font-minus').title = '减小字号'; $('font-plus').title = '增大字号';
document.addEventListener('keydown', event => {
  if (!project || readingBlocked() || event.isComposing || event.ctrlKey || event.metaKey || event.shiftKey || document.querySelector('dialog[open]')) return;
  if (event.target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return;
  const key = event.key.toLowerCase();
  const next = (!event.altKey && (key === 'j' || event.key === 'ArrowDown' || event.key === 'ArrowRight')) || (event.altKey && event.key === 'ArrowDown');
  const previous = (!event.altKey && (key === 'k' || event.key === 'ArrowUp' || event.key === 'ArrowLeft')) || (event.altKey && event.key === 'ArrowUp');
  if (!next && !previous) return;
  event.preventDefault();
  const button = $(next ? 'next-sentence' : 'previous-sentence');
  if (!button.disabled) button.click();
});
$('font-minus').onclick = () => { settings.fontSize = Math.max(15, settings.fontSize - 1); persistSettings(); };
$('font-plus').onclick = () => { settings.fontSize = Math.min(28, settings.fontSize + 1); persistSettings(); };
$('focus-mode').onchange = () => { settings.focus = $('focus-mode').checked; persistSettings(); };
$('translate').onclick = () => runTranslation();
$('stop-translate').onclick = () => { stopRequested = true; $('stop-translate').disabled = true; $('stop-translate').textContent = '正在等待当前批次…'; };
$('edit-translation').onclick = () => openEditor('translation'); $('correct-source').onclick = () => openEditor('source'); $('split-group').onclick = () => openEditor('split');
$('merge-next').onclick = () => {
  const group = selectedGroups()[0]; if (!group) return;
  try { readingTools.record('合并句组'); const index = project.groups.indexOf(group); project.groups = mergeGroups(project.groups, index); renderTargets(); selectIds(project.groups[index].source_ids, 'target'); saveSoon(); }
  catch (error) { showError(error); }
};
$('review-group').onclick = () => { const group = selectedGroups()[0]; if (!group?.translation) return; readingTools.record('核对标记'); group.reviewed = !group.reviewed; renderTargets(); saveSoon(); };
$('retranslate-group').onclick = () => { const group = selectedGroups()[0]; if (group && (!group.translation || confirm('重新翻译会替换本组现有译文。继续吗？'))) runTranslation(group); };
$('text-form').onsubmit = async event => {
  event.preventDefault(); if (busy) return;
  const text = $('text-input').value.trim(); if (text.length > 1000000) return showError(new Error('第一版支持 100 万字符以内的正文。'));
  const units = textToUnits(text); if (!units.length) return;
  await saveProject(); await activateProject(newProject($('text-title').value.trim() || '粘贴的论文正文', units));
  $('text-dialog').close(); $('text-input').value = ''; $('text-title').value = ''; toast('正文已导入，可以配置服务并开始翻译。');
};
$('settings-form').onsubmit = event => {
  event.preventDefault(); const config = formConfig();
  settings = { ...settings, protocol: config.protocol, baseUrl: config.baseUrl, model: config.model,
    domain: $('setting-domain').value.trim(), batch: Number($('setting-batch').value), theme: $('setting-theme').value };
  secret = config.apiKey; persistSettings(); $('settings-dialog').close(); toast('设置已保存。密钥仅保留在当前页面内存中。');
};
$('setting-protocol').onchange = () => {
  if ($('setting-protocol').value === 'ollama' && !$('setting-url').value) $('setting-url').value = 'http://127.0.0.1:11434';
  resetModelList();
};
for (const id of ['setting-url', 'setting-key']) $(id).addEventListener('input', resetModelList);
$('load-models').onclick = loadModelList;
$('setting-model-filter').oninput = renderModelList;
$('setting-model-filter').onkeydown = event => { if (event.key === 'Enter') event.preventDefault(); };
$('setting-model-list').onchange = () => {
  const value = $('setting-model-list').value;
  if (value) $('setting-model').value = value;
  $('setting-model').hidden = !!value;
  if (!value) $('setting-model').focus();
};
$('settings-dialog').addEventListener('close', resetModelList);
$('test-connection').onclick = async () => {
  $('test-connection').disabled = true; $('connection-result').textContent = '正在请求一个简短的翻译测试…';
  try { const result = await requestTranslation([{ source_id: 'connection_test', text: 'This is a connection test.', paragraph_id: 'test' }], formConfig()); $('connection-result').textContent = '连接成功，编号检查通过。\n' + result.groups[0].translation; }
  catch (error) { $('connection-result').textContent = error.message; }
  finally { $('test-connection').disabled = false; }
};
$('edit-form').onsubmit = event => {
  event.preventDefault();
  const group = project.groups[editGroupIndex]; if (!group) return;
  const fields = [...$('edit-fields').querySelectorAll('textarea')];
  if (fields.some(field => !field.value.trim())) return;
  readingTools.record(editMode === 'source' ? '修正原文' : editMode === 'split' ? '拆分句组' : '编辑译文');
  if (editMode === 'source') {
    let changed = false;
    for (const field of fields) { const unit = project.units.find(u => u.source_id === field.dataset.sourceId); if (unit.text !== field.value.trim()) { unit.text = field.value.trim(); changed = true; } }
    if (changed) replaceGroups(project, group.source_ids, group.source_ids.map(id => ({ source_ids: [id], translation: '', needs_review: false, note: '' })));
    renderSource();
  } else if (editMode === 'split') {
    project.groups.splice(editGroupIndex, 1, ...fields.map(field => ({ source_ids: [field.dataset.sourceId], translation: field.value.trim(), reviewed: $('edit-reviewed').checked, needs_review: !$('edit-reviewed').checked, note: '手动拆分的译文。' })));
  } else {
    group.translation = fields[0].value.trim(); group.reviewed = $('edit-reviewed').checked;
    if (!group.reviewed) { group.needs_review = true; group.note = '译文已手动修改，尚未确认。'; }
  }
  renderTargets(); selectIds(project.activeIds, 'restore'); saveSoon(); $('edit-dialog').close();
};
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(async () => { if (project?.view === 'pdf') await renderPdf(); if (project) selectIds(project.activeIds, 'restore', false); }, 200); });
function watchDisplayResolution() {
  const display = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  display.addEventListener('change', () => { watchDisplayResolution(); window.dispatchEvent(new Event('resize')); }, { once: true });
}
watchDisplayResolution();
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } else if (saveTimer) saveProject(); });
window.addEventListener('unhandledrejection', event => { showError(event.reason); });

async function initialize() {
  applyAppearance();
  if (location.protocol === 'file:') return showError(new Error('请双击 start.cmd 启动本机服务，不要直接打开 index.html。'));
  try { db = await openDatabase(); library = await database('getAll'); } catch { showError(new Error('浏览器不允许自动保存，请在关闭前导出档案。')); }
  let last;
  try { last = localStorage.getItem('sentence-reader-last'); } catch {}
  if (new URLSearchParams(location.search).get('demo') === 'layout') {
    const existing = library.find(item => item.layoutDemo);
    if (existing) await activateProject(existing);
    else { const response = await fetch('examples/layout-demo.句读.json'); if (!response.ok) throw new Error('版式演示文件未找到。'); await importProject(new File([await response.blob()], 'layout-demo.句读.json')); }
    return;
  }
  await activateProject(library.find(item => item.id === last) || library[0] || demoProject());
}
initialize().catch(showError);
