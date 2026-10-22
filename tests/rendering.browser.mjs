// Optional PDF rendering regression; uses only the self-authored two-page demo.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.READER_TEST_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch({ headless: true, ...(process.env.READER_BROWSER ? { executablePath: process.env.READER_BROWSER } : {}) });
const bitmap = canvas => canvas.evaluate(node => ({ width: node.width, height: node.height,
  cssWidth: parseFloat(node.style.width), cssHeight: parseFloat(node.style.height) }));
const bounded = size => { assert(size.width * size.height <= 8 * 1024 * 1024); assert(size.width <= 8192 && size.height <= 8192); };
try {
  for (const deviceScaleFactor of [1, 1.5]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/?demo=layout');
    await page.waitForSelector('#pdf-container [data-pdf-ready="1"]');
    await page.waitForSelector('#translated-pdf-container [data-pdf-ready="1"]');
    for (const id of ['pdf-container', 'translated-pdf-container']) {
      const size = await bitmap(page.locator(`#${id} canvas`).first());
      assert(size.width / size.cssWidth >= 1.99, 'Small PDF text must be supersampled on ordinary and fractional-DPI screens'); bounded(size);
    }
    // Check actual composited pixels: the yellow overlay must preserve dark ink.
    const image = await page.locator('#pdf-container [data-linked-id="s000001"]').first().screenshot({ scale: 'css' });
    const dark = await page.evaluate(async encoded => {
      const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
      const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); image.close();
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0; for (let i = 0; i < data.length; i += 4) if (data[i] < 70 && data[i + 1] < 70 && data[i + 2] < 70) count++;
      return count;
    }, image.toString('base64'));
    assert(dark > 20, 'Selected PDF text must remain dark under the yellow highlight');
    await page.locator('#focus-mode').uncheck();
    assert.equal(await page.locator('#pdf-container .pdf-focus-veil').count(), 0);
    await page.locator('#focus-mode').check();
    assert.equal(await page.locator('#pdf-container .pdf-focus-veil').count() > 0, true);
    const originalBox = await page.locator('#pdf-container [data-linked-id="s000001"]').first().evaluate(node => [node.style.left, node.style.top, node.style.width, node.style.height]);
    await page.locator('#pdf-zoom').selectOption('2');
    await page.waitForFunction(() => parseFloat(document.querySelector('#pdf-container .pdf-page-slot').style.width) > 1000 && document.querySelector('#pdf-container [data-pdf-ready="1"]'));
    const zoomedBox = await page.locator('#pdf-container [data-linked-id="s000001"]').first().evaluate(node => [node.style.left, node.style.top, node.style.width, node.style.height]);
    assert.deepEqual(zoomedBox, originalBox, 'Supersampling must preserve cropped-PDF highlight coordinates during zoom');
    bounded(await bitmap(page.locator('#pdf-container canvas').first()));
    if (deviceScaleFactor === 1.5) { assert.deepEqual(errors, []); await page.close(); continue; }

    // Switch from externally cropped bilingual PDFs to the native Chinese preview.
    const archive = await page.evaluate(async () => {
      const value = await (await fetch('/examples/layout-demo.句读.json')).json();
      const { loadPdf, extractPdf } = await import('/pdf-reader.mjs'), { newProject } = await import('/alignment.mjs');
      const bytes = Uint8Array.from(atob(value.project.pdfBase64), c => c.charCodeAt(0));
      const pdf = await loadPdf(new Blob([bytes], { type: 'application/pdf' }));
      const units = await extractPdf(pdf); await pdf.destroy();
      const project = newProject('Rendering regression', units);
      project.pdfBase64 = value.project.pdfBase64; project.view = 'pdf'; project.targetView = 'layout';
      project.groups.forEach(group => { group.translation = '这是测试译文。'; });
      return { ...value, project };
    });
    await page.locator('#project-file').setInputFiles({ name: 'rendering.句读.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)) });
    await page.waitForSelector('#translated-pdf-container [data-layout-ready="1"]');
    const size = await bitmap(page.locator('#translated-pdf-container canvas').first());
    assert(size.width / size.cssWidth >= 1.99); bounded(size);
    assert.equal(await page.locator('#translated-pdf-container .layout-sentence').count() > 0, true, 'Chinese preview text must remain visible');
    const before = await page.locator('#position-label').textContent();
    await page.locator('#source-scroll').evaluate(node => { node.scrollTop = 200; });
    const scroll = await page.locator('#source-scroll').evaluate(node => node.scrollTop);
    await page.locator('#pdf-container canvas').first().evaluate(node => { node.dataset.oldBitmap = 'true'; });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 3, mobile: false });
    // CDP changes devicePixelRatio without emitting the browser's native resize
    // or resolution-media event. Deliver the notification without changing width.
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.waitForFunction(() => {
      const canvas = document.querySelector('#pdf-container [data-pdf-ready="1"] canvas');
      return canvas && !canvas.dataset.oldBitmap && canvas.width / parseFloat(canvas.style.width) > 2.99;
    });
    assert.equal(await page.locator('#position-label').textContent(), before, 'A display-density change must preserve the selected sentence');
    assert(Math.abs(await page.locator('#source-scroll').evaluate(node => node.scrollTop) - scroll) < 3, 'A display-density change must preserve reading position');
    await page.waitForFunction(() => {
      const canvas = document.querySelector('#translated-pdf-container [data-layout-ready="1"] canvas');
      return canvas && canvas.width / parseFloat(canvas.style.width) > 2.99;
    });
    const limits = await page.evaluate(async () => {
      const { pdfCanvasSize } = await import('/pdf-rendering.mjs');
      return [pdfCanvasSize({ width: 50000, height: 20000 }, 4), pdfCanvasSize({ width: 12000, height: 200 }, 4)];
    });
    limits.forEach(bounded);
    await page.locator('#next-sentence').focus(); await page.keyboard.press('ArrowDown');
    assert.notEqual(await page.locator('#position-label').textContent(), before, 'Sentence navigation must keep working after a resolution change');
    assert.deepEqual(errors, []); await page.close();
  }
  console.log('PASS: PDF sharpness at normal/fractional DPI, dark highlighted text, cropped-page zoom alignment, bitmap limits, native Chinese preview and automatic density refresh preserving sentence and scroll.');
} finally {
  await browser.close();
}
