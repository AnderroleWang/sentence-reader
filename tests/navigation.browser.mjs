// Optional browser regression: install Playwright locally, then run this file.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.READER_TEST_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch({ headless: true, ...(process.env.READER_BROWSER ? { executablePath: process.env.READER_BROWSER } : {}) });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  const queue = []; let waiting;
  await page.route('**/api/translate', route => {
    const request = { route, body: route.request().postDataJSON() };
    if (waiting) { const resolve = waiting; waiting = null; resolve(request); } else queue.push(request);
  });
  const nextRequest = () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => { waiting = resolve; });
  const reply = request => request.route.fulfill({ json: { groups: request.body.sourceUnits.map(unit => ({ source_ids: [unit.source_id], translation: '已生成的测试译文。', needs_review: false, note: '' })) } });
  const position = () => page.locator('#position-label').textContent();
  const configure = async () => {
    await page.locator('#open-settings').click();
    await page.locator('#setting-url').fill('https://api.example.test/v1');
    await page.locator('#setting-model').fill('mock-model');
    await page.locator('#setting-batch').selectOption('4');
    await page.locator('#settings-form button[type=submit]').click();
  };
  const importArchive = async archive => {
    await page.locator('#project-file').setInputFiles({ name: 'navigation.句读.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)) });
    await page.waitForFunction(() => document.getElementById('paper-title').textContent.endsWith('（导入）'));
  };
  const key = async name => {
    await page.keyboard.press(name);
    assert.equal(await page.evaluate(() => window.lastNavigationPrevented), true, 'Navigation must prevent native arrow scrolling during translation');
  };
  await page.goto(base);
  await page.waitForSelector('.source-sentence');
  await page.evaluate(() => document.addEventListener('keydown', event => { window.lastNavigationPrevented = event.defaultPrevented; }));
  const archive = await page.evaluate(async () => {
    const { newProject, textToUnits } = await import('/alignment.mjs');
    const text = Array.from({ length: 40 }, (_, i) => `Sentence ${i + 1} describes the network architecture and the experimental setting with sufficient context for a reader to follow the method and compare the results on several datasets without losing the place in the paper.`).join('\n\n');
    const project = newProject('Navigation regression', textToUnits(text));
    project.groups.slice(0, 6).forEach(group => { group.translation = '已经翻译的中文句子。'; });
    return { format: 'sentence-reader-project', version: 1, project };
  });
  await importArchive(archive); await configure();
  await page.locator('[data-source-id="s000003"]').click();
  await page.locator('#translate').click(); const firstBatch = await nextRequest();
  const session = firstBatch.body.config.sessionId;
  assert.match(session, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  await key('ArrowDown'); assert.equal(await position(), '4 / 40');
  await key('ArrowUp'); assert.equal(await position(), '3 / 40');
  await key('ArrowRight'); assert.equal(await position(), '4 / 40');
  await key('ArrowLeft'); assert.equal(await position(), '3 / 40');
  await key('j'); assert.equal(await position(), '4 / 40');
  await key('k'); assert.equal(await position(), '3 / 40');
  await key('Alt+ArrowDown'); assert.equal(await position(), '4 / 40');
  await key('Alt+ArrowUp'); assert.equal(await position(), '3 / 40');
  await page.locator('[data-source-id="s000005"]').click(); assert.equal(await position(), '5 / 40');
  await page.locator('[data-group-id="s000002"] .translation-content').click(); assert.equal(await position(), '2 / 40');
  for (const id of ['edit-translation', 'correct-source', 'review-group', 'merge-next', 'retranslate-group', 'undo-edit', 'import-pdf']) assert.equal(await page.locator('#' + id).isDisabled(), true, id + ' must remain locked while a batch is pending');
  await page.locator('#open-reading').click(); await key('ArrowDown'); assert.equal(await position(), '3 / 40'); await page.locator('#desk-close').click();
  await page.locator('#open-notes').click();
  await page.locator('#note-text').fill('Reading note stays editable while translation runs.');
  await page.keyboard.press('ArrowUp'); assert.equal(await position(), '3 / 40');
  await page.locator('#desk-close').click();
  await page.locator('#source-scroll').evaluate(node => { node.scrollTop = 1200; });
  await page.locator('#target-scroll').evaluate(node => { node.scrollTop = 300; });
  const scroll = await page.evaluate(() => ['source-scroll', 'target-scroll'].map(id => document.getElementById(id).scrollTop));
  await reply(firstBatch); const secondBatch = await nextRequest();
  assert.equal(secondBatch.body.config.sessionId, session, 'Batches from the same paper must share a session');
  assert.equal(await position(), '3 / 40', 'A completed batch must preserve the current sentence');
  assert.deepEqual(await page.evaluate(() => ['source-scroll', 'target-scroll'].map(id => document.getElementById(id).scrollTop)), scroll, 'A completed batch must preserve manual scrolling');
  assert.equal(await page.locator('[data-group-id="s000007"] .translation-content').isEnabled(), true, 'Newly rendered translations must remain clickable');
  await page.locator('[data-group-id="s000007"] .translation-content').click(); assert.equal(await position(), '7 / 40');
  await page.locator('#stop-translate').click(); await reply(secondBatch);
  await page.waitForFunction(() => document.getElementById('stop-translate').hidden);
  assert.equal(await page.locator('#edit-translation').isEnabled(), true);

  let explanationSession;
  await page.route('**/api/explain', async route => {
    const body = route.request().postDataJSON(), unit = body.sourceUnits[0];
    explanationSession = body.config.sessionId;
    const item = { source_id: unit.source_id, quote: unit.text, explanation: '测试解释。' };
    await route.fulfill({ json: { structure: [item], terms: [], intent: item, limits: '测试。' } });
  });
  await page.locator('#open-explain').click();
  await page.getByRole('button', { name: '解释这句话', exact: true }).click();
  await page.getByText('AI 解释 · 原文引句已逐字检查，解释内容仍需核对', { exact: true }).waitFor();
  assert.equal(explanationSession, session, 'Explanations and translation must share the paper session');
  await page.locator('#desk-close').click();
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#export-project').click();
  const download = await downloadEvent, chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString('utf8').includes(session), false, 'Session identifiers must stay out of shared archives');
  const saved = await page.evaluate(async () => {
    const opened = indexedDB.open('sentence-reader', 1);
    const db = await new Promise((resolve, reject) => { opened.onsuccess = () => resolve(opened.result); opened.onerror = () => reject(opened.error); });
    const request = db.transaction('projects').objectStore('projects').getAll();
    const projects = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    db.close(); return JSON.stringify({ local: { ...localStorage }, projects });
  });
  assert.equal(saved.includes(session), false, 'Session identifiers must stay out of persistent browser storage');

  // Reuse the self-authored two-page PDF; remove the external Chinese-PDF mapping
  // to exercise ordinary translation, layout preview and cross-page navigation.
  const pdfArchive = await page.evaluate(async () => {
    const value = await (await fetch('/examples/layout-demo.句读.json')).json();
    const project = value.project;
    delete project.externalLayout; delete project.translatedPdfBase64; delete project.sharedPdf;
    delete project.sourceCrops; delete project.targetCrops; delete project.targetFragments;
    project.title = 'PDF navigation regression'; project.targetView = 'layout'; project.activeIds = [project.units[0].source_id];
    project.groups.forEach((group, index) => { group.translation = index < 2 ? '已有的译文。' : ''; delete group.fragmentIds; });
    return value;
  });
  await importArchive(pdfArchive);
  await page.waitForSelector('#pdf-container [data-pdf-ready="1"]');
  await page.locator('#translate').click(); const pdfBatch = await nextRequest();
  assert.notEqual(pdfBatch.body.config.sessionId, session, 'Different papers must get different sessions');
  await page.locator('#next-sentence').focus(); await key('ArrowDown'); assert.equal(await position(), '2 / 6');
  await key('ArrowDown'); await key('ArrowDown'); assert.equal(await position(), '4 / 6');
  await page.waitForSelector('#pdf-container [data-pdf-ready="2"] [data-linked-id="s000004"]');
  await page.waitForSelector('#translated-pdf-container [data-layout-ready="2"]');
  await page.locator('#page-number').fill('1'); await page.locator('#page-number').press('Tab');
  await page.waitForFunction(() => document.getElementById('page-number').value === '1');
  const beforeInput = await position();
  await page.locator('#page-number').focus(); await page.keyboard.press('ArrowUp'); assert.equal(await position(), beforeInput, 'Page inputs keep their own arrow behavior');
  await page.locator('#next-sentence').focus();
  await page.locator('#stop-translate').click(); await reply(pdfBatch);
  await page.waitForFunction(() => document.getElementById('stop-translate').hidden);
  assert.deepEqual(errors, []);
  console.log('PASS: navigation and both-language clicks during pending translation, input guards, read-only locks, preserved sentence/scroll across batches, new translation clicks, PDF cross-page focus and layout preview.');
} finally {
  await browser.close();
}
