import { EditHistory, alignmentIssues, pagesOf, sourceText, ensureFragments, normalizeRange, applyPairing, validatePairing, termsFor, findTerms, exportNotes, referenceMentions, referenceCandidates } from './reading-data.mjs';
import { PdfPane, orderLines } from './pdf-reader.mjs';
const $ = id => document.getElementById(id);
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; };
const button = (text, action, cls) => { const node = el('button', text, cls); node.type = 'button'; node.onclick = action; return node; };
const field = (text, input) => { const label = el('label', null, 'field'); label.append(el('span', text), input); return label; };
const download = (name, text, type = 'application/json') => { const url = URL.createObjectURL(new Blob([text], { type })); const a = el('a'); a.href = url; a.download = name.replace(/[<>:"/\\|?*]/g, '_'); a.click(); setTimeout(() => URL.revokeObjectURL(url), 3000); };
const tabs = [['reading', '全文'], ['alignment', '对齐'], ['explain', '难句'], ['terms', '术语'], ['references', '图表'], ['notes', '笔记']];
export class ReadingTools {
  constructor(host) {
    this.host = host; this.histories = new Map(); this.tab = 'reading'; this.personal = []; this.explainPending = new Set(); this.explainErrors = new Map();
    try { const data = JSON.parse(localStorage.getItem('sentence-reader-glossary') || '[]'); if (Array.isArray(data)) this.personal = data.filter(t => t && typeof t.term === 'string' && t.term && typeof t.chinese === 'string'); } catch {}
    for (const [id, label] of tabs) $('desk-tabs').append(button(label, () => this.open(id)));
    for (const [id, tab] of Object.entries({ 'open-reading': 'reading', 'open-alignment': 'alignment', 'open-explain': 'explain', 'open-terms': 'terms', 'open-references': 'references', 'open-notes': 'notes' })) $(id).onclick = () => this.open(tab);
    $('desk-close').onclick = () => this.close();
    $('desk-expand').onclick = () => { $('reader-desk').classList.toggle('desk-expanded'); this.resize(); };
    $('desk-width').oninput = () => { $('reader-desk').style.width = $('desk-width').value + 'px'; this.resize(); };
    $('undo-edit').onclick = () => this.undo('undo'); $('redo-edit').onclick = () => this.undo('redo');
    document.addEventListener('keydown', event => {
      if (event.isComposing || event.target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'z' && !document.querySelector('dialog[open]') && !this.host.get().busy) {
        event.preventDefault(); this.undo(event.shiftKey ? 'redo' : 'undo');
      } else if (event.key === 'Escape' && !document.querySelector('dialog[open]')) this.close();
    });
    this.tooltip = el('div', null, 'term-tooltip'); this.tooltip.id = 'term-tooltip'; this.tooltip.role = 'tooltip'; this.tooltip.hidden = true; document.body.append(this.tooltip);
    document.addEventListener('pointermove', event => this.hoverTerm(event));
    document.addEventListener('focusin', event => { if (event.target.matches?.('.glossary-term')) this.showTerm(event.target.dataset.term, event.target.getBoundingClientRect()); });
    document.addEventListener('scroll', () => { this.tooltip.hidden = true; }, true);
    document.addEventListener('click', event => this.referenceClick(event), true);
    document.addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.reference-link')) { event.preventDefault(); event.stopPropagation(); this.previewReference({ kind: event.target.dataset.kind, number: event.target.dataset.number, text: event.target.textContent }); } });
    this.observer = new MutationObserver(() => { clearTimeout(this.decorateTimer); this.decorateTimer = setTimeout(() => this.decorate(), 80); });
    this.observer.observe($('reading-panes'), { childList: true, subtree: true });
  }
  get project() { return this.host.get().project; }
  get history() { const id = this.project.id; if (!this.histories.has(id)) this.histories.set(id, new EditHistory()); return this.histories.get(id); }
  resize() { window.dispatchEvent(new Event('resize')); }
  record(label) { this.history.record(this.project, label); this.history.undoStack.at(-1).personal = structuredClone(this.personal); this.updateHistory(); }
  updateHistory() { if (!this.project) return; $('undo-edit').disabled = this.host.get().busy || !this.history.undoStack.length; $('redo-edit').disabled = this.host.get().busy || !this.history.redoStack.length; }
  undo(direction) {
    if (this.host.get().busy) return;
    const from = direction === 'undo' ? this.history.undoStack : this.history.redoStack, personal = from.at(-1)?.personal, before = structuredClone(this.personal);
    const label = this.history.move(this.project, direction); if (!label) return;
    (direction === 'undo' ? this.history.redoStack : this.history.undoStack).at(-1).personal = before;
    if (personal) { this.personal = personal; try { localStorage.setItem('sentence-reader-glossary', JSON.stringify(this.personal)); } catch {} }
    this.host.refresh(true); this.host.save(); this.update(true); this.host.toast((direction === 'undo' ? '已撤销：' : '已重做：') + label);
  }
  open(tab = 'reading') {
    if (!this.project) return;
    const wasHidden = $('reader-desk').hidden;
    $('reader-desk').hidden = false; this.tab = tab; this.selectionKey = ''; this.update(true);
    if (wasHidden) this.resize();
  }
  close() { if ($('reader-desk').hidden) return; $('reader-desk').hidden = true; $('reader-desk').classList.remove('desk-expanded'); this.resize(); }
  update(force = false) {
    if (!this.project) return;
    this.updateHistory();
    if (this.projectId !== this.project.id) { this.projectId = this.project.id; this.selectionKey = ''; this.referenceToken = (this.referenceToken || 0) + 1; this.referenceDialog?.close(); }
    const signature = this.project.id + ':' + this.project.activeIds.join('|');
    if (signature !== this.selectionKey) this.noteEditId = null;
    if ($('reader-desk').hidden || !force && signature === this.selectionKey) return;
    if (signature === this.selectionKey && $('desk-body').contains(document.activeElement) && document.activeElement.matches('input,textarea,select')) return;
    this.selectionKey = signature;
    $('desk-title').textContent = { reading: '完整阅读', alignment: '对应关系检查', explain: '结合上下文理解', terms: '术语与缩写', references: '图表与公式', notes: '双语批注' }[this.tab];
    [...$('desk-tabs').children].forEach((node, i) => { node.classList.toggle('selected', tabs[i][0] === this.tab); node.setAttribute('aria-pressed', String(tabs[i][0] === this.tab)); });
    $('desk-body').replaceChildren();
    this['render_' + this.tab](); this.decorate();
  }
  selected() { return this.project.groups.filter(g => g.source_ids.some(id => this.project.activeIds.includes(id))); }
  excerpt(container, ids = this.project.activeIds) {
    const units = this.project.units.filter(u => ids.includes(u.source_id));
    const meta = el('div', '原文第 ' + units.map(u => this.project.units.indexOf(u) + 1).join('、') + ' 句 · ' + ([...new Set(units.flatMap(pagesOf))].map(p => 'p.' + p).join(' / ') || '网页正文'), 'desk-meta');
    container.append(meta, el('p', units.map(u => u.text).join('\n'), 'desk-source'));
  }
  render_reading() {
    const body = $('desk-body');
    body.append(el('p', '↑ ↓ 逐句阅读 · Esc 收起 · 可拖动上方滑杆调宽', 'muted'));
    for (const group of this.selected()) {
      const article = el('article', null, 'desk-reading'); this.excerpt(article, group.source_ids);
      article.append(el('p', group.translation || '尚未翻译', 'full-translation'));
      for (const note of (this.project.notes || []).filter(n => n.source_ids.some(id => group.source_ids.includes(id)))) article.append(el('p', '批注：' + note.text, 'desk-note'));
      body.append(article);
    }
    body.append(button('连续阅读全文 → 舒展阅读', () => { this.host.targetView('reader'); this.close(); }, 'primary'));
  }
  render_alignment() {
    const body = $('desk-body'), issues = alignmentIssues(this.project);
    body.append(el('p', '检查漏译、长度、数值及已有警告。提示需要核对，不等于已判断语义正确。', 'muted'),
      button('重新配对 / 合并 / 拆分…', () => this.openPairing(), 'primary'), el('p', issues.length + ' 组检查提示', 'desk-meta'));
    for (const issue of issues.slice(0, 500)) {
      const first = this.project.units.findIndex(u => u.source_id === issue.ids[0]) + 1;
      const row = button('第 ' + first + ' 句 · ' + issue.reasons.join('；'), () => this.host.select(issue.ids, 'nav'), 'issue-item');
      row.dataset.issueId = issue.ids[0]; body.append(row);
    }
    if (!issues.length) body.append(el('p', '未发现上述规则可识别的问题；语义仍可逐句核对。', 'muted'));
  }
  openPairing() {
    if (this.host.get().busy) return;
    ensureFragments(this.project);
    const p = this.project;
    const dialog = this.pairDialog ||= el('dialog', null, 'pairing-dialog'); dialog.id = 'pairing-dialog'; dialog.replaceChildren(); if (!dialog.isConnected) document.body.append(dialog);
    const head = el('div', null, 'dialog-heading'); head.append(el('h2', '调整对应关系'), button('×', () => dialog.close())); dialog.append(head);
    dialog.append(el('p', p.externalLayout ? '选择中文 PDF 中已有片段重新配对。合并时可选多个片段；原 PDF 内容保留。每个片段只使用一次。' : '原文范围例如 3 或 3-5。可交换译文、添加一行拆分，或合成一行组成句组；按编号完整覆盖编辑区。', 'muted'));
    const start = el('input'), end = el('input'); start.type = end.type = 'number'; start.min = end.min = 1; start.max = end.max = p.units.length;
    const selected = this.selected(), firstGroup = p.groups.indexOf(selected[0]), lastGroup = Math.min(p.groups.length - 1, p.groups.indexOf(selected.at(-1)) + 1);
    start.value = p.units.findIndex(u => u.source_id === selected[0].source_ids[0]) + 1; end.value = p.units.findIndex(u => u.source_id === p.groups[lastGroup].source_ids.at(-1)) + 1;
    const scopeFields = el('div', null, 'settings-row'); scopeFields.append(field('编辑区起始句', start), field('编辑区结束句', end)); dialog.append(scopeFields);
    const editor = el('div'); editor.id = 'pairing-rows'; const error = el('p', '', 'tool-error'); error.role = 'alert';
    let scopeIds = [], sourceGroups = [], scopeFragments = [];
    const addRow = group => {
      const row = el('div', null, 'pairing-row'), range = el('input'), text = el('textarea'); range.className = 'pair-range'; text.className = 'pair-text'; text.rows = 3;
      if (group) { const first = p.units.findIndex(u => u.source_id === group.source_ids[0]) + 1, last = p.units.findIndex(u => u.source_id === group.source_ids.at(-1)) + 1; range.value = first === last ? first : first + '-' + last; text.value = group.translation; }
      row.append(field('原文编号范围', range));
      if (p.externalLayout) {
        const choices = el('select'); choices.multiple = true; choices.className = 'pair-fragments'; choices.size = Math.min(5, Math.max(2, scopeFragments.length));
        for (const fragment of scopeFragments) { const option = el('option', fragment.translation.slice(0, 100)); option.value = fragment.id; option.selected = !!group?.fragmentIds?.includes(fragment.id); choices.append(option); }
        text.readOnly = true; choices.onchange = () => { text.value = [...choices.selectedOptions].map(o => scopeFragments.find(f => f.id === o.value).translation).join('\n'); };
        row.append(field('对应的中文 PDF 片段（可多选）', choices));
      } else {
        const reuse = el('select'); reuse.append(el('option', '换用原来的某组译文…'));
        for (const [i, source] of sourceGroups.entries()) { const option = el('option', source.translation.slice(0, 70) || '待翻译'); option.value = String(i); reuse.append(option); }
        reuse.onchange = () => { if (reuse.selectedIndex) text.value = sourceGroups[Number(reuse.value)].translation; }; row.append(reuse);
      }
      row.append(field('完整译文', text), button('移除此行', () => row.remove(), 'text-button')); editor.append(row);
    };
    const load = () => {
      try {
        const requested = normalizeRange(start.value + '-' + end.value, p);
        sourceGroups = p.groups.filter(g => g.source_ids.some(id => requested.includes(id)));
        scopeIds = sourceGroups.flatMap(g => g.source_ids);
        start.value = p.units.findIndex(u => u.source_id === scopeIds[0]) + 1; end.value = p.units.findIndex(u => u.source_id === scopeIds.at(-1)) + 1;
        if (scopeIds.length > 40) throw new Error('每次最多编辑 40 个原文单元，请缩小范围。');
        scopeFragments = (p.targetFragments || []).filter(f => sourceGroups.some(g => g.fragmentIds.includes(f.id)));
        editor.replaceChildren(); sourceGroups.forEach(addRow); error.textContent = '';
      } catch (e) { error.textContent = e.message; }
    };
    dialog.append(button('载入编辑区', load), editor, error);
    const actions = el('div', null, 'dialog-actions');
    actions.append(button('合为一组', () => { editor.replaceChildren(); addRow({ source_ids: scopeIds, translation: sourceGroups.map(g => g.translation).join('\n'), fragmentIds: scopeFragments.map(f => f.id) }); }), button('添加一组', () => addRow()), button('取消', () => dialog.close()), button('保存对应关系', () => {
      try {
        if (this.project !== p) throw new Error('文档已切换，请重新打开编辑区。');
        const rows = [...editor.children].map(row => ({ source_ids: normalizeRange(row.querySelector('.pair-range').value, p), translation: row.querySelector('.pair-text').value.trim(), ...(p.externalLayout ? { fragmentIds: [...row.querySelector('.pair-fragments').selectedOptions].map(o => o.value) } : {}) }));
        validatePairing(p, scopeIds, rows); this.record('调整对应关系'); applyPairing(p, scopeIds, rows); this.host.refresh(true); this.host.save(); dialog.close(); this.update(true);
      } catch (e) { error.textContent = e.message; }
    }, 'primary')); dialog.append(actions); load(); dialog.showModal();
  }
  render_explain() {
    const body = $('desk-body'), p = this.project, ids = [...p.activeIds], units = p.units.filter(u => ids.includes(u.source_id));
    this.excerpt(body);
    const before = p.units.indexOf(units[0]), last = p.units.indexOf(units.at(-1));
    const context = p.units.slice(Math.max(0, before - 2), Math.min(p.units.length, last + 3));
    const text = sourceText(p, ids), key = JSON.stringify([ids, context.map(u => [u.source_id, u.text]), this.selected().map(g => g.translation), this.host.get().domain]);
    const explanation = (p.explanations || []).find(e => e.key === key);
    body.append(el('p', '点击后使用你的模型，发送当前句、相邻上下文和已有译文。解释为 AI 生成；每项附原文短语供核对。', 'muted'));
    const run = button(this.explainPending.has(key) ? '正在解释…' : explanation ? '重新解释' : '解释这句话', async () => {
      if (this.explainPending.has(key)) return;
      this.explainPending.add(key); this.explainErrors.delete(key); this.update(true);
      try {
        const response = await fetch('/api/explain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceUnits: units.map(({ source_id, text }) => ({ source_id, text })), contextUnits: context.map(({ source_id, text }) => ({ source_id, text })), translation: this.selected().map(g => g.translation).join('\n'), domain: this.host.get().domain, config: this.host.get().config }) });
        const data = await response.json(); if (!response.ok) throw new Error(data.error || '解释失败。');
        if (this.project === p) { p.explanations ||= []; p.explanations = p.explanations.filter(e => e.key !== key); p.explanations.push({ key, source_ids: ids, ...data, createdAt: new Date().toISOString() }); this.host.save(); }
      } catch (e) { if (this.project === p) this.explainErrors.set(key, e.message); }
      finally { this.explainPending.delete(key); if (this.project === p && this.tab === 'explain') this.update(true); }
    }, 'primary'); run.disabled = this.explainPending.has(key); body.append(run);
    if (this.explainErrors.has(key)) body.append(el('p', this.explainErrors.get(key), 'tool-error'));
    if (explanation) {
      body.append(el('p', 'AI 解释 · 原文引句已逐字检查，解释内容仍需核对', 'desk-meta'));
      for (const [heading, items] of [['句子结构', explanation.structure], ['术语含义', explanation.terms], ['作者想表达什么', [explanation.intent]]]) {
        body.append(el('h3', heading));
        if (!items.length) body.append(el('p', '未单列术语。', 'muted'));
        for (const item of items) { const section = el('section', null, 'evidence-card'); section.append(el('blockquote', item.quote), el('p', item.explanation)); section.append(button('定位原文第 ' + (p.units.findIndex(u => u.source_id === item.source_id) + 1) + ' 句', () => this.host.select([item.source_id], 'nav'), 'text-button')); body.append(section); }
      }
      if (explanation.limits) body.append(el('p', explanation.limits, 'muted'));
    }
  }
  render_terms() {
    const body = $('desk-body'), p = this.project;
    body.append(el('p', '内置释义是通用参考。填写“本文含义”后，悬停术语会显示你的定义和当前论文中的原句。', 'muted'));
    const list = el('div', null, 'term-list');
    const form = el('form'); form.id = 'term-form';
    const term = el('input'), full = el('input'), chinese = el('input'), meaning = el('textarea'), old = el('input'), personal = el('input');
    term.id = 'term-name'; chinese.id = 'term-chinese'; full.id = 'term-full'; meaning.id = 'term-meaning'; old.id = 'term-old'; personal.type = 'checkbox'; personal.checked = true;
    term.required = chinese.required = true; meaning.rows = 3;
    form.append(field('术语 / 缩写', term), field('英文全称', full), field('中文译法', chinese), field('本文里的含义（可自行修改）', meaning), field('要统一替换的旧译法（可选）', old));
    const savePersonal = el('label', null, 'review-check'); savePersonal.append(personal, document.createTextNode('保存到我的专业词库')); form.append(savePersonal);
    const status = el('p', this.termMessage || '', 'muted'); status.id = 'term-result';
    const fill = entry => { term.value = entry.term; full.value = entry.full || ''; chinese.value = entry.chinese || ''; meaning.value = entry.builtin ? '' : entry.meaning || ''; old.value = entry.chinese || ''; };
    for (const entry of termsFor(p, this.personal)) list.append(button(entry.term + ' · ' + entry.chinese, () => fill(entry), 'term-chip'));
    body.append(list, form);
    const saveTerm = () => {
      if (!form.reportValidity()) return null;
      const entry = { term: term.value.trim().slice(0, 120), full: full.value.trim().slice(0, 500), chinese: chinese.value.trim().slice(0, 200), meaning: meaning.value.trim().slice(0, 4000) };
      if (!entry.term || !entry.chinese) return null;
      p.terms ||= []; p.terms = p.terms.filter(t => t.term.toLowerCase() !== entry.term.toLowerCase()); p.terms.push(entry);
      if (personal.checked) { this.personal = this.personal.filter(t => t.term.toLowerCase() !== entry.term.toLowerCase()); this.personal.push(entry); try { localStorage.setItem('sentence-reader-glossary', JSON.stringify(this.personal)); } catch {} }
      this.host.save(); this.decorate(true); return entry;
    };
    form.onsubmit = event => { event.preventDefault(); if (!form.reportValidity()) return; this.record('修改术语'); if (saveTerm()) status.textContent = '已保存。悬停术语可查看；之后翻译也会带上这份词库。'; };
    const actions = el('div', null, 'desk-actions'); const save = el('button', '保存术语', 'primary'); save.type = 'submit'; actions.append(save);
    actions.append(button('统一现有译文', () => {
      if (!form.reportValidity()) return;
      if (!old.value.trim() || old.value.trim() === chinese.value.trim()) { status.textContent = '请填写与新译法不同的旧译法。'; return; }
      const matches = p.groups.filter(g => findTerms(sourceText(p, g.source_ids), [{ term: term.value.trim() }]).length && g.translation.includes(old.value.trim()));
      if (!matches.length) { status.textContent = '当前论文含该英文术语的句组中，没有找到这项旧译法。'; return; }
      this.record('统一术语译法'); saveTerm();
      for (const group of matches) { group.translation = group.translation.split(old.value.trim()).join(chinese.value.trim()); group.reviewed = false; group.needs_review = true; group.note = '术语译法已统一，请核对上下文。'; }
      this.termMessage = '已更新 ' + matches.length + ' 个句组，可撤销。' + (p.externalLayout ? '已转为舒展阅读；原中文 PDF 保留原样。' : '');
      this.host.refresh(); this.host.save();
      if (p.externalLayout) this.host.targetView('reader');
      status.textContent = this.termMessage;
    })); form.append(actions, status);
    body.append(button('导出我的专业词库', () => download('句读-专业词库.json', JSON.stringify({ format: 'sentence-reader-glossary', terms: this.personal }, null, 2))));
    const file = el('input'); file.type = 'file'; file.accept = '.json'; file.hidden = true;
    file.onchange = async () => {
      try {
        if (!file.files[0] || file.files[0].size > 1024 * 1024) throw new Error('词库需小于 1 MB。');
        const data = JSON.parse(await file.files[0].text());
        if (data.format !== 'sentence-reader-glossary' || !Array.isArray(data.terms) || data.terms.length > 2000 || data.terms.some(t => !t || typeof t.term !== 'string' || !t.term.trim() || t.term.length > 120 || typeof t.chinese !== 'string' || t.chinese.length > 200 || typeof t.meaning !== 'string' || t.meaning.length > 4000 || typeof t.full !== 'string' || t.full.length > 500)) throw new Error('词库格式不正确。');
        for (const entry of data.terms) { this.personal = this.personal.filter(t => t.term.toLowerCase() !== entry.term.toLowerCase()); this.personal.push(entry); }
        localStorage.setItem('sentence-reader-glossary', JSON.stringify(this.personal)); this.update(true); this.decorate(true); this.host.toast('专业词库已导入。');
      } catch (e) { status.textContent = e.message; }
    };
    body.append(button('导入专业词库', () => file.click()), file);
  }
  render_notes() {
    const body = $('desk-body'), p = this.project;
    p.notes ||= [];
    let note = p.notes.find(n => n.id === this.noteEditId) || p.notes.find(n => n.source_ids.join('|') === p.activeIds.join('|')) || p.notes.find(n => n.source_ids.some(id => p.activeIds.includes(id)));
    const ids = note ? [...note.source_ids] : [...p.activeIds];
    this.excerpt(body, ids); body.append(el('p', p.groups.filter(g => g.source_ids.some(id => ids.includes(id))).map(g => g.translation || '尚未翻译').join('\n'), 'note-translation'));
    const input = el('textarea'); input.id = 'note-text'; input.rows = 6; input.placeholder = '记录疑问、结论或复现思路…';
    input.value = note?.text || ''; const selection = document.getSelection();
    const quote = selection?.anchorNode && $('reading-panes').contains(selection.anchorNode) ? selection.toString().trim().slice(0, 2000) : '';
    const state = el('p', '自动保存 · 批注通过原文编号关联两种语言', 'muted');
    let recorded = false;
    input.oninput = () => {
      if (!recorded) { this.record('修改批注'); recorded = true; }
      if (!note) { note = { id: crypto.randomUUID(), source_ids: ids, text: '', quote, createdAt: new Date().toISOString() }; p.notes.push(note); }
      note.text = input.value; note.updatedAt = new Date().toISOString();
      if (!input.value.trim()) { p.notes = p.notes.filter(n => n !== note); note = null; }
      this.host.save(); state.textContent = '批注已更新 · 自动保存';
    };
    body.append(input, state, button('导出笔记 Markdown', () => download(p.title + '-阅读笔记.md', exportNotes(p), 'text/markdown;charset=utf-8')),
      button('导出笔记 JSON', () => download(p.title + '-阅读笔记.json', JSON.stringify({ title: p.title, notes: (p.notes || []).map(n => ({ ...n, source: sourceText(p, n.source_ids), translation: p.groups.filter(g => g.source_ids.some(id => n.source_ids.includes(id))).map(g => g.translation).join('\n'), pages: [...new Set(p.units.filter(u => n.source_ids.includes(u.source_id)).flatMap(pagesOf))] })) }, null, 2))));
    body.append(el('h3', '这篇论文的批注'));
    for (const entry of p.notes) body.append(button('第 ' + (p.units.findIndex(u => u.source_id === entry.source_ids[0]) + 1) + ' 句 · ' + entry.text.slice(0, 100), async () => { await this.host.select(entry.source_ids, 'nav'); this.noteEditId = entry.id; this.update(true); }, 'issue-item'));
  }
  render_references() {
    const body = $('desk-body'), references = referenceMentions(sourceText(this.project, this.project.activeIds));
    this.excerpt(body); body.append(el('p', '展开原页预览，保留图表和公式上下文；关闭后仍停在当前句。识别不到编号时可手动指定页码。', 'muted'));
    for (const reference of references) body.append(button('展开 ' + reference.text, () => this.previewReference(reference), 'reference-choice'));
    const kind = el('select'); for (const [key, label] of [['figure', '图'], ['table', '表'], ['equation', '公式']]) { const option = el('option', label); option.value = key; kind.append(option); }
    const number = el('input'); number.placeholder = '编号，例如 3 或 5'; number.id = 'reference-number';
    body.append(field('手动查找', kind), number, button('查找并展开', () => { if (number.value.trim()) this.previewReference({ kind: kind.value, number: number.value.trim(), text: kind.selectedOptions[0].textContent + ' ' + number.value.trim() }); }));
  }
  previewReference(reference) {
    const project = this.project;
    return this.showReference(reference).catch(error => { if (this.project === project && this.referenceDialog?.open) this.host.error(error); });
  }
  async showReference(reference) {
    const p = this.project, pdf = this.host.get().pdf;
    const dialog = this.referenceDialog ||= el('dialog', null, 'reference-dialog'); dialog.id = 'reference-dialog';
    this.referenceRenderer?.clear(); dialog.replaceChildren(); if (!dialog.isConnected) document.body.append(dialog);
    const head = el('div', null, 'dialog-heading'); head.append(el('h2', reference.text + ' · 原页预览'), button('返回刚才的句子', () => dialog.close())); dialog.append(head);
    const status = el('p', '正在查找编号…', 'muted'); dialog.append(status);
    if (!dialog.open) dialog.showModal(); const token = this.referenceToken = (this.referenceToken || 0) + 1;
    dialog.onclose = () => { this.referenceToken++; this.referenceRenderer?.clear(); };
    const candidates = referenceCandidates(p, reference);
    let rawCandidate;
    if (!candidates.length && pdf) {
      const escaped = reference.number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = reference.kind === 'equation' ? new RegExp('^\\s*\\(' + escaped + '\\)\\s*$')
        : new RegExp('^\\s*' + (reference.kind === 'figure' ? '(?:Fig(?:ure)?\\.?|图)' : '(?:Table|表)') + '\\s*' + escaped + '(?![0-9a-z])', 'i');
      for (let page = 1; page <= pdf.numPages; page++) {
        const documentPage = await pdf.getPage(page), content = await documentPage.getTextContent(); if (token !== this.referenceToken || this.project !== p) return;
        const items = content.items.filter(i => typeof i.str === 'string').map((item, itemIndex) => ({ ...item, itemIndex }));
        const lines = orderLines(items, documentPage.getViewport({ scale: 1 }).width);
        const line = lines.find(line => pattern.test(line.tokens.map(t => t.str).join(' ')) || reference.kind === 'equation' && line.tokens.some(t => pattern.test(t.str)));
        if (line) { rawCandidate = { source_id: 'reference-hit', text: line.tokens.map(t => t.str).join(' '), anchors: line.tokens.map(t => ({ page, itemIndex: t.itemIndex, start: 0, end: t.str.length })) }; break; }
      }
    }
    if (token !== this.referenceToken || this.project !== p) return;
    const choices = candidates.length ? candidates : rawCandidate ? [rawCandidate] : [];
    const preview = el('div', null, 'reference-preview'); dialog.append(preview);
    let previewRequest = 0;
    const show = async unit => {
      const request = ++previewRequest;
      this.referenceRenderer?.clear(); preview.replaceChildren();
      const group = p.groups.find(g => g.source_ids.includes(unit.source_id));
      status.textContent = unit.text + (group?.translation ? '\n图注 / 对应译文：' + group.translation : '');
      const number = pagesOf(unit)[0];
      if (!pdf || !number) { preview.append(el('p', '当前是粘贴正文，没有原 PDF。可通过原句和对应译文查看。', 'muted')); return; }
      const label = el('p', '原文第 ' + number + ' 页 · 图表与公式显示原样', 'desk-meta'), host = el('div'); preview.append(label, host);
      const renderer = this.referenceRenderer = new PdfPane(host, () => {}); renderer.pageWidth = Math.min(900, Math.max(280, dialog.clientWidth - 75));
      await renderer.render(pdf, number, [unit], 1, p.sourceCrops?.[number]); if (token !== this.referenceToken || request !== previewRequest || this.project !== p) { renderer.clear(); return; }
      const hit = renderer.highlight([unit.source_id]);
      if (hit) { const root = preview.getBoundingClientRect(), rect = hit.getBoundingClientRect(); preview.scrollTop += rect.top - root.top - preview.clientHeight * .68; }
    };
    if (choices.length) {
      for (const unit of choices) dialog.insertBefore(button('p.' + (pagesOf(unit)[0] || '—') + ' · ' + unit.text.slice(0, 70), () => show(unit).catch(e => status.textContent = e.message), 'reference-choice'), preview);
      await show(choices[0]);
    } else status.textContent = '没有可靠识别到这个编号。可输入原文页码查看，不会猜测图表位置。';
    if (pdf) { const input = el('input'); input.type = 'number'; input.min = 1; input.max = pdf.numPages; input.placeholder = '原文页码'; const manual = el('div', null, 'desk-actions'); manual.append(input, button('打开该页', () => { const page = Number(input.value); if (page >= 1 && page <= pdf.numPages) show({ source_id: 'manual-reference', text: '手动选择的原页', pdfBoxes: [{ page, x: 0, y: 0, w: 1, h: 1 }], anchors: [] }).catch(e => status.textContent = e.message); })); dialog.insertBefore(manual, preview); }
  }
  decorate(force = false) {
    if (!this.project) return;
    const terms = termsFor(this.project, this.personal), signature = JSON.stringify(terms.map(t => [t.term, t.chinese]));
    for (const node of document.querySelectorAll('.source-sentence,.translation-content,.layout-sentence,.desk-source,.full-translation')) {
      if (!force && node.dataset.decorated === signature) continue;
      if (force) node.textContent = node.textContent;
      const text = node.textContent, matches = findTerms(text, terms).map(m => ({ ...m, type: 'term' }));
      for (const reference of referenceMentions(text)) { const { start, end } = reference; if (!matches.some(m => start < m.end && end > m.start)) matches.push({ start, end, reference, type: 'reference' }); }
      matches.sort((a, b) => a.start - b.start); const fragment = document.createDocumentFragment(); let at = 0;
      for (const match of matches) {
        fragment.append(document.createTextNode(text.slice(at, match.start))); const span = el('span', text.slice(match.start, match.end), match.type === 'term' ? 'glossary-term' : 'reference-link'); span.tabIndex = 0;
        if (match.type === 'term') { span.dataset.term = match.entry.term; span.setAttribute('aria-label', match.entry.term + '：' + match.entry.chinese); }
        else { span.dataset.kind = match.reference.kind; span.dataset.number = match.reference.number; span.role = 'link'; span.title = '展开对应图表或公式'; }
        fragment.append(span); at = match.end;
      }
      fragment.append(document.createTextNode(text.slice(at))); node.replaceChildren(fragment); node.dataset.decorated = signature;
    }
  }
  hitText(event) {
    const div = event.target.closest?.('.textLayer [data-pdf-item]'); if (!div || !div.firstChild || div.firstChild.nodeType !== Node.TEXT_NODE) return null;
    const caret = document.caretRangeFromPoint?.(event.clientX, event.clientY); if (!caret || caret.startContainer !== div.firstChild) return null;
    return { div, text: div.textContent, offset: caret.startOffset };
  }
  hoverTerm(event) {
    const span = event.target.closest?.('.glossary-term');
    if (span) { this.showTerm(span.dataset.term, span.getBoundingClientRect()); return; }
    const hit = this.hitText(event);
    if (hit && this.project) {
      const match = findTerms(hit.text, termsFor(this.project, this.personal)).find(m => hit.offset >= m.start && hit.offset <= m.end);
      if (match) { const range = document.createRange(); range.setStart(hit.div.firstChild, match.start); range.setEnd(hit.div.firstChild, match.end); const rect = range.getBoundingClientRect(); if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) { this.showTerm(match.entry.term, rect); return; } }
    }
    this.tooltip.hidden = true;
  }
  showTerm(term, rect) {
    const entry = termsFor(this.project, this.personal).find(t => t.term.toLowerCase() === term.toLowerCase()); if (!entry) return;
    this.tooltip.replaceChildren(el('strong', entry.term + ' · ' + entry.chinese), el('div', entry.full || entry.term), el('p', (entry.builtin ? '通用释义：' : '本文含义：') + (entry.meaning || '尚未填写，可在术语面板补充。')));
    const unit = this.project.units.find(u => this.project.activeIds.includes(u.source_id) && findTerms(u.text, [entry]).length) || this.project.units.find(u => findTerms(u.text, [entry]).length);
    if (unit) this.tooltip.append(el('blockquote', unit.text.slice(0, 350)));
    this.tooltip.style.left = Math.max(8, Math.min(innerWidth - 360, rect.left)) + 'px'; this.tooltip.style.top = Math.max(8, Math.min(innerHeight - 260, rect.bottom + 8)) + 'px'; this.tooltip.hidden = false;
  }
  referenceClick(event) {
    if (!document.getSelection()?.isCollapsed) return;
    const span = event.target.closest?.('.reference-link');
    let reference = span && { kind: span.dataset.kind, number: span.dataset.number, text: span.textContent };
    if (!reference && !document.querySelector('dialog[open]')) { const hit = this.hitText(event); if (hit) { for (const item of referenceMentions(hit.text)) {
      if (hit.offset >= item.start && hit.offset <= item.end) {
        const range = document.createRange(); range.setStart(hit.div.firstChild, item.start); range.setEnd(hit.div.firstChild, item.end);
        if ([...range.getClientRects()].some(r => event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom)) { reference = item; break; }
      }
    } } }
    if (reference && this.project) { event.preventDefault(); event.stopPropagation(); this.previewReference(reference).catch(e => this.host.error(e)); }
  }
}
