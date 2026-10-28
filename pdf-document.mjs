// Continuous page slots keep their dimensions when their canvases are unloaded.
// Rendering and navigation have separate lifetimes: scrolling never selects text.
export class PdfDocumentPane {
  constructor(container, factory, { preview = false, onVisible = () => {}, onRendered = () => {}, onError = () => {} } = {}) {
    Object.assign(this, { container, factory, preview, onVisible, onRendered, onError });
    this.scroll = container.parentElement; this.generation = 0; this.records = []; this.ids = [];
    container.classList.add('pdf-document');
    this.scroll.addEventListener('scroll', () => {
      cancelAnimationFrame(this.scrollFrame);
      this.scrollFrame = requestAnimationFrame(() => this.trackVisible());
    }, { passive: true });
  }
  clear() {
    this.generation++; this.observer?.disconnect(); cancelAnimationFrame(this.scrollFrame);
    for (const record of this.records) record.renderer?.clear();
    this.records = []; this.pdf = null; this.pendingPosition = null; this.container.replaceChildren(); this.ids = [];
  }
  invalidate() {
    for (const record of this.records) { record.renderer?.clear(); record.renderer = null; record.promise = null; record.stats = null; }
    this.revision = (this.revision || 0) + 1;
    for (const record of this.records) { this.observer?.unobserve(record.slot); this.observer?.observe(record.slot); }
  }
  async render(pdf, number, units, zoom = 1, crops = null, groups = null) {
    // Use the viewport, not content/scroll width: an enlarged page must not
    // become the base width for the next zoom or resize.
    const width = Math.max(160, this.scroll.clientWidth - 16) * zoom;
    const pixelRatio = window.devicePixelRatio || 1;
    if (this.pdf !== pdf || this.width !== width || this.crops !== crops || this.pixelRatio !== pixelRatio) {
      const old = this.pendingPosition || this.capturePosition();
      const samePdf = this.pdf === pdf;
      this.clear(); this.pdf = pdf; this.width = width; this.crops = crops; this.pixelRatio = pixelRatio;
      this.pendingPosition = samePdf && old ? old : { page: number, fraction: 0 };
      const generation = this.generation;
      this.units = units; this.groups = groups;
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        if (generation !== this.generation) return;
        const base = page.getViewport({ scale: 1 }), crop = crops?.[pageNumber] || { w: 1, h: 1 };
        const slot = document.createElement('section'); slot.className = 'pdf-page-slot'; slot.dataset.pageNumber = pageNumber;
        slot.setAttribute('aria-label', `第 ${pageNumber} 页`);
        slot.style.width = width + 'px'; slot.style.height = width * base.height * crop.h / (base.width * crop.w) + 'px';
        const label = document.createElement('span'); label.className = 'pdf-page-label'; label.textContent = `第 ${pageNumber} 页`;
        const host = document.createElement('div'); host.className = 'pdf-page-host'; slot.append(host, label); this.container.append(slot);
        this.records.push({ number: pageNumber, slot, host });
      }
      this.observer = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) {
          const record = this.records[Number(entry.target.dataset.pageNumber) - 1];
          this.ensure(record.number).catch(this.onError);
        }
      }, { root: this.scroll, rootMargin: '600px 0px' });
      for (const record of this.records) this.observer.observe(record.slot);
      this.restorePosition(this.pendingPosition); this.pendingPosition = null;
    } else {
      this.units = units; this.groups = groups;
    }
    await this.ensure(number);
    this.trackVisible();
  }
  capturePosition() {
    if (!this.records.length) return null;
    const root = this.scroll.getBoundingClientRect(), top = root.top;
    const record = this.records.find(r => r.slot.getBoundingClientRect().bottom > top) || this.records.at(-1);
    const rect = record.slot.getBoundingClientRect();
    return { page: record.number, fraction: Math.max(0, (top - rect.top) / rect.height),
      horizontal: (root.left + this.scroll.clientLeft + this.scroll.clientWidth / 2 - rect.left) / rect.width };
  }
  restorePosition(position) {
    const record = this.records[position.page - 1]; if (!record) return;
    const rect = record.slot.getBoundingClientRect(), root = this.scroll.getBoundingClientRect();
    const left = Number.isFinite(position.horizontal)
      ? this.scroll.scrollLeft + rect.left - root.left - this.scroll.clientLeft + position.horizontal * rect.width - this.scroll.clientWidth / 2 : this.scroll.scrollLeft;
    this.scroll.scrollTo({ top: this.scroll.scrollTop + rect.top - root.top + position.fraction * rect.height, left, behavior: 'instant' });
  }
  trackVisible() {
    if (!this.records.length || this.container.hidden) return;
    const root = this.scroll.getBoundingClientRect(), line = root.top + Math.min(100, root.height * .25);
    const record = this.records.find(r => r.slot.getBoundingClientRect().bottom > line) || this.records.at(-1);
    this.visiblePage = record.number; this.onVisible(record.number); this.evict();
  }
  async ensure(number) {
    const record = this.records[number - 1]; if (!record) return;
    if (record.promise) return record.promise;
    const renderer = this.factory(record.host), generation = this.generation, revision = this.revision;
    record.renderer = renderer; renderer.pageWidth = this.width; renderer.selectionRoot = this.container;
    renderer.onSelection = selection => this.readSelection(selection);
    record.promise = (async () => {
      const result = this.preview
        ? await renderer.render(this.pdf, number, this.units, this.groups, 1)
        : await renderer.render(this.pdf, number, this.units, 1, this.crops?.[number]);
      if (generation !== this.generation || revision !== this.revision || record.renderer !== renderer) return;
      record.stats = result; renderer.setFocus?.(this.focus); renderer.highlight(this.ids); this.onRendered(number, result); this.evict(); return result;
    })().catch(error => {
      if (generation !== this.generation || record.renderer !== renderer) return;
      record.promise = null; throw error;
    });
    return record.promise;
  }
  evict() {
    const root = this.scroll.getBoundingClientRect(), selection = document.getSelection();
    const mounted = this.records.filter(r => r.renderer);
    if (mounted.length <= 8) return;
    const candidates = mounted.filter(r => {
      const rect = r.slot.getBoundingClientRect();
      return !r.locks && (rect.bottom < root.top - 700 || rect.top > root.bottom + 700)
        && !(selection?.rangeCount && !selection.isCollapsed && selection.getRangeAt(0).intersectsNode(r.slot));
    }).sort((a, b) => Math.abs(b.number - (this.visiblePage || 1)) - Math.abs(a.number - (this.visiblePage || 1)));
    for (const record of candidates.slice(0, Math.max(0, mounted.length - 8))) {
      record.renderer.clear(); record.renderer = null; record.promise = null; record.host.replaceChildren();
    }
  }
  highlight(ids) {
    this.ids = [...ids]; let first;
    const ordered = [...this.records].sort((a, b) => Math.abs(a.number - (this.visiblePage || 1)) - Math.abs(b.number - (this.visiblePage || 1)));
    for (const record of ordered) { const node = record.renderer?.highlight(ids); if (!first && node) first = node; }
    return first;
  }
  setFocus(enabled) { this.focus = enabled; for (const record of this.records) record.renderer?.setFocus?.(enabled); }
  readSelection(selection) {
    if (!selection?.rangeCount || selection.isCollapsed || !this.container.contains(selection.anchorNode) || !this.container.contains(selection.focusNode)) return;
    const ids = new Set();
    for (const record of this.records) for (const id of record.renderer?.selectionIds?.(selection) || []) ids.add(id);
    if (ids.size) this.records.find(r => r.renderer)?.renderer.onSelect([...ids]);
  }
  async reveal(ids, valid = () => true, center = false) {
    const selected = this.units.filter(u => ids.includes(u.source_id));
    const pages = [...new Set(selected.flatMap(u => [...(u.anchors || []), ...(u.pdfBoxes || [])].map(a => a.page)))];
    const number = pages.includes(this.visiblePage) ? this.visiblePage : pages[0];
    if (!number) return;
    // A sentence can continue on the adjacent page; both fragments stay linked.
    const records = pages.filter(p => Math.abs(p - number) <= 1).map(p => this.records[p - 1]).filter(Boolean);
    for (const record of records) record.locks = (record.locks || 0) + 1;
    try {
      await Promise.all(records.map(record => this.ensure(record.number)));
      if (!valid()) return;
      this.highlight(ids);
      const element = this.records[number - 1]?.renderer?.highlight(ids);
      if (element) this.revealElement(element, center);
      else await this.jump(number, valid);
    } finally { for (const record of records) record.locks--; this.evict(); }
  }
  revealElement(element, center = false) {
    const rect = element.getBoundingClientRect(), root = this.scroll.getBoundingClientRect();
    const margin = center ? root.height * .28 : 20;
    if (rect.top >= root.top + margin && rect.bottom <= root.bottom - margin && rect.left >= root.left && rect.right <= root.right) return;
    const top = this.scroll.scrollTop + rect.top - root.top - Math.max(20, (root.height - Math.min(rect.height, root.height)) / 2);
    const left = this.scroll.scrollLeft + rect.left - root.left - Math.max(12, (root.width - Math.min(rect.width, root.width)) / 2);
    this.scroll.scrollTo({ top, left, behavior: 'instant' }); this.trackVisible();
  }
  async jump(number, valid = () => true) {
    number = Math.max(1, Math.min(this.records.length, Number(number) || 1));
    const record = this.records[number - 1]; if (!record) return;
    record.locks = (record.locks || 0) + 1;
    try {
      await this.ensure(number); if (!valid()) return;
      this.restorePosition({ page: number, fraction: 0 }); this.trackVisible();
    } finally { record.locks--; this.evict(); }
  }
}
