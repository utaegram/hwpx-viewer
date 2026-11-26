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
  const SLACK = 0.6;

  const FONT_PRESETS = {
    serif: '"함초롬바탕","HCR Batang","한컴바탕","바탕","Batang","AppleMyungjo","Nanum Myeongjo","Noto Serif KR",serif',
    sans: '"함초롬돋움","HCR Dotum","한컴돋움","돋움","맑은 고딕","Malgun Gothic","Apple SD Gothic Neo","NanumGothic","Noto Sans KR",sans-serif',
    mono: '"한컴고정폭","HCR Dotum","D2Coding","Courier New",monospace',
  };
  const MONO_RE = /(굴림체|고정폭|mono|coding|code)/i;
  const GOTHIC_RE = /(돋움|고딕|굴림|맑은|헤드|남산|sans|gothic|malgun|dotum|gulim)/i;
  const SERIF_RE = /(바탕|명조|신명|궁서|batang|serif|myeongjo|myungjo)/i;

  /* 도형·개체 태그 — 글자가 되살아나야 하는 것들 */
  const SHAPE_TAGS = new Set(['rect', 'ellipse', 'arc', 'polygon', 'curve', 'connectLine', 'container', 'textart']);
  const OBJ_TAGS = new Set([...SHAPE_TAGS, 'pic', 'equation', 'chart', 'ole', 'video', 'compose']);
  const CTRL_IGNORE = new Set(['colPr', 'pageNum', 'pageHiding', 'newNum', 'fieldBegin', 'fieldEnd',
    'bookmark', 'indexmark', 'hiddenComment', 'header', 'footer', 'autoNum', 'sectionDefine']);

  const $id = (id) => document.getElementById(id);
  const ui = {
    fileInput: $id('fileInput'), fileName: $id('fileName'), fileStatus: $id('fileStatus'),
    docMeter: $id('docMeter'), pageInfo: $id('pageInfo'), dirtyDot: $id('dirtyDot'),
    modeToggle: $id('modeToggle'), replaceBtn: $id('replaceBtn'), saveBtn: $id('saveBtn'),
    openBtn: $id('openBtn'), dropzone: $id('dropzone'), docWrap: $id('docWrap'), doc: $id('doc'),
    dzOpenBtn: $id('dzOpenBtn'), replacePanel: $id('replacePanel'), findInput: $id('findInput'),
    replaceInput: $id('replaceInput'), replaceAllBtn: $id('replaceAllBtn'),
    replaceCloseBtn: $id('replaceCloseBtn'), replaceResult: $id('replaceResult'),
    toast: $id('toast'), dropOverlay: $id('dropOverlay'),
  };

  const emptyStyles = () => ({
    char: new Map(), para: new Map(), faces: new Map(), borderFills: new Map(), styles: new Map(),
    tabs: new Map(),
    defaultCharId: '0', defaultParaId: '0',
  });

  const state = {
    zip: null,
    fileName: '',
    sections: [],            // { path, doc, dirty, geom, notes }
    nodeMap: new WeakMap(),  // rendered .hp-p element -> { el, pEl, sec, originalText }
    dirtyNodes: new Set(),   // XML <p> elements changed by the user
    styles: emptyStyles(),
    bin: new Map(),          // binaryItemIDRef -> zip path
    imgUrls: new Map(),      // zip path -> object URL
    mode: 'read',
    busy: false,
    fontPass: 0,
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
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  /* 색상: none / #rrggbb / 0xrrggbb / rrggbb 모두 받아 CSS 색으로 */
  function cssColor(v, fallback) {
    const fb = fallback === undefined ? '' : fallback;
    if (v == null) return fb;
    const s = String(v).trim();
    if (!s || /^none$/i.test(s)) return fb;
    const m = /^0x([0-9a-f]{6})$/i.exec(s);
    if (m) return '#' + m[1].toLowerCase();
    if (/^#[0-9a-f]{6}$/i.test(s) || /^#[0-9a-f]{3}$/i.test(s)) return s;
    if (/^[0-9a-f]{6}$/i.test(s)) return '#' + s.toLowerCase();
    return fb;
  }

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
    const width = clamp(mmToPx(String(el.getAttribute('width') || '0.12').replace(/[^\d.\-]/g, '')), 0.3, 8);
    return { type, width, color: cssColor(el.getAttribute('color'), '#000000') };
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
    if (!doc || (doc.getElementsByTagName('parsererror') || []).length) return;

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
      let fill = brush ? cssColor(brush.getAttribute('faceColor'), '') : '';
      if (!fill) {
        /* 그라데이션 채우기(단색 두 점)는 첫 색을 쓴다 — 한글 제목 띠가 여기 해당 */
        const grad = firstIn(bf, 'gradation');
        if (grad) {
          const colors = kids(grad, 'color');
          const first = colors.map((c) => cssColor(c.getAttribute('value'), '')).find(Boolean);
          if (first) fill = first;
        }
      }
      st.borderFills.set(String(id), {
        left: readBorder(kids(bf, 'leftBorder')[0]),
        right: readBorder(kids(bf, 'rightBorder')[0]),
        top: readBorder(kids(bf, 'topBorder')[0]),
        bottom: readBorder(kids(bf, 'bottomBorder')[0]),
        fill,
      });
    }

    /* 글자 모양 */
    for (const cp of allByLocal(doc, 'charPr')) {
      const id = cp.getAttribute('id');
      if (id == null) continue;
      const rawHeight = num(cp.getAttribute('height'), 1000);   // 1/100 pt
      const fontRef = kids(cp, 'fontRef')[0];
      const ratioEl = kids(cp, 'ratio')[0];
      const spacingEl = kids(cp, 'spacing')[0];
      const relSzEl = kids(cp, 'relSz')[0];
      const offsetEl = kids(cp, 'offset')[0];
      const underlineEl = firstIn(cp, 'underline');
      const strikeEl = firstIn(cp, 'strikeout');
      const relSize = clamp(num(relSzEl ? relSzEl.getAttribute('hangul') : 100, 100), 10, 800);
      /* height 0·음수는 한글에서도 0pt가 아니라 기본 크기로 그린다 */
      const basePt = (rawHeight > 0 ? rawHeight / 100 : 10);
      const face = faceOf('HANGUL', fontRef ? fontRef.getAttribute('hangul') : '0');
      const latinFace = faceOf('LATIN', fontRef ? fontRef.getAttribute('latin') : '0');
      st.char.set(String(id), {
        sizePt: clamp(basePt * (relSize / 100), 0.5, 400),
        bold: isOn(cp, 'bold'),
        italic: isOn(cp, 'italic'),
        underline: underlineEl ? String(underlineEl.getAttribute('type') || 'NONE').toUpperCase() !== 'NONE' : false,
        strikeout: strikeEl ? String(strikeEl.getAttribute('type') || 'NONE').toUpperCase() !== 'NONE' : false,
        color: cssColor(cp.getAttribute('textColor'), ''),
        shade: cssColor(cp.getAttribute('shadeColor'), ''),
        stack: fontStack(face || latinFace),
        /* 자간: 한글 수치(%)를 웹 글꼴에 그대로 주면 음수에서 글자가 겹친다.
           음수는 완만하게(-0.08em 한계), 양수도 조금 줄여 쓴다. */
        spacingEm: charSpacing(num(spacingEl ? spacingEl.getAttribute('hangul') : 0, 0)),
        ratio: clamp(num(ratioEl ? ratioEl.getAttribute('hangul') : 100, 100), 10, 500),
        offsetPt: clamp(num(offsetEl ? offsetEl.getAttribute('hangul') : 0, 0) * U2PT, -30, 30),
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
        return el ? clamp(num(el.getAttribute('value'), 0), -40000, 60000) : 0;
      };
      const ls = firstIn(picked, 'lineSpacing') || firstIn(pp, 'lineSpacing');
      const alignEl = firstIn(pp, 'align');
      const bs = firstIn(pp, 'breakSetting');
      st.para.set(String(id), {
        align: alignEl ? String(alignEl.getAttribute('horizontal') || '').toUpperCase() : '',
        lineType: ls ? String(ls.getAttribute('type') || 'PERCENT').toUpperCase() : 'PERCENT',
        lineValue: ls ? clamp(num(ls.getAttribute('value'), 160), 0, 20000) : 160,
        intent: mval('intent'),
        left: mval('left'),
        right: mval('right'),
        prev: mval('prev'),
        next: mval('next'),
        tabPr: String(pp.getAttribute('tabPrIDRef') || ''),
        keepLatinWord: bs ? String(bs.getAttribute('breakLatinWord') || '').toUpperCase() : '',
      });
    }

    /* 탭 정지점 (hh:tabProperties > hh:tabPr > hh:tabItem pos) — 2016 규격 switch 는 case 를 쓴다 */
    for (const tp of allByLocal(doc, 'tabPr')) {
      const id = tp.getAttribute('id');
      if (id == null) continue;
      const items = [];
      const pushItems = (root) => {
        for (const it of kids(root, 'tabItem')) {
          items.push({
            pos: num(it.getAttribute('pos'), 0),
            type: String(it.getAttribute('type') || 'LEFT').toUpperCase(),
            leader: String(it.getAttribute('leader') || 'NONE').toUpperCase(),
          });
        }
      };
      for (const child of Array.from(tp.children)) {
        const nm = local(child);
        if (nm === 'tabItem') pushItems(tp);
        else if (nm === 'switch') {
          const c = kids(child, 'case')[0];
          pushItems(c || kids(child, 'default')[0] || child);
        }
      }
      st.tabs.set(String(id), {
        autoLeft: String(tp.getAttribute('autoTabLeft') || '0') === '1',
        items: items
          .filter((it, i, arr) => arr.findIndex((x) => x.pos === it.pos) === i)
          .sort((a, b) => a.pos - b.pos),
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

  /* HWP 자간(%) → CSS letter-spacing(em). 한글의 자간 % 는 글자 폭 기준이라
     -16% 는 em 의 -0.16 이다. 겹침을 막기 위해 극단값만 잘라 둔다. */
  function charSpacing(v) {
    if (!v) return 0;
    /* 한글 자간 % 는 글자 폭 기준이라 -16% 면 -0.16em 이지만, 브라우저가 쓰는
       대체 글꼴은 속공간이 좁아 그대로 두면 글자가 겹친다. 겹치지 않을 만큼만 당긴다. */
    return clamp(v / 100, -0.1, 0.3);
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
    return st.char.get(String(id == null ? st.defaultCharId : id))
      || st.char.get(String(st.defaultCharId)) || st.char.get('0') || null;
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

  /* 줄간격 → CSS line-height (0·음수는 글자가 겹치지 않게 최소값으로) */
  function lineHeightCss(ps, sizePt) {
    const size = sizePt > 0 ? sizePt : 10;
    if (!ps) return String(LINE_FACTOR);
    const v = ps.lineValue;
    if (ps.lineType === 'FIXED') {
      const pt = clamp(v * U2PT, size * 0.6, 400);
      return `${round(pt, 2)}pt`;
    }
    if (ps.lineType === 'AT_LEAST' || ps.lineType === 'ATLEAST') {
      const pt = clamp(v * U2PT, 1, 400);
      return `max(${round(pt, 2)}pt, ${round(size * LINE_FACTOR, 2)}pt)`;
    }
    return String(round(clamp(v, 50, 500) / 100 * LINE_FACTOR, 4));   // PERCENT
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

  /* 그림(BinData) id → zip 경로 */
  async function loadBinMap(zip) {
    const map = new Map();
    const hpf = zip.file(/Contents\/content\.hpf$/i)[0] || zip.file(/content\.hpf$/i)[0];
    if (hpf) {
      try {
        const doc = new DOMParser().parseFromString(await hpf.async('string'), 'application/xml');
        for (const node of allByLocal(doc, 'item')) {
          const id = node.getAttribute('id');
          const href = node.getAttribute('href');
          if (!id || !href) continue;
          const clean = href.replace(/^\.?\//, '');
          const path = zip.files[clean] ? clean
            : (zip.files['Contents/' + clean] ? 'Contents/' + clean : null);
          if (path) map.set(id, path);
        }
      } catch (e) { /* ignore */ }
    }
    return map;
  }

  function imageUrl(path) {
    if (state.imgUrls.has(path)) return state.imgUrls.get(path);
    const entry = state.zip && state.zip.files[path];
    if (!entry) return null;
    const p = entry.async('blob').then((blob) => {
      const url = URL.createObjectURL(blob);
      state.imgUrls.set(path, url);
      return url;
    }).catch(() => null);
    state.imgUrls.set(path, p);
    return p;
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
          page.left = clamp(num(m.getAttribute('left'), page.left), 0, page.w * 0.45);
          page.right = clamp(num(m.getAttribute('right'), page.right), 0, page.w * 0.45);
          page.top = clamp(num(m.getAttribute('top'), page.top), 0, page.h * 0.45);
          page.bottom = clamp(num(m.getAttribute('bottom'), page.bottom), 0, page.h * 0.45);
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

  /* 본문 글꼴이 늦게 도착하면 조판이 흔들리므로, 그리기 전에 웹 글꼴을 받아 둔다 */
  async function ensureFonts() {
    if (!document.fonts || !document.fonts.load) return;
    const load = (spec) => {
      try { return document.fonts.load(spec); } catch (e) { return Promise.resolve(); }
    };
    try {
      await Promise.race([
        Promise.all([
          load('10pt "Noto Serif KR"'),
          load('10pt "Noto Sans KR"'),
          load('700 10pt "Noto Sans KR"'),
          document.fonts.ready,
        ]),
        new Promise((r) => setTimeout(r, 2500)),
      ]);
    } catch (e) { /* 글꼴을 못 받아도 기본 글꼴로 그린다 */ }
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

      /* 이전 문서의 그림 URL 정리 */
      for (const v of state.imgUrls.values()) {
        if (v && typeof v.then !== 'function') URL.revokeObjectURL(v);
      }
      state.imgUrls = new Map();

      await loadStyles(zip);
      state.bin = await loadBinMap(zip);

      const sections = [];
      for (const path of paths) {
        const xml = await zip.file(path).async('string');
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        if (doc.getElementsByTagName('parsererror').length) throw new Error('본문 XML을 해석하지 못했습니다: ' + path);
        sections.push({ path, doc, dirty: false, geom: readGeometry(doc), notes: [] });
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
      await ensureFonts();
      state.fontPass = 0;
      setMode('read', { rerender: true });
      /* 한글 글꼴은 실제 글자가 그려질 때 하위 집합을 더 받아 온다.
         첫 렌더가 그 요청을 만들므로, 글꼴이 다 온 뒤 한 번 더 조판해 장 높이를 고정한다. */
      const opened = zip;
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => {
          setTimeout(() => {
            if (state.zip !== opened || state.fontPass > 0) return;
            state.fontPass = 1;
            renderDocument();
          }, 60);
        });
      }
      [ui.openBtn, ui.saveBtn, ui.modeToggle].forEach((b) => { b.disabled = false; });
      ui.docMeter.hidden = false;
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
      sec.notes = [];
      const page = document.createElement('section');
      page.className = 'page';
      applyPageBox(page, g);
      page.setAttribute('data-page-index', String(idx + 1));
      page.dataset.sectionIndex = String(idx);
      if (state.sections.length > 1) page.setAttribute('aria-label', `문서 ${idx + 1}쪽`);
      ui.doc.appendChild(page);
      const root = sec.doc.documentElement;
      noteMarker.items = new Map();
      if (root) renderBlocks(root, page, sec);
      appendNotes(page, sec);
      paginate(page, g);
    });

    balancePages();
    finalizePages();
    fitPages();
    updateStatus();
    updatePageInfo();
    window.scrollTo({ top: scrollY });
  }

  /* 글꼴 교체 등으로 장이 조금 넘치면 마지막 덩어리를 나누거나 다음 장으로 넘긴다 */
  function balancePages() {
    let guard = 0;
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      for (const page of Array.from(ui.doc.querySelectorAll('.page'))) {
        const pageH = parseFloat(page.dataset.pageHeight || '0');
        const contentH = parseFloat(page.dataset.contentHeight || '0');
        if (!pageH || !contentH) continue;
        while (++guard < 1200 && page.isConnected && page.offsetHeight > pageH + 1.2) {
          const last = page.lastElementChild;
          if (!last) break;
          const before = last.offsetHeight;
          let cont = null;
          if (last.querySelector && last.querySelector('table.hp-tbl')) cont = splitBlock(last, contentH);
          const after = last.offsetHeight;
          let next = page.nextElementSibling;
          const sameSection = (el) => el && el.classList && el.classList.contains('page')
            && el.dataset.sectionIndex === page.dataset.sectionIndex;
          if (!sameSection(next)) next = newPageAfter(page, page);
          if (cont && after < before - 1) {
            next.insertBefore(cont, next.firstChild);
            changed = true;
          } else if (page.children.length > 1) {
            if (cont && cont.parentNode) cont.remove();
            next.insertBefore(last, next.firstChild);
            changed = true;
          } else break;
        }
      }
      if (!changed) break;
    }
  }

  function applyPageBox(page, g) {
    page.dataset.pageWidth = String(g.wPx);
    page.dataset.pageHeight = String(g.hPx);
    page.dataset.contentHeight = String(round(g.hPx - g.topPx - g.bottomPx - 2, 2));
    page.style.width = g.wPx + 'px';
    page.style.minHeight = g.hPx + 'px';
    page.style.padding = `${g.topPx}px ${g.rightPx}px ${g.bottomPx}px ${g.leftPx}px`;
    const base = charStyle(state.styles.defaultCharId);
    if (base) {
      page.style.fontFamily = base.stack;
      page.style.fontSize = round(base.sizePt, 2) + 'pt';
    }
  }

  /* 용지 높이를 넘는 내용을 다음 장으로 넘긴다(문단·표 단위, 긴 표는 행 단위로 나눔). */
  function paginate(firstPage, g) {
    const contentH = round(g.hPx - g.topPx - g.bottomPx - 2, 2);   // 위/아래 여백, 테두리 1px씩
    if (!(contentH > 40)) return;
    let page = firstPage;
    let used = 0;
    let pending = false;
    const queue = Array.from(firstPage.children);
    let guard = 0;

    const flushBreak = () => {
      if (!pending) return;
      pending = false;
      page = newPageAfter(page, firstPage);
      used = 0;
    };

    while (queue.length) {
      if (++guard > 20000) { console.warn('hwpx: pagination guard reached'); break; }
      const block = queue.shift();
      flushBreak();
      if (block.dataset.breakBefore === '1' && used > 0.5) { pending = true; flushBreak(); }
      block.dataset.breakBefore = '';
      page.appendChild(block);

      let h = block.offsetHeight;
      /* 저자 페이지 나눔 바로 앞의 짧은 꼬리(각주 등)가 다음 장에 홀로 남지 않도록
         아래 여백을 조금만 빌려 쓴다. */
      const nextBreak = queue.length && queue[0].dataset.breakBefore === '1';
      const borrow = nextBreak && !tableOfBlock(block) ? Math.min(g.bottomPx * 0.55, contentH * 0.05) : 0;
      if (h <= contentH - used + SLACK + borrow) { used += h; continue; }

      /* 이 페이지 남은 자리에 들어가지 않는다 */
      const remaining = contentH - used;
      const cont = remaining > 24 ? splitBlock(block, remaining) : null;
      if (cont) {
        used += block.offsetHeight;
        queue.unshift(cont);
        pending = true;
        continue;
      }
      if (used > 0.5) {
        /* 빈 장에는 들어가는 덩어리라면 통째로 다음 장으로 */
        block.remove();
        pending = true;
        flushBreak();
        page.appendChild(block);
        h = block.offsetHeight;
      }
      if (h <= contentH + SLACK) { used = h; continue; }

      /* 한 장보다 큰 덩어리 — 표는 행 단위로 나눈다 */
      const cont2 = splitBlock(block, contentH);
      if (cont2) {
        used += block.offsetHeight;
        queue.unshift(cont2);
        pending = true;
        continue;
      }
      used = contentH;   // 더 나눌 수 없는 덩어리: 이 장은 그만큼 커진다
    }
  }

  const EMPTY_P = () => {
    const d = document.createElement('div');
    d.className = 'hp-p hp-p-empty';
    d.appendChild(document.createElement('br'));
    return d;
  };

  function tableOfBlock(block) {
    if (!block.querySelector) return null;
    const table = block.querySelector('table.hp-tbl');
    return table || null;
  }

  function splitBlock(block, available) {
    const table = tableOfBlock(block);
    if (!table) return null;
    return splitTableAt(block, table, available) || splitTallRow(block, table, available);
  }

  /* 표를 available 높이만큼만 남김 (행 경계에서 자름). 남은 행은 새 블록으로 돌려준다. */
  function splitTableAt(block, table, available) {
    const tbody = table.tBodies[0];
    const rows = tbody ? Array.from(tbody.rows) : [];
    if (rows.length < 2) return null;

    const overhead = Math.max(0, block.offsetHeight - table.offsetHeight);
    const headH = table.tHead ? table.tHead.getBoundingClientRect().height : 0;
    const space = available - overhead - headH - 3;
    if (space <= 8) return null;

    const heights = rows.map((r) => r.getBoundingClientRect().height);
    let keep = 0;
    let acc = 0;
    for (let i = 0; i < rows.length; i++) {
      if (acc + heights[i] > space + 0.5) break;
      acc += heights[i];
      keep = i + 1;
    }
    if (keep === 0 || keep >= rows.length) return null;

    /* rowSpan 을 자르는 경계는 되도록 피한다 */
    const safe = (k) => {
      for (let rr = 0; rr < k; rr++) {
        for (const cell of Array.from(rows[rr].cells)) {
          const rs = cell.rowSpan || 1;
          if (rs > 1 && rr + rs > k) return false;
        }
      }
      return true;
    };
    if (!safe(keep)) {
      let s = keep;
      while (s > 0 && !safe(s)) s--;
      if (s >= 1) keep = s;      // 세로 병합을 자르면 장이 부풀므로 안전한 경계로 물러난다
    }

    const moved = rows.slice(keep);
    const contBlock = block.cloneNode(false);
    contBlock.style.paddingTop = '0';
    contBlock.style.paddingBottom = '0';
    delete contBlock.dataset.breakBefore;
    const wrap = block.querySelector('.hp-tbl-wrap');
    const contWrap = document.createElement('div');
    contWrap.className = 'hp-tbl-wrap';
    if (wrap) contWrap.style.cssText = wrap.style.cssText;
    contWrap.style.marginTop = '0';
    const t2 = table.cloneNode(false);
    const cg = table.querySelector('colgroup');
    if (cg) t2.appendChild(cg.cloneNode(true));
    if (table.tHead) t2.appendChild(table.tHead.cloneNode(true));
    const tb2 = document.createElement('tbody');
    for (const row of moved) tb2.appendChild(row);
    t2.appendChild(tb2);
    contWrap.appendChild(t2);
    contBlock.appendChild(contWrap);

    /* 경계를 걸친 세로 병합: 앞 표는 잘라 붙이고, 뒷 표에는 이어지는 빈 칸을 둔다 */
    const crossings = [];
    for (let rr = 0; rr < keep; rr++) {
      for (const cell of Array.from(rows[rr].cells)) {
        const rs = cell.rowSpan || 1;
        if (rs > 1 && rr + rs > keep) {
          const col = num(cell.dataset.col, cell.cellIndex);
          const extra = rr + rs - keep;
          cell.rowSpan = keep - rr;
          crossings.push({
            col,
            colSpan: cell.colSpan || 1,
            rowSpan: Math.max(1, Math.min(extra, moved.length)),
            source: cell,
          });
        }
      }
    }
    const contCells = [];
    if (crossings.length) {
      const firstRow = moved[0];
      for (const spec of crossings) {
        const td = document.createElement('td');
        td.className = 'hp-cell hp-cell-cont';
        td.colSpan = spec.colSpan;
        td.rowSpan = spec.rowSpan;
        td.dataset.col = String(spec.col);
        for (const prop of ['padding', 'borderLeft', 'borderRight', 'borderTop', 'borderBottom', 'backgroundColor']) {
          td.style[prop] = spec.source.style[prop];
        }
        td.appendChild(EMPTY_P());
        let idx = firstRow.cells.length;
        for (let i = 0; i < firstRow.cells.length; i++) {
          if (num(firstRow.cells[i].dataset.col, i) > spec.col) { idx = i; break; }
        }
        if (idx >= firstRow.cells.length) firstRow.appendChild(td);
        else firstRow.insertBefore(td, firstRow.cells[idx]);
        contCells.push({ td, source: spec.source });
      }
    }

    block.parentNode.insertBefore(contBlock, block.nextSibling);

    /* 잘린 병합 칸의 넘치는 문단을 뒷 표의 이어지는 칸으로 옮겨 장이 커지지 않게 */
    let guard = 0;
    while (contCells.length && ++guard < 300) {
      if (block.offsetHeight <= available + SLACK) break;
      let best = null;
      let bestH = 0;
      for (const pair of contCells) {
        const ps = Array.from(pair.source.children);
        if (ps.length <= 1) continue;
        const h = pair.source.getBoundingClientRect().height;
        if (h > bestH) { bestH = h; best = pair; }
      }
      if (!best) break;
      const ps = Array.from(best.source.children);
      const last = ps[ps.length - 1];
      const placeholder = best.td.querySelector('.hp-p-empty');
      if (placeholder && best.td.children.length === 1) placeholder.remove();
      best.td.appendChild(last);
    }

    return contBlock;
  }

  /* 한 행이 한 장보다 큰 표: 그 행의 문단을 다음 장으로 넘긴다 */
  function splitTallRow(block, table, available) {
    const tbody = table.tBodies[0];
    if (!tbody || tbody.rows.length !== 1) return null;
    const row = tbody.rows[0];
    const overhead = Math.max(0, block.offsetHeight - table.offsetHeight);
    const headH = table.tHead ? table.tHead.getBoundingClientRect().height : 0;
    const space = available - overhead - headH - 3;
    if (space <= 24) return null;

    const contBlock = block.cloneNode(false);
    contBlock.style.paddingTop = '0';
    contBlock.style.paddingBottom = '0';
    delete contBlock.dataset.breakBefore;
    const wrap = block.querySelector('.hp-tbl-wrap');
    const contWrap = document.createElement('div');
    contWrap.className = 'hp-tbl-wrap';
    if (wrap) contWrap.style.cssText = wrap.style.cssText;
    contWrap.style.marginTop = '0';
    const t2 = table.cloneNode(false);
    const cg = table.querySelector('colgroup');
    if (cg) t2.appendChild(cg.cloneNode(true));
    if (table.tHead) t2.appendChild(table.tHead.cloneNode(true));
    const tb2 = document.createElement('tbody');
    const row2 = document.createElement('tr');
    for (const cell of Array.from(row.cells)) {
      const td = document.createElement('td');
      td.className = 'hp-cell';
      td.colSpan = cell.colSpan || 1;
      td.rowSpan = 1;
      td.dataset.col = cell.dataset.col || '0';
      for (const prop of ['padding', 'borderLeft', 'borderRight', 'borderTop', 'borderBottom', 'backgroundColor', 'verticalAlign', 'textAlign']) {
        td.style[prop] = cell.style[prop];
      }
      td.appendChild(EMPTY_P());
      row2.appendChild(td);
    }
    tb2.appendChild(row2);
    t2.appendChild(tb2);
    contWrap.appendChild(t2);
    contBlock.appendChild(contWrap);
    block.parentNode.insertBefore(contBlock, block.nextSibling);

    /* 내용이 많은 칸부터 차례로 덜어 낸다 (행 높이는 모든 칸이 같으므로 글자 양으로 고른다) */
    const textLen = (td) => Array.from(td.querySelectorAll('.hp-p')).reduce((n, d) => n + (d.innerText || '').length, 0);
    const candidates = Array.from(row.cells)
      .map((td, i) => ({ td, dst: row2.cells[i], weight: textLen(td) }))
      .filter((c) => c.weight > 0 && c.dst)
      .sort((a, b) => b.weight - a.weight);
    let guard = 0;
    let progress = true;
    while (progress && ++guard < 800) {
      progress = false;
      if (block.offsetHeight <= available + SLACK) break;
      for (const cand of candidates) {
        const ps = Array.from(cand.td.children).filter((e) => e.classList.contains('hp-p'));
        if (!ps.length) continue;
        const dstPlaceholder = cand.dst.querySelector('.hp-p-empty');
        if (ps.length > 1) {
          if (dstPlaceholder && cand.dst.children.length === 1) dstPlaceholder.remove();
          cand.dst.appendChild(ps[ps.length - 1]);
          progress = true;
          break;
        }
        const para = ps[0];
        const excess = block.offsetHeight - available;
        const allowance = Math.max(18, cand.td.getBoundingClientRect().height - excess - 4);
        const tail = splitParagraphTail(para, allowance);
        if (!tail) continue;
        if (dstPlaceholder && cand.dst.children.length === 1) dstPlaceholder.remove();
        cand.dst.appendChild(tail);
        progress = true;
        break;
      }
    }
    return contBlock;
  }

  /* 문단의 아래쪽 줄을 잘라 새 문단으로 돌려준다 (한 줄짜리 긴 셀 내용 대응) */
  function splitParagraphTail(div, maxH) {
    const spans = Array.from(div.children);
    if (spans.length !== 1 || !spans[0].classList || !spans[0].classList.contains('hp-run')) return null;
    const span = spans[0];
    if (span.children.length) return null;                 // <br>·개체가 섞인 문단은 자르지 않는다
    const node = span.firstChild;
    if (!node || node.nodeType !== 3) return null;
    const text = node.nodeValue;
    if (text.length < 12) return null;
    const top = div.getBoundingClientRect().top;
    const range = document.createRange();
    const bottomAt = (k) => {
      range.setStart(node, 0);
      range.setEnd(node, k);
      const rects = range.getClientRects();
      return rects.length ? rects[rects.length - 1].bottom - top : 0;
    };
    let lo = 1;
    let hi = text.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bottomAt(mid) <= maxH) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best <= 0 || best >= text.length - 2) return null;
    let cut = best;
    const spaceAt = text.lastIndexOf(' ', cut);
    if (spaceAt > cut - 16 && spaceAt > 0) cut = spaceAt + 1;
    node.nodeValue = text.slice(0, cut);
    const clone = div.cloneNode(false);
    const s2 = span.cloneNode(false);
    s2.textContent = text.slice(cut);
    clone.appendChild(s2);
    return clone;
  }

  function newPageAfter(current, template) {
    const page = template.cloneNode(false);
    page.removeAttribute('data-page-index');
    current.parentNode.insertBefore(page, current.nextSibling);
    return page;
  }

  function finalizePages() {
    let pages = Array.from(ui.doc.querySelectorAll('.page'));
    if (pages.length > 1 && !pages[0].children.length) pages[0].remove();
    for (let i = pages.length - 1; i > 0; i--) {
      if (pages[i].isConnected && !pages[i].children.length) pages[i].remove();
      else break;
    }
    pages = Array.from(ui.doc.querySelectorAll('.page'));
    pages.forEach((p, i) => {
      p.dataset.pageIndex = String(i + 1);
      if (pages.length > 1) p.setAttribute('aria-label', `문서 ${i + 1}쪽`);
      else p.removeAttribute('aria-label');
    });
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

  /* ---------------- blocks ---------------- */
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
    if (tables.length) {
      /* 표만 있는 문단: 한글은 표를 한 글자처럼 줄 안에 놓고 문단 정렬을 따른다.
         문단의 들여쓰기(padding/text-indent)를 표가 물려받으면 오른쪽으로 밀리므로,
         줄 정보의 horzpos 만큼만 밀어 두고 나머지는 표 자신의 여백에 맡긴다. */
      const ps = paraStyle(pEl);
      const segs = lineSegs(pEl);
      const hasText = ownText(pEl).trim() !== '';
      const align = ALIGN[ps && ps.align];
      let lineW = 0;
      if (!hasText && segs && segs.length) {
        div.classList.add('hp-p-tbl');
        div.style.paddingLeft = round(clamp(segs[0].horzpos * U2PX, 0, 4000), 2) + 'px';
        if (align) div.style.textAlign = align;
        lineW = Math.max(0, segs[0].horzsize * U2PX);
      }
      for (const tbl of tables) {
        const el = renderTable(tbl, sec);
        /* 표를 한 글자처럼 다룰 때(treatAsChar)는 문단 정렬이 표의 가로 위치를 정한다.
           가운데·오른쪽 정렬 문단의 표가 왼쪽으로 밀려 보이던 문제를 여기서 바로잡는다. */
        if (!hasText && lineW > 0 && (align === 'center' || align === 'right')) {
          const sz = kids(tbl, 'sz')[0];
          const om = kids(tbl, 'outMargin')[0];
          const tw = num(sz && sz.getAttribute('width'), 0) * U2PX;
          const omL = num(om && om.getAttribute('left'), 0) * U2PX;
          const omR = num(om && om.getAttribute('right'), 0) * U2PX;
          const free = lineW - (tw + omL + omR);
          if (tw > 0 && free > 0) {
            const shift = align === 'center' ? free / 2 : free;
            el.style.marginLeft = round(omL + shift, 2) + 'px';
          }
        }
        div.appendChild(el);
      }
    }
    return div;
  }

  /* ---------------- inline content ---------------- */
  /* <hp:t> 안의 글자를 꺼낸다. 줄바꿈·탭·고정폭 공백은 실제 글자로 살린다. */
  function textOfT(tEl) {
    let s = '';
    let hadFw = false;
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) {
          s += c.nodeValue.replace(/[\r\n]+/g, ' ');
          continue;
        }
        if (c.nodeType !== 1) continue;
        const nm = local(c);
        if (nm === 'nbSpace') s += '\u00A0';
        else if (nm === 'fwSpace') hadFw = true;
        else if (nm === 'tab') s += '\t';
        else if (nm === 'lineBreak') s += '\n';
        else if (nm === 'hyphen') s += '\u00AD';
        else if (nm === 'titleMark' || nm === 'markpenBegin' || nm === 'markpenEnd' || nm === 'metaTag') { /* 표시 없음 */ }
        else walk(c);
      }
    };
    walk(tEl);
    if (!s && hadFw) s = ' ';
    return s;
  }

  /* run 하나를 글자 조각으로 나눈다 (글자 모양 유지 + 형광펜 + 개체) */
  function runSegments(runEl) {
    const cid = runEl.getAttribute('charPrIDRef');
    const segs = [];
    let buf = '';
    let mark = '';
    const flush = () => {
      if (!buf) return;
      segs.push({ kind: 'text', text: buf, cid, mark });
      buf = '';
    };
    const walkT = (tEl) => {
      for (const c of tEl.childNodes) {
        if (c.nodeType === 3) { buf += c.nodeValue.replace(/[\r\n]+/g, ' '); continue; }
        if (c.nodeType !== 1) continue;
        const nm = local(c);
        if (nm === 'markpenBegin') { flush(); mark = cssColor(c.getAttribute('color'), '#fff59d'); }
        else if (nm === 'markpenEnd') { flush(); mark = ''; }
        else if (nm === 'nbSpace') buf += '\u00A0';
        else if (nm === 'fwSpace') { if (!buf) buf = ' '; }
        else if (nm === 'tab') { flush(); segs.push({ kind: 'tab', width: num(c.getAttribute('width'), 0), cid, mark }); }
        else if (nm === 'lineBreak') { flush(); segs.push({ kind: 'br', cid, mark }); }
        else if (nm === 'hyphen') buf += '\u00AD';
        else if (nm === 'titleMark' || nm === 'metaTag') { /* 표시 없음 */ }
        else walkT(c);
      }
    };
    for (const child of Array.from(runEl.children)) {
      const name = local(child);
      if (name === 't') walkT(child);
      else if (name === 'lineBreak') { flush(); segs.push({ kind: 'br', cid, mark }); }
      else if (name === 'tab') { flush(); segs.push({ kind: 'tab', width: num(child.getAttribute('width'), 0), cid, mark }); }
      else if (name === 'fwSpace') { if (!buf) buf = ' '; }
      else if (name === 'nbSpace') buf += '\u00A0';
      else if (name === 'hyphen') buf += '\u00AD';
      else if (name === 'ctrl') {
        for (const c of Array.from(child.children)) {
          const nm = local(c);
          if (nm === 'footNote' || nm === 'endNote') { flush(); segs.push({ kind: 'note', node: c, cid }); }
          else if (!CTRL_IGNORE.has(nm) && OBJ_TAGS.has(nm)) { flush(); segs.push({ kind: 'obj', node: c, cid }); }
          /* fieldBegin/End·pageNum·colPr 등은 글자가 없으므로 지나간다 */
        }
      } else if (OBJ_TAGS.has(name)) {
        flush();
        segs.push({ kind: 'obj', node: child, cid });
      }
      /* secPr·titleMark·hiddenComment 등은 화면에 그리지 않는다 */
    }
    flush();
    return segs;
  }

  function applyCharStyle(span, cs) {
    if (!cs) return;
    span.style.fontFamily = cs.stack;
    span.style.fontSize = round(cs.sizePt, 3) + 'pt';
    if (cs.bold) span.style.fontWeight = '700';
    if (cs.italic) span.style.fontStyle = 'italic';
    const deco = [];
    if (cs.underline) deco.push('underline');
    if (cs.strikeout) deco.push('line-through');
    if (deco.length) span.style.textDecoration = deco.join(' ');
    if (cs.color) span.style.color = cs.color;
    if (cs.shade) span.style.backgroundColor = cs.shade;
    if (cs.spacingEm) span.style.letterSpacing = round(cs.spacingEm, 4) + 'em';
    if (cs.ratio && cs.ratio !== 100) span.style.fontStretch = clamp(cs.ratio, 10, 500) + '%';
    if (cs.offsetPt) span.style.verticalAlign = round(cs.offsetPt, 2) + 'pt';
  }

  function appendMultiline(host, text) {
    const parts = String(text).split('\n');
    parts.forEach((part, i) => {
      if (i) host.appendChild(document.createElement('br'));
      if (part) host.appendChild(document.createTextNode(part));
    });
  }

  function renderSegs(segs, host, sec) {
    for (const seg of segs) {
      if (seg.kind === 'text') {
        const sp = document.createElement('span');
        sp.className = 'hp-run';
        applyCharStyle(sp, charStyle(seg.cid));
        if (seg.mark) sp.style.backgroundColor = seg.mark;
        appendMultiline(sp, seg.text);
        host.appendChild(sp);
      } else if (seg.kind === 'br') {
        host.appendChild(document.createElement('br'));
      } else if (seg.kind === 'tab') {
        const sp = document.createElement('span');
        sp.className = 'hp-tab';
        const cs = charStyle(seg.cid);
        if (cs) sp.style.fontSize = round(cs.sizePt, 3) + 'pt';
        const w = seg.width > 0 ? clamp(seg.width * U2PX, 6, 200) : 32;
        sp.style.tabSize = w + 'px';
        sp.textContent = '\t';
        host.appendChild(sp);
      } else if (seg.kind === 'obj') {
        host.appendChild(renderObject(seg.node, sec));
      } else if (seg.kind === 'note') {
        host.appendChild(noteMarker(seg.node));
      }
    }
  }

  /* ---------------- notes (각주/미주) ---------------- */
  function noteMarker(node) {
    const sup = document.createElement('sup');
    sup.className = 'hp-note-mark';
    const n = node.getAttribute('number');
    sup.textContent = '[' + (n || '※') + ']';
    const texts = allByLocal(node, 't').map((t) => textOfT(t)).filter((s) => s.trim());
    noteMarker.items = noteMarker.items || new Map();
    const key = (noteMarker.items.size + 1);
    noteMarker.items.set(key, `[${n || key}] ${texts.join(' ').trim()}`.trim());
    sup.dataset.noteKey = String(key);
    return sup;
  }

  function collectNotes(page, sec) {
    const marks = Array.from(page.querySelectorAll('.hp-note-mark'));
    noteMarker.items = noteMarker.items || new Map();
    const lines = [];
    for (const m of marks) {
      const v = noteMarker.items.get(Number(m.dataset.noteKey));
      if (v) lines.push(v);
    }
    if (!lines.length) return;
    const box = document.createElement('div');
    box.className = 'hp-notes';
    const head = document.createElement('div');
    head.className = 'hp-notes-head';
    head.textContent = '각주';
    box.appendChild(head);
    for (const line of lines) {
      const p = document.createElement('div');
      p.className = 'hp-note-line';
      p.textContent = line;
      box.appendChild(p);
    }
    sec.notes = lines;
    page.appendChild(box);
  }

  function appendNotes(page, sec) {
    collectNotes(page, sec);
  }

  /* 한 문단: paraPr 의 정렬·여백·들여쓰기·줄간격을 그대로 옮긴다 */
  /* ---------------- HWP 조판 정보(lineseg) 기반 줄 배치 ----------------
     HWPX 의 <hp:p> 안에는 한글이 저장할 때 계산해 둔 줄 정보(linesegarray)가 있다.
     줄마다 글자 시작 위치(textpos)·왼쪽 좌표(horzpos)·높이(textheight/spacing)가
     적혀 있으므로, 그것을 그대로 옮기면 들여쓰기·내어쓰기·줄바꿈·줄높이가
     한글과 같은 자리에 온다. 없거나 개체가 섞인 문단은 브라우저 흐름으로 그린다. */
  function lineSegs(pEl) {
    const arr = kids(pEl, 'linesegarray')[0];
    if (!arr) return null;
    const out = [];
    for (const el of kids(arr, 'lineseg')) {
      out.push({
        textpos: Math.max(0, num(el.getAttribute('textpos'), 0)),
        vertpos: num(el.getAttribute('vertpos'), 0),
        vertsize: num(el.getAttribute('vertsize'), 0),
        textheight: num(el.getAttribute('textheight'), 0),
        baseline: num(el.getAttribute('baseline'), 0),
        spacing: num(el.getAttribute('spacing'), 0),
        horzpos: num(el.getAttribute('horzpos'), 0),
        horzsize: num(el.getAttribute('horzsize'), 0),
      });
    }
    return out.length ? out : null;
  }

  /* 문단 글자를 순서대로 늘어놓는다 (textpos 는 이 순서의 글자 번호).
     탭·줄나눔·고정폭공백·개체도 한 글자로 센다. */
  function buildAtoms(pEl) {
    const atoms = [];
    let hasObj = false;
    let mark = '';
    const pushText = (text, cid) => {
      for (const ch of String(text).replace(/[\r\n]+/g, ' ')) atoms.push({ kind: 'text', ch, cid, mark });
    };
    /* <hp:t> 안: 글자 노드와 tab·lineBreak·markpen 같은 인라인 요소가 섞여 있다 */
    const walkT = (tEl, cid) => {
      for (const c of tEl.childNodes) {
        if (c.nodeType === 3) { pushText(c.nodeValue, cid); continue; }
        if (c.nodeType !== 1) continue;
        const nm = local(c);
        if (nm === 'tab') atoms.push({ kind: 'tab', cid });
        else if (nm === 'lineBreak') atoms.push({ kind: 'br', cid });
        else if (nm === 'nbSpace') atoms.push({ kind: 'text', ch: '\u00A0', cid, mark });
        /* 고정폭 공백은 보통 공백이 아니라 글자 폭만큼 벌어진 공백이다 */
        else if (nm === 'fwSpace') atoms.push({ kind: 'text', ch: '\u2007', cid, mark });
        else if (nm === 'hyphen') atoms.push({ kind: 'text', ch: '\u00AD', cid, mark });
        else if (nm === 'markpenBegin') mark = cssColor(c.getAttribute('color'), '#fff59d');
        else if (nm === 'markpenEnd') mark = '';
        else walkT(c, cid);
      }
    };
    for (const run of kids(pEl, 'run')) {
      const cid = run.getAttribute('charPrIDRef');
      mark = '';
      for (const c of Array.from(run.children)) {
        const nm = local(c);
        if (nm === 't') walkT(c, cid);
        else if (OBJ_TAGS.has(nm)) { hasObj = true; atoms.push({ kind: 'obj', node: c, cid }); }
        else if (nm === 'ctrl') {
          for (const cc of Array.from(c.children)) {
            const n2 = local(cc);
            if (n2 === 'footNote' || n2 === 'endNote') { hasObj = true; atoms.push({ kind: 'note', node: cc, cid }); }
            else if (OBJ_TAGS.has(n2)) { hasObj = true; atoms.push({ kind: 'obj', node: cc, cid }); }
          }
        }
      }
    }
    return { atoms, hasObj };
  }

  function makeTabSpan(cid, ps) {
    const sp = document.createElement('span');
    sp.className = 'hp-tab';
    const cs = charStyle(cid);
    if (cs) sp.style.fontSize = round(cs.sizePt, 3) + 'pt';
    if (ps && ps.tabPr) sp.dataset.tabPr = ps.tabPr;
    const fill = document.createElement('span');
    fill.className = 'hp-tab-fill';
    sp.appendChild(fill);
    return sp;
  }

  /* 조각들을 한 줄에 그린다 (같은 글자 모양은 span 하나로 묶는다) */
  function renderAtoms(atoms, host, sec, ps) {
    let buf = '';
    let cid = null;
    let mark = '';
    const flush = () => {
      if (!buf) return;
      const sp = document.createElement('span');
      sp.className = 'hp-run';
      applyCharStyle(sp, charStyle(cid));
      if (mark) sp.style.backgroundColor = mark;
      sp.textContent = buf;
      host.appendChild(sp);
      buf = '';
    };
    for (const a of atoms) {
      if (a.kind === 'text') {
        if (a.cid !== cid || (a.mark || '') !== mark) { flush(); cid = a.cid; mark = a.mark || ''; }
        buf += a.ch;
        continue;
      }
      flush();
      if (a.kind === 'tab') host.appendChild(makeTabSpan(a.cid, ps));
      else if (a.kind === 'br') host.appendChild(document.createElement('br'));
      else if (a.kind === 'note') host.appendChild(noteMarker(a.node));
      else if (a.kind === 'obj') {
        const el = renderObject(a.node, sec);
        if (el) host.appendChild(el);
      }
    }
    flush();
  }

  function renderLineLayout(div, atoms, lines, ps, sec) {
    const nLines = lines.length;
    const align = ps ? ALIGN[ps.align] : '';
    for (let i = 0; i < nLines; i++) {
      const seg = lines[i];
      const from = clamp(seg.textpos, 0, atoms.length);
      const to = i + 1 < nLines ? clamp(lines[i + 1].textpos, from, atoms.length) : atoms.length;
      const slice = atoms.slice(from, to);
      /* 줄 끝의 빈칸은 한글이 줄을 나누며 먹은 자리라 그리지 않는다 */
      if (i + 1 < nLines) {
        while (slice.length) {
          const last = slice[slice.length - 1];
          if (last.kind === 'text' && (last.ch === ' ' || last.ch === '\u00A0')) slice.pop();
          else break;
        }
      }
      const line = document.createElement('div');
      line.className = 'hp-line';
      const advance = Math.max(1, (seg.textheight + seg.spacing) * U2PX);
      line.style.height = round(advance, 2) + 'px';
      line.style.lineHeight = round(Math.max(seg.textheight, 1) * U2PX, 2) + 'px';
      /* 문단 들여쓰기(intent)는 lineseg 의 horzpos 에 담기지 않는다.
         들여쓰기(+)는 첫 줄만, 내어쓰기(-)는 이어지는 줄만 그만큼 더 들어간다. */
      let leftHwu = seg.horzpos;
      if (ps && ps.intent) {
        if (i === 0) { if (ps.intent > 0) leftHwu += ps.intent; }
        else if (ps.intent < 0) leftHwu -= ps.intent;
      }
      line.style.paddingLeft = round(clamp(leftHwu * U2PX, 0, 4000), 2) + 'px';
      if (align) line.style.textAlign = align;
      if (align === 'justify' && i + 1 < nLines) line.classList.add('hp-line-justify');
      line.dataset.textpos = String(seg.textpos);
      renderAtoms(slice, line, sec, ps);
      div.appendChild(line);
    }
  }

  function makeParagraph(pEl, sec, hasTable) {
    const div = document.createElement('div');
    div.className = 'hp-p';
    const ps = paraStyle(pEl);
    const g = sec.geom || { contentPx: 700 };
    const availPt = (g.contentPx / U2PX) * U2PT;

    const runs = kids(pEl, 'run');
    const primaryRun = runs.find((r) => kids(r, 't').length) || runs[0];
    const primary = charStyle(primaryRun ? primaryRun.getAttribute('charPrIDRef') : null);

    /* 읽기 모드에서는 한글이 저장한 줄 정보로 줄을 직접 놓는다.
       개체(그림·도형)가 섞였거나 줄 정보가 글자 수와 맞지 않으면 흐름 배치로 돌아간다. */
    const atomsInfo = buildAtoms(pEl);
    const lines = (!hasTable && state.mode !== 'edit') ? lineSegs(pEl) : null;
    const lastTextpos = lines ? lines[lines.length - 1].textpos : 0;
    const lineMode = !!(lines && !atomsInfo.hasObj && atomsInfo.atoms.length >= lastTextpos);

    if (ps) {
      const pad = (v) => round(clamp(v * U2PT, 0, availPt * 0.7), 2);
      if (ps.prev) div.style.paddingTop = pad(ps.prev) + 'pt';
      if (ps.next) div.style.paddingBottom = pad(ps.next) + 'pt';
      if (ps.right) div.style.paddingRight = pad(ps.right) + 'pt';
      if (!lineMode) {
        const align = ALIGN[ps.align];
        if (align) div.style.textAlign = align;
        const intent = clamp(ps.intent * U2PT, -availPt * 0.7, availPt * 0.7);
        const left = clamp(ps.left * U2PT, 0, availPt * 0.7);
        if (intent > 0) {
          if (left) div.style.paddingLeft = round(left, 2) + 'pt';
          div.style.textIndent = round(intent, 2) + 'pt';
        } else if (intent < 0) {
          /* 내어쓰기: 첫 줄만 왼쪽으로 나가고 나머지 줄은 |intent| 만큼 들어간다 */
          div.style.paddingLeft = round(Math.max(0, left - intent), 2) + 'pt';
          div.style.textIndent = round(intent, 2) + 'pt';
        } else if (left) {
          div.style.paddingLeft = round(left, 2) + 'pt';
        }
        div.style.lineHeight = lineHeightCss(ps, primary ? primary.sizePt : 10);
      }
    }
    if (pEl.getAttribute('pageBreak') === '1') div.dataset.breakBefore = '1';

    if (primary) {
      div.style.fontFamily = primary.stack;
      div.style.fontSize = round(primary.sizePt, 2) + 'pt';
    }

    if (lineMode) {
      div.classList.add('hp-p-lines');
      renderLineLayout(div, atomsInfo.atoms, lines, ps, sec);
    } else {
      let text = '';
      for (const run of runs) {
        const segs = runSegments(run);
        for (const s of segs) if (s.kind === 'text' || s.kind === 'tab') text += s.kind === 'text' ? s.text : '\t';
        renderSegs(segs, div, sec);
      }
      if (!text.trim() && !hasTable && !div.querySelector('.hp-obj')) {
        div.classList.add('hp-p-empty');
        div.appendChild(document.createElement('br'));
      }
    }

    if (!hasTable) {
      state.nodeMap.set(div, { el: div, pEl, sec, originalText: ownText(pEl) });
      if (state.dirtyNodes.has(pEl)) div.classList.add('modified');
      applyEditable(div);
    }
    return div;
  }

  function applyEditable(div) {
    if (state.mode === 'edit') div.setAttribute('contenteditable', 'true');
    else div.removeAttribute('contenteditable');
  }

  /* ---------------- objects (글상자·그림·수식) ---------------- */
  /* 그룹(container) 안의 개체는 orgSz × scaMatrix 배율로 크기가 정해진다 */
  function groupScale(node) {
    const ri = kids(node, 'renderingInfo')[0];
    if (!ri) return 1;
    let k = 1;
    for (const m of kids(ri, 'scaMatrix')) {
      const e1 = num(m.getAttribute('e1'), 1);
      if (e1 > 0 && e1 < 10) k *= e1;
    }
    return k || 1;
  }

  function objectSize(node, sec, opts) {
    const g = sec.geom || { contentPx: 700, hPx: 1122 };
    const sz = kids(node, 'sz')[0];
    let wUnits = 0;
    let hUnits = 0;
    if (sz && !(opts && opts.inGroup)) {
      wUnits = num(sz.getAttribute('width'), 0);
      hUnits = num(sz.getAttribute('height'), 0);
    } else {
      const org = kids(node, 'orgSz')[0];
      const cur = kids(node, 'curSz')[0];
      const k = (opts && opts.scale) || groupScale(node);
      const src = org || cur;
      wUnits = num(src ? src.getAttribute('width') : 0, 0) * (org ? k : 1);
      hUnits = num(src ? src.getAttribute('height') : 0, 0) * (org ? k : 1);
    }
    return {
      w: clamp(wUnits * U2PX, 8, Math.max(8, g.contentPx)),
      h: clamp(hUnits * U2PX, 0, g.hPx * 4),
    };
  }

  function applyObjectOffset(el, node, sec) {
    const off = kids(node, 'offset')[0];
    if (!off) return;
    const x = clamp(num(off.getAttribute('x'), 0) * U2PX, 0, 4000);
    const y = clamp(num(off.getAttribute('y'), 0) * U2PX, 0, 8000);
    el.style.position = 'absolute';
    el.style.left = round(x, 2) + 'px';
    el.style.top = round(y, 2) + 'px';
  }

  function renderObject(node, sec, opts) {
    const name = local(node);
    if (name === 'pic') return renderPicture(node, sec, opts);
    if (name === 'equation') return renderEquation(node, sec, opts);
    if (name === 'container') return renderGroup(node, sec);
    if (name === 'chart' || name === 'ole' || name === 'video' || name === 'textart' || name === 'compose') {
      return renderPlaceholder(node, sec, name, opts);
    }
    return renderShape(node, sec, opts);
  }

  /* 그룹(묶은 개체): 안의 그림·도형을 각자의 위치에 절대 배치 */
  function renderGroup(node, sec) {
    const g = sec.geom || { contentPx: 700 };
    const box = document.createElement('div');
    box.className = 'hp-obj hp-group';
    const cur = kids(node, 'curSz')[0] || kids(node, 'sz')[0] || kids(node, 'orgSz')[0];
    const w = clamp(num(cur ? cur.getAttribute('width') : 0, 0) * U2PX, 20, g.contentPx);
    const h = clamp(num(cur ? cur.getAttribute('height') : 0, 0) * U2PX, 10, g.hPx * 3);
    box.style.width = w + 'px';
    box.style.height = h + 'px';
    box.style.position = 'relative';
    let any = false;
    for (const child of Array.from(node.children)) {
      const nm = local(child);
      if (!OBJ_TAGS.has(nm) || nm === 'container') continue;
      const el = renderObject(child, sec, { inGroup: true, scale: groupScale(child) });
      if (!el) continue;
      applyObjectOffset(el, child, sec);
      box.appendChild(el);
      any = true;
    }
    if (!any) {
      box.classList.add('hp-obj-placeholder');
      box.textContent = '묶은 개체';
    }
    return box;
  }

  function renderPlaceholder(node, sec, kind, opts) {
    const { w, h } = objectSize(node, sec, opts);
    const box = document.createElement('div');
    box.className = 'hp-obj hp-obj-placeholder';
    box.style.width = w + 'px';
    if (h > 0) box.style.height = h + 'px';
    const label = { chart: '차트', ole: '개체', video: '동영상', textart: '글맵시', compose: '글자 겹치기' }[kind] || '개체';
    box.textContent = label;
    const comment = firstIn(node, 'shapeComment');
    if (comment && comment.textContent.trim()) box.title = comment.textContent.trim();
    if (opts && opts.inGroup) applyObjectOffset(box, node, sec);
    return box;
  }

  function renderShape(node, sec, opts) {
    const { w, h } = objectSize(node, sec, opts);
    const box = document.createElement('div');
    box.className = 'hp-obj hp-shape';
    box.style.width = w + 'px';
    if (h > 0) box.style.minHeight = h + 'px';
    if (opts && opts.inGroup) applyObjectOffset(box, node, sec);

    const line = firstIn(node, 'lineShape');
    if (line) {
      const lw = clamp(num(String(line.getAttribute('width') || '283').replace(/[^\d.\-]/g, ''), 283) * U2PX, 0.5, 9);
      box.style.border = `${round(lw, 2)}px solid ${cssColor(line.getAttribute('color'), '#000000')}`;
    }
    const brush = firstIn(node, 'winBrush');
    if (brush) {
      const fill = cssColor(brush.getAttribute('faceColor'), '');
      if (fill) box.style.backgroundColor = fill;
    }
    const inM = kids(node, 'inMargin')[0];
    if (inM) {
      const px = (v) => round(clamp(num(v, 0) * U2PX, 0, 40), 2);
      box.style.padding = `${px(inM.getAttribute('top'))}px ${px(inM.getAttribute('right'))}px ${px(inM.getAttribute('bottom'))}px ${px(inM.getAttribute('left'))}px`;
    }
    const dt = kids(node, 'drawText')[0];
    const sub = dt ? kids(dt, 'subList')[0] : kids(node, 'subList')[0];
    if (sub) {
      for (const p of kids(sub, 'p')) renderParagraphBlock(p, box, sec);
    }
    if (!box.childNodes.length) {
      box.classList.add('hp-obj-placeholder');
      box.textContent = '도형';
    }
    return box;
  }

  function renderEquation(node, sec, opts) {
    const { w, h } = objectSize(node, sec, opts);
    const box = document.createElement('div');
    box.className = 'hp-obj hp-equation';
    box.style.minWidth = Math.min(w, 60) + 'px';
    if (h > 0) box.style.minHeight = h + 'px';
    const script = firstIn(node, 'script');
    const raw = script ? script.textContent.trim() : '';
    box.textContent = raw ? raw.replace(/\s+/g, ' ') : '수식';
    box.title = '한글 수식';
    if (opts && opts.inGroup) applyObjectOffset(box, node, sec);
    return box;
  }

  function renderPicture(node, sec, opts) {
    const { w, h } = objectSize(node, sec, opts);
    const box = document.createElement('div');
    box.className = 'hp-obj hp-pic';
    box.style.width = w + 'px';
    box.style.height = (h > 0 ? h : w * 0.75) + 'px';
    const imgEl = firstIn(node, 'img');
    const ref = imgEl ? imgEl.getAttribute('binaryItemIDRef') : '';
    const path = ref ? state.bin.get(ref) : null;
    if (path) {
      const img = document.createElement('img');
      img.alt = '';
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'contain';
      box.appendChild(img);
      const pending = imageUrl(path);
      if (pending && typeof pending.then === 'function') {
        pending.then((url) => { if (url) img.src = url; });
      } else if (pending) {
        img.src = pending;
      }
    } else {
      box.classList.add('hp-obj-placeholder');
      box.textContent = '그림';
    }
    const comment = firstIn(node, 'shapeComment');
    if (comment && comment.textContent.trim()) box.title = comment.textContent.trim();
    if (opts && opts.inGroup) applyObjectOffset(box, node, sec);
    return box;
  }

  /* ---------------- tables ---------------- */
  function renderTable(tblEl, sec) {
    const g = sec.geom || { contentPx: 700 };
    const wrap = document.createElement('div');
    wrap.className = 'hp-tbl-wrap';
    const table = document.createElement('table');
    table.className = 'hp-tbl';
    table.style.tableLayout = 'fixed';
    table.style.maxWidth = '100%';

    /* 표 바깥 여백 */
    const outM = kids(tblEl, 'outMargin')[0];
    if (outM) {
      wrap.style.marginTop = round(clamp(num(outM.getAttribute('top'), 0) * U2PX, 0, 40), 2) + 'px';
      wrap.style.marginBottom = round(clamp(num(outM.getAttribute('bottom'), 0) * U2PX, 0, 40), 2) + 'px';
      wrap.style.marginLeft = round(clamp(num(outM.getAttribute('left'), 0) * U2PX, 0, 40), 2) + 'px';
      wrap.style.marginRight = round(clamp(num(outM.getAttribute('right'), 0) * U2PX, 0, 40), 2) + 'px';
    }

    const szEl = kids(tblEl, 'sz')[0];
    const tableUnits = szEl ? num(szEl.getAttribute('width'), 0) : 0;
    const inMargin = kids(tblEl, 'inMargin')[0] || firstIn(tblEl, 'inMargin');
    const tablePad = {
      left: inMargin ? num(inMargin.getAttribute('left'), 0) : 0,
      right: inMargin ? num(inMargin.getAttribute('right'), 0) : 0,
      top: inMargin ? num(inMargin.getAttribute('top'), 0) : 0,
      bottom: inMargin ? num(inMargin.getAttribute('bottom'), 0) : 0,
    };
    const tableFill = state.styles.borderFills.get(String(tblEl.getAttribute('borderFillIDRef') || '')) || null;

    const trs = kids(tblEl, 'tr');
    const repeatHeader = String(tblEl.getAttribute('repeatHeader') || '0') === '1';
    let declaredCols = Math.max(1, num(tblEl.getAttribute('colCnt'), 0) || 1);
    const declaredRows = Math.max(1, num(tblEl.getAttribute('rowCnt'), 0) || trs.length);

    /* 셀 주소(cellAddr)를 기준으로 격자를 만든다. 주소가 없거나 겹치면 앞으로 밀어 배치. */
    const cells = [];
    let maxCol = Math.min(declaredCols, 200);
    let maxRow = Math.min(Math.max(declaredRows, trs.length), 5000);
    trs.forEach((tr, ri) => {
      let seqCol = 0;
      for (const tc of kids(tr, 'tc')) {
        const addr = kids(tc, 'cellAddr')[0];
        const spanEl = kids(tc, 'cellSpan')[0];
        const cs = clamp(num(spanEl ? spanEl.getAttribute('colSpan') : 1, 1), 1, 200);
        const rs = clamp(num(spanEl ? spanEl.getAttribute('rowSpan') : 1, 1), 1, 2000);
        let c = addr ? num(addr.getAttribute('colAddr'), -1) : -1;
        let r = addr ? num(addr.getAttribute('rowAddr'), ri) : ri;
        if (!(r >= 0) || r > 4000) r = ri;
        if (!(c >= 0) || c > 190) c = seqCol;
        cells.push({ el: tc, r, c, cs, rs });
        seqCol = c + cs;
        maxCol = Math.min(200, Math.max(maxCol, c + cs));
        maxRow = Math.min(5000, Math.max(maxRow, r + rs));
      }
    });

    const grid = Array.from({ length: maxRow }, () => new Array(maxCol).fill(0));
    const fits = (r, c, cs, rs) => {
      if (r + rs > maxRow || c + cs > maxCol) return false;
      for (let rr = r; rr < r + rs; rr++) for (let cc = c; cc < c + cs; cc++) if (grid[rr][cc]) return false;
      return true;
    };
    const placed = [];
    for (const rec of cells) {
      let { r, c } = rec;
      const cs = Math.min(rec.cs, maxCol - c);
      const rs = Math.min(rec.rs, maxRow - r);
      if (cs < 1 || rs < 1) continue;
      if (!fits(r, c, cs, rs)) {
        const text = allByLocal(rec.el, 't').map((t) => t.textContent.trim()).join('');
        if (!text) continue;                 // 덮인 중복 칸은 버린다
        let done = false;
        for (let rr = r; rr < maxRow && !done; rr++) {
          for (let cc = (rr === r ? c + 1 : 0); cc < maxCol; cc++) {
            if (fits(rr, cc, cs, rs)) { r = rr; c = cc; done = true; break; }
          }
        }
        if (!done) continue;
      }
      for (let rr = r; rr < r + rs; rr++) for (let cc = c; cc < c + cs; cc++) grid[rr][cc] = 1;
      placed.push({ ...rec, r, c, cs, rs });
    }

    /* 열 폭: 단일 칸 폭을 우선 쓰고, 병합 칸 폭은 빈 열에 나눠 준다 */
    const widths = new Array(maxCol).fill(0);
    const cellWidth = (tc) => {
      const csz = kids(tc, 'cellSz')[0];
      return csz ? Math.max(0, num(csz.getAttribute('width'), 0)) : 0;
    };
    for (const rec of placed) {
      if (rec.cs !== 1) continue;
      const w = cellWidth(rec.el);
      if (w > 0) widths[rec.c] = Math.max(widths[rec.c], w);
    }
    for (const rec of placed) {
      if (rec.cs <= 1) continue;
      const w = cellWidth(rec.el);
      if (!(w > 0)) continue;
      let known = 0;
      const unknown = [];
      for (let i = rec.c; i < rec.c + rec.cs; i++) {
        if (widths[i] > 0) known += widths[i];
        else unknown.push(i);
      }
      if (!unknown.length) continue;
      const rest = w - known;
      const each = rest > 0 ? rest / unknown.length : w / rec.cs;
      for (const i of unknown) widths[i] = each;
    }
    const knownW = widths.filter((w) => w > 0);
    const avg = knownW.length
      ? knownW.reduce((a, b) => a + b, 0) / knownW.length
      : (tableUnits > 0 ? tableUnits / maxCol : 3000);
    for (let i = 0; i < widths.length; i++) if (!(widths[i] > 0)) widths[i] = avg;
    const sumUnits = widths.reduce((a, b) => a + b, 0) || (tableUnits || 1);
    const totalUnits = tableUnits > 0 ? tableUnits : sumUnits;

    /* 용지 본문 폭을 넘는 표는 비율을 유지한 채 줄인다 (가로로 끝없이 뻗지 않게) */
    const availPx = Math.max(60, g.contentPx);
    const naturalPx = totalUnits * U2PX;
    const px = Math.min(naturalPx, availPx);
    table.style.width = round(px, 2) + 'px';

    const cg = document.createElement('colgroup');
    for (const wu of widths) {
      const col = document.createElement('col');
      col.style.width = round((wu / sumUnits) * 100, 4) + '%';
      cg.appendChild(col);
    }
    table.appendChild(cg);

    /* 행 높이 (셀 높이가 비정상적으로 크면 무시) */
    const maxRowPx = Math.max(40, g.hPx * 0.9);
    const rowEls = [];
    for (let r = 0; r < maxRow; r++) {
      const trEl = document.createElement('tr');
      rowEls.push(trEl);
    }
    for (let r = 0; r < maxRow; r++) {
      let hUnits = 0;
      for (const rec of placed) {
        if (rec.r === r && rec.rs === 1) {
          const csz = kids(rec.el, 'cellSz')[0];
          if (csz) hUnits = Math.max(hUnits, num(csz.getAttribute('height'), 0));
        }
      }
      const hPx = hUnits * U2PX;
      if (hPx > 0 && hPx < maxRowPx) rowEls[r].style.height = round(hPx, 2) + 'px';
    }

    const byRow = new Map();
    for (const rec of placed) {
      if (!byRow.has(rec.r)) byRow.set(rec.r, []);
      byRow.get(rec.r).push(rec);
    }

    /* 머리행: header="1" 인 앞쪽 행들 */
    let headRows = 0;
    if (repeatHeader) {
      while (headRows < trs.length && kids(trs[headRows], 'tc').length &&
             kids(trs[headRows], 'tc').every((tc) => String(tc.getAttribute('header') || '0') === '1')) {
        headRows++;
      }
      if (headRows >= maxRow) headRows = 0;
    }

    for (let r = 0; r < maxRow; r++) {
      const list = (byRow.get(r) || []).sort((a, b) => a.c - b.c);
      const trEl = rowEls[r];
      for (const rec of list) {
        const tc = rec.el;
        const cell = document.createElement('td');
        cell.className = 'hp-cell';
        if (rec.cs > 1) cell.colSpan = rec.cs;
        if (rec.rs > 1) cell.rowSpan = rec.rs;
        cell.dataset.col = String(rec.c);
        cell.dataset.row = String(rec.r);
        cell.dataset.cs = String(rec.cs);
        cell.dataset.rs = String(rec.rs);

        const margin = kids(tc, 'cellMargin')[0];
        const pad = margin ? {
          left: num(margin.getAttribute('left'), tablePad.left),
          right: num(margin.getAttribute('right'), tablePad.right),
          top: num(margin.getAttribute('top'), tablePad.top),
          bottom: num(margin.getAttribute('bottom'), tablePad.bottom),
        } : tablePad;
        const px4 = (v) => round(clamp(num(v, 0) * U2PX, 0, 30), 2);
        cell.style.padding = `${px4(pad.top)}px ${px4(pad.right)}px ${px4(pad.bottom)}px ${px4(pad.left)}px`;

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
          cell.appendChild(EMPTY_P());
        }
        for (const pEl of paragraphs) renderParagraphBlock(pEl, cell, sec);

        trEl.appendChild(cell);
      }
    }

    if (headRows > 0) {
      const thead = document.createElement('thead');
      for (let r = 0; r < headRows; r++) thead.appendChild(rowEls[r]);
      const tbody = document.createElement('tbody');
      for (let r = headRows; r < maxRow; r++) tbody.appendChild(rowEls[r]);
      table.appendChild(thead);
      table.appendChild(tbody);
    } else {
      const tbody = document.createElement('tbody');
      for (let r = 0; r < maxRow; r++) tbody.appendChild(rowEls[r]);
      table.appendChild(tbody);
    }

    /* 표 제목(hp:caption) — 표 위/아래/좌/우 */
    const caption = kids(tblEl, 'caption')[0];
    if (caption) {
      const capList = kids(caption, 'subList')[0];
      if (capList) {
        const side = String(caption.getAttribute('side') || 'TOP').toUpperCase();
        const capBox = document.createElement('div');
        capBox.className = 'hp-caption hp-caption-' + side.toLowerCase();
        for (const pEl of kids(capList, 'p')) renderParagraphBlock(pEl, capBox, sec);
        if (side === 'BOTTOM') wrap.appendChild(table), wrap.appendChild(capBox);
        else if (side === 'LEFT' || side === 'RIGHT') {
          const row = document.createElement('div');
          row.className = 'hp-caption-row';
          if (side === 'LEFT') { row.appendChild(capBox); row.appendChild(table); }
          else { row.appendChild(table); row.appendChild(capBox); }
          wrap.appendChild(row);
          return wrap;
        } else { wrap.appendChild(capBox); wrap.appendChild(table); }
        return wrap;
      }
    }

    wrap.appendChild(table);
    return wrap;
  }

  /* ---------------- editing / committing ---------------- */
  function ownText(pEl) {
    let out = '';
    const walk = (node) => {
      for (const child of Array.from(node.children)) {
        const name = local(child);
        if (name === 'tbl' || name === 'subList') continue;
        if (OBJ_TAGS.has(name)) continue;
        if (name === 't') out += textOfT(child);
        else if (name === 'lineBreak') out += '\n';
        else if (name === 'tab') out += '\t';
        else if (name === 'ctrl') { /* 각주·필드 표시는 본문 글자가 아니다 */ }
        else walk(child);
      }
    };
    walk(pEl);
    return out;
  }

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
    /* 원래 <hp:t> 안에 있던 표시 요소(형광펜 등)는 잃지 않게 옮겨 둔다 */
    const keepInline = firstT
      ? Array.from(firstT.childNodes).filter((n) => n.nodeType === 1)
      : [];

    for (const run of runs) {
      for (const t of kids(run, 't')) run.removeChild(t);
      for (const lb of kids(run, 'lineBreak')) run.removeChild(lb);
    }

    const frag = doc.createDocumentFragment();
    text.split('\n').forEach((line, i) => {
      if (i) frag.appendChild(make('lineBreak'));
      const t = template ? template.cloneNode(false) : make('t');
      for (const node of keepInline) t.appendChild(node.cloneNode(true));
      t.appendChild(doc.createTextNode(line));
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
    const editing = mode === 'edit';
    ui.modeToggle.textContent = editing ? '읽기' : '편집';
    ui.modeToggle.dataset.mode = editing ? 'read' : 'edit';
    ui.modeToggle.classList.toggle('on', editing);
    ui.modeToggle.setAttribute('aria-pressed', String(editing));
    ui.replaceBtn.hidden = !editing;
    ui.replaceBtn.disabled = !(state.zip && editing);
    if (!editing) ui.replacePanel.hidden = true;
    if (state.zip) {
      if (!opts || opts.rerender) renderDocument();
      updateStatus();
    }
  }

  function updateStatus() {
    const st = ui.fileStatus;
    const n = state.dirtyNodes.size;
    ui.dirtyDot.hidden = !n;
    if (!state.zip) {
      st.hidden = true;
      ui.docMeter.hidden = true;
      return;
    }
    if (n) {
      st.hidden = false;
      st.textContent = `수정 ${n}`;
      st.classList.add('dirty');
    } else {
      st.hidden = true;
      st.classList.remove('dirty');
    }
  }

  /* 지금 보고 있는 쪽 표시 (1 / 5쪽) */
  function updatePageInfo() {
    const pages = Array.from(ui.doc.querySelectorAll('.page'));
    if (!pages.length) { ui.docMeter.hidden = true; return; }
    ui.docMeter.hidden = false;
    const header = document.querySelector('.app-header');
    const line = (header ? header.getBoundingClientRect().bottom : 52) + 48;
    let cur = 1;
    pages.forEach((p, i) => {
      if (p.getBoundingClientRect().top <= line) cur = i + 1;
    });
    ui.pageInfo.textContent = `${cur} / ${pages.length}쪽`;
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

    ui.modeToggle.addEventListener('click', () => {
      if (ui.modeToggle.disabled) return;
      setMode(ui.modeToggle.dataset.mode === 'edit' ? 'edit' : 'read');
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
      resizeTimer = setTimeout(() => { fitPages(); updatePageInfo(); }, 120);
    });

    let scrollFrame = 0;
    window.addEventListener('scroll', () => {
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        updatePageInfo();
      });
    }, { passive: true });

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
