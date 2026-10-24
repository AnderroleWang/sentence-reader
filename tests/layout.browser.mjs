// Self-authored PDF fixtures: prose with inline scripts, display math and rotation.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

function fixturePdf() {
  const stream = [
    'BT /F1 11 Tf 40 730 Td (Inline notation and translated prose) Tj ET',
    'BT /F1 11 Tf 40 700 Td (Using the model, we obtain a list of predicted labels) Tj ET',
    'BT /F1 11 Tf 40 686 Td (from the input article. These labels are converted) Tj ET',
    'BT /F1 11 Tf 40 672 Td (to vectors in R) Tj ET',
    'BT /F1 7 Tf 107 676 Td (truth) Tj ET',
    'BT /F1 11 Tf 123 672 Td (so that each value is a binary indicator.) Tj ET',
    'BT /F1 11 Tf 40 658 Td (With these labels, we train the prediction model.) Tj ET',
    'BT /F1 11 Tf 170 590 Td (x = y + z) Tj ET',
    '0.2 0.6 0.3 rg 40 400 100 70 re f',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate 90 /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let file = '%PDF-1.4\n', offsets = [0];
  objects.forEach((body, i) => { offsets.push(file.length); file += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = file.length;
  file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  file += offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  return Buffer.from(file + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}

const base = process.env.READER_TEST_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch({ headless: true, ...(process.env.READER_BROWSER ? { executablePath: process.env.READER_BROWSER } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  const result = await page.evaluate(async encoded => {
    const { loadPdf, extractPdf } = await import('/pdf-reader.mjs');
    const { TranslatedPdfPane } = await import('/translated-pdf.mjs');
    const { newProject } = await import('/alignment.mjs');
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    const pdf = await loadPdf(new Blob([bytes], { type: 'application/pdf' }));
    const units = await extractPdf(pdf);
    const groups = units.map(u => ({ source_ids: [u.source_id], translation: '这是已完成的中文译文。' }));
    const host = document.createElement('div'); host.style.width = '612px'; document.body.append(host);
    const events = [], pane = new TranslatedPdfPane(host, ids => events.push(['select', ids]), ids => events.push(['expand', ids]));
    const stats = await pane.render(pdf, 1, units, groups);
    const prose = units.find(u => u.text.includes('Using the model'));
    const notation = units.find(u => u.text.includes('These labels'));
    const visible = id => [...host.querySelectorAll('.layout-sentence')].some(n => n.sourceIds.includes(id) && n.textContent.includes('中文'));
    const math = units.find(u => u.text.includes('x = y + z'));
    const mathRetained = [...host.querySelectorAll('.layout-original-hit')].some(n => n.sourceIds.includes(math.source_id));
    const canvas = host.querySelector('canvas'), context = canvas.getContext('2d');
    const pixel = context.getImageData(Math.round(60 / 612 * canvas.width), Math.round(350 / 792 * canvas.height), 1, 1).data;
    const retained = id => [...host.querySelectorAll('.layout-original-hit')].some(n => n.sourceIds.includes(id));
    const first = { proseVisible: visible(prose.source_id), notationVisible: visible(notation.source_id), proseRetained: retained(prose.source_id), notationRetained: retained(notation.source_id), mathId: math.source_id, mathRetained, green: [...pixel], stats };
    await pane.render(pdf, 2, units, groups);
    host.querySelector('.layout-original-hit').click();
    const project = newProject('Native layout regression', units, { view: 'pdf', targetView: 'layout', pdfBase64: encoded });
    project.groups = groups;
    pane.clear(); host.remove(); await pdf.destroy();
    return { first, events, archive: { format: 'sentence-reader-project', version: 1, project } };
  }, fixturePdf().toString('base64'));
  assert(result.first.proseVisible, 'Completed prose next to a superscript must be shown in Chinese');
  assert(result.first.notationVisible, 'Inline superscripts must not make the containing prose stay in English');
  assert(!result.first.proseRetained && !result.first.notationRetained, 'Translated body sentences must not retain stray English fragments around inline scripts');
  assert(result.first.mathRetained, 'Standalone equations must retain their original drawing');
  assert(result.first.green[1] > 140 && result.first.green[0] < 80, 'Original vector illustrations must be preserved');
  assert.deepEqual(result.events.map(e => e[0]), ['select', 'expand'], 'Clicking a translated region retained as an original must select it and open the full Chinese');

  await page.locator('#project-file').setInputFiles({ name: 'layout.句读.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(result.archive)) });
  await page.waitForSelector('#translated-pdf-container [data-layout-ready="1"]');
  await page.locator('#focus-mode').uncheck();
  const mathHit = page.locator(`#translated-pdf-container [data-layout-ready="1"] .layout-original-hit[data-layout-ids="${result.first.mathId}"]`).first();
  await mathHit.click();
  await page.waitForFunction(() => !document.getElementById('reader-desk').hidden);
  assert((await page.locator('#reader-desk').textContent()).includes('这是已完成的中文译文。'), 'Retained original regions must provide the existing Chinese without retranslating');
  assert((await page.locator('#layout-status').textContent()).includes('保留原样'), 'The layout must explain why some completed content still uses its original drawing');
  await page.locator('#desk-close').click();
  await page.locator('#next-sentence').focus(); await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => document.getElementById('reader-desk').hidden);
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => !document.getElementById('reader-desk').hidden);
  assert(!(await page.locator('#focus-mode').isChecked()), 'Retained-original navigation must work with focus mode off');
  await page.locator('#desk-close').click();
  await page.setViewportSize({ width: 1440, height: 760 });
  await page.waitForFunction(() => {
    const scroll = document.getElementById('target-scroll'); scroll.scrollTop = scroll.scrollHeight;
    return document.getElementById('layout-status').textContent.startsWith('第 2 页');
  });
  await page.screenshot({ path: process.env.READER_TEST_SCREENSHOT || 'layout-regression.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: inline math prose translated, standalone math and figures preserved, retained regions open full Chinese by click and arrows with focus off, per-page retained status follows scrolling.');
} finally { await browser.close(); }
