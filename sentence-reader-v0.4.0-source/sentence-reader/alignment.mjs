export const APP_VERSION = 1;

export function splitSentences(text) {
  const parts = typeof Intl.Segmenter === 'function'
    ? [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)].map(x => ({ text: x.segment, start: x.index }))
    : [...text.matchAll(/[^.!?]+(?:[.!?]+[\s]*|$)/g)].map(x => ({ text: x[0], start: x.index }));
  const combined = [];
  for (const part of parts) {
    const prior = combined.at(-1);
    if (prior && /(?:\b(?:figs?|eqs?|secs?|refs?|dr|prof|mr|mrs|vs|al|approx|no)|e\.g|i\.e)\.\s*$/i.test(prior.text)) {
      prior.text += part.text;
    } else combined.push({ ...part });
  }
  return combined.map(part => {
    const leading = part.text.length - part.text.trimStart().length;
    return { text: part.text.trim(), start: part.start + leading, end: part.start + part.text.trimEnd().length };
  }).filter(x => x.text);
}

export function unitsFromParagraphs(paragraphs) {
  const units = [];
  paragraphs.forEach((paragraph, p) => {
    for (const sentence of splitSentences(paragraph.text)) {
      const anchors = [];
      for (const run of paragraph.runs || []) {
        const start = Math.max(sentence.start, run.start), end = Math.min(sentence.end, run.end);
        if (start < end) anchors.push({ page: run.page, itemIndex: run.itemIndex,
          start: (run.itemStart || 0) + start - run.start, end: (run.itemStart || 0) + end - run.start });
      }
      units.push({ source_id: 's' + String(units.length + 1).padStart(6, '0'),
        paragraph_id: 'p' + String(p + 1).padStart(4, '0'), text: sentence.text, anchors });
    }
  });
  return units;
}

export function textToUnits(text) {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\u00ad/g, '').trim();
  const paragraphs = normalized.split(/\n\s*\n/).map(text => ({
    text: text.replace(/([a-z])-\n(?=[a-z])/g, '$1').replace(/\s*\n\s*/g, ' ').replace(/[ \t]+/g, ' ').trim()
  })).filter(p => p.text);
  return unitsFromParagraphs(paragraphs);
}

export function newProject(title, units, extra = {}) {
  return { formatVersion: APP_VERSION, id: crypto.randomUUID(), title: title || '未命名论文',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sourceType: 'text',
    units, groups: units.map(unit => ({ source_ids: [unit.source_id], translation: '', needs_review: false, note: '', reviewed: false })),
    activeIds: units.length ? [units[0].source_id] : [], page: 1, view: 'text', ...extra };
}

export function validateProject(project) {
  if (!project || project.formatVersion !== APP_VERSION || !Array.isArray(project.units) || !Array.isArray(project.groups)) throw new Error('不是支持的句读阅读档案。');
  if (!project.units.length || project.units.length > 100000) throw new Error('原文单元数量异常。');
  const ids = project.units.map(u => u.source_id);
  if (new Set(ids).size !== ids.length) throw new Error('档案中存在重复原文编号。');
  for (const unit of project.units) {
    if (typeof unit.source_id !== 'string' || typeof unit.text !== 'string' || unit.text.length > 50000) throw new Error('档案原文格式错误。');
    if (!Array.isArray(unit.anchors)) unit.anchors = [];
    for (const key of ['pdfBoxes', 'targetBoxes']) if (unit[key] != null) {
      if (!Array.isArray(unit[key]) || unit[key].length > 10000 || unit[key].some(box => !box || !Number.isInteger(box.page) || box.page < 1 ||
        !['x', 'y', 'w', 'h'].every(k => typeof box[k] === 'number' && Number.isFinite(box[k])) || box.x < 0 || box.y < 0 || box.w <= 0 || box.h <= 0 || box.x + box.w > 1.001 || box.y + box.h > 1.001)) throw new Error('档案中的 PDF 对应坐标无效。');
    }
    if (project.externalLayout && (!unit.pdfBoxes?.length || !unit.targetBoxes?.length)) throw new Error('已排版对读档案缺少双向对应坐标。');
  }
  for (const key of ['sourceCrops', 'targetCrops']) if (project[key] != null) {
    if (typeof project[key] !== 'object' || Array.isArray(project[key]) || Object.values(project[key]).some(crop => !crop || !['x', 'y', 'w', 'h'].every(k => typeof crop[k] === 'number' && Number.isFinite(crop[k])) || crop.x < 0 || crop.y < 0 || crop.w <= 0 || crop.h <= 0 || crop.x + crop.w > 1.001 || crop.y + crop.h > 1.001)) throw new Error('档案中的双栏裁切范围无效。');
  }
  const covered = project.groups.flatMap(g => {
    if (!Array.isArray(g.source_ids) || !g.source_ids.length || typeof g.translation !== 'string') throw new Error('档案译文格式错误。');
    return g.source_ids;
  });
  if (covered.length !== ids.length || covered.some((id, i) => id !== ids[i])) throw new Error('档案中原文与译文的编号覆盖或顺序不一致。');
  const validIds = new Set(ids), textById = new Map(project.units.map(u => [u.source_id, u.text]));
  if (project.notes != null && (!Array.isArray(project.notes) || project.notes.length > 10000 || project.notes.some(n => !n || typeof n.id !== 'string' || typeof n.text !== 'string' || n.text.length > 100000 || !Array.isArray(n.source_ids) || !n.source_ids.length || n.source_ids.some(id => !validIds.has(id)) || n.createdAt != null && typeof n.createdAt !== 'string' || n.quote != null && typeof n.quote !== 'string'))) throw new Error('档案中的批注格式或原文编号无效。');
  if (project.terms != null && (!Array.isArray(project.terms) || project.terms.length > 2000 || project.terms.some(t => !t || typeof t.term !== 'string' || !t.term.trim() || t.term.length > 120 || typeof t.chinese !== 'string' || t.chinese.length > 200 || t.full != null && typeof t.full !== 'string' || t.meaning != null && typeof t.meaning !== 'string'))) throw new Error('档案中的术语格式无效。');
  if (project.targetFragments != null) {
    if (!Array.isArray(project.targetFragments) || project.targetFragments.length > 100000 || project.targetFragments.some(f => !f || typeof f.id !== 'string' || typeof f.translation !== 'string' || !Array.isArray(f.boxes) || f.boxes.some(b => !b || !Number.isInteger(b.page) || b.page < 1 || !['x', 'y', 'w', 'h'].every(k => typeof b[k] === 'number' && Number.isFinite(b[k])) || b.x < 0 || b.y < 0 || b.w <= 0 || b.h <= 0 || b.x + b.w > 1.001 || b.y + b.h > 1.001))) throw new Error('档案中的中文 PDF 片段无效。');
    const fragments = project.targetFragments.map(f => f.id), assignments = project.groups.flatMap(g => g.fragmentIds || []);
    if (new Set(fragments).size !== fragments.length || [...fragments].sort().join('|') !== [...assignments].sort().join('|')) throw new Error('档案中的中文片段有重复或遗漏。');
  }
  if (project.explanations != null) {
    if (!Array.isArray(project.explanations) || project.explanations.length > 10000) throw new Error('档案中的解释列表格式无效。');
    // Source corrections can make an old explanation stale. Keep the reading
    // document usable and discard cached explanations whose evidence changed.
    project.explanations = project.explanations.filter(e => e && typeof e.key === 'string' && Array.isArray(e.structure) && e.structure.length && Array.isArray(e.terms) && typeof e.limits === 'string' && [...e.structure, ...e.terms, e.intent].every(item => item && typeof item.quote === 'string' && item.quote.trim() && typeof item.explanation === 'string' && textById.get(item.source_id)?.includes(item.quote)));
  }
  if (typeof project.title !== 'string') project.title = '导入的论文';
  if (typeof project.id !== 'string') project.id = crypto.randomUUID();
  return project;
}

export function mergeGroups(groups, index) {
  if (index < 0 || index >= groups.length - 1) return groups;
  const first = groups[index], second = groups[index + 1];
  if (!first.translation || !second.translation) throw new Error('请先翻译这两组，再合并对应关系。');
  return [...groups.slice(0, index), { source_ids: [...first.source_ids, ...second.source_ids],
    translation: first.translation + '\n' + second.translation,
    needs_review: true, note: '手动合并的句组，请核对后确认。', reviewed: false }, ...groups.slice(index + 2)];
}

export function replaceGroups(project, ids, replacements) {
  const target = new Set(ids);
  const old = project.groups.filter(g => g.source_ids.some(id => target.has(id)));
  if (old.some(g => g.source_ids.some(id => !target.has(id)))) throw new Error('操作必须覆盖整个句组。');
  const flat = replacements.flatMap(g => g.source_ids);
  if (flat.join('|') !== ids.join('|')) throw new Error('返回的对应编号与所选原文不一致。');
  const first = project.groups.indexOf(old[0]);
  project.groups.splice(first, old.length, ...replacements.map(g => ({ ...g, reviewed: false })));
}

export function planBatches(project, maxUnits = 10, limit = 6500) {
  const pending = new Set(project.groups.filter(g => !g.translation).flatMap(g => g.source_ids));
  const batches = [];
  let batch = [], length = 0;
  for (const unit of project.units) {
    if (!pending.has(unit.source_id)) {
      if (batch.length) { batches.push(batch); batch = []; length = 0; }
      continue;
    }
    if (batch.length && (batch.length >= maxUnits || length + unit.text.length > limit)) {
      batches.push(batch); batch = []; length = 0;
    }
    batch.push(unit); length += unit.text.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function demoProject() {
  const paragraphs = [
    'Reading scientific papers requires frequent shifts between unfamiliar terms and complex arguments. When the original text and its translation are displayed far apart, readers must repeatedly search for the corresponding sentence. Linking each sentence to its translation can reduce this search effort and help readers maintain their place.',
    'Although the model is accurate, it requires substantial computation. We evaluate the method on two datasets. The results suggest that performance depends on the quality of the input data. Further studies are needed to determine whether these findings generalize to other settings.'
  ];
  const project = newProject('欢迎 · 逐句对应阅读示例', textToUnits(paragraphs.join('\n\n')), { isDemo: true });
  const translations = [
    '阅读科学论文，需要不断在陌生术语与复杂论证之间切换注意力。',
    '当原文与译文相距较远时，读者必须反复寻找相互对应的句子。',
    '将每个句子与其译文关联起来，可以减少寻找的负担，帮助读者保持阅读位置。',
    '该模型准确率很高。不过，它需要大量计算。',
    '我们在两个数据集上评估了该方法。',
    '结果表明，模型的表现取决于输入数据的质量。',
    '还需要进一步研究，以确定这些发现是否适用于其他情境。'
  ];
  project.groups.forEach((group, i) => { group.translation = translations[i]; });
  project.activeIds = [project.units[3].source_id];
  return project;
}
