// Independent zoom, scroll anchors and bilingual navigation; self-authored PDFs only.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.READER_TEST_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch({ headless: true, ...(process.env.READER_BROWSER ? { executablePath: process.env.READER_BROWSER } : {}) });
try {
  for (const native of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    const archive = await page.evaluate(async native => {
      const value = await (await fetch('/examples/layout-demo.句读.json')).json();
      if (native) {
        const { loadPdf, extractPdf } = await import('/pdf-reader.mjs');
        const { newProject } = await import('/alignment.mjs');
        const bytes = Uint8Array.from(atob(value.project.pdfBase64), c => c.charCodeAt(0));
        const pdf = await loadPdf(new Blob([bytes]));
        const units = await extractPdf(pdf); await pdf.destroy();
        const project = newProject('Independent zoom preview', units, { view: 'pdf', targetView: 'layout', pdfBase64: value.project.pdfBase64 });
        project.groups.forEach(g => { g.translation = '这是用于检查中文缩放和双向定位的测试译文。'; });
        value.project = project;
      }
      value.project.pdfZoom = 1.25; // Migration from the old shared zoom setting.
      delete value.project.targetPdfZoom;
      return value;
    }, native);
    await page.locator('#project-file').setInputFiles({ name: 'zoom.句读.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)) });
    const source = '#pdf-container', target = '#translated-pdf-container';
    const ready = async id => page.waitForSelector(`${id} [${native && id === target ? 'data-layout-ready' : 'data-pdf-ready'}="1"]`);
    const width = id => page.locator(id + ' .pdf-page-slot').first().evaluate(n => parseFloat(n.style.width));
    const scroll = id => page.locator(id).evaluate(n => ({ top: n.scrollTop, left: n.scrollLeft }));
    const zoom = async (side, scale) => {
      const prefix = side === source ? '#pdf-zoom' : '#target-pdf-zoom';
      await page.locator(prefix).selectOption(String(scale));
      await page.waitForFunction(({ id, scale }) => {
        const root = document.querySelector(id), slot = root.querySelector('.pdf-page-slot');
        return slot && Math.abs(parseFloat(slot.style.width) - (root.parentElement.clientWidth - 16) * scale) < .1;
      }, { id: side, scale });
      await ready(side);
    };
    await ready(source); await ready(target);
    assert.equal(await page.locator('#pdf-zoom').inputValue(), '1.25');
    assert.equal(await page.locator('#target-pdf-zoom').inputValue(), '1.25', 'Old shared zoom must migrate to both sides');
    const originalSource = await width(source), originalTarget = await width(target);
    // Tag the opposite bitmap: independent zoom must not even repaint it.
    await page.locator(target + ' canvas').first().evaluate(n => { n.dataset.unchanged = 'true'; });
    const targetScroll = await scroll('#target-scroll');
    await zoom(source, 2);
    assert(Math.abs(await width(source) / originalSource - 2 / 1.25) < .01);
    assert.equal(await width(target), originalTarget);
    assert.equal(await page.locator(target + ' canvas').first().getAttribute('data-unchanged'), 'true');
    assert.deepEqual(await scroll('#target-scroll'), targetScroll);
    await page.locator(source + ' canvas').first().evaluate(n => { n.dataset.unchanged = 'true'; });
    const sourceScroll = await scroll('#source-scroll');
    await zoom(target, 3);
    assert.equal(await width(source), originalSource * 2 / 1.25);
    assert.equal(await page.locator(source + ' canvas').first().getAttribute('data-unchanged'), 'true');
    assert.deepEqual(await scroll('#source-scroll'), sourceScroll);
    assert.equal(await page.locator('#target-pdf-zoom-in').isDisabled(), true);
    // Keep the same point in a column while enlarging; remember horizontal pan.
    const anchor = async (side = '#target-scroll') => page.locator(side).evaluate(root => {
      const rect = root.getBoundingClientRect(), slot = [...root.querySelectorAll('.pdf-page-slot')].find(n => n.getBoundingClientRect().bottom > rect.top);
      const box = slot.getBoundingClientRect();
      return { page: slot.dataset.pageNumber, fraction: (rect.top - box.top) / box.height, horizontal: (rect.left + root.clientWidth / 2 - box.left) / box.width };
    });
    await page.locator('#target-scroll').evaluate(n => { n.scrollTop = 250; n.scrollLeft = 300; });
    const oldAnchor = await anchor();
    await zoom(target, 2.5);
    const newAnchor = await anchor();
    assert.equal(newAnchor.page, oldAnchor.page);
    assert(Math.abs(newAnchor.fraction - oldAnchor.fraction) < .005, 'Vertical reading position must survive zoom');
    assert(Math.abs(newAnchor.horizontal - oldAnchor.horizontal) < .005, 'Horizontal column position must survive zoom');
    await page.locator('#source-scroll').evaluate(n => { n.scrollTop = 200; n.scrollLeft = 200; });
    const rapidAnchor = await anchor('#source-scroll');
    await page.evaluate(() => { document.getElementById('pdf-zoom-in').click(); document.getElementById('pdf-zoom-in').click(); });
    await ready(source);
    const rapidResult = await anchor('#source-scroll');
    assert.equal(await page.locator('#pdf-zoom').inputValue(), '3');
    assert.equal(rapidResult.page, rapidAnchor.page);
    assert(Math.abs(rapidResult.fraction - rapidAnchor.fraction) < .005 && Math.abs(rapidResult.horizontal - rapidAnchor.horizontal) < .005, 'Rapid zoom clicks must retain the original reading position');
    await zoom(source, 2);
    // Repeated selection and resize must always use the pane viewport as base.
    const fixedWidth = await width(target);
    for (let i = 0; i < 3; i++) { await zoom(target, 2.5); assert.equal(await width(target), fixedWidth); }
    await page.locator('#focus-mode').uncheck();
    let linkedId;
    if (native) {
      const sentence = page.locator(target + ' .layout-sentence').nth(1);
      linkedId = (await sentence.getAttribute('data-layout-ids')).split(' ')[0];
      await sentence.click();
    } else {
      linkedId = 's000002';
      const box = archive.project.units.find(u => u.source_id === linkedId).targetBoxes[0];
      const point = await page.locator('#target-scroll').evaluate((root, box) => {
        const page = root.querySelector('.pdf-page'), width = page.clientWidth, height = page.clientHeight;
        const x = (box.x + box.w / 2) * width, y = (box.y + box.h / 2) * height;
        root.scrollLeft = x - root.clientWidth / 2; root.scrollTop = y - root.clientHeight / 2;
        const rect = page.getBoundingClientRect(); return { x: rect.left + x, y: rect.top + y };
      }, box);
      await page.mouse.click(point.x, point.y);
    }
    await page.waitForSelector(`${source} [data-linked-id="${linkedId}"]`);
    if (!await page.locator('#reader-desk').isHidden()) await page.locator('#desk-close').click();
    const selected = await page.locator('#position-label').textContent();
    await page.locator('#next-sentence').focus(); await page.keyboard.press('ArrowDown');
    await page.waitForFunction(before => document.getElementById('position-label').textContent !== before, selected);
    // Save/reload both zooms and the horizontal reading position.
    await page.locator('#target-scroll').evaluate(n => { n.scrollLeft = 250; });
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#export-project').click();
    const download = await downloadPromise, chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    const saved = JSON.parse(Buffer.concat(chunks).toString('utf8')).project;
    assert.equal(saved.pdfZoom, 2); assert.equal(saved.targetPdfZoom, 2.5);
    await page.waitForFunction(() => document.getElementById('save-state').textContent.includes('已保存'));
    await page.reload(); await ready(source); await ready(target);
    await page.waitForFunction(() => document.getElementById('save-state').textContent.includes('已保存'));
    assert.equal(await page.locator('#pdf-zoom').inputValue(), '2');
    assert.equal(await page.locator('#target-pdf-zoom').inputValue(), '2.5');
    assert(Math.abs((await scroll('#target-scroll')).left - 250) < 3, 'Reload must retain horizontal reading position');
    for (const viewportWidth of [860, 390, 1440]) {
      await page.setViewportSize({ width: viewportWidth, height: 1000 });
      await page.waitForFunction(() => ['pdf-container', 'translated-pdf-container'].every((id, i) => {
        const root = document.getElementById(id), slot = root.querySelector('.pdf-page-slot');
        return slot && Math.abs(parseFloat(slot.style.width) - (root.parentElement.clientWidth - 16) * [2, 2.5][i]) < .1;
      }));
      for (const id of ['pdf-zoom-in', 'target-pdf-zoom-in', 'pdf-zoom', 'target-pdf-zoom']) {
        assert(await page.locator('#' + id).isVisible());
        assert(await page.locator('#' + id).evaluate(n => { const r = n.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }), 'Zoom controls must remain reachable on narrow screens');
      }
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Only the PDF panes may scroll horizontally');
    }
    await ready(source); await ready(target);
    if (process.env.READER_TEST_SCREENSHOT && native) await page.screenshot({ path: process.env.READER_TEST_SCREENSHOT, fullPage: true });
    await page.locator('#pdf-zoom-fit').click(); await ready(source);
    assert.equal(await page.locator('#pdf-zoom').inputValue(), '1');
    assert.equal(await page.locator('#target-pdf-zoom').inputValue(), '2.5');
    await zoom(target, .75);
    assert.equal(await page.locator('#target-pdf-zoom-out').isDisabled(), true);
    await page.locator('#target-pdf-zoom-in').click(); await ready(target);
    assert.equal(await page.locator('#target-pdf-zoom').inputValue(), '1');
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('PASS: independent native/paired PDF zoom, legacy settings, opposite-pane preservation, horizontal and vertical anchors, reverse links, arrow navigation, reload and narrow-screen controls.');
} finally { await browser.close(); }
