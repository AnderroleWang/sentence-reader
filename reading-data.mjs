export const pagesOf = unit => [...new Set([...(unit.anchors || []), ...(unit.pdfBoxes || [])].map(a => a.page))];
export const sourceText = (project, ids) => project.units.filter(u => ids.includes(u.source_id)).map(u => u.text).join(' ');
export function alignmentIssues(project) {
  const byId = new Map(project.units.map(u => [u.source_id, u.text]));
  return project.groups.flatMap(group => {
    const source = group.source_ids.map(id => byId.get(id)).join(' '), text = group.translation.trim(), reasons = [];
    if (!text) reasons.push('尚未翻译');
    else {
      if (group.needs_review && !group.reviewed) reasons.push(group.note || '模型或映射提示待核对');
      if (/[A-Za-z]/.test(source) && source.length > 80 && !/[\u3400-\u9fff]/.test(text)) reasons.push('中文很少，可能漏译');
      if (source.length > 100 && text.length < source.length * .08) reasons.push('译文异常偏短');
      const numbers = [...new Set(source.match(/\b\d+(?:\.\d+)?%?/g) || [])];
      const missing = numbers.filter(n => !text.includes(n));
      if (missing.length) reasons.push('请核对数值或引文：' + missing.slice(0, 5).join('、'));
    }
    return reasons.length ? [{ ids: group.source_ids, reasons }] : [];
  });
}
const historyKeys = ['units', 'groups', 'activeIds', 'notes', 'terms', 'targetFragments'];
const snapshot = project => Object.fromEntries(historyKeys.map(key => [key, structuredClone(project[key])]));
export class EditHistory {
  constructor() { this.undoStack = []; this.redoStack = []; }
  record(project, label) { this.undoStack.push({ value: snapshot(project), label }); if (this.undoStack.length > 30) this.undoStack.shift(); this.redoStack = []; }
  move(project, direction) {
    const from = direction === 'undo' ? this.undoStack : this.redoStack, to = direction === 'undo' ? this.redoStack : this.undoStack;
    const entry = from.pop(); if (!entry) return;
    to.push({ value: snapshot(project), label: entry.label });
    for (const key of historyKeys) { if (entry.value[key] === undefined) delete project[key]; else project[key] = structuredClone(entry.value[key]); }
    return entry.label;
  }
}
export function normalizeRange(value, project) {
  const match = /^\s*(\d+)\s*(?:[-–—]\s*(\d+))?\s*$/.exec(value);
  if (!match) throw new Error('原文范围请填写句号编号，例如 3 或 3-5。');
  const first = Number(match[1]), last = Number(match[2] || match[1]);
  if (first < 1 || last < first || last > project.units.length) throw new Error('原文范围超出文档。');
  return project.units.slice(first - 1, last).map(u => u.source_id);
}
export function validatePairing(project, scopeIds, rows) {
  const covered = rows.flatMap(r => r.source_ids);
  if (covered.join('|') !== scopeIds.join('|')) throw new Error('原文范围须按顺序完整覆盖本次编辑区，不能漏句或重复。');
  if (rows.some(r => !r.source_ids.length || !r.translation.trim())) throw new Error('每组都需要原文范围和完整译文。');
  if (project.externalLayout) {
    const fragments = rows.flatMap(r => r.fragmentIds || []);
    const expected = project.groups.filter(g => g.source_ids.some(id => scopeIds.includes(id))).flatMap(g => g.fragmentIds);
    if ([...fragments].sort().join('|') !== [...expected].sort().join('|')) throw new Error('中文 PDF 的片段须各使用一次；请把被互换的两组一起纳入编辑区。');
  }
  return rows.map(row => ({ ...row, reviewed: false, needs_review: true, note: '已手动调整对应关系，请核对。' }));
}
export function ensureFragments(project) {
  if (!project.externalLayout || project.targetFragments) return;
  project.targetFragments = project.groups.map((group, index) => {
    const id = 'fragment-' + index; group.fragmentIds = [id];
    const boxes = project.units.filter(u => group.source_ids.includes(u.source_id)).flatMap(u => u.targetBoxes || []);
    return { id, translation: group.translation, boxes };
  });
}
export function applyPairing(project, scopeIds, rows) {
  const validated = validatePairing(project, scopeIds, rows);
  const indices = project.groups.map((g, i) => g.source_ids.some(id => scopeIds.includes(id)) ? i : -1).filter(i => i >= 0);
  project.groups.splice(indices[0], indices.length, ...validated);
  if (project.externalLayout) for (const group of validated) {
    const boxes = project.targetFragments.filter(f => group.fragmentIds.includes(f.id)).flatMap(f => f.boxes);
    for (const unit of project.units.filter(u => group.source_ids.includes(u.source_id))) unit.targetBoxes = structuredClone(boxes);
  }
  project.activeIds = validated[0].source_ids;
}
export const defaultTerms = [
  { term: 'mAP', full: 'mean Average Precision', chinese: '平均精度均值', meaning: '目标检测常用指标。具体 IoU 阈值与类别平均方式需查看本文实验设置。', builtin: true },
  { term: 'ablation study', full: 'ablation study', chinese: '消融实验', meaning: '通过移除或替换模块比较结果；本文具体比较了什么，应结合实验段落核对。', builtin: true }
];
export function termsFor(project, personal = []) {
  const map = new Map();
  for (const term of [...defaultTerms, ...personal, ...(project.terms || [])]) map.set(term.term.toLowerCase(), term);
  return [...map.values()].sort((a, b) => b.term.length - a.term.length);
}
export function findTerms(text, terms) {
  const matches = [];
  for (const entry of terms) {
    const escaped = entry.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'gi'); let match;
    while ((match = re.exec(text)) && matches.length < 5000) {
      const start = match.index, end = start + match[0].length;
      if (/[A-Za-z0-9]$/.test(entry.term) && /[A-Za-z0-9]/.test(text[end] || '')) continue;
      if (/^[A-Za-z0-9]/.test(entry.term) && /[A-Za-z0-9]/.test(text[start - 1] || '')) continue;
      if (!matches.some(m => start < m.end && end > m.start)) matches.push({ start, end, entry });
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}
export function exportNotes(project) {
  const lines = ['# ' + project.title + ' · 阅读笔记', ''];
  for (const note of project.notes || []) {
    const units = project.units.filter(u => note.source_ids.includes(u.source_id));
    const groups = project.groups.filter(g => g.source_ids.some(id => note.source_ids.includes(id)));
    lines.push('## ' + (note.createdAt || '').slice(0, 10) + ' · 原文第 ' + units.map(u => project.units.indexOf(u) + 1).join('、') + ' 句', '',
      '页码：' + ([...new Set(units.flatMap(pagesOf))].join('、') || '网页正文'), '', '**原文**', '', units.map(u => u.text).join('\n\n'), '',
      '**译文**', '', groups.map(g => g.translation || '尚未翻译').join('\n\n'), '', '**批注**', '', note.text, '');
    if (note.quote) lines.push('选中片段：' + note.quote, '');
  }
  return lines.join('\n');
}
export function referenceMentions(text) {
  return [...text.matchAll(/(\bFig(?:ure)?s?\.?|\bTable|\bEq(?:uation)?s?\.?|公式|图|表|式)\s*[(（]?([0-9]+[a-z]?)[)）]?/gi)].map(m => ({ text: m[0], start: m.index, end: m.index + m[0].length, kind: /^(?:fig|图)/i.test(m[1]) ? 'figure' : /^(?:table|表)/i.test(m[1]) ? 'table' : 'equation', number: m[2] }));
}
export function referenceCandidates(project, reference) {
  const n = reference.number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const caption = new RegExp('^\\s*' + (reference.kind === 'figure' ? '(?:Fig(?:ure)?\\.?|图)' : reference.kind === 'table' ? '(?:Table|表)' : '(?:Eq(?:uation)?\\.?|式)') + '\\s*\\(?' + n + '(?![0-9a-z])', 'i');
  const numberOnly = new RegExp('^\\s*\\(' + n + '\\)\\s*$');
  return project.units.filter(u => caption.test(u.text) || reference.kind === 'equation' && numberOnly.test(u.text));
}
