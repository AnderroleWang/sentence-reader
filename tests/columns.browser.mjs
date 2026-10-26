import assert from 'node:assert/strict';
import { chromium } from 'playwright';

function columnsPdf() {
  const lines = [
    'We evaluate the models using evidence.',
    'These models use verified news claims.',
    'Our AI model finds reliable evidence.',
    'The results require further analysis.',
    'Each system uses the same input data.',
    'The authors verify every cited claim.',
  ];
  const commands = [];
  for (const x of [40, 307]) lines.forEach((text, i) => {
    const y = 720 - i * 14;
    commands.push(`BT /F1 11 Tf ${x} ${y} Td`);
    if (i === 2) commands.push('(Our ) Tj /F2 11 Tf (AI) Tj /F1 11 Tf ( model finds reliable evidence.) Tj');
    else commands.push(`(${text}) Tj`);
    commands.push('ET');
  });
  commands.push('0.2 0.6 0.3 rg 40 400 100 70 re f');
  const stream = commands.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>',
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
const browser = await chromium.launch({headless: true, ...(process.env.READER_BROWSER ? {executablePath: process.env.READER_BROWSER} : {})});
try {
  for (const width of [390, 860, 1440]) {
    const page = await browser.newPage({viewport: {width, height: 1000}});
    await page.goto(base);
    const report = await page.evaluate(async encoded => {
      const {loadPdf, extractPdf} = await import('/pdf-reader.mjs');
      const {TranslatedPdfPane} = await import('/translated-pdf.mjs');
      const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
      const pdf = await loadPdf(new Blob([bytes]));
      const units = await extractPdf(pdf);
      const host = document.createElement('div'); host.style.width = Math.max(280, innerWidth - 32) + 'px';
      document.body.replaceChildren(host);
      const groups = units.map(u => ({source_ids: [u.source_id], translation: '研究者根据相同的输入数据核对模型给出的结论，并检查所引用的证据。'}));
      const pane = new TranslatedPdfPane(host, () => {}, () => {}), reports = [];
      for (const zoom of [1, 1.5, 2]) {
        const stats = await pane.render(pdf, 1, units, groups, zoom);
        const root = pane.wrapper.getBoundingClientRect(), scale = root.width / 612;
        const blocks = [...host.querySelectorAll('.layout-region')].map(n => {
          const r = n.getBoundingClientRect();
          return {left: (r.left - root.left) / scale, right: (r.right - root.left) / scale, top: (r.top - root.top) / scale, bottom: (r.bottom - root.top) / scale, bold: getComputedStyle(n).fontWeight};
        });
        const overlap = blocks.some((a, i) => blocks.slice(i + 1).some(b => Math.min(a.right,b.right) - Math.max(a.left,b.left) > .5 && Math.min(a.bottom,b.bottom) - Math.max(a.top,b.top) > .5));
        reports.push({zoom, stats, blocks, overlap});
      }
      return reports;
    }, columnsPdf().toString('base64'));
    for (const r of report) {
      assert(r.blocks.length >= 2, 'Both completed columns must remain visible as Chinese');
      assert(!r.overlap, 'Translated regions must never overlap another column or paragraph');
      assert(r.blocks.every(b => Number(b.bold) < 600), 'A single bold term must not make a whole body paragraph bold');
      assert(r.blocks.filter(b=>b.left<100).every(b=>b.right<=291.5), 'Left column must stay inside its source text geometry');
      assert(r.blocks.filter(b=>b.left>100).every(b=>b.left>=306.5), 'Right column must retain the source gutter');
    }
    if (width === 860 && process.env.READER_TEST_SCREENSHOT) await page.screenshot({path: process.env.READER_TEST_SCREENSHOT, fullPage:true});
    await page.close();
  }
  console.log('PASS: Chinese column bounds, gutters, normal body weight and no region overlap at three widths and three zoom levels.');
} finally {await browser.close();}
