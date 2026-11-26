/* HWPX viewer / editor — 100% in-browser (JSZip + DOM XML) */
'use strict';
(() => {
  const HP_NS = 'http://www.hancom.co.kr/hwpml/2011/paragraph';
  const MIMETYPE = 'application/hwp+zip';
  const ALIGN = {
    JUSTIFY: 'justify', LEFT: 'left', CENTER: 'center', RIGHT: 'right',
    DISTRIBUTE: 'justify', DISTRIBUTE_SPACE: 'justify',
  };

  /* HWPUNIT: 1pt = 100 HWPUNIT, 1pt = 4/3 CSS px (96dpi) */
  const U2PX = 4 / 3 / 100;
  const U2PT = 1 / 100;
  /* 한글의 줄간격 %는 글자 크기 기준이다. (13pt · 193% → 25.09pt = 33.4px, 실제 문서 렌더 실측 일치)
     CSS 의 단위 없는 line-height 도 같은 뜻이므로 %/100 을 그대로 쓴다. */
  const LINE_FACTOR = 1;

  const FONT_PRESETS = {
    serif: '"함초롬바탕","HCR Batang","한컴바탕","바탕","Batang","AppleMyungjo","Nanum Myeongjo","Noto Serif KR",serif',
    sans: '"함초롬돋움","HCR Dotum","한컴돋움","돋움","맑은 고딕","Malgun Gothic","Apple SD Gothic Neo","NanumGothic","Noto Sans KR",sans-serif',
    mono: '"한컴고정폭","HCR Dotum","D2Coding","Courier New",monospace',
  };
  const MONO_RE = /(굴림체|고정폭|mono|coding|code)/i;
  const GOTHIC_RE = /(돋움|고딕|굴림|맑은|헤드|남산|sans|gothic|malgun|dotum|gulim)/i;
  const SERIF_RE = /(바탕|명조|신명|궁서|batang|serif|myeongjo|myungjo)/i;

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

  const emptyStyles = () => ({
    char: new Map(), para: new Map(), faces: new Map(), borderFills: new Map(), styles: new Map(),
    defaultCharId: '0', defaultParaId: '0',
  });

  const state = {
    zip: null,
    fileName: '',
    sections: [],            // { path, doc, dirty, geom }
    nodeMap: new WeakMap(),  // rendered .hp-p element -> { el, pEl, sec, originalText }
    dirtyNodes: new Set(),   // XML <p> elements changed by the user
    styles: emptyStyles(),
    mode: 'read',
    busy: false,
  };

  /* ---------------- helpers ---------------- */
  const local = (node) => (node.localName || String(node.nodeName).split(':').pop());
  const kids = (node, name) => Array.from(node.children || []).filter((c) => local(c) === name);
  const allByLocal = (root, name) => Array.from(root.getElementsByTagName('*')).filter((n) => local(n) === name);
  const firstIn = (root, name) => (allByLocal(root, name)[0] || null);
  const num = (v, d) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : d;
  };
  const round = (n, p) => {
    const f = Math.pow(10, p);
    return Math.round(n * f) / f;
  };

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

  /* 폰트 이름 → 웹 폰트 스택 (로컬에 설치된 한컴 글꼴을 먼저, 없으면 Noto 폴백) */
  function fontStack(face) {
    const name = String(face || '').trim();
    if (!name) return FONT_PRESETS.sans;
    let preset = FONT_PRESETS.sans;
    if (MONO_RE.test(name)) preset = FONT_PRESETS.mono;
    else if (GOTHIC_RE.test(name)) preset = FONT_PRESETS.sans;
    else if (SERIF_RE.test(name)) preset = FONT_PRESETS.serif;
    return '"' + name.replace(/"/g, '') + '",' + preset;
  }

  /* ---------------- styles from header.xml ---------------- */
  const BORDER_STYLE = {
    NONE: 'none', SOLID: 'solid', DASH: 'dashed', DOT: 'dotted', DASH_DOT: 'dashed',
    DASH_DOT_DOT: 'dashed', LONG_DASH: 'dashed', CIRCLE: 'dotted', DOUBLE: 'double',
    THICK: 'solid', THIN: 'solid', WAVE: 'solid', DOUBLE_SLIM: 'double',
  };

  function mmToPx(mm) {
    return round((num(mm, 0) * 96) / 25.4, 2);
  }

  function readBorder(el) {
    if (!el) return null;
    const type = BORDER_STYLE[String(el.getAttribute('type') || 'NONE').toUpperCase()] || 'none';
    if (type === 'none') return { type: 'none' };
    const width = Math.max(0.4, mmToPx(String(el.getAttribute('width') || '0.12').replace(/[^\d.\-]/g, '')));
    return { type, width, color: el.getAttribute('color') || '#000000' };
  }

  function borderCss(b) {
    return !b || b.type === 'none' ? 'none' : `${b.width}px ${b.type} ${b.color}`;
  }

  async function loadStyles(zip) {
    const st = emptyStyles();
    state.styles = st;
    const headerFile = zip.file(/Contents\/header\.xml$/i)[0];
    if (!headerFile) return;
    let doc;
    try {
      doc = new DOMParser().parseFromString(await headerFile.async('string'), 'application/xml');
    } catch (e) { return; }

    /* 글꼴 목록 (언어별 id → 글꼴 이름) */
    for (const ff of allByLocal(doc, 'fontface')) {
      const lang = (ff.getAttribute('lang') || 'HANGUL').toUpperCase();
      const map = st.faces.get(lang) || new Map();
      for (const f of kids(ff, 'font')) {
        const id = f.getAttribute('id');
        if (id != null) map.set(String(id), f.getAttribute('face') || '');
      }
      st.faces.set(lang, map);
    }
    const faceOf = (lang, id) => {
      const l = st.faces.get(lang) || st.faces.get('HANGUL') || st.faces.get('LATIN');
      return l ? (l.get(String(id || '0')) || '') : '';
    };

    /* 표 셀 테두리/배경 */
    for (const bf of allByLocal(doc, 'borderFill')) {
      const id = bf.getAttribute('id');
      if (id == null) continue;
      const brush = firstIn(bf, 'winBrush');
      const faceColor = brush ? (brush.getAttribute('faceColor') || 'none') : 'none';
      st.borderFills.set(String(id), {
        left: readBorder(kids(bf, 'leftBorder')[0]),
        right: readBorder(kids(bf, 'rightBorder')[0]),
        top: readBorder(kids(bf, 'topBorder')[0]),
        bottom: readBorder(kids(bf, 'bottomBorder')[0]),
        fill: /^none$/i.test(faceColor) ? '' : faceColor,
      });
    }

    /* 글자 모양 */
    for (const cp of allByLocal(doc, 'charPr')) {
      const id = cp.getAttribute('id');
      if (id == null) continue;
      const height = num(cp.getAttribute('height'), 1000) || 1000;   // 1/100 pt
      const fontRef = kids(cp, 'fontRef')[0];
      const ratioEl = kids(cp, 'ratio')[0];
      const spacingEl = kids(cp, 'spacing')[0];
      const relSzEl = kids(cp, 'relSz')[0];
      const offsetEl = kids(cp, 'offset')[0];
      const underlineEl = firstIn(cp, 'underline');
      const strikeEl = firstIn(cp, 'strikeout');
      const relSize = fontRef && relSzEl ? num(relSzEl.getAttribute('hangul'), 100) : 100;
      const face = faceOf('HANGUL', fontRef ? fontRef.getAttribute('hangul') : '0');
      const latinFace = faceOf('LATIN', fontRef ? fontRef.getAttribute('latin') : '0');
      st.char.set(String(id), {
        sizePt: (height / 100) * ((relSize || 100) / 100),
        bold: isOn(cp, 'bold'),
        italic: isOn(cp, 'italic'),
        underline: underlineEl ? String(underlineEl.getAttribute('type') || 'NONE').toUpperCase() !== 'NONE' : false,
        strikeout: strikeEl ? String(strikeEl.getAttribute('type') || 'NONE').toUpperCase() !== 'NONE' : false,
        color: cp.getAttribute('textColor') || '',
        shade: !/^none$/i.test(cp.getAttribute('shadeColor') || 'none') ? cp.getAttribute('shadeColor') : '',
        stack: fontStack(face || latinFace),
        spacingEm: spacingEl ? num(spacingEl.getAttribute('hangul'), 0) / 100 : 0,
        ratio: ratioEl ? num(ratioEl.getAttribute('hangul'), 100) : 100,
        offsetPt: offsetEl ? num(offsetEl.getAttribute('hangul'), 0) * U2PT : 0,
      });
    }

    /* 문단 모양 */
    for (const pp of allByLocal(doc, 'paraPr')) {
      const id = pp.getAttribute('id');
      if (id == null) continue;
      /* hp:switch 안에서는 첫 hp:case(2016 HwpUnitChar 규격)가 실제 값이다.
         hp:default 값은 같은 수치를 2배로 적어 둔 구형 호환값이라 쓰면 안 된다. */
      const branch = firstIn(pp, 'switch') || pp;
      const picked = kids(branch, 'case')[0] || kids(branch, 'default')[0] || pp;
      const margin = firstIn(picked, 'margin') || firstIn(pp, 'margin');
      const mval = (name) => {
        if (!margin) return 0;
        const el = firstIn(margin, name);
        return el ? num(el.getAttribute('value'), 0) : 0;
      };
      const ls = firstIn(picked, 'lineSpacing') || firstIn(pp, 'lineSpacing');
      const alignEl = firstIn(pp, 'align');
      st.para.set(String(id), {
        align: alignEl ? String(alignEl.getAttribute('horizontal') || '').toUpperCase() : '',
        lineType: ls ? String(ls.getAttribute('type') || 'PERCENT').toUpperCase() : 'PERCENT',
        lineValue: ls ? num(ls.getAttribute('value'), 160) : 160,
        intent: mval('intent'),
        left: mval('left'),
        right: mval('right'),
        prev: mval('prev'),
        next: mval('next'),
      });
    }

    /* 문단/글자 기본 모양 (바탕글 스타일) */
    const styles = allByLocal(doc, 'style');
    if (styles.length) {
      const s0 = styles.find((s) => s.getAttribute('id') === '0') || styles[0];
      for (const s of styles) {
        st.styles.set(String(s.getAttribute('id')), {
          paraPr: s.getAttribute('paraPrIDRef'), charPr: s.getAttribute('charPrIDRef'),
        });
      }
      if (s0) {
        st.defaultParaId = String(s0.getAttribute('paraPrIDRef') || '0');
        st.defaultCharId = String(s0.getAttribute('charPrIDRef') || '0');
      }
    }
  }

  function isOn(node, name) {
    const el = firstIn(node, name);
    if (!el) return false;
    const v = String(el.getAttribute('value') || el.getAttribute('val') || '1').toLowerCase();
    return v !== '0' && v !== 'false' && v !== 'none';
  }

  /* ---------------- 문단/글자 서식 조회 ---------------- */
  function charStyle(id) {
    const st = state.styles;
    return st.char.get(String(id == null ? st.defaultCharId : id)) || st.char.get(String(st.defaultCharId)) || st.char.get('0') || null;
  }

  function paraStyle(pEl) {
    const st = state.styles;
    if (!pEl) return st.para.get(String(st.defaultParaId)) || st.para.get('0') || null;
    const id = pEl.getAttribute('paraPrIDRef');
    const styleRef = st.styles.get(String(pEl.getAttribute('styleIDRef') || ''));
    return (id != null ? st.para.get(String(id)) : null)
      || st.para.get(String(st.defaultParaId))
      || (styleRef ? st.para.get(String(styleRef.paraPr)) : null)
      || st.para.get('0') || null;
  }

  /* 줄간격 → CSS line-height */
  function lineHeightCss(ps, sizePt) {
    if (!ps) return String(LINE_FACTOR);
    const v = ps.lineValue;
    if (ps.lineType === 'FIXED') return `${round(v * U2PT, 2)}pt`;
    if (ps.lineType === 'AT_LEAST' || ps.lineType === 'ATLEAST') {
      const min = round((sizePt || 10) * LINE_FACTOR, 2);
      return `max(${round(v * U2PT, 2)}pt, ${min}pt)`;
    }
    return String(round((v / 100) * LINE_FACTOR, 4));   // PERCENT
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

  /* ---------------- 용지 크기 / 여백 (secPr > pagePr) ---------------- */
  const A4 = { w: 59528, h: 84188, left: 8504, right: 8504, top: 5669, bottom: 4252 };

  function readGeometry(secDoc) {
    const page = { ...A4 };
    const secPr = firstIn(secDoc, 'secPr');
    if (secPr) {
      const pg = kids(secPr, 'pagePr')[0] || firstIn(secPr, 'pagePr');
      if (pg) {
        page.w = num(pg.getAttribute('width'), page.w) || page.w;
        page.h = num(pg.getAttribute('height'), page.h) || page.h;
        const m = kids(pg, 'margin')[0] || firstIn(pg, 'margin');
        if (m) {
          page.left = num(m.getAttribute('left'), page.left);
          page.right = num(m.getAttribute('right'), page.right);
          page.top = num(m.getAttribute('top'), page.top);
          page.bottom = num(m.getAttribute('bottom'), page.bottom);
        }
      }
    }
    return {
      wPx: round(page.w * U2PX, 2),
      hPx: round(page.h * U2PX, 2),
      leftPx: round(page.left * U2PX, 2),
      rightPx: round(page.right * U2PX, 2),
      topPx: round(page.top * U2PX, 2),
      bottomPx: round(page.bottom * U2PX, 2),
      contentPx: round((page.w - page.left - page.right) * U2PX, 2),
    };
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
        sections.push({ path, doc, dirty: false, geom: readGeometry(doc) });
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

    state.sections.forEach((sec, idx) => {
      const g = sec.geom || readGeometry(sec.doc);
      sec.geom = g;
      const page = document.createElement('section');
      page.className = 'page';
      page.dataset.pageWidth = String(g.wPx);
      page.style.width = g.wPx + 'px';
      page.style.minHeight = g.hPx + 'px';
      page.style.padding = `${g.topPx}px ${g.rightPx}px ${g.bottomPx}px ${g.leftPx}px`;
      const base = charStyle(state.styles.defaultCharId);
      if (base) {
        page.style.fontFamily = base.stack;
        page.style.fontSize = round(base.sizePt, 2) + 'pt';
      }
      page.setAttribute('data-page-index', String(idx + 1));
      if (state.sections.length > 1) page.setAttribute('aria-label', `문서 ${idx + 1}쪽`);
      ui.doc.appendChild(page);
      const root = sec.doc.documentElement;
      if (root) renderBlocks(root, page, sec);
      paginate(page, g);
    });

    fitPages();
    updateStatus();
    window.scrollTo({ top: scrollY });
  }

  /* 용지 높이를 넘는 내용을 다음 장으로 넘긴다(문단·표 단위, 긴 표는 행 단위로 나눔). */
  function paginate(firstPage, g) {
    const contentH = g.hPx - g.topPx - g.bottomPx - 2;   // 위/아래 여백, 테두리 1px씩
    if (!(contentH > 0)) return;
    let page = firstPage;
    let used = 0;
    const queue = Array.from(firstPage.children);
    for (let i = 0; i < queue.length; i++) {
      const block = queue[i];
      const force = block.dataset.breakBefore === '1';
      if (used > 0 && (force || used + block.offsetHeight > contentH + 0.5)) {
        page = newPageAfter(page, firstPage);
        used = 0;
        block.dataset.breakBefore = '';
      }
      if (block.parentElement !== page) page.appendChild(block);
      used += block.offsetHeight;
      if (used <= contentH + 0.5) continue;
      const rest = splitTableAt(block, contentH - (used - block.offsetHeight));
      if (rest) queue.splice(i + 1, 0, rest);
      used = block.offsetHeight;   // 표를 나눴으면 남은 높이로 다시 계산
      if (used > contentH + 0.5) used = contentH;  // 한 장보다 큰 덩어리는 그대로 둔다
    }
  }

  /* 표를 available 높이만큼만 남김 (행 경계에서 자름). 남은 행은 새 블록으로 돌려준다. */
  function splitTableAt(block, available) {
    const table = block.querySelector ? block.querySelector('table.hp-tbl') : null;
    if (!table) return null;
    const rows = Array.from(table.rows);
    if (rows.length < 2) return null;
    const overhead = block.offsetHeight - table.offsetHeight;
    const space = available - overhead - 2;
    if (space <= 0) return null;
    const heights = rows.map((r) => r.getBoundingClientRect().height);
    if (heights[0] > space) return null;

    let keep = 0;
    let acc = 0;
    for (let i = 0; i < rows.length; i++) {
      if (acc + heights[i] > space) break;
      acc += heights[i];
      keep = i + 1;
    }
    if (keep === 0 || keep >= rows.length) return null;

    const rest = rows.slice(keep);
    for (const row of rest) row.parentNode.removeChild(row);

    const cont = block.cloneNode(false);
    cont.style.paddingTop = '0';
    cont.style.paddingBottom = '0';
    delete cont.dataset.breakBefore;
    const wrap = document.createElement('div');
    wrap.className = 'hp-tbl-wrap';
    const t = table.cloneNode(false);
    const cg = table.querySelector('colgroup');
    if (cg) t.appendChild(cg.cloneNode(true));
    for (const row of rest) t.appendChild(row);
    wrap.appendChild(t);
    cont.appendChild(wrap);
    block.parentNode.insertBefore(cont, block.nextSibling);
    return cont;
  }

  function newPageAfter(current, template) {
    const page = template.cloneNode(false);
    page.removeAttribute('data-page-index');
    current.parentNode.insertBefore(page, current.nextSibling);
    return page;
  }

  /* 좁은 화면: 용지 폭에 맞춰 페이지 전체를 축소(레이아웃은 그대로 유지) */
  function fitPages() {
    const avail = ui.doc.clientWidth;
    if (!avail) return;
    for (const page of ui.doc.querySelectorAll('.page')) {
      const w = parseFloat(page.dataset.pageWidth || '0');
      if (!w) continue;
      const zoom = w > avail + 0.5 ? Math.max(0.3, avail / w) : 1;
      page.style.zoom = zoom < 0.999 ? String(round(zoom, 4)) : '';
    }
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
    const tables = tablesOf(pEl);
    const div = makeParagraph(pEl, sec, tables.length > 0);
    host.appendChild(div);
    for (const tbl of tables) div.appendChild(renderTable(tbl, sec));
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

  /* 한 문단: paraPr 의 정렬·여백·들여쓰기·줄간격을 그대로 옮긴다 */
  function makeParagraph(pEl, sec, hasTable) {
    const div = document.createElement('div');
    div.className = 'hp-p';
    const ps = paraStyle(pEl);

    const runs = ownRuns(pEl);
    const primary = charStyle(runs.find((r) => r.text) ? runs.find((r) => r.text).charPrIDRef : (runs[0] || {}).charPrIDRef);

    if (ps) {
      const align = ALIGN[ps.align];
      if (align) div.style.textAlign = align;
      if (ps.prev) div.style.paddingTop = round(ps.prev * U2PT, 2) + 'pt';
      if (ps.next) div.style.paddingBottom = round(ps.next * U2PT, 2) + 'pt';
      if (ps.right) div.style.paddingRight = round(ps.right * U2PT, 2) + 'pt';
      if (ps.intent > 0) {
        if (ps.left) div.style.paddingLeft = round(ps.left * U2PT, 2) + 'pt';
        div.style.textIndent = round(ps.intent * U2PT, 2) + 'pt';
      } else if (ps.intent < 0) {
        /* 내어쓰기: 첫 줄만 왼쪽으로 나가고 나머지 줄은 |intent| 만큼 들어간다 */
        div.style.paddingLeft = round((ps.left - ps.intent) * U2PT, 2) + 'pt';
        div.style.textIndent = round(ps.intent * U2PT, 2) + 'pt';
      } else if (ps.left) {
        div.style.paddingLeft = round(ps.left * U2PT, 2) + 'pt';
      }
      div.style.lineHeight = lineHeightCss(ps, primary ? primary.sizePt : 10);
    }
    if (pEl.getAttribute('pageBreak') === '1') div.dataset.breakBefore = '1';

    if (primary) {
      div.style.fontFamily = primary.stack;
      div.style.fontSize = round(primary.sizePt, 2) + 'pt';
    }

    let text = '';
    for (const run of runs) {
      if (!run.text) continue;
      text += run.text;
      const span = document.createElement('span');
      span.className = 'hp-run';
      const cs = charStyle(run.charPrIDRef);
      if (cs) {
        span.style.fontFamily = cs.stack;
        span.style.fontSize = round(cs.sizePt, 3) + 'pt';
        if (cs.bold) span.style.fontWeight = '700';
        if (cs.italic) span.style.fontStyle = 'italic';
        const deco = [];
        if (cs.underline) deco.push('underline');
        if (cs.strikeout) deco.push('line-through');
        if (deco.length) span.style.textDecoration = deco.join(' ');
        if (cs.color && cs.color.toLowerCase() !== '#000000') span.style.color = cs.color;
        if (cs.shade) span.style.backgroundColor = cs.shade;
        if (cs.spacingEm) span.style.letterSpacing = round(cs.spacingEm, 4) + 'em';
        if (cs.ratio && cs.ratio !== 100) span.style.fontStretch = cs.ratio + '%';
        if (cs.offsetPt) span.style.verticalAlign = round(cs.offsetPt, 2) + 'pt';
      }
      appendWithBreaks(span, run.text);
      div.appendChild(span);
    }
    const fullText = runs.map((r) => r.text).join('');
    if (!text && !hasTable) {
      div.classList.add('hp-p-empty');
      div.appendChild(document.createElement('br'));
    }

    if (!hasTable) {
      state.nodeMap.set(div, { el: div, pEl, sec, originalText: fullText });
      if (state.dirtyNodes.has(pEl)) div.classList.add('modified');
      applyEditable(div);
    }
    return div;
  }

  function applyEditable(div) {
    if (state.mode === 'edit') div.setAttribute('contenteditable', 'true');
    else div.removeAttribute('contenteditable');
  }

  /* 표: 표 폭·열 폭·셀 여백·셀 테두리/배경·세로 정렬까지 실제 조판에 맞춘다 */
  function renderTable(tblEl, sec) {
    const wrap = document.createElement('div');
    wrap.className = 'hp-tbl-wrap';
    const table = document.createElement('table');
    table.className = 'hp-tbl';

    const sz = kids(tblEl, 'sz')[0];
    const tableWidthUnits = sz ? num(sz.getAttribute('width'), 0) : 0;
    const inMargin = kids(tblEl, 'inMargin')[0] || firstIn(tblEl, 'inMargin');
    const tablePad = {
      left: inMargin ? num(inMargin.getAttribute('left'), 0) : 0,
      right: inMargin ? num(inMargin.getAttribute('right'), 0) : 0,
      top: inMargin ? num(inMargin.getAttribute('top'), 0) : 0,
      bottom: inMargin ? num(inMargin.getAttribute('bottom'), 0) : 0,
    };
    const tableFill = state.styles.borderFills.get(String(tblEl.getAttribute('borderFillIDRef') || '')) || null;

    const rows = Array.from(tblEl.children).filter((c) => local(c) === 'tr');
    const colCount = Math.max(1, num(tblEl.getAttribute('colCnt'), 0) || 0);

    /* 열 폭: colSpan=1 셀의 cellSz 폭으로 계산 */
    const widths = new Array(colCount).fill(0);
    const scan = (tr) => {
      let col = 0;
      for (const tc of kids(tr, 'tc')) {
        const span = kids(tc, 'cellSpan')[0];
        const colSpan = Math.max(1, num(span ? span.getAttribute('colSpan') : 1, 1));
        const csz = kids(tc, 'cellSz')[0];
        const wu = csz ? num(csz.getAttribute('width'), 0) : 0;
        if (colSpan === 1 && col < widths.length && wu) widths[col] = wu;
        col += colSpan;
      }
    };
    rows.forEach(scan);
    const known = widths.filter((w) => w > 0);
    const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 0;
    for (let i = 0; i < widths.length; i++) if (!widths[i]) widths[i] = avg;
    const sumWidth = widths.reduce((a, b) => a + b, 0) || tableWidthUnits;
    /* 표 전체 폭(hp:sz)을 기준으로 열 폭을 비례 배분한다 */
    const totalUnits = tableWidthUnits || sumWidth;
    const totalPx = round(totalUnits * U2PX, 2);

    table.style.width = totalPx ? totalPx + 'px' : '100%';
    table.style.tableLayout = 'fixed';
    if (totalPx) {
      const cg = document.createElement('colgroup');
      widths.forEach((wu) => {
        const col = document.createElement('col');
        col.style.width = round((wu / (sumWidth || 1)) * 100, 3) + '%';
        cg.appendChild(col);
      });
      table.appendChild(cg);
    }

    const occupied = [];
    const isTaken = (r, c) => occupied[r] && occupied[r].has(c);
    const take = (r, c) => { (occupied[r] = occupied[r] || new Set()).add(c); };

    rows.forEach((tr, r) => {
      const trEl = document.createElement('tr');
      let rowHeightUnits = 0;
      for (const tc of kids(tr, 'tc')) {
        const csz = kids(tc, 'cellSz')[0];
        if (csz) rowHeightUnits = Math.max(rowHeightUnits, num(csz.getAttribute('height'), 0));
      }
      if (rowHeightUnits) trEl.style.height = round(rowHeightUnits * U2PX, 2) + 'px';
      let col = 0;
      for (const tc of kids(tr, 'tc')) {
        while (isTaken(r, col)) col++;
        const spanEl = kids(tc, 'cellSpan')[0];
        const colSpan = Math.max(1, Math.min(100, num(spanEl ? spanEl.getAttribute('colSpan') : 1, 1)));
        const rowSpan = Math.max(1, Math.min(1000, num(spanEl ? spanEl.getAttribute('rowSpan') : 1, 1)));
        const cell = document.createElement('td');
        cell.className = 'hp-cell';
        if (colSpan > 1) cell.colSpan = colSpan;
        if (rowSpan > 1) cell.rowSpan = rowSpan;
        for (let rr = r; rr < r + rowSpan; rr++) for (let cc = col; cc < col + colSpan; cc++) take(rr, cc);

        const margin = kids(tc, 'cellMargin')[0];
        const pad = margin ? {
          left: num(margin.getAttribute('left'), tablePad.left),
          right: num(margin.getAttribute('right'), tablePad.right),
          top: num(margin.getAttribute('top'), tablePad.top),
          bottom: num(margin.getAttribute('bottom'), tablePad.bottom),
        } : tablePad;
        cell.style.padding = `${round(pad.top * U2PX, 2)}px ${round(pad.right * U2PX, 2)}px ${round(pad.bottom * U2PX, 2)}px ${round(pad.left * U2PX, 2)}px`;

        const bf = state.styles.borderFills.get(String(tc.getAttribute('borderFillIDRef') || '')) || tableFill;
        if (bf) {
          cell.style.borderLeft = borderCss(bf.left);
          cell.style.borderRight = borderCss(bf.right);
          cell.style.borderTop = borderCss(bf.top);
          cell.style.borderBottom = borderCss(bf.bottom);
          if (bf.fill) cell.style.backgroundColor = bf.fill;
        }

        const subList = kids(tc, 'subList')[0];
        const vert = subList ? String(subList.getAttribute('vertAlign') || '').toUpperCase() : '';
        cell.style.verticalAlign = vert === 'CENTER' ? 'middle' : vert === 'BOTTOM' ? 'bottom' : 'top';

        const paragraphs = subList ? kids(subList, 'p') : kids(tc, 'p');
        if (!paragraphs.length) {
          const empty = document.createElement('div');
          empty.className = 'hp-p hp-p-empty';
          empty.appendChild(document.createElement('br'));
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
    const fresh = makeParagraph(rec.pEl, rec.sec, false);
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

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(fitPages, 120);
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
