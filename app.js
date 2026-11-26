/* HWPX viewer / editor — 100% in-browser (JSZip + DOM XML) */
'use strict';
(() => {
  const HP_NS = 'http://www.hancom.co.kr/hwpml/2011/paragraph';
  const MIMETYPE = 'application/hwp+zip';
  const ALIGN = { JUSTIFY: 'justify', LEFT: 'left', CENTER: 'center', RIGHT: 'right', DISTRIBUTE: 'justify' };

  const $id = (id) => document.getElementById(id);
  const ui = {
    fileInput: $id('fileInput'), fileName: $id('fileName'), fileStatus: $id('fileStatus'),
    modeToggle: $id('modeToggle'), replaceBtn: $id('replaceBtn'), saveBtn: $id('saveBtn'),
    openBtn: $id('openBtn'), dropzone: $id('dropzone'), docWrap: $id('docWrap'), doc: $id('doc'),
    dzOpenBtn: $id('dzOpenBtn'), replacePanel: $id('replacePanel'), findInput: $id('findInput'),
    replaceInput: $id('replaceInput'), replaceAllBtn: $id('replaceAllBtn'),
    replaceCloseBtn: $id('replaceCloseBtn'), replaceResult: $id('replaceResult'),
    toast: $id('toast'), dropOverlay: $id('dropOverlay'),
  };

  const state = {
    zip: null,
    fileName: '',
    sections: [],            // { path, doc, dirty }
    nodeMap: new WeakMap(),  // rendered .hp-p element -> { el, pEl, sec, originalText }
    dirtyNodes: new Set(),   // XML <p> elements changed by the user
    styles: { char: new Map(), para: new Map() },
    mode: 'read',
    busy: false,
  };

  /* ---------------- helpers ---------------- */
  const local = (node) => (node.localName || String(node.nodeName).split(':').pop());
  const kids = (node, name) => Array.from(node.children || []).filter((c) => local(c) === name);
  const allByLocal = (root, name) => Array.from(root.getElementsByTagName('*')).filter((n) => local(n) === name);

  function normalizeText(text) {
    return String(text == null ? '' : text).replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  }

  let toastTimer = null;
  function toast(message, isError) {
    const t = ui.toast;
    t.textContent = message;
    t.classList.toggle('error', !!isError);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 5200 : 3200);
  }

  /* ---------------- styles from header.xml ---------------- */
  async function loadStyles(zip) {
    state.styles.char.clear();
    state.styles.para.clear();
    const headerFile = zip.file(/Contents\/header\.xml$/i)[0];
    if (!headerFile) return;
    let doc;
    try {
      doc = new DOMParser().parseFromString(await headerFile.async('string'), 'application/xml');
    } catch (e) { return; }
    for (const cp of allByLocal(doc, 'charPr')) {
      const id = cp.getAttribute('id');
      if (id == null) continue;
      const height = parseInt(cp.getAttribute('height') || '1000', 10) || 1000;
      const flag = (name) => kids(cp, name).length > 0 || cp.getAttribute(name) === '1' || cp.getAttribute(name) === 'true';
      state.styles.char.set(String(id), {
        sizePt: height / 100,
        bold: flag('bold'),
        italic: flag('italic'),
        underline: flag('underline'),
        color: cp.getAttribute('textColor') || '',
      });
    }
    for (const pp of allByLocal(doc, 'paraPr')) {
      const id = pp.getAttribute('id');
      if (id == null) continue;
      const alignEl = kids(pp, 'align')[0];
      const align = alignEl ? alignEl.getAttribute('horizontal') : null;
      state.styles.para.set(String(id), { align: ALIGN[align] || null });
    }
  }

  /* ---------------- package structure ---------------- */
  function naturalCompare(a, b) {
    const na = a.match(/\d+/g), nb = b.match(/\d+/g);
    if (na && nb) {
      for (let i = 0; i < Math.min(na.length, nb.length); i++) {
        const d = parseInt(na[i], 10) - parseInt(nb[i], 10);
        if (d) return d;
      }
    }
    return a.localeCompare(b);
  }

  async function findSectionPaths(zip) {
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    const paths = [];
    const hpf = zip.file(/Contents\/content\.hpf$/i)[0] || zip.file(/content\.hpf$/i)[0];
    if (hpf) {
      try {
        const doc = new DOMParser().parseFromString(await hpf.async('string'), 'application/xml');
        const items = new Map();
        for (const node of allByLocal(doc, 'item')) {
          const id = node.getAttribute('id');
          const href = node.getAttribute('href');
          if (id && href) items.set(id, href);
        }
        for (const node of allByLocal(doc, 'itemref')) {
          const href = items.get(node.getAttribute('idref'));
          if (href && /section/i.test(href)) {
            const direct = names.find((n) => n === href || n.endsWith('/' + href));
            paths.push(direct || ('Contents/' + href.replace(/^\.?\//, '')));
          }
        }
      } catch (e) { /* fall through to scan */ }
    }
    if (!paths.length) {
      const scanned = names.filter((n) => /(^|\/)section\d+\.xml$/i.test(n)).sort(naturalCompare);
      paths.push(...scanned);
    }
    const seen = new Set();
    return paths.filter((p) => {
      if (!zip.files[p] || seen.has(p)) return false;
      seen.add(p);
      return true;
    });
  }

  /* ---------------- opening a file ---------------- */
  async function openFile(file) {
    if (!file) return;
    if (typeof JSZip === 'undefined') {
      toast('JSZip 라이브러리를 불러오지 못했습니다. 네트워크 연결을 확인해 주세요.', true);
      return;
    }
    if (!/\.hwpx$/i.test(file.name)) {
      toast('확장자가 .hwpx 인 파일만 열 수 있습니다.', true);
      return;
    }
    ui.fileStatus.textContent = '여는 중…';
    try {
      const buffer = await file.arrayBuffer();
      const zip = await JSZip.loadAsync(buffer);
      const paths = await findSectionPaths(zip);
      if (!paths.length) throw new Error('본문(section) XML을 찾지 못했습니다. HWPX 파일인지 확인해 주세요.');

      await loadStyles(zip);

      const sections = [];
      for (const path of paths) {
        const xml = await zip.file(path).async('string');
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        if (doc.getElementsByTagName('parsererror').length) throw new Error('본문 XML을 해석하지 못했습니다: ' + path);
        sections.push({ path, doc, dirty: false });
      }

      state.zip = zip;
      state.sections = sections;
      state.fileName = file.name;
      state.dirtyNodes = new Set();
      state.nodeMap = new WeakMap();
      state.mode = 'read';

      ui.fileName.textContent = file.name;
      ui.fileName.title = file.name;
      ui.dropzone.hidden = true;
      ui.docWrap.hidden = false;
      ui.replacePanel.hidden = true;
      ui.replaceResult.textContent = '';
      setMode('read', { rerender: true });
      [ui.openBtn, ui.saveBtn].forEach((b) => { b.disabled = false; });
      Array.from(ui.modeToggle.querySelectorAll('button')).forEach((b) => { b.disabled = false; });
      toast(`${file.name} · ${sections.length}개 본문을 열었습니다`);
      window.scrollTo({ top: 0 });
    } catch (err) {
      console.error(err);
      ui.fileStatus.textContent = '읽기 전용 뷰어 · 100% 로컬 처리';
      toast('파일을 열지 못했습니다: ' + (err && err.message ? err.message : err), true);
    }
  }

  /* ---------------- rendering ---------------- */
  function renderDocument() {
    if (!state.zip) return;
    const scrollY = window.scrollY;
    ui.doc.textContent = '';
    state.nodeMap = new WeakMap();
    ui.doc.classList.toggle('is-edit', state.mode === 'edit');
    document.body.classList.toggle('mode-edit', state.mode === 'edit');
    for (const sec of state.sections) {
      const root = sec.doc.documentElement;
      if (!root) continue;
      renderBlocks(root, ui.doc, sec);
    }
    updateStatus();
    window.scrollTo({ top: scrollY });
  }

  function renderBlocks(parentXml, host, sec) {
    for (const child of Array.from(parentXml.children)) {
      const name = local(child);
      if (name === 'p') renderParagraphBlock(child, host, sec);
      else if (name === 'tbl') host.appendChild(renderTable(child, sec));
    }
  }

  function tablesOf(pEl) {
    const found = [];
    for (const tbl of kids(pEl, 'tbl')) found.push(tbl);
    for (const run of kids(pEl, 'run')) for (const tbl of kids(run, 'tbl')) found.push(tbl);
    return found;
  }

  function renderParagraphBlock(pEl, host, sec) {
    const text = ownText(pEl);
    const tables = tablesOf(pEl);
    if (text.length || !tables.length) host.appendChild(makeParagraph(pEl, sec));
    for (const tbl of tables) host.appendChild(renderTable(tbl, sec));
  }

  function ownRuns(pEl) {
    return kids(pEl, 'run').map((run) => {
      let text = '';
      for (const child of Array.from(run.children)) {
        const name = local(child);
        if (name === 't') text += child.textContent;
        else if (name === 'lineBreak') text += '\n';
        else if (name === 'tab') text += '\t';
      }
      return { text, charPrIDRef: run.getAttribute('charPrIDRef') };
    });
  }

  function ownText(pEl) {
    let out = '';
    const walk = (node) => {
      for (const child of Array.from(node.children)) {
        const name = local(child);
        if (name === 'tbl' || name === 'subList') continue;
        if (name === 't') out += child.textContent;
        else if (name === 'lineBreak') out += '\n';
        else if (name === 'tab') out += '\t';
        else walk(child);
      }
    };
    walk(pEl);
    return out;
  }

  function appendWithBreaks(parent, text) {
    const parts = text.split('\n');
    parts.forEach((part, i) => {
      if (i) parent.appendChild(document.createElement('br'));
      if (part) parent.appendChild(document.createTextNode(part));
    });
  }

  function makeParagraph(pEl, sec) {
    const div = document.createElement('div');
    div.className = 'hp-p';
    const paraStyle = state.styles.para.get(String(pEl.getAttribute('paraPrIDRef') || '0'));
    if (paraStyle && paraStyle.align) div.style.textAlign = paraStyle.align;

    const runs = ownRuns(pEl);
    let text = '';
    for (const run of runs) {
      if (!run.text) continue;
      text += run.text;
      const span = document.createElement('span');
      span.className = 'hp-run';
      const cs = state.styles.char.get(String(run.charPrIDRef || '0'));
      if (cs) {
        if (cs.bold) span.style.fontWeight = '700';
        if (cs.italic) span.style.fontStyle = 'italic';
        if (cs.underline) span.style.textDecoration = 'underline';
        if (cs.color && cs.color.toLowerCase() !== '#000000') span.style.color = cs.color;
        if (cs.sizePt && cs.sizePt > 0) span.style.fontSize = (Math.round(cs.sizePt * 1.333 * 10) / 10) + 'px';
      }
      appendWithBreaks(span, run.text);
      div.appendChild(span);
    }
    const fullText = runs.map((r) => r.text).join('');
    if (!text) {
      div.classList.add('hp-p-empty');
      div.appendChild(document.createElement('br'));
    }

    state.nodeMap.set(div, { el: div, pEl, sec, originalText: fullText });
    if (state.dirtyNodes.has(pEl)) div.classList.add('modified');
    applyEditable(div);
    return div;
  }

  function applyEditable(div) {
    if (state.mode === 'edit') div.setAttribute('contenteditable', 'true');
    else div.removeAttribute('contenteditable');
  }

  function renderTable(tblEl, sec) {
    const wrap = document.createElement('div');
    wrap.className = 'hp-tbl-wrap';
    const table = document.createElement('table');
    table.className = 'hp-tbl';

    const occupied = [];
    const isTaken = (r, c) => occupied[r] && occupied[r].has(c);
    const take = (r, c) => { (occupied[r] = occupied[r] || new Set()).add(c); };

    Array.from(tblEl.children).filter((c) => local(c) === 'tr').forEach((tr, r) => {
      const trEl = document.createElement('tr');
      let col = 0;
      for (const tc of kids(tr, 'tc')) {
        while (isTaken(r, col)) col++;
        const span = kids(tc, 'cellSpan')[0];
        const colSpan = Math.max(1, Math.min(100, parseInt(span ? span.getAttribute('colSpan') : '1', 10) || 1));
        const rowSpan = Math.max(1, Math.min(1000, parseInt(span ? span.getAttribute('rowSpan') : '1', 10) || 1));
        const isHeader = ['1', 'true'].includes(tc.getAttribute('header') || '');
        const cell = document.createElement(isHeader ? 'th' : 'td');
        cell.className = 'hp-cell';
        if (colSpan > 1) cell.colSpan = colSpan;
        if (rowSpan > 1) cell.rowSpan = rowSpan;
        for (let rr = r; rr < r + rowSpan; rr++) for (let cc = col; cc < col + colSpan; cc++) take(rr, cc);

        const subList = kids(tc, 'subList')[0];
        const paragraphs = subList ? kids(subList, 'p') : kids(tc, 'p');
        if (!paragraphs.length) {
          const empty = document.createElement('div');
          empty.className = 'hp-p hp-p-empty';
          cell.appendChild(empty);
        }
        for (const pEl of paragraphs) renderParagraphBlock(pEl, cell, sec);

        trEl.appendChild(cell);
        col += colSpan;
      }
      table.appendChild(trEl);
    });

    wrap.appendChild(table);
    return wrap;
  }

  /* ---------------- editing / committing ---------------- */
  function setParagraphText(pEl, text) {
    const doc = pEl.ownerDocument;
    const ns = pEl.namespaceURI || HP_NS;
    const prefix = pEl.prefix || 'hp';
    const make = (name) => doc.createElementNS(ns, prefix + ':' + name);

    let runs = kids(pEl, 'run');
    if (!runs.length) {
      const run = make('run');
      run.setAttribute('charPrIDRef', '0');
      pEl.appendChild(run);
      runs = [run];
    }
    const target = runs.find((r) => kids(r, 't').length) || runs[0];
    const firstT = kids(target, 't')[0] || null;
    const anchor = firstT ? firstT.nextSibling : null;
    const template = firstT ? firstT.cloneNode(false) : null;

    for (const run of runs) {
      for (const t of kids(run, 't')) run.removeChild(t);
      for (const lb of kids(run, 'lineBreak')) run.removeChild(lb);
    }

    const frag = doc.createDocumentFragment();
    text.split('\n').forEach((line, i) => {
      if (i) frag.appendChild(make('lineBreak'));
      const t = template ? template.cloneNode(false) : make('t');
      t.textContent = line;
      frag.appendChild(t);
    });

    if (anchor && anchor.parentNode === target) target.insertBefore(frag, anchor);
    else target.appendChild(frag);
  }

  function commit(pElDiv) {
    const rec = state.nodeMap.get(pElDiv);
    if (!rec) return false;
    const next = normalizeText(pElDiv.innerText);
    const prev = normalizeText(rec.originalText);
    if (next === prev) {
      refreshParagraph(rec);
      return false;
    }
    setParagraphText(rec.pEl, next);
    rec.sec.dirty = true;
    state.dirtyNodes.add(rec.pEl);
    refreshParagraph(rec);
    updateStatus();
    return true;
  }

  function refreshParagraph(rec) {
    if (!rec.el.parentNode) return;
    const fresh = makeParagraph(rec.pEl, rec.sec);
    state.nodeMap.delete(rec.el);
    rec.el.replaceWith(fresh);
    if (state.mode === 'edit' && document.activeElement === rec.el) fresh.focus();
  }

  function commitActive() {
    const active = document.activeElement;
    if (active && active.classList && active.classList.contains('hp-p')) commit(active);
  }

  /* ---------------- mode / status ---------------- */
  function setMode(mode, opts) {
    commitActive();
    state.mode = mode;
    Array.from(ui.modeToggle.querySelectorAll('button')).forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    if (mode !== 'edit') ui.replacePanel.hidden = true;
    ui.replaceBtn.disabled = !(state.zip && mode === 'edit');
    if (state.zip) {
      if (!opts || opts.rerender) renderDocument();
      updateStatus();
    }
  }

  function updateStatus() {
    const st = ui.fileStatus;
    if (!state.zip) {
      st.textContent = '읽기 전용 뷰어 · 100% 로컬 처리';
      st.classList.remove('dirty');
      return;
    }
    const n = state.dirtyNodes.size;
    if (n) {
      st.textContent = `수정 ${n}곳 · 저장하면 새 .hwpx 파일로 내려받습니다`;
      st.classList.add('dirty');
    } else {
      st.textContent = state.mode === 'edit'
        ? '편집 모드 · 수정한 곳은 노란색으로 표시됩니다'
        : '읽기 모드 · 고치려면 [편집]을 누르세요';
      st.classList.remove('dirty');
    }
  }

  /* ---------------- find & replace ---------------- */
  function replaceAll(find, replacement) {
    if (!find) return 0;
    let count = 0;
    for (const sec of state.sections) {
      for (const pEl of allByLocal(sec.doc, 'p')) {
        const text = ownText(pEl);
        if (!text.includes(find)) continue;
        const next = text.split(find).join(replacement);
        count += text.split(find).length - 1;
        setParagraphText(pEl, next);
        sec.dirty = true;
        state.dirtyNodes.add(pEl);
      }
    }
    if (count) renderDocument();
    return count;
  }

  /* ---------------- saving ---------------- */
  function baseName(name) {
    return name.replace(/\.hwpx$/i, '');
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function saveHwpx() {
    if (!state.zip || state.busy) return;
    commitActive();
    state.busy = true;
    ui.saveBtn.disabled = true;
    const label = ui.saveBtn.textContent;
    ui.saveBtn.textContent = '저장 중…';
    try {
      const dirty = new Map(state.sections.filter((s) => s.dirty).map((s) => [s.path, s]));
      const out = new JSZip();
      // HWPX requires mimetype first and stored without compression
      out.file('mimetype', MIMETYPE, { compression: 'STORE' });

      for (const name of Object.keys(state.zip.files)) {
        const entry = state.zip.files[name];
        if (entry.dir || name === 'mimetype') continue;
        const sec = dirty.get(name);
        if (sec) {
          let xml = new XMLSerializer().serializeToString(sec.doc);
          if (!/^\s*<\?xml/i.test(xml)) xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + xml;
          out.file(name, xml, { compression: 'DEFLATE' });
        } else {
          out.file(name, await entry.async('uint8array'), { compression: 'DEFLATE' });
        }
      }

      const blob = await out.generateAsync({ type: 'blob', compression: 'DEFLATE', mimeType: MIMETYPE });
      downloadBlob(blob, baseName(state.fileName) + '_수정.hwpx');
      toast(`저장 완료 · ${baseName(state.fileName)}_수정.hwpx`);
    } catch (err) {
      console.error(err);
      toast('저장에 실패했습니다: ' + (err && err.message ? err.message : err), true);
    } finally {
      state.busy = false;
      ui.saveBtn.disabled = false;
      ui.saveBtn.textContent = label;
    }
  }

  /* ---------------- events ---------------- */
  function bind() {
    ui.openBtn.addEventListener('click', () => ui.fileInput.click());
    ui.dzOpenBtn.addEventListener('click', () => ui.fileInput.click());
    ui.fileInput.addEventListener('change', () => {
      const file = ui.fileInput.files && ui.fileInput.files[0];
      ui.fileInput.value = '';
      openFile(file);
    });

    ui.modeToggle.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-mode]');
      if (!btn || btn.disabled) return;
      setMode(btn.dataset.mode);
    });

    ui.saveBtn.addEventListener('click', saveHwpx);

    ui.replaceBtn.addEventListener('click', () => {
      if (state.mode !== 'edit') return;
      const open = ui.replacePanel.hidden;
      ui.replacePanel.hidden = !open;
      if (open) ui.findInput.focus();
    });
    ui.replaceCloseBtn.addEventListener('click', () => { ui.replacePanel.hidden = true; });
    ui.replaceAllBtn.addEventListener('click', () => {
      const find = ui.findInput.value;
      if (!find) { ui.replaceResult.textContent = '찾을 내용을 입력해 주세요'; return; }
      const count = replaceAll(find, ui.replaceInput.value);
      ui.replaceResult.textContent = count ? `${count}곳을 바꿨습니다` : '찾는 내용이 없습니다';
      if (count) toast(`${count}곳을 바꿨습니다`);
    });
    [ui.findInput, ui.replaceInput].forEach((input) => {
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ui.replaceAllBtn.click(); });
    });

    ui.doc.addEventListener('focusout', (e) => {
      const p = e.target && e.target.closest ? e.target.closest('.hp-p') : null;
      if (p && p.isContentEditable) commit(p);
    });
    ui.doc.addEventListener('input', (e) => {
      const p = e.target && e.target.closest ? e.target.closest('.hp-p') : null;
      if (!p) return;
      const rec = state.nodeMap.get(p);
      if (!rec) return;
      const changed = normalizeText(p.innerText) !== normalizeText(rec.originalText);
      p.classList.toggle('modified', changed || state.dirtyNodes.has(rec.pEl));
    });

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (state.zip) saveHwpx();
      }
    });

    // drag & drop anywhere on the page
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      dragDepth++;
      ui.dropOverlay.hidden = false;
    });
    window.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) ui.dropOverlay.hidden = true;
    });
    window.addEventListener('dragover', (e) => { e.preventDefault(); });
    window.addEventListener('drop', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      dragDepth = 0;
      ui.dropOverlay.hidden = true;
      const file = Array.from(e.dataTransfer.files).find((f) => /\.hwpx$/i.test(f.name)) || e.dataTransfer.files[0];
      openFile(file);
    });
  }

  bind();
})();
