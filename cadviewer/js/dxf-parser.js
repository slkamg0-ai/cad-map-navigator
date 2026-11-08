/**
 * dxf-parser.js - ASCII DXF 파서
 *
 * 한국 실무 도면(AutoCAD 2000~2018, CP949 인코딩)을 우선 고려한다.
 * 반환 구조:
 *   { header, layers:{name:{...}}, ltypes:{name:{pattern:[]}}, blocks:{name:{...}}, entities:[] }
 */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------- 인코딩 */

  var CODEPAGE_MAP = {
    ANSI_949: 'euc-kr',   // 한국어 (CP949 / 통합 완성형)
    ANSI_1252: 'windows-1252',
    ANSI_1250: 'windows-1250',
    ANSI_1251: 'windows-1251',
    ANSI_1253: 'windows-1253',
    ANSI_1254: 'windows-1254',
    ANSI_874: 'windows-874',
    ANSI_932: 'shift_jis',
    ANSI_936: 'gbk',
    ANSI_950: 'big5',
    UTF8: 'utf-8'
  };

  function latin1(bytes) {
    var s = '';
    var CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)));
    }
    return s;
  }

  function tryDecode(bytes, enc, fatal) {
    try {
      return new TextDecoder(enc, { fatal: !!fatal }).decode(bytes);
    } catch (e) {
      return null;
    }
  }

  /**
   * DXF 바이트열을 문자열로 디코딩한다.
   * AC1021(2007) 이상은 UTF-8 고정, 그 이하는 $DWGCODEPAGE 를 따른다.
   */
  function decodeDXF(buffer) {
    var u8 = new Uint8Array(buffer);

    if (u8.length > 21 && latin1(u8.subarray(0, 18)) === 'AutoCAD Binary DXF') {
      throw new Error('바이너리 DXF는 지원하지 않습니다. CAD에서 "AutoCAD DXF (ASCII)" 형식으로 다시 저장해 주세요.');
    }
    if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
      return new TextDecoder('utf-8').decode(u8.subarray(3));
    }

    var head = latin1(u8.subarray(0, Math.min(u8.length, 1 << 16)));

    var mVer = /\$ACADVER\s*[\r\n]+\s*1\s*[\r\n]+\s*(AC\d+)/.exec(head);
    if (mVer && mVer[1] >= 'AC1021') {
      return tryDecode(u8, 'utf-8') || latin1(u8);
    }

    var mCp = /\$DWGCODEPAGE\s*[\r\n]+\s*3\s*[\r\n]+\s*([^\r\n]+)/.exec(head);
    if (mCp) {
      var enc = CODEPAGE_MAP[mCp[1].trim().toUpperCase()];
      if (enc) {
        var out = tryDecode(u8, enc);
        if (out) return out;
      }
    }

    // 코드페이지 정보가 없으면 UTF-8을 엄격 모드로 시도하고, 실패하면 CP949로 본다.
    return tryDecode(u8, 'utf-8', true) || tryDecode(u8, 'euc-kr') || latin1(u8);
  }

  /* ----------------------------------------------------------- 그룹코드 스캔 */

  // 실수 / 정수로 다뤄야 하는 그룹코드 범위 (DXF 스펙)
  function isFloatCode(c) {
    return (c >= 10 && c <= 59) || (c >= 110 && c <= 149) || (c >= 210 && c <= 239) ||
      (c >= 460 && c <= 469) || (c >= 1010 && c <= 1059);
  }
  function isIntCode(c) {
    return (c >= 60 && c <= 79) || (c >= 90 && c <= 99) || (c >= 170 && c <= 179) ||
      (c >= 270 && c <= 289) || (c >= 370 && c <= 389) || (c >= 400 && c <= 409) ||
      (c >= 420 && c <= 429) || (c >= 440 && c <= 459) || (c >= 1060 && c <= 1071);
  }

  function tokenize(text) {
    var lines = text.split(/\r\n|\r|\n/);
    var n = lines.length >> 1;
    var codes = new Int32Array(n);
    var values = new Array(n);
    var k = 0;
    for (var i = 0; i + 1 < lines.length; i += 2) {
      var c = parseInt(lines[i], 10);
      if (isNaN(c)) continue;              // 손상된 줄은 건너뛴다
      var raw = lines[i + 1];
      codes[k] = c;
      values[k] = isFloatCode(c) ? parseFloat(raw) : (isIntCode(c) ? parseInt(raw, 10) : raw.trim());
      k++;
    }
    return { codes: codes, values: values, length: k };
  }

  /* -------------------------------------------------------------- 엔티티 객체 */

  // 같은 그룹코드가 문맥에 따라 다른 뜻을 갖는 타입들. 등장 순서를 잃으면 해석할 수
  // 없으므로(HATCH: 10 = 정점 또는 원호 중심, MULTILEADER: 10 = 지시선 정점 또는
  // 꺾임점) 이 타입만 순서를 함께 보관한다.
  var ORDERED = { HATCH: 1, MULTILEADER: 1 };

  function makeEntity(type) {
    var e = { type: type, c: Object.create(null) };  // c: code -> 값 또는 값 배열
    if (ORDERED[type]) e.seq = [];                   // [code, value, code, value, ...]
    return e;
  }
  function put(ent, code, value) {
    if (ent.seq) { ent.seq.push(code, value); }
    var c = ent.c;
    if (code in c) {
      var cur = c[code];
      if (Array.isArray(cur)) cur.push(value);
      else c[code] = [cur, value];
    } else {
      c[code] = value;
    }
  }
  // 단일 값 조회
  function g(ent, code, dflt) {
    var v = ent.c[code];
    if (v === undefined) return dflt;
    return Array.isArray(v) ? v[0] : v;
  }
  // 배열 조회 (항상 배열)
  function ga(ent, code) {
    var v = ent.c[code];
    if (v === undefined) return [];
    return Array.isArray(v) ? v : [v];
  }

  /* ------------------------------------------------------------------ 파싱 */

  function parse(text, onProgress) {
    var tok = tokenize(text);
    var codes = tok.codes, values = tok.values, N = tok.length;

    var doc = {
      header: Object.create(null),
      layers: Object.create(null),
      ltypes: Object.create(null),
      styles: Object.create(null),
      blocks: Object.create(null),
      entities: []
    };

    var i = 0;
    while (i < N) {
      if (codes[i] === 0 && values[i] === 'SECTION') {
        i++;
        var name = codes[i] === 2 ? values[i] : '';
        i++;
        if (name === 'HEADER') i = parseHeader(doc, codes, values, N, i);
        else if (name === 'TABLES') i = parseTables(doc, codes, values, N, i);
        else if (name === 'BLOCKS') i = parseBlocks(doc, codes, values, N, i);
        else if (name === 'ENTITIES') i = parseEntities(doc.entities, codes, values, N, i);
        else i = skipSection(codes, values, N, i);
        if (onProgress) onProgress(i / N);
      } else if (codes[i] === 0 && values[i] === 'EOF') {
        break;
      } else {
        i++;
      }
    }
    return doc;
  }

  function skipSection(codes, values, N, i) {
    while (i < N && !(codes[i] === 0 && values[i] === 'ENDSEC')) i++;
    return i + 1;
  }

  function parseHeader(doc, codes, values, N, i) {
    var key = null;
    while (i < N && !(codes[i] === 0 && values[i] === 'ENDSEC')) {
      if (codes[i] === 9) {
        key = values[i];
        doc.header[key] = [];
      } else if (key) {
        doc.header[key].push(values[i]);
      }
      i++;
    }
    return i + 1;
  }

  function parseTables(doc, codes, values, N, i) {
    var current = null;   // 현재 테이블 종류
    var ent = null;

    function flush() {
      if (!ent) return;
      if (current === 'LAYER') {
        var name = g(ent, 2, '0');
        var flags = g(ent, 70, 0);
        var rawColor = g(ent, 62, 7);
        doc.layers[name] = {
          name: name,
          color: Math.abs(rawColor) || 7,
          trueColor: ent.c[420] !== undefined ? g(ent, 420) : null,
          on: rawColor >= 0,                       // 음수 = 레이어 꺼짐
          frozen: !!(flags & 1),
          locked: !!(flags & 4),
          ltype: g(ent, 6, 'CONTINUOUS'),
          lineweight: g(ent, 370, -3)
        };
      } else if (current === 'LTYPE') {
        var lname = g(ent, 2, 'CONTINUOUS');
        var dashes = ga(ent, 49).filter(function (v) { return typeof v === 'number' && !isNaN(v); });
        doc.ltypes[lname] = { name: lname, pattern: dashes };
      } else if (current === 'STYLE') {
        var sname = g(ent, 2, 'STANDARD');
        doc.styles[sname] = { name: sname, font: g(ent, 3, ''), widthFactor: g(ent, 41, 1), oblique: g(ent, 50, 0) };
      }
      ent = null;
    }

    while (i < N && !(codes[i] === 0 && values[i] === 'ENDSEC')) {
      if (codes[i] === 0) {
        var v = values[i];
        if (v === 'TABLE') {
          flush();
          current = (codes[i + 1] === 2) ? values[i + 1] : null;
        } else if (v === 'ENDTAB') {
          flush();
          current = null;
        } else {
          flush();
          ent = makeEntity(v);
        }
      } else if (ent) {
        put(ent, codes[i], values[i]);
      }
      i++;
    }
    flush();
    return i + 1;
  }

  function parseBlocks(doc, codes, values, N, i) {
    while (i < N && !(codes[i] === 0 && values[i] === 'ENDSEC')) {
      if (codes[i] === 0 && values[i] === 'BLOCK') {
        var head = makeEntity('BLOCK');
        i++;
        while (i < N && codes[i] !== 0) { put(head, codes[i], values[i]); i++; }
        var name = g(head, 2, g(head, 3, ''));
        var block = {
          name: name,
          base: [g(head, 10, 0), g(head, 20, 0), g(head, 30, 0)],
          flags: g(head, 70, 0),
          entities: []
        };
        i = parseEntities(block.entities, codes, values, N, i, 'ENDBLK');
        doc.blocks[name] = block;
      } else {
        i++;
      }
    }
    return i + 1;
  }

  var SEQ_OWNERS = { POLYLINE: 1, INSERT: 1 };

  /**
   * ENTITIES 를 읽어 out 에 담는다. stopAt / ENDSEC / EOF 에서 멈춘다.
   * VERTEX·ATTRIB 는 직전 POLYLINE·INSERT 의 children 으로 붙는다.
   */
  function parseEntities(out, codes, values, N, i, stopAt) {
    var ent = null;
    var owner = null;

    function flush() {
      if (!ent) return;
      if (owner && (ent.type === 'VERTEX' || ent.type === 'ATTRIB')) {
        (owner.children || (owner.children = [])).push(ent);
      } else if (ent.type === 'SEQEND') {
        owner = null;
      } else {
        out.push(ent);
        owner = SEQ_OWNERS[ent.type] ? ent : null;
      }
      ent = null;
    }

    while (i < N) {
      if (codes[i] === 0) {
        var v = values[i];
        if (v === 'ENDSEC' || v === 'EOF' || (stopAt && v === stopAt)) {
          flush();
          return i + 1;
        }
        flush();
        ent = makeEntity(v);
      } else if (ent) {
        put(ent, codes[i], values[i]);
      }
      i++;
    }
    flush();
    return i;
  }

  global.DXF = { parse: parse, decodeDXF: decodeDXF, g: g, ga: ga };
})(window);
