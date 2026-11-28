/* 한글 5.0 바이너리 문서(.hwp) → HWPX 구조 변환기 — 100% 브라우저 안에서
 *
 * .hwp 는 OLE 복합 파일(CFB) 안에 FileHeader·DocInfo·BodyText/Section*·BinData/* 를
 * 레코드(태그+레벨+크기) 단위로 담은 형식이다. 이 파일은 그것을 읽어, 지금 앱이 쓰는
 * HWPX(ZIP+XML) 구조 — header.xml / content.hpf / section*.xml / BinData — 를 메모리에
 * 만들어 준다. 그 뒤로는 .hwpx 와 똑같은 조판·보기·편집·저장 경로를 그대로 탄다.
 *
 * 레코드 배치(필드 순서·크기)는 한글 5.0 문서 파일 형식 규격을 따랐다.
 * 파일은 어디에도 전송되지 않는다.
 */
'use strict';

(function (global) {
  /* ---------------- 레코드 태그 ---------------- */
  const T = {
    /* DocInfo */
    DOC_PROPS: 16, ID_MAPPINGS: 17, BIN_DATA: 18, FACE_NAME: 19, BORDER_FILL: 20,
    CHAR_SHAPE: 21, TAB_DEF: 22, NUMBERING: 23, BULLET: 24, PARA_SHAPE: 25, STYLE: 26,
    /* BodyText / Section */
    PARA_HEADER: 66, PARA_TEXT: 67, PARA_CHAR_SHAPE: 68, PARA_LINE_SEG: 69,
    PARA_RANGE_TAG: 70, CTRL_HEADER: 71, LIST_HEADER: 72, PAGE_DEF: 73,
    FOOTNOTE_SHAPE: 74, PAGE_BORDER_FILL: 75, SHAPE_COMPONENT: 76, TABLE: 77,
    LINE: 78, RECT: 79, ELLIPSE: 80, ARC: 81, POLYGON: 82, CURVE: 83,
    OLE: 84, PICTURE: 85, CONTAINER: 86, CTRL_DATA: 87, EQEDIT: 88,
  };

  const LANGS = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'];

  /* 16바이트(8글자)를 차지하는 컨트롤 문자 */
  const CTRL_CHARS = new Set([0x01, 0x02, 0x03, 0x0b, 0x0c, 0x0e, 0x0f, 0x10, 0x11,
    0x12, 0x15, 0x16, 0x17, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x13, 0x14]);

  const BORDER_TYPES = ['NONE', 'SOLID', 'DASH', 'DOT', 'DASH_DOT', 'DASH_DOT_DOT',
    'LONG_DASH', 'DOT', 'DOUBLE', 'DOUBLE', 'DOUBLE', 'DOUBLE', 'SOLID', 'DOUBLE',
    'SOLID', 'SOLID', 'SOLID', 'SOLID'];
  const BORDER_WIDTHS = ['0.1 mm', '0.12 mm', '0.15 mm', '0.2 mm', '0.25 mm', '0.3 mm',
    '0.4 mm', '0.5 mm', '0.6 mm', '0.7 mm', '1.0 mm', '1.5 mm', '2.0 mm', '3.0 mm',
    '4.0 mm', '5.0 mm'];
  const ALIGN_NAMES = ['JUSTIFY', 'LEFT', 'RIGHT', 'CENTER', 'DISTRIBUTE', 'DISTRIBUTE_SPACE'];

  /* ---------------- 바이트 리더 ---------------- */
  class Reader {
    constructor(u8, pos) {
      this.u8 = u8;
      this.view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      this.p = pos || 0;
    }
    byte() { return this.u8[this.p++]; }
    i8() { const v = this.view.getInt8(this.p); this.p += 1; return v; }
    u16() { const v = this.view.getUint16(this.p, true); this.p += 2; return v; }
    i16() { const v = this.view.getInt16(this.p, true); this.p += 2; return v; }
    u32() { const v = this.view.getUint32(this.p, true); this.p += 4; return v; }
    i32() { const v = this.view.getInt32(this.p, true); this.p += 4; return v; }
    skip(n) { this.p += n; }
    left() { return this.u8.length - this.p; }
    /* BSTR: 2바이트 글자 수 + UTF-16LE */
    str() {
      if (this.left() < 2) return '';
      const n = this.u16();
      let s = '';
      for (let i = 0; i < n && this.left() >= 2; i++) s += String.fromCharCode(this.u16());
      return s;
    }
    bytes(n) { const b = this.u8.subarray(this.p, this.p + n); this.p += n; return b; }
  }

  const colorOf = (v) => {
    if (v == null) return null;
    const r = v & 0xff, g = (v >>> 8) & 0xff, b = (v >>> 16) & 0xff;
    return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  };
  const xmlEsc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    /* XML 1.0 이 허용하지 않는 제어 문자는 지운다 */
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');

  /* ---------------- CFB(OLE 복합 파일) 읽기 ---------------- */
  function readCfb(u8) {
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (u8.length < 512 || view.getUint32(0, true) !== 0xE011CFD0 || view.getUint32(4, true) !== 0xE11AB1A1) {
      throw new Error('한글 문서(OLE) 구조가 아닙니다.');
    }
    const sectorSize = 1 << view.getUint16(0x1e, true);
    const miniSize = 1 << view.getUint16(0x20, true);
    const numFat = view.getUint32(0x2c, true);
    const dirStart = view.getUint32(0x30, true);
    const miniCutoff = view.getUint32(0x38, true);
    const miniFatStart = view.getUint32(0x3c, true);
    const numMiniFat = view.getUint32(0x40, true);
    const difatStart = view.getUint32(0x44, true);
    const numDifat = view.getUint32(0x48, true);
    const FREE = 0xFFFFFFFF;
    const END = 0xFFFFFFFE;
    const off = (n) => (n + 1) * sectorSize;

    /* FAT 섹터 목록 (헤더의 109개 + DIFAT 체인) */
    const fatSectors = [];
    for (let i = 0; i < 109; i++) {
      const s = view.getUint32(0x4c + i * 4, true);
      if (s === FREE || s === END) continue;
      fatSectors.push(s);
    }
    let ds = difatStart;
    let guard = 0;
    while (ds !== FREE && ds !== END && guard++ < 4096) {
      if (off(ds) + sectorSize > u8.length) break;
      const per = sectorSize / 4 - 1;
      for (let i = 0; i < per; i++) {
        const s = view.getUint32(off(ds) + i * 4, true);
        if (s !== FREE && s !== END) fatSectors.push(s);
      }
      ds = view.getUint32(off(ds) + sectorSize - 4, true);
    }
    const fatPer = sectorSize / 4;
    const fat = [];
    const useFat = numFat ? fatSectors.slice(0, numFat) : fatSectors;
    for (const fs of useFat) {
      const base = off(fs);
      if (base + sectorSize > u8.length) continue;
      for (let i = 0; i < fatPer; i++) fat.push(view.getUint32(base + i * 4, true));
    }

    const chain = (start, table, max) => {
      const out = [];
      let s = start;
      let n = 0;
      while (s !== FREE && s !== END && s < table.length && n++ < (max || 1 << 20)) {
        out.push(s);
        s = table[s];
      }
      return out;
    };
    const readSectors = (start, size) => {
      const sectors = chain(start, fat);
      const out = new Uint8Array(sectors.length * sectorSize);
      sectors.forEach((s, i) => {
        const base = off(s);
        out.set(u8.subarray(base, Math.min(base + sectorSize, u8.length)), i * sectorSize);
      });
      return size ? out.subarray(0, Math.min(size, out.length)) : out;
    };

    /* 디렉터리 */
    const dirBytes = readSectors(dirStart, 0);
    const entries = [];
    for (let base = 0; base + 128 <= dirBytes.length; base += 128) {
      const dv = new DataView(dirBytes.buffer, dirBytes.byteOffset + base, 128);
      const nameLen = dv.getUint16(64, true);
      let name = '';
      for (let i = 0; i + 2 <= Math.max(0, nameLen - 2) && i < 64; i += 2) {
        name += String.fromCharCode(dv.getUint16(i, true));
      }
      entries.push({
        name,
        type: dirBytes[base + 66],
        left: dv.getInt32(68, true),
        right: dv.getInt32(72, true),
        child: dv.getInt32(76, true),
        start: dv.getUint32(116, true),
        size: dv.getUint32(120, true),
      });
    }
    if (!entries.length) throw new Error('문서 디렉터리를 읽지 못했습니다.');

    const root = entries[0];
    /* 작은 스트림(< 4096)은 뿌리 엔트리가 가리키는 미니 스트림에 모여 있다 */
    const miniStream = root && root.size ? readSectors(root.start, root.size) : new Uint8Array(0);
    const miniFat = [];
    if (miniFatStart !== FREE && miniFatStart !== END) {
      const sectors = chain(miniFatStart, fat).slice(0, numMiniFat || undefined);
      for (const s of sectors) {
        const base = off(s);
        for (let i = 0; i < fatPer; i++) miniFat.push(view.getUint32(base + i * 4, true));
      }
    }
    const readMini = (start, size) => {
      const sectors = chain(start, miniFat);
      const out = new Uint8Array(sectors.length * miniSize);
      sectors.forEach((s, i) => {
        const base = s * miniSize;
        out.set(miniStream.subarray(base, Math.min(base + miniSize, miniStream.length)), i * miniSize);
      });
      return out.subarray(0, Math.min(size, out.length));
    };
    const streamBytes = (entry) => {
      if (!entry.size) return new Uint8Array(0);
      return entry.size < miniCutoff ? readMini(entry.start, entry.size) : readSectors(entry.start, entry.size);
    };

    /* 이름 경로 만들기: 저장소(디렉터리) 아래 스트림 */
    const files = new Map();
    const seen = new Set();
    const walk = (index, prefix) => {
      if (index < 0 || index >= entries.length || seen.has(index)) return;
      seen.add(index);
      const e = entries[index];
      walk(e.left, prefix);
      walk(e.right, prefix);
      if (e.type === 1) walk(e.child, prefix + e.name + '/');
      else if (e.type === 2) files.set(prefix + e.name, streamBytes(e));
    };
    if (root.child >= 0) walk(root.child, '');
    return files;
  }

  /* ---------------- 압축 풀기 (deflate raw) ----------------
     한글은 스트림 뒤에 여분 바이트를 붙여 두기도 해서, 그것을 오류로 보지 않는 pako 를
     먼저 쓴다(로컬 lib/pako.min.js). 없으면 브라우저 기본 DecompressionStream 으로 시도한다. */
  async function inflateRaw(bytes) {
    if (!bytes || !bytes.length) return bytes;
    if (global.pako && typeof global.pako.inflateRaw === 'function') {
      try {
        return global.pako.inflateRaw(bytes);
      } catch (err) { /* 아래에서 다른 방법을 시도한다 */ }
    }
    if (typeof DecompressionStream === 'function') {
      try {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (err) { /* 아래에서 다시 시도한다 */ }
    }
    try {
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      writer.write(bytes);
      writer.close();
      const chunks = [];
      const reader = ds.readable.getReader();
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        chunks.push(r.value);
      }
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) { out.set(c, at); at += c.length; }
      return out;
    } catch (err) {
      throw new Error('압축된 문서를 풀지 못했습니다.');
    }
  }

  /* ---------------- 레코드 트리 ---------------- */
  function recordTree(u8) {
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const root = { tag: -1, level: -1, payload: null, children: [] };
    const stack = [root];
    let p = 0;
    let guard = 0;
    while (p + 4 <= u8.length && guard++ < 500000) {
      const head = view.getUint32(p, true);
      p += 4;
      const tag = head & 0x3ff;
      const level = (head >>> 10) & 0x3ff;
      let size = head >>> 20;
      if (size === 0xfff) {
        if (p + 4 > u8.length) break;
        size = view.getUint32(p, true);
        p += 4;
      }
      if (p + size > u8.length) break;
      const node = { tag, level, payload: u8.subarray(p, p + size), children: [] };
      p += size;
      while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    }
    return root;
  }

  function descendants(node, tag) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (tag == null || c.tag === tag) out.push(c);
        walk(c);
      }
    };
    walk(node);
    return out;
  }

  /* ---------------- DocInfo ---------------- */
  function parseFaceName(rec) {
    try {
      const r = new Reader(rec.payload);
      const flags = r.byte();
      const name = r.str();
      let alt = '';
      try {
        if (flags & 0x80) { r.byte(); alt = r.str(); }
        if (flags & 0x40) r.skip(10);          // panose
        if (flags & 0x20) r.str();             // 대체 글꼴
      } catch (e) { /* 이름만 있으면 된다 */ }
      return { name, alt };
    } catch (e) {
      return { name: '', alt: '' };
    }
  }

  function readBorder(r) {
    const stroke = r.byte();
    const width = r.byte();
    const color = r.u32();
    const type = BORDER_TYPES[stroke & 0x1f] || 'SOLID';
    const w = BORDER_WIDTHS[width & 0x0f] || '0.12 mm';
    return { type: stroke & 0x1f ? type : 'NONE', width: w, color: colorOf(color) || '#000000' };
  }

  function parseBorderFill(rec) {
    const none = { type: 'NONE', width: '0.12 mm', color: '#000000' };
    try {
      const r = new Reader(rec.payload);
      r.u16();                                // 속성(3D·그림자 등)
      const left = readBorder(r);
      const right = readBorder(r);
      const top = readBorder(r);
      const bottom = readBorder(r);
      readBorder(r);                          // 대각선
      let fill = '';
      try {
        const fillFlags = r.u32();
        if (fillFlags & 1) {                  // 단색·무늬 채우기
          const bg = r.u32();
          const c = colorOf(bg);
          if (c && bg !== 0xFFFFFFFF) fill = c;
        }
      } catch (e) { /* 채우기 정보가 없어도 테두리는 살린다 */ }
      return { left, right, top, bottom, fill };
    } catch (e) {
      return { left: none, right: none, top: none, bottom: none, fill: '' };
    }
  }

  function parseCharShape(rec) {
    try {
      const r = new Reader(rec.payload);
      const fontId = [];
      const width = [];
      const spacing = [];
      const relSize = [];
      const offset = [];
      for (let i = 0; i < 7; i++) fontId.push(r.u16());
      for (let i = 0; i < 7; i++) width.push(r.byte());
      for (let i = 0; i < 7; i++) spacing.push(r.i8());
      for (let i = 0; i < 7; i++) relSize.push(r.byte());
      for (let i = 0; i < 7; i++) offset.push(r.i8());
      const baseSize = r.i32();                 // 글자 크기 (1/100 pt)
      const flags = r.u32();
      let shade = 0xffffffff;
      let textColor = 0;
      let underlineColor = 0;
      try {
        r.skip(2);                              // 그림자 x·y
        textColor = r.u32();
        underlineColor = r.u32();
        shade = r.u32();
      } catch (e) { /* 색 정보가 짧은 문서도 있다 */ }
      return {
        baseSize: baseSize > 0 ? baseSize : 1000,
        fontId, width, spacing, relSize, offset,
        italic: !!(flags & 1),
        bold: !!(flags & 2),
        underline: (flags >>> 2) & 3,           // 0 없음, 1 밑줄, 2 취소선, 3 윗줄
        underlineShape: (flags >>> 4) & 0x0f,
        outline: (flags >>> 8) & 0x07,
        shadow: (flags >>> 11) & 0x07,
        textColor, underlineColor, shade,
      };
    } catch (e) {
      /* 모양을 읽지 못한 문서는 기본 글자 모양으로 그린다 */
      return {
        baseSize: 1000, fontId: [0, 0, 0, 0, 0, 0, 0],
        width: [100, 100, 100, 100, 100, 100, 100], spacing: [0, 0, 0, 0, 0, 0, 0],
        relSize: [100, 100, 100, 100, 100, 100, 100], offset: [0, 0, 0, 0, 0, 0, 0],
        italic: false, bold: false, underline: 0, underlineShape: 0, outline: 0, shadow: 0,
        textColor: 0, underlineColor: 0, shade: 0xffffffff,
      };
    }
  }

  function parseParaShape(rec) {
    const r = new Reader(rec.payload);
    try {
      const flags = r.u32();
      const left = r.i32();
      const right = r.i32();
      const indent = r.i32();
      const prev = r.i32();
      const next = r.i32();
      const lineSpacing = r.i32();
      let tabDef = 0;
      let borderFill = 0;
      try {
        tabDef = r.u16();
        r.u16();                                // numbering/bullet id
        borderFill = r.u16();
      } catch (e) { /* 없으면 기본값 */ }
      return {
        align: (flags >>> 2) & 0x07,
        lineType: flags & 0x03,                 // 0 비율, 1 고정, 2 여백만, 3 최소
        left: Math.round(left / 2),             // 저장값은 HWPUNIT 의 2배
        right: Math.round(right / 2),
        indent,
        prev: Math.round(prev / 2),
        next: Math.round(next / 2),
        lineSpacing,
        tabDef,
        borderFill,
      };
    } catch (e) {
      return { align: 0, lineType: 0, left: 0, right: 0, indent: 0, prev: 0, next: 0,
        lineSpacing: 160, tabDef: 0, borderFill: 0 };
    }
  }

  async function parseDocInfo(root, compressed) {
    const di = {
      faces: [],
      borderFills: [],
      charShapes: [],
      paraShapes: [],
      binData: [],
      fontCounts: [0, 0, 0, 0, 0, 0, 0],
      borderFillCount: 0,
      charShapeCount: 0,
      paraShapeCount: 0,
      tabCount: 0,
    };
    const flat = descendants(root, null);
    for (const rec of flat) {
      switch (rec.tag) {
        case T.ID_MAPPINGS: {
          const r = new Reader(rec.payload);
          try {
            r.u32();                          // bindata 수
            for (let i = 0; i < 7; i++) di.fontCounts[i] = r.u32();
            di.borderFillCount = r.u32();
            di.charShapeCount = r.u32();
            di.tabCount = r.u32();
            r.u32();                          // numbering
            r.u32();                          // bullet
            di.paraShapeCount = r.u32();
          } catch (e) { /* 개수가 없어도 레코드 순서로 센다 */ }
          break;
        }
        case T.FACE_NAME: di.faces.push(parseFaceName(rec)); break;
        case T.BORDER_FILL: di.borderFills.push(parseBorderFill(rec)); break;
        case T.CHAR_SHAPE: di.charShapes.push(parseCharShape(rec)); break;
        case T.PARA_SHAPE: di.paraShapes.push(parseParaShape(rec)); break;
        case T.BIN_DATA: {
          const r = new Reader(rec.payload);
          const flags = r.u16();
          const storage = flags & 0x0f;
          const compress = (flags >>> 4) & 0x03;
          let ext = '';
          try {
            if (storage === 1) { r.u16(); ext = r.str(); }
            else if (storage === 2) { r.u16(); }
            else { r.str(); r.str(); }
          } catch (e) { /* 확장자가 없으면 스트림 이름으로 찾는다 */ }
          di.binData.push({ storage, compress, ext: String(ext || '').toLowerCase() });
          break;
        }
        default: break;
      }
    }
    /* 개수를 못 읽었으면 실제 레코드 수로 채운다 */
    const totalFaces = di.faces.length;
    const sumCounts = di.fontCounts.reduce((a, b) => a + b, 0);
    if (!sumCounts || sumCounts !== totalFaces) {
      /* 언어별 개수를 모르면 한글 글꼴 하나로 모두 묶는다 (글꼴 이름은 그대로 쓴다) */
      di.fontCounts = [totalFaces, 0, 0, 0, 0, 0, 0];
    }
    return di;
  }

  /* ---------------- 스타일(header.xml) 만들기 ---------------- */
  function langOfFont(di, id) {
    let rest = id;
    for (let i = 0; i < 7; i++) {
      const n = di.fontCounts[i] || 0;
      if (rest < n) return { lang: LANGS[i], local: rest };
      rest -= n;
    }
    return { lang: 'HANGUL', local: 0 };
  }

  function fontRefXml(di, charShape) {
    const parts = [];
    const slots = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'];
    const localOf = (lang, globalId) => {
      let start = 0;
      for (let i = 0; i < 7; i++) {
        if (LANGS[i] === lang) return Math.max(0, globalId - start);
        start += di.fontCounts[i] || 0;
      }
      return 0;
    };
    slots.forEach((lang, i) => {
      const gid = charShape.fontId[i] || 0;
      parts.push(`${lang.toLowerCase()}="${localOf(lang, gid)}"`);
    });
    return `<hh:fontRef ${parts.join(' ')}/>`;
  }

  function headerXml(di) {
    const out = [];
    out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    out.push('<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head"'
      + ' xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"'
      + ' xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core"'
      + ' xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" version="1.1">');
    out.push('<hh:refList>');

    /* 글꼴 */
    out.push(`<hh:fontfaces itemCnt="${LANGS.length}">`);
    let start = 0;
    LANGS.forEach((lang, i) => {
      const n = di.fontCounts[i] || 0;
      out.push(`<hh:fontface lang="${lang}" fontCnt="${n}">`);
      for (let k = 0; k < n; k++) {
        const face = di.faces[start + k] || { name: '' };
        out.push(`<hh:font id="${k}" face="${xmlEsc(face.name)}" type="TTF" isEmbedded="0"/>`);
      }
      out.push('</hh:fontface>');
      start += n;
    });
    out.push('</hh:fontfaces>');

    /* 테두리/배경 */
    out.push(`<hh:borderFills itemCnt="${di.borderFills.length}">`);
    di.borderFills.forEach((bf, i) => {
      out.push(`<hh:borderFill id="${i + 1}" threeD="0" shadow="0" centerLine="NONE">`);
      for (const side of ['left', 'right', 'top', 'bottom']) {
        const b = bf[side];
        out.push(`<hh:${side}Border type="${b.type}" width="${b.width}" color="${b.color}"/>`);
      }
      if (bf.fill) {
        out.push(`<hc:fillBrush><hc:winBrush faceColor="${bf.fill}" hatchColor="#00000000" alpha="0"/></hc:fillBrush>`);
      }
      out.push('</hh:borderFill>');
    });
    if (!di.borderFills.length) {
      out.push('<hh:borderFill id="1" threeD="0" shadow="0" centerLine="NONE">'
        + '<hh:leftBorder type="SOLID" width="0.12 mm" color="#000000"/>'
        + '<hh:rightBorder type="SOLID" width="0.12 mm" color="#000000"/>'
        + '<hh:topBorder type="SOLID" width="0.12 mm" color="#000000"/>'
        + '<hh:bottomBorder type="SOLID" width="0.12 mm" color="#000000"/>'
        + '</hh:borderFill>');
    }
    out.push('</hh:borderFills>');

    /* 글자 모양 */
    out.push(`<hh:charProperties itemCnt="${di.charShapes.length}">`);
    di.charShapes.forEach((cs, i) => {
      const rel = cs.relSize[0] ? cs.relSize[0] : 100;
      const ratio = cs.width[0] ? cs.width[0] : 100;
      const shade = cs.shade === 0xffffffff || cs.shade == null ? 'none' : colorOf(cs.shade);
      const textColor = cs.textColor === 0xffffffff ? '#000000' : (colorOf(cs.textColor) || '#000000');
      const underlineOn = cs.underline === 1;
      const strikeOn = cs.underline === 2;
      const uColor = colorOf(cs.underlineColor) || '#000000';
      out.push(`<hh:charPr id="${i}" height="${cs.baseSize}" textColor="${textColor}" shadeColor="${shade}"`
        + ' useFontSpace="0" useKerning="0" symMark="NONE">');
      out.push(fontRefXml(di, cs));
      out.push(`<hh:ratio hangul="${ratio}" latin="${ratio}" hanja="${ratio}" japanese="${ratio}" other="${ratio}" symbol="${ratio}" user="${ratio}"/>`);
      out.push(`<hh:spacing hangul="${cs.spacing[0] || 0}" latin="${cs.spacing[1] || 0}" hanja="${cs.spacing[2] || 0}" japanese="${cs.spacing[3] || 0}" other="${cs.spacing[4] || 0}" symbol="${cs.spacing[5] || 0}" user="${cs.spacing[6] || 0}"/>`);
      out.push(`<hh:relSz hangul="${rel}" latin="${cs.relSize[1] || rel}" hanja="${cs.relSize[2] || rel}" japanese="${cs.relSize[3] || rel}" other="${cs.relSize[4] || rel}" symbol="${cs.relSize[5] || rel}" user="${cs.relSize[6] || rel}"/>`);
      out.push(`<hh:offset hangul="${cs.offset[0] || 0}" latin="${cs.offset[1] || 0}" hanja="${cs.offset[2] || 0}" japanese="${cs.offset[3] || 0}" other="${cs.offset[4] || 0}" symbol="${cs.offset[5] || 0}" user="${cs.offset[6] || 0}"/>`);
      out.push(`<hh:underline type="${underlineOn ? 'BOTTOM' : 'NONE'}" shape="SOLID" color="${uColor}"/>`);
      out.push(`<hh:strikeout shape="${strikeOn ? 'SOLID' : 'NONE'}" color="${uColor}"/>`);
      out.push(`<hh:outline type="${cs.outline ? 'NORMAL' : 'NONE'}"/>`);
      out.push(`<hh:shadow type="${cs.shadow ? 'DROP' : 'NONE'}" color="#B2B2B2" offsetX="10" offsetY="10"/>`);
      out.push('</hh:charPr>');
    });
    if (!di.charShapes.length) {
      out.push('<hh:charPr id="0" height="1000" textColor="#000000" shadeColor="none" useFontSpace="0" useKerning="0">'
        + '<hh:fontRef hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>'
        + '<hh:ratio hangul="100"/><hh:spacing hangul="0"/><hh:relSz hangul="100"/><hh:offset hangul="0"/>'
        + '<hh:underline type="NONE"/><hh:strikeout shape="NONE"/></hh:charPr>');
    }
    out.push('</hh:charProperties>');

    /* 탭 (정지점 정보는 쓰지 않고 기본값만 둔다) */
    out.push('<hh:tabProperties itemCnt="1"><hh:tabPr id="0" autoTabLeft="1" autoTabRight="0"/></hh:tabProperties>');

    /* 문단 모양 */
    out.push(`<hh:paraProperties itemCnt="${di.paraShapes.length}">`);
    di.paraShapes.forEach((ps, i) => {
      const align = ALIGN_NAMES[ps.align] || 'JUSTIFY';
      const lineType = ps.lineType === 1 ? 'FIXED'
        : ps.lineType === 3 ? 'AT_LEAST'
          : ps.lineType === 2 ? 'SPACE_ONLY' : 'PERCENT';
      const value = ps.lineSpacing > 0 ? ps.lineSpacing : (lineType === 'PERCENT' ? 160 : 1600);
      out.push(`<hh:paraPr id="${i}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0">`);
      out.push(`<hh:align horizontal="${align}" vertical="BASELINE"/>`);
      out.push('<hh:heading type="NONE" idRef="0" level="0"/>');
      out.push('<hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="BREAK_WORD" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>');
      out.push('<hh:autoSpacing eAsianEng="0" eAsianNum="0"/>');
      out.push('<hh:margin>'
        + `<hc:intent value="${ps.indent || 0}" unit="HWPUNIT"/>`
        + `<hc:left value="${ps.left || 0}" unit="HWPUNIT"/>`
        + `<hc:right value="${ps.right || 0}" unit="HWPUNIT"/>`
        + `<hc:prev value="${ps.prev || 0}" unit="HWPUNIT"/>`
        + `<hc:next value="${ps.next || 0}" unit="HWPUNIT"/>`
        + '</hh:margin>');
      out.push(`<hh:lineSpacing type="${lineType}" value="${value}" unit="HWPUNIT"/>`);
      out.push('<hh:border borderFillIDRef="0" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/>');
      out.push('</hh:paraPr>');
    });
    if (!di.paraShapes.length) {
      out.push('<hh:paraPr id="0" tabPrIDRef="0"><hh:align horizontal="JUSTIFY" vertical="BASELINE"/>'
        + '<hh:margin><hc:intent value="0" unit="HWPUNIT"/><hc:left value="0" unit="HWPUNIT"/>'
        + '<hc:right value="0" unit="HWPUNIT"/><hc:prev value="0" unit="HWPUNIT"/><hc:next value="0" unit="HWPUNIT"/></hh:margin>'
        + '<hh:lineSpacing type="PERCENT" value="160" unit="HWPUNIT"/></hh:paraPr>');
    }
    out.push('</hh:paraProperties>');

    /* 스타일 — 바탕글 하나만 두고 문단은 paraPrIDRef 로 직접 가리킨다 */
    out.push('<hh:styles itemCnt="1">');
    out.push('<hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/>');
    out.push('</hh:styles>');

    out.push('</hh:refList>');
    out.push('</hh:head>');
    return out.join('');
  }

  /* ---------------- BodyText → section XML ---------------- */
  function decodeChars(payload) {
    const out = [];
    if (!payload) return out;
    const r = new Reader(payload);
    while (r.left() >= 2) {
      const code = r.u16();
      if (code === 0x0d) { out.push({ code, units: 1, chid: '' }); break; }
      if (code === 0) { out.push({ code, units: 1, chid: '' }); continue; }
      if (CTRL_CHARS.has(code)) {
        const param = r.bytes(12);
        let chid = '';
        if (code !== 0x09) {
          chid = String.fromCharCode(param[3] || 0, param[2] || 0, param[1] || 0, param[0] || 0);
        } else {
          /* 탭: 앞 4바이트가 폭 */
          const w = (param[0] | (param[1] << 8) | (param[2] << 16) | (param[3] << 24)) >>> 0;
          out.push({ code, units: 8, chid: '', tabWidth: w });
          continue;
        }
        out.push({ code, units: 8, chid });
        continue;
      }
      out.push({ code, units: 1, chid: '' });
    }
    return out;
  }

  function parseCharRanges(rec) {
    if (!rec) return [];
    const r = new Reader(rec.payload);
    const out = [];
    while (r.left() >= 8) out.push({ start: r.u32(), id: r.u32() });
    return out;
  }

  function parseLineSegs(rec) {
    if (!rec) return [];
    const r = new Reader(rec.payload);
    const out = [];
    while (r.left() >= 36) {
      out.push({
        textpos: r.u32(), vertpos: r.i32(), vertsize: r.i32(), textheight: r.i32(),
        baseline: r.i32(), spacing: r.i32(), horzpos: r.i32(), horzsize: r.i32(),
        flags: r.u32(),
      });
    }
    return out;
  }

  /* 문단 하나 → <hp:p> */
  function paragraphXml(pRec, ctx) {
    const di = ctx.di;
    const r = new Reader(pRec.payload);
    const paraId = (() => {
      r.u32(); r.u32();
      return r.u16();
    })();
    r.byte();                                    // style id
    const split = r.byte();
    const pageBreak = (split & 0x04) ? 1 : 0;

    const textRec = pRec.children.find((c) => c.tag === T.PARA_TEXT);
    const rangeRec = pRec.children.find((c) => c.tag === T.PARA_CHAR_SHAPE);
    const segRec = pRec.children.find((c) => c.tag === T.PARA_LINE_SEG);
    const ctrlRecs = pRec.children.filter((c) => c.tag === T.CTRL_HEADER);

    const chars = decodeChars(textRec ? textRec.payload : null);
    const ranges = parseCharRanges(rangeRec);
    const segs = parseLineSegs(segRec);

    /* 컨트롤 기록 → 개체 XML (표·그림·글상자·용지 설정) */
    const ctrlQueue = ctrlRecs.map((rec) => ({ chid: chidOf(rec.payload), rec, used: false }));
    const takeCtrl = (chid) => {
      const found = ctrlQueue.find((c) => !c.used && c.chid === chid);
      if (!found) return null;
      found.used = true;
      return found.rec;
    };

    const atoms = [];
    for (const c of chars) {
      if (c.code === 0x0d) break;
      if (c.code === 0) { atoms.push({ k: 'text', ch: '', units: 1 }); continue; }
      if (c.code === 0x0a) { atoms.push({ k: 'br', units: 1 }); continue; }
      if (c.code === 0x18) { atoms.push({ k: 'hyph', units: 1 }); continue; }
      if (c.code === 0x1e) { atoms.push({ k: 'nbSpace', units: 1 }); continue; }
      if (c.code === 0x1f) { atoms.push({ k: 'fwSpace', units: 1 }); continue; }
      if (c.code === 0x09) { atoms.push({ k: 'tab', units: 8 }); continue; }
      if (CTRL_CHARS.has(c.code)) {
        let xml = '';
        if (c.chid) {
          const rec = takeCtrl(c.chid);
          if (rec) xml = controlXml(c.chid, rec, ctx);
        }
        atoms.push({ k: 'obj', units: 8, xml });
        continue;
      }
      atoms.push({ k: 'text', ch: String.fromCharCode(c.code), units: 1 });
    }
    /* 글자 없이 개체만 있는 문단 등 — 남은 개체를 뒤에 붙인다 */
    for (const c of ctrlQueue) {
      if (c.used) continue;
      const xml = controlXml(c.chid, c.rec, ctx);
      if (xml) { c.used = true; atoms.push({ k: 'obj', units: 1, xml }); }
    }

    /* ---- HWP 글자 위치(컨트롤 = 8글자) ↔ 이 문서의 조각 위치 맞추기 ---- */
    const unit = chooseUnit(atoms, segs, ranges);
    const offsets = [];
    {
      let o = 0;
      for (const a of atoms) { offsets.push(o); o += a.units === 8 ? unit : 1; }
      offsets.push(o);
    }
    const indexOfOffset = (target) => {
      if (target >= offsets[offsets.length - 1]) return atoms.length;
      const i = offsets.indexOf(target);
      return i < 0 ? -1 : i;
    };

    /* ---- 글자 모양 구간 → 조각별 charPr ---- */
    const charIdAt = (off) => {
      let id = ranges.length ? ranges[0].id : 0;
      for (const rg of ranges) {
        if (rg.start <= off) id = rg.id; else break;
      }
      return id;
    };
    const clause = charIdAt(0);
    atoms.forEach((a, i) => {
      a.charId = a.k === 'obj' ? clause : charIdAt(offsets[i]);
    });

    /* ---- <hp:p> 조립 ---- */
    let out = `<hp:p paraPrIDRef="${paraId}" styleIDRef="0" pageBreak="${pageBreak}" columnBreak="0" merged="0">`;
    let runId = null;
    let buf = '';
    const flushText = () => {
      if (buf) { out += '<hp:t>' + xmlEsc(buf) + '</hp:t>'; buf = ''; }
    };
    const openRun = (id) => {
      if (runId === id) return;
      flushText();
      if (runId !== null) out += '</hp:run>';
      out += `<hp:run charPrIDRef="${id}">`;
      runId = id;
    };
    for (const a of atoms) {
      if (a.k === 'text') {
        openRun(a.charId);
        buf += a.ch;
        continue;
      }
      openRun(a.charId);
      flushText();
      if (a.k === 'br') out += '<hp:lineBreak/>';
      else if (a.k === 'tab') out += '<hp:tab/>';
      else if (a.k === 'nbSpace') out += '<hp:nbSpace/>';
      else if (a.k === 'fwSpace') out += '<hp:fwSpace/>';
      else if (a.k === 'hyph') out += '<hp:hyphen/>';
      else if (a.k === 'obj' && a.xml) out += a.xml;
    }
    if (runId === null) out += `<hp:run charPrIDRef="${Math.max(0, ranges.length ? ranges[0].id : 0)}"/>`;
    else { flushText(); out += '</hp:run>'; }

    /* ---- 줄 정보 ---- */
    if (segs.length) {
      const parts = [];
      for (const s of segs) {
        let tp = indexOfOffset(s.textpos);
        if (tp < 0) continue;
        parts.push(`<hp:lineseg textpos="${tp}" vertpos="${Math.max(0, s.vertpos)}"`
          + ` vertsize="${Math.max(1, s.vertsize)}" textheight="${Math.max(1, s.textheight)}"`
          + ` baseline="${s.baseline}" spacing="${s.spacing}"`
          + ` horzpos="${s.horzpos}" horzsize="${Math.max(0, s.horzsize)}" flags="${s.flags}"/>`);
      }
      if (parts.length) out += '<hp:linesegarray>' + parts.join('') + '</hp:linesegarray>';
    }
    out += '</hp:p>';
    return out;
  }

  /* 컨트롤 문자 위치를 8글자로 볼지 1글자로 볼지 — 줄 정보가 정확히 맞는 쪽을 고른다 */
  function chooseUnit(atoms, segs, ranges) {
    const total8 = atoms.reduce((n, a) => n + (a.units === 8 ? 8 : 1), 0);
    const total1 = atoms.length;
    if (total8 === total1) return 8;
    const aligns = (unit) => {
      const offs = new Set();
      let o = 0;
      for (const a of atoms) { offs.add(o); o += a.units === 8 ? unit : 1; }
      offs.add(o);
      for (const s of segs) if (s.textpos > 0 && !offs.has(s.textpos)) return false;
      for (const rg of ranges) if (rg.start > 0 && !offs.has(rg.start)) return false;
      return true;
    };
    if (aligns(8)) return 8;
    if (aligns(1)) return 1;
    return 8;
  }

  function chidOf(payload) {
    if (!payload || payload.length < 4) return '';
    return String.fromCharCode(payload[3], payload[2], payload[1], payload[0]);
  }

  /* 개체 공통 속성 (표·그림·글상자 공통) */
  function commonOf(payload, offset) {
    const r = new Reader(payload, offset);
    const out = { flags: 0, x: 0, y: 0, w: 0, h: 0, margin: [0, 0, 0, 0], inline: true };
    try {
      out.flags = r.u32();
      out.y = r.i32();
      out.x = r.i32();
      out.w = r.u32();
      out.h = r.u32();
      r.skip(4);                               // z order + 예약
      out.margin = [r.u16(), r.u16(), r.u16(), r.u16()];
      out.inline = !!(out.flags & 1);
    } catch (e) { /* 짧은 기록은 기본값 */ }
    return out;
  }

  function controlXml(chid, rec, ctx) {
    try {
      if (chid === 'tbl ') return tableXml(rec, ctx);
      if (chid === 'gso ') return shapeXml(rec, ctx);
      if (chid === 'secd') return secPrXml(rec, ctx);
    } catch (err) {
      /* 한 개체가 깨져도 문서 전체는 계속 그린다 */
      if (global.console) console.warn('HWP 개체를 건너뛰었습니다', chid, err);
    }
    return '';
  }

  function secPrXml(rec, ctx) {
    const pageRec = descendants(rec, T.PAGE_DEF)[0];
    if (!pageRec) return '';
    const g = parsePageDef(pageRec);
    ctx.geom = g;
    return `<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="0" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">`
      + '<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/>'
      + '<hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>'
      + '<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>'
      + '<hp:pagePr landscape="' + (g.landscape ? 'NARROWLY' : 'WIDELY') + '" width="' + g.w + '" height="' + g.h + '" gutterType="LEFT_ONLY">'
      + '<hp:margin header="' + g.header + '" footer="' + g.footer + '" gutter="' + g.gutter + '" left="' + g.left + '" right="' + g.right + '" top="' + g.top + '" bottom="' + g.bottom + '"/>'
      + '</hp:pagePr>'
      + '</hp:secPr>';
  }

  function parsePageDef(rec) {
    const r = new Reader(rec.payload);
    let w = 59528, h = 84188;
    const g = { w, h, left: 8504, right: 8504, top: 5669, bottom: 4252, header: 4252, footer: 4252, gutter: 0, landscape: false };
    try {
      w = r.u32(); h = r.u32();
      g.left = r.u32(); g.right = r.u32(); g.top = r.u32(); g.bottom = r.u32();
      g.header = r.u32(); g.footer = r.u32();
      r.u32();                                 // 제본 여백
      const attr = r.u32();
      g.landscape = !!(attr & 1);
    } catch (e) { /* 기본 A4 */ }
    g.w = w || 59528;
    g.h = h || 84188;
    if (g.landscape && g.w < g.h) { const t = g.w; g.w = g.h; g.h = t; }
    return g;
  }

  /* 문단 리스트 헤더(LIST_HEADER) 하나에 딸린 문단들을 걷는다.
     한글은 리스트 헤더 뒤에 그 문단들을 '같은 레벨의 다음 레코드'로 잇달아 쓴다.
     (헤더 첫 u16 이 문단 수다) 문서에 따라 헤더의 자식으로 넣은 경우도 받아 준다. */
  function collectListItems(children, isHeader, start) {
    const out = [];
    let i = Math.max(0, start || 0);
    while (i < children.length) {
      const rec = children[i];
      if (!isHeader(rec)) { i += 1; continue; }
      let count = 0;
      try { count = new Reader(rec.payload).u16(); } catch (e) { count = 0; }
      const paras = [];
      let j = i + 1;
      while (j < children.length && paras.length < count && children[j].tag === T.PARA_HEADER) {
        paras.push(children[j]);
        j += 1;
      }
      if (!paras.length) {                 // 헤더 안에 자식으로 들어 있는 경우
        for (const c of rec.children) if (c.tag === T.PARA_HEADER) paras.push(c);
      }
      out.push({ header: rec, paras });
      i = j;
    }
    return out;
  }

  /* ---- 표 ---- */
  function tableXml(rec, ctx) {
    const tableRec = rec.children.find((c) => c.tag === T.TABLE);
    if (!tableRec) return '';
    const common = commonOf(rec.payload, 4);
    const r = new Reader(tableRec.payload);
    const flags = r.u32();
    const rows = r.u16();
    const cols = r.u16();
    const cellSpacing = r.u16();
    const pad = [r.u16(), r.u16(), r.u16(), r.u16()];
    r.skip(2 * rows);                          // 행별 셀 수
    let tableBf = 0;
    try { tableBf = r.u16(); } catch (e) { tableBf = 0; }
    const repeatHeader = (flags & 0x04) ? 1 : 0;

    const tableIndex = rec.children.indexOf(tableRec);
    const cells = collectListItems(rec.children, (c) => c.tag === T.LIST_HEADER, tableIndex + 1)
      .map((item) => {
        const cr = new Reader(item.header.payload);
        /* 셀 정보는 문단 리스트 헤더(문단 수 u16, 예약 u16, 속성 u32) 뒤에 이어진다 */
        cr.u16();
        cr.u16();
        cr.u32();
        const cell = {
          col: cr.u16(), row: cr.u16(), colSpan: cr.u16(), rowSpan: cr.u16(),
          w: cr.i32(), h: cr.i32(),
          pad: [cr.u16(), cr.u16(), cr.u16(), cr.u16()],
          bf: 0,
          xml: item.paras.map((p) => paragraphXml(p, ctx)).join(''),
        };
        try { cell.bf = cr.u16(); } catch (e) { cell.bf = 0; }
        return cell;
      });
    if (!cells.length) return '';

    const maxRow = Math.max(rows || 0, ...cells.map((c) => c.row + Math.max(1, c.rowSpan)));
    const maxCol = Math.max(cols || 0, ...cells.map((c) => c.col + Math.max(1, c.colSpan)));
    const byRow = new Map();
    for (const c of cells) {
      if (!byRow.has(c.row)) byRow.set(c.row, []);
      byRow.get(c.row).push(c);
    }

    const bfOut = tableBf > 0 && tableBf <= ctx.di.borderFills.length ? tableBf : 1;
    const out = [];
    out.push(`<hp:tbl id="${ctx.nextId()}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="${repeatHeader}" rowCnt="${maxRow}" colCnt="${maxCol}" cellSpacing="${cellSpacing || 0}" borderFillIDRef="${bfOut}" noAdjust="0">`);
    out.push(`<hp:sz width="${common.w || 0}" widthRelTo="ABSOLUTE" height="${common.h || 0}" heightRelTo="ABSOLUTE" protect="0"/>`);
    out.push('<hp:pos treatAsChar="' + (common.inline ? 1 : 0) + '" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>');
    out.push(`<hp:outMargin left="${common.margin[0] || 0}" right="${common.margin[1] || 0}" top="${common.margin[2] || 0}" bottom="${common.margin[3] || 0}"/>`);
    out.push(`<hp:inMargin left="${pad[0] || 0}" right="${pad[1] || 0}" top="${pad[2] || 0}" bottom="${pad[3] || 0}"/>`);
    for (let row = 0; row < maxRow; row++) {
      const list = (byRow.get(row) || []).slice().sort((a, b) => a.col - b.col);
      if (!list.length) continue;
      out.push('<hp:tr>');
      for (const c of list) {
        const bf = c.bf > 0 && c.bf <= ctx.di.borderFills.length ? c.bf : bfOut;
        out.push(`<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${bf}">`);
        out.push('<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">');
        out.push(c.xml || '<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"/></hp:p>');
        out.push('</hp:subList>');
        out.push(`<hp:cellAddr colAddr="${Math.max(0, c.col)}" rowAddr="${Math.max(0, c.row)}"/>`);
        out.push(`<hp:cellSpan colSpan="${Math.max(1, c.colSpan)}" rowSpan="${Math.max(1, c.rowSpan)}"/>`);
        out.push(`<hp:cellSz width="${Math.max(0, c.w)}" height="${Math.max(0, c.h)}"/>`);
        out.push(`<hp:cellMargin left="${c.pad[0] || 0}" right="${c.pad[1] || 0}" top="${c.pad[2] || 0}" bottom="${c.pad[3] || 0}"/>`);
        out.push('</hp:tc>');
      }
      out.push('</hp:tr>');
    }
    out.push('</hp:tbl>');
    return out.join('');
  }

  /* ---- 그리기 개체(그림·글상자) ---- */
  function shapeXml(rec, ctx) {
    const common = commonOf(rec.payload, 4);
    const sc = rec.children.find((c) => c.tag === T.SHAPE_COMPONENT) || rec;
    const picRec = descendants(sc, T.PICTURE)[0];
    if (picRec) {
      const pr = new Reader(picRec.payload);
      let binId = 0;
      try {
        pr.skip(71);
        binId = pr.u16();
      } catch (e) { binId = 0; }
      if (!binId) return '';
      const w = common.w || 0;
      const h = common.h || 0;
      return `<hp:pic id="${ctx.nextId()}" zOrder="0" numberingType="NONE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="1" instid="0" reverse="0">`
        + '<hp:offset x="0" y="0"/>'
        + `<hp:sz width="${w}" height="${h}" widthRelTo="ABSOLUTE" heightRelTo="ABSOLUTE" protect="0"/>`
        + `<hp:orgSz width="${w}" height="${h}"/>`
        + `<hp:curSz width="${w}" height="${h}"/>`
        + '<hp:flip horizontal="0" vertical="0"/>'
        + '<hp:lineShape color="#000000" width="0" style="SOLID" endCap="ROUND" headStyle="NORMAL" tailStyle="NORMAL" headfill="0" tailfill="0" headSz="SMALL_SMALL" tailSz="SMALL_SMALL" outlineStyle="OUTER" alpha="0"/>'
        + `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${w}" y="0"/><hc:pt2 x="${w}" y="${h}"/><hc:pt3 x="0" y="${h}"/></hp:imgRect>`
        + `<hp:imgClip left="0" right="${w}" top="0" bottom="${h}"/>`
        + '<hp:inMargin left="0" right="0" top="0" bottom="0"/>'
        + `<hp:imgDim dimwidth="${w}" dimheight="${h}"/>`
        + `<hc:img binaryItemIDRef="image${binId}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/>`
        + '<hp:effects/></hp:pic>';
    }
    /* 글상자 */
    const items = collectListItems(sc.children, (c) => c.tag === T.LIST_HEADER, 0);
    const listRec = items.length ? items[0].header : descendants(sc, T.LIST_HEADER)[0];
    if (!listRec) return '';
    const paras = (items.length ? items[0].paras : []).map((p) => paragraphXml(p, ctx)).join('');
    if (!paras) return '';
    return `<hp:rect id="${ctx.nextId()}" zOrder="0" numberingType="NONE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="1">`
      + `<hp:sz width="${common.w || 0}" height="${common.h || 0}" widthRelTo="ABSOLUTE" heightRelTo="ABSOLUTE" protect="0"/>`
      + '<hp:offset x="0" y="0"/>'
      + '<hp:drawText lastWidth="0" name="" editable="0">'
      + '<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">'
      + paras
      + '</hp:subList></hp:drawText></hp:rect>';
  }

  /* ---------------- ZIP(HWPX) 만들기 ---------------- */
  async function toZip(buffer) {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const files = readCfb(u8);
    const fh = files.get('FileHeader');
    if (!fh || fh.length < 40) throw new Error('한글 문서의 머리 정보(FileHeader)를 찾지 못했습니다.');
    const fv = new DataView(fh.buffer, fh.byteOffset, fh.byteLength);
    const props = fv.getUint32(36, true);
    if (props & 0x02) throw new Error('암호가 설정된 문서는 열 수 없습니다. 한글에서 암호를 풀어 저장한 뒤 열어 주세요.');
    if (props & 0x04) throw new Error('배포용(보안) 문서는 열 수 없습니다. 일반 문서로 저장한 뒤 열어 주세요.');
    const compressed = !!(props & 0x01);

    const docInfoRaw = files.get('DocInfo');
    if (!docInfoRaw || !docInfoRaw.length) throw new Error('문서 정보(DocInfo)를 찾지 못했습니다.');
    const docInfo = await inflateRaw(docInfoRaw);
    const di = await parseDocInfo(recordTree(docInfo), compressed);

    /* 본문 구역 */
    const sectionNames = [...files.keys()]
      .filter((n) => /^BodyText\/Section\d+$/i.test(n))
      .sort((a, b) => parseInt(a.replace(/\D+/g, ''), 10) - parseInt(b.replace(/\D+/g, ''), 10));
    if (!sectionNames.length) throw new Error('본문(BodyText)을 찾지 못했습니다.');

    const zip = new JSZip();
    /* HWPX 규격: mimetype 이 패키지의 첫 항목이고 압축하지 않는다 */
    zip.file('mimetype', 'application/hwp+zip', { compression: 'STORE' });
    let idSeq = 0;
    const ctx = { di, geom: null, nextId: () => (++idSeq) };
    const sectionXmls = [];
    for (const name of sectionNames) {
      const raw = await inflateRaw(files.get(name));
      const tree = recordTree(raw);
      ctx.geom = null;
      const paras = tree.children.filter((c) => c.tag === T.PARA_HEADER);
      const body = paras.map((p) => paragraphXml(p, ctx)).join('');
      sectionXmls.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"'
        + ' xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"'
        + ' xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core">'
        + body
        + '</hs:sec>');
    }

    /* 그림 */
    const imageItems = [];
    for (let i = 0; i < di.binData.length; i++) {
      const bin = di.binData[i];
      if (bin.storage === 0) continue;         // 외부 링크 그림은 담을 수 없다
      const idStr = String(i + 1).padStart(4, '0');
      let bytes = null;
      let ext = bin.ext;
      const want = (ext ? `BinData/BIN${idStr}.${ext}` : '').toUpperCase();
      for (const key of files.keys()) {
        if (!/^BinData\//i.test(key)) continue;
        if (want && key.toUpperCase() === want) { bytes = files.get(key); break; }
      }
      if (!bytes) {
        for (const key of files.keys()) {
          if (new RegExp(`^BinData/BIN${idStr}\\.[A-Za-z0-9]+$`, 'i').test(key)) {
            bytes = files.get(key);
            if (!ext) ext = key.split('.').pop().toLowerCase();
            break;
          }
        }
      }
      if (!bytes) continue;
      const shouldInflate = bin.compress === 1 || (bin.compress === 0 && compressed);
      let data = bytes;
      if (shouldInflate) {
        try { data = await inflateRaw(bytes); } catch (e) { data = bytes; }
      }
      const media = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
        bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', wmf: 'image/x-wmf',
        emf: 'image/x-emf', svg: 'image/svg+xml',
      }[String(ext || '').toLowerCase()] || 'application/octet-stream';
      const path = `BinData/image${i + 1}.${ext || 'bin'}`;
      zip.file(path, data, { binary: true });
      imageItems.push({ id: `image${i + 1}`, href: path, media });
    }

    /* 패키지 구성 */
    zip.file('version.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="HWPX"'
      + ' major="5" minor="0" micro="5" buildNumber="0" os="10" xmlVersion="1.4" application="Hancom Office Hangul" appVersion="11, 0, 0, 1"/>');
    zip.file('Contents/header.xml', headerXml(di));
    sectionXmls.forEach((xml, i) => zip.file(`Contents/section${i}.xml`, xml));

    const manifest = [];
    manifest.push('<opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>');
    sectionXmls.forEach((_, i) => manifest.push(`<opf:item id="section${i}" href="Contents/section${i}.xml" media-type="application/xml"/>`));
    imageItems.forEach((im) => manifest.push(`<opf:item id="${im.id}" href="${im.href}" media-type="${im.media}" isEmbeded="1"/>`));
    const spine = ['<opf:itemref idref="header" linear="yes"/>']
      .concat(sectionXmls.map((_, i) => `<opf:itemref idref="section${i}" linear="yes"/>`));
    zip.file('Contents/content.hpf', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<opf:package xmlns:opf="http://www.idpf.org/2007/opf" version="" unique-identifier="" id="">'
      + '<opf:metadata><opf:title>한글 문서</opf:title><opf:language>ko</opf:language></opf:metadata>'
      + `<opf:manifest>${manifest.join('')}</opf:manifest>`
      + `<opf:spine>${spine.join('')}</opf:spine>`
      + '</opf:package>');
    zip.file('META-INF/container.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">'
      + '<ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></ocf:rootfiles>'
      + '</ocf:container>');
    zip.file('META-INF/manifest.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">'
      + '<odf:file-entry odf:full-path="/" odf:media-type="application/hwpml-package+xml"/>'
      + '</odf:manifest>');
    zip.file('settings.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>');
    return zip;
  }

  global.HwpImport = {
    isHwpName: (name) => /\.hwp$/i.test(String(name || '')),
    toZip,
  };
})(typeof window !== 'undefined' ? window : globalThis);
