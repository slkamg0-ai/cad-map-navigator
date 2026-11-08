/**
 * geometry.js - DXF 엔티티를 화면에 그릴 수 있는 평면 표시목록(display list)으로 변환한다.
 *
 * 블록(INSERT)은 재귀적으로 펼치고, 원호/타원/스플라인/벌지는 폴리라인으로 근사한다.
 * 원과 원호는 변환이 등각(conformal, 회전+균일축척)인 경우 원본 형태를 유지해
 * 확대해도 매끄럽게 보이도록 한다.
 */
(function (global) {
  'use strict';

  var g = global.DXF.g, ga = global.DXF.ga;

  /* ------------------------------------------------------------ ACI 팔레트 */

  // AutoCAD Color Index 0~255 를 RGB 로 생성한다.
  // 10~249 는 24개 색상(15도 간격) x 5단계 명도 x 2단계 채도의 규칙적 배열이다.
  var ACI = (function () {
    var t = new Array(256);
    var FIXED = [
      [0, 0, 0], [255, 0, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255],
      [0, 0, 255], [255, 0, 255], [255, 255, 255], [128, 128, 128], [192, 192, 192]
    ];
    for (var i = 0; i < 10; i++) t[i] = FIXED[i];

    function hue(deg) {              // s=1, v=1 인 HSV -> RGB (DXF 팔레트는 내림 처리)
      var h = (deg % 360) / 60, x = 255 * (1 - Math.abs((h % 2) - 1));
      var s = h < 1 ? [255, x, 0] : h < 2 ? [x, 255, 0] : h < 3 ? [0, 255, x] :
        h < 4 ? [0, x, 255] : h < 5 ? [x, 0, 255] : [255, 0, x];
      return [Math.floor(s[0]), Math.floor(s[1]), Math.floor(s[2])];
    }
    var LEVELS = [255, 255, 165, 165, 127, 127, 76, 76, 38, 38];
    for (var k = 0; k < 24; k++) {
      var pure = hue(k * 15);
      var half = [Math.floor((pure[0] + 255) / 2), Math.floor((pure[1] + 255) / 2), Math.floor((pure[2] + 255) / 2)];
      for (var j = 0; j < 10; j++) {
        var base = (j % 2) ? half : pure;
        var f = LEVELS[j] / 255;
        t[10 + k * 10 + j] = [Math.round(base[0] * f), Math.round(base[1] * f), Math.round(base[2] * f)];
      }
    }
    var GRAY = [0x33, 0x5b, 0x83, 0xab, 0xd3, 0xff];
    for (var m = 0; m < 6; m++) t[250 + m] = [GRAY[m], GRAY[m], GRAY[m]];
    return t;
  })();

  function aciToRGB(idx) {
    var c = ACI[(idx | 0) & 255] || ACI[7];
    return (c[0] << 16) | (c[1] << 8) | c[2];
  }

  /* ---------------------------------------------------------------- 행렬 */

  // [x' y'] = [a c e; b d f] * [x y 1]
  function mIdent() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; }
  function mMul(m, n) {   // m 다음 n 이 아니라, n 을 적용한 뒤 m 을 적용
    return {
      a: m.a * n.a + m.c * n.b,
      b: m.b * n.a + m.d * n.b,
      c: m.a * n.c + m.c * n.d,
      d: m.b * n.c + m.d * n.d,
      e: m.a * n.e + m.c * n.f + m.e,
      f: m.b * n.e + m.d * n.f + m.f
    };
  }
  function mDet(m) { return m.a * m.d - m.b * m.c; }
  function mConformal(m) {
    var s1 = m.a * m.a + m.b * m.b, s2 = m.c * m.c + m.d * m.d;
    return Math.abs(s1 - s2) < 1e-9 * (s1 + s2 + 1) && Math.abs(m.a * m.c + m.b * m.d) < 1e-9 * (s1 + s2 + 1);
  }
  function mScale(m) { return Math.sqrt(Math.abs(mDet(m))) || 1; }
  function mRot(m) { return Math.atan2(m.b, m.a); }

  /* ---------------------------------------------------------- 곡선 근사 */

  var ARC_SEGS = 96;           // 원 한 바퀴 기준 분할 수

  function arcPoints(cx, cy, r, a0, a1, out) {
    var sweep = a1 - a0;
    while (sweep <= 0) sweep += Math.PI * 2;
    var n = Math.max(2, Math.min(512, Math.ceil(Math.abs(sweep) / (Math.PI * 2) * ARC_SEGS)));
    for (var i = 0; i <= n; i++) {
      var t = a0 + sweep * (i / n);
      out.push(cx + r * Math.cos(t), cy + r * Math.sin(t));
    }
  }

  // 벌지(bulge)가 있는 폴리라인 구간을 원호로 펼친다.
  function bulgeArc(x0, y0, x1, y1, bulge, out) {
    var theta = 4 * Math.atan(bulge);
    var dx = x1 - x0, dy = y1 - y0;
    var chord = Math.hypot(dx, dy);
    if (chord < 1e-12 || Math.abs(bulge) < 1e-12) { out.push(x1, y1); return; }
    var r = chord / (2 * Math.sin(Math.abs(theta) / 2));
    var mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    var h = Math.sqrt(Math.max(0, r * r - (chord / 2) * (chord / 2)));
    var sign = (Math.abs(theta) > Math.PI ? -1 : 1) * (theta > 0 ? 1 : -1);
    var cx = mx - sign * h * (dy / chord);
    var cy = my + sign * h * (dx / chord);
    var a0 = Math.atan2(y0 - cy, x0 - cx);
    var a1 = Math.atan2(y1 - cy, x1 - cx);
    var n = Math.max(2, Math.min(512, Math.ceil(Math.abs(theta) / (Math.PI * 2) * ARC_SEGS)));
    var d = a1 - a0;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    if (theta > 0 && d < 0) d += Math.PI * 2;
    if (theta < 0 && d > 0) d -= Math.PI * 2;
    for (var i = 1; i <= n; i++) {
      var t = a0 + d * (i / n);
      out.push(cx + r * Math.cos(t), cy + r * Math.sin(t));
    }
  }

  function ellipsePoints(cx, cy, majX, majY, ratio, p0, p1, out) {
    var rx = Math.hypot(majX, majY);
    var ry = rx * ratio;
    var rot = Math.atan2(majY, majX);
    var sweep = p1 - p0;
    while (sweep <= 1e-12) sweep += Math.PI * 2;
    var n = Math.max(4, Math.min(512, Math.ceil(sweep / (Math.PI * 2) * ARC_SEGS * 1.5)));
    var cr = Math.cos(rot), sr = Math.sin(rot);
    for (var i = 0; i <= n; i++) {
      var t = p0 + sweep * (i / n);
      var x = rx * Math.cos(t), y = ry * Math.sin(t);
      out.push(cx + x * cr - y * sr, cy + x * sr + y * cr);
    }
  }

  // 균일하지 않은 노트 벡터를 지원하는 B-스플라인(de Boor) 평가
  function splinePoints(ctrl, knots, degree, weights, out) {
    var n = ctrl.length / 2;
    if (n < 2) return;
    if (degree < 1) degree = 3;
    if (n <= degree) degree = n - 1;
    if (!knots || knots.length !== n + degree + 1) {
      knots = [];
      for (var i = 0; i < n + degree + 1; i++) {
        knots.push(i < degree + 1 ? 0 : i > n - 1 ? n - degree : i - degree);
      }
    }
    var t0 = knots[degree], t1 = knots[n];
    var steps = Math.max(16, Math.min(1024, n * 12));
    for (var s = 0; s <= steps; s++) {
      var t = t0 + (t1 - t0) * (s / steps);
      if (s === steps) t = t1 - 1e-12;
      // 구간 찾기
      var k = degree;
      while (k < n - 1 && knots[k + 1] <= t) k++;
      var dx = [], dy = [], dw = [];
      for (var j = 0; j <= degree; j++) {
        var idx = k - degree + j;
        var w = weights ? (weights[idx] || 1) : 1;
        dx.push(ctrl[idx * 2] * w);
        dy.push(ctrl[idx * 2 + 1] * w);
        dw.push(w);
      }
      for (var r = 1; r <= degree; r++) {
        for (var jj = degree; jj >= r; jj--) {
          var i2 = k - degree + jj;
          var den = knots[i2 + degree - r + 1] - knots[i2];
          var alpha = den === 0 ? 0 : (t - knots[i2]) / den;
          dx[jj] = (1 - alpha) * dx[jj - 1] + alpha * dx[jj];
          dy[jj] = (1 - alpha) * dy[jj - 1] + alpha * dy[jj];
          dw[jj] = (1 - alpha) * dw[jj - 1] + alpha * dw[jj];
        }
      }
      var ww = dw[degree] || 1;
      out.push(dx[degree] / ww, dy[degree] / ww);
    }
  }

  /* -------------------------------------------------------------- 텍스트 */

  function decodeSpecial(s) {
    if (typeof s !== 'string') return '';
    return s
      .replace(/\\U\+([0-9A-Fa-f]{4})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
      .replace(/%%[dD]/g, '°')
      .replace(/%%[cC]/g, '⌀')
      .replace(/%%[pP]/g, '±')
      .replace(/%%%/g, '%')
      .replace(/%%[0-9]{3}/g, '');
  }

  // MTEXT 서식코드를 제거하고 순수 텍스트만 남긴다.
  function stripMText(s) {
    if (typeof s !== 'string') return '';
    var out = s;
    out = out.replace(/\\[fF][^;]*;/g, '');             // 글꼴
    // 높이/폭/기울기/자간/정렬/색/문단속성(\pxqc; \pxsm1.5; 등)
    out = out.replace(/\\[HhWwQqTtAaCcp][^;\\]*;/g, '');
    out = out.replace(/\\[Ss]([^;]*);/g, function (_, x) { // 분수/누승
      return x.replace(/[#^\\\/]/g, '/');
    });
    out = out.replace(/\\[PX]/g, '\n');
    out = out.replace(/\\~/g, ' ');
    out = out.replace(/[{}]/g, '');
    out = out.replace(/\\[LlOoKkNn]/g, '');
    out = out.replace(/\\\\/g, '\\');
    return decodeSpecial(out);
  }

  /* ---------------------------------------------------- 표시목록 빌더 */

  function Builder(doc, opts) {
    this.doc = doc;
    this.opts = opts || {};
    this.items = [];
    this.minX = Infinity; this.minY = Infinity;
    this.maxX = -Infinity; this.maxY = -Infinity;
    this.skipped = Object.create(null);
    this.layerSet = Object.create(null);
  }

  Builder.prototype.grow = function (x, y) {
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
  };

  // 엔티티의 색을 (ACI, trueColor) 로 해석한다. ctx 는 상위 INSERT 의 색.
  Builder.prototype.resolveColor = function (ent, ctx) {
    var tc = g(ent, 420, null);
    if (tc !== null && tc !== undefined && !isNaN(tc)) return { rgb: tc & 0xffffff, aci: null };
    var ci = g(ent, 62, 256);
    if (ci === 0) return ctx && ctx.color ? ctx.color : { rgb: null, aci: 7 };   // ByBlock
    if (ci === 256) return { rgb: null, aci: null };                            // ByLayer
    return { rgb: null, aci: ci };
  };

  Builder.prototype.baseAttrs = function (ent, ctx) {
    var layer = g(ent, 8, ctx && ctx.layer ? ctx.layer : '0');
    this.layerSet[layer] = 1;
    var col = this.resolveColor(ent, ctx);
    var lw = g(ent, 370, undefined);
    return {
      layer: layer,
      aci: col.aci,
      rgb: col.rgb,
      lw: (lw === undefined || lw === null) ? null : lw,
      lt: g(ent, 6, null)
    };
  };

  Builder.prototype.addPoly = function (attrs, pts, closed, fill) {
    if (pts.length < 4 && !fill) {
      if (pts.length < 2) return;
    }
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < pts.length; i += 2) {
      var x = pts[i], y = pts[i + 1];
      if (!isFinite(x) || !isFinite(y)) continue;
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    if (!isFinite(minX)) return;
    this.grow(minX, minY); this.grow(maxX, maxY);
    this.items.push({
      kind: 'poly', pts: Float64Array.from(pts), closed: !!closed, fill: !!fill,
      layer: attrs.layer, aci: attrs.aci, rgb: attrs.rgb, lw: attrs.lw, lt: attrs.lt,
      bbox: [minX, minY, maxX, maxY]
    });
  };

  Builder.prototype.addArc = function (attrs, cx, cy, r, a0, a1) {
    if (!(r > 0) || !isFinite(cx) || !isFinite(cy)) return;
    this.grow(cx - r, cy - r); this.grow(cx + r, cy + r);
    this.items.push({
      kind: 'arc', cx: cx, cy: cy, r: r, a0: a0, a1: a1,
      layer: attrs.layer, aci: attrs.aci, rgb: attrs.rgb, lw: attrs.lw, lt: attrs.lt,
      bbox: [cx - r, cy - r, cx + r, cy + r]
    });
  };

  Builder.prototype.addText = function (attrs, o) {
    if (!o.str) return;
    // 실제 글꼴 폭을 모르므로 근사한다. 도면 범위 계산에 쓰이므로 과하게 잡지 않는다.
    var lines = o.str.split('\n');
    var maxLen = 0;
    for (var li = 0; li < lines.length; li++) maxLen = Math.max(maxLen, lines[li].length);
    var w = maxLen * o.h * 0.62 * (o.wf || 1);
    var th = lines.length * o.h * 1.3;
    var x0 = o.hAlign === 1 ? o.x - w / 2 : o.hAlign === 2 ? o.x - w : o.x;
    var y0 = o.vAlign === 3 ? o.y - th : o.vAlign === 2 ? o.y - th / 2 : o.y;
    var bbox = [x0, y0, x0 + w, y0 + th];
    this.grow(bbox[0], bbox[1]); this.grow(bbox[2], bbox[3]);
    this.items.push({
      kind: 'text', x: o.x, y: o.y, h: o.h, rot: o.rot || 0, str: o.str,
      hAlign: o.hAlign || 0, vAlign: o.vAlign || 0, wf: o.wf || 1,
      layer: attrs.layer, aci: attrs.aci, rgb: attrs.rgb, bbox: bbox
    });
  };

  Builder.prototype.addPoint = function (attrs, x, y) {
    if (!isFinite(x) || !isFinite(y)) return;
    this.grow(x, y);
    this.items.push({
      kind: 'point', x: x, y: y,
      layer: attrs.layer, aci: attrs.aci, rgb: attrs.rgb, bbox: [x, y, x, y]
    });
  };

  function tx(m, x, y, out) { out[0] = m.a * x + m.c * y + m.e; out[1] = m.b * x + m.d * y + m.f; }

  function mapPts(m, src) {
    var dst = new Array(src.length);
    for (var i = 0; i < src.length; i += 2) {
      var x = src[i], y = src[i + 1];
      dst[i] = m.a * x + m.c * y + m.e;
      dst[i + 1] = m.b * x + m.d * y + m.f;
    }
    return dst;
  }

  /* ------------------------------------------------------- 엔티티 처리 */

  Builder.prototype.entity = function (ent, m, ctx, depth) {
    var t = ent.type;
    var attrs = this.baseAttrs(ent, ctx);
    var p = [0, 0], q = [0, 0];
    var i, n;

    switch (t) {
      case 'LINE': {
        tx(m, g(ent, 10, 0), g(ent, 20, 0), p);
        tx(m, g(ent, 11, 0), g(ent, 21, 0), q);
        this.addPoly(attrs, [p[0], p[1], q[0], q[1]], false);
        break;
      }
      case 'LWPOLYLINE': {
        var xs = ga(ent, 10), ys = ga(ent, 20), bl = ent.c[42];
        var bulges = bl === undefined ? [] : (Array.isArray(bl) ? bl : [bl]);
        // 벌지는 정점마다 나오는 게 아니므로 등장 순서를 정점 순서와 맞추기 어렵다.
        // 실무 파일 대부분은 벌지가 있는 정점이 소수이므로, 벌지 개수가 정점 수와
        // 같을 때만 정점별로 대응시키고 그 외에는 직선으로 처리한다.
        var useBulge = bulges.length === xs.length;
        var closedFlag = (g(ent, 70, 0) & 1) === 1;
        var raw = [];
        for (i = 0; i < xs.length; i++) {
          if (i === 0) { raw.push(xs[0], ys[0]); continue; }
          var b = useBulge ? bulges[i - 1] : 0;
          if (b) bulgeArc(xs[i - 1], ys[i - 1], xs[i], ys[i], b, raw);
          else raw.push(xs[i], ys[i]);
        }
        if (closedFlag && xs.length > 1) {
          var bl2 = useBulge ? bulges[xs.length - 1] : 0;
          if (bl2) bulgeArc(xs[xs.length - 1], ys[ys.length - 1], xs[0], ys[0], bl2, raw);
        }
        this.addPoly(attrs, mapPts(m, raw), closedFlag);
        break;
      }
      case 'POLYLINE': {
        var flags = g(ent, 70, 0);
        var kids = (ent.children || []).filter(function (c) { return c.type === 'VERTEX'; });
        if (flags & 16 || flags & 64) {          // 폴리곤/폴리페이스 메시: 정점만 잇는다
          var mesh = [];
          for (i = 0; i < kids.length; i++) mesh.push(g(kids[i], 10, 0), g(kids[i], 20, 0));
          this.addPoly(attrs, mapPts(m, mesh), false);
          break;
        }
        var pl = [];
        for (i = 0; i < kids.length; i++) {
          var vx = g(kids[i], 10, 0), vy = g(kids[i], 20, 0);
          if (i === 0) { pl.push(vx, vy); continue; }
          var pb = g(kids[i - 1], 42, 0);
          if (pb) bulgeArc(g(kids[i - 1], 10, 0), g(kids[i - 1], 20, 0), vx, vy, pb, pl);
          else pl.push(vx, vy);
        }
        if ((flags & 1) && kids.length > 1) {
          var lb = g(kids[kids.length - 1], 42, 0);
          if (lb) bulgeArc(g(kids[kids.length - 1], 10, 0), g(kids[kids.length - 1], 20, 0),
            g(kids[0], 10, 0), g(kids[0], 20, 0), lb, pl);
        }
        this.addPoly(attrs, mapPts(m, pl), (flags & 1) === 1);
        break;
      }
      case 'CIRCLE':
      case 'ARC': {
        var cx = g(ent, 10, 0), cy = g(ent, 20, 0), r = g(ent, 40, 0);
        var a0 = t === 'ARC' ? g(ent, 50, 0) * Math.PI / 180 : 0;
        var a1 = t === 'ARC' ? g(ent, 51, 360) * Math.PI / 180 : Math.PI * 2;
        if (mConformal(m) && mDet(m) > 0) {
          tx(m, cx, cy, p);
          var rot = mRot(m);
          this.addArc(attrs, p[0], p[1], r * mScale(m), a0 + rot, a1 + rot);
        } else {
          var ap = [];
          arcPoints(cx, cy, r, a0, a1, ap);
          this.addPoly(attrs, mapPts(m, ap), t === 'CIRCLE');
        }
        break;
      }
      case 'ELLIPSE': {
        var ep = [];
        ellipsePoints(g(ent, 10, 0), g(ent, 20, 0), g(ent, 11, 1), g(ent, 21, 0),
          g(ent, 40, 1), g(ent, 41, 0), g(ent, 42, Math.PI * 2), ep);
        this.addPoly(attrs, mapPts(m, ep), false);
        break;
      }
      case 'SPLINE': {
        var cxs = ga(ent, 10), cys = ga(ent, 20);
        var ctrl = [];
        for (i = 0; i < cxs.length; i++) ctrl.push(cxs[i], cys[i]);
        var sp = [];
        if (ctrl.length >= 4) {
          splinePoints(ctrl, ga(ent, 40), g(ent, 71, 3), ga(ent, 41), sp);
        } else {
          var fx = ga(ent, 11), fy = ga(ent, 21);
          for (i = 0; i < fx.length; i++) sp.push(fx[i], fy[i]);
        }
        if (sp.length >= 4) this.addPoly(attrs, mapPts(m, sp), (g(ent, 70, 0) & 1) === 1);
        break;
      }
      case 'POINT': {
        tx(m, g(ent, 10, 0), g(ent, 20, 0), p);
        this.addPoint(attrs, p[0], p[1]);
        break;
      }
      case 'SOLID':
      case 'TRACE':
      case '3DFACE': {
        var sx = [g(ent, 10, 0), g(ent, 11, 0), g(ent, 13, g(ent, 12, 0)), g(ent, 12, 0)];
        var sy = [g(ent, 20, 0), g(ent, 21, 0), g(ent, 23, g(ent, 22, 0)), g(ent, 22, 0)];
        var quad = [];
        for (i = 0; i < 4; i++) quad.push(sx[i], sy[i]);
        this.addPoly(attrs, mapPts(m, quad), true, t !== '3DFACE');
        break;
      }
      case 'TEXT':
      case 'ATTRIB': {
        var h = g(ent, 40, 1);
        var hA = g(ent, 72, 0), vA = g(ent, 73, 0);
        var useAlign = (hA !== 0 || vA !== 0) && ent.c[11] !== undefined;
        tx(m, useAlign ? g(ent, 11, 0) : g(ent, 10, 0), useAlign ? g(ent, 21, 0) : g(ent, 20, 0), p);
        this.addText(attrs, {
          x: p[0], y: p[1], h: h * mScale(m), rot: g(ent, 50, 0) * Math.PI / 180 + mRot(m),
          str: decodeSpecial(g(ent, 1, '')), hAlign: hA, vAlign: vA, wf: g(ent, 41, 1)
        });
        break;
      }
      case 'MTEXT': {
        var att = g(ent, 71, 1);     // 1..9 : 좌상 ~ 우하
        tx(m, g(ent, 10, 0), g(ent, 20, 0), p);
        var dirX = g(ent, 11, null);
        var rotM = dirX !== null ? Math.atan2(g(ent, 21, 0), dirX) : g(ent, 50, 0) * Math.PI / 180;
        var parts = ga(ent, 3).join('') + (g(ent, 1, '') || '');
        this.addText(attrs, {
          x: p[0], y: p[1], h: g(ent, 40, 1) * mScale(m), rot: rotM + mRot(m),
          str: stripMText(parts),
          hAlign: (att - 1) % 3,                              // 0 좌 · 1 중 · 2 우
          vAlign: [3, 2, 1][Math.floor((att - 1) / 3)] || 3,  // 3 상 · 2 중 · 1 하
          wf: 1
        });
        break;
      }
      case 'INSERT': {
        if (depth > 12) break;
        var bname = g(ent, 2, '');
        var blk = this.doc.blocks[bname];
        if (!blk) { this.skipped['BLOCK:' + bname] = (this.skipped['BLOCK:' + bname] || 0) + 1; break; }
        var sxs = g(ent, 41, 1) || 1, sys = g(ent, 42, 1) || 1;
        var rr = g(ent, 50, 0) * Math.PI / 180;
        var cols = Math.max(1, g(ent, 70, 1) || 1), rows = Math.max(1, g(ent, 71, 1) || 1);
        var cs = g(ent, 44, 0), rs = g(ent, 45, 0);
        var ix = g(ent, 10, 0), iy = g(ent, 20, 0);
        var childCtx = {
          layer: attrs.layer,
          color: { rgb: attrs.rgb, aci: attrs.aci === null ? 7 : attrs.aci }
        };
        for (var cc = 0; cc < cols; cc++) {
          for (var rw = 0; rw < rows; rw++) {
            var cosr = Math.cos(rr), sinr = Math.sin(rr);
            var local = {
              a: cosr * sxs, b: sinr * sxs, c: -sinr * sys, d: cosr * sys,
              e: ix + cc * cs, f: iy + rw * rs
            };
            // 블록 기준점 이동
            local.e += -(local.a * blk.base[0] + local.c * blk.base[1]);
            local.f += -(local.b * blk.base[0] + local.d * blk.base[1]);
            var mm = mMul(m, local);
            for (var bi = 0; bi < blk.entities.length; bi++) {
              this.entity(blk.entities[bi], mm, childCtx, depth + 1);
            }
          }
        }
        var atts = (ent.children || []).filter(function (c) { return c.type === 'ATTRIB'; });
        for (i = 0; i < atts.length; i++) this.entity(atts[i], m, ctx, depth + 1);
        break;
      }
      case 'DIMENSION': {
        if (depth > 12) break;
        var dblk = this.doc.blocks[g(ent, 2, '')];
        if (dblk) {
          var dm = mMul(m, { a: 1, b: 0, c: 0, d: 1, e: -dblk.base[0], f: -dblk.base[1] });
          for (var di = 0; di < dblk.entities.length; di++) this.entity(dblk.entities[di], dm, ctx, depth + 1);
        }
        break;
      }
      case 'LEADER':
      case 'MLINE': {
        var lx = ga(ent, 10), ly = ga(ent, 20);
        var lp = [];
        for (i = 0; i < lx.length; i++) lp.push(lx[i], ly[i]);
        if (lp.length >= 4) this.addPoly(attrs, mapPts(m, lp), false);
        break;
      }
      case 'MULTILEADER': {
        this.multileader(ent, m, attrs);
        break;
      }
      case 'HATCH': {
        this.hatch(ent, m, attrs);
        break;
      }
      case 'VIEWPORT':
      case 'SEQEND':
      case 'ATTDEF':
        break;
      default:
        this.skipped[t] = (this.skipped[t] || 0) + 1;
    }
  };

  /**
   * MULTILEADER(다중 지시선) - 지시선 + 꺾임선 + 문자.
   *
   * 형상은 CONTEXT_DATA 안에 중첩되어 있고, 코드 10/20 이 지시선 정점인지 꺾임점인지는
   * 어느 블록 안인지로만 구분된다. 그래서 등장 순서(ent.seq)를 따라 상태를 추적한다.
   *   300 CONTEXT_DATA{ … 302 LEADER{ … 304 LEADER_LINE{ … 305 } … 303 } … 301 }
   */
  Builder.prototype.multileader = function (ent, m, attrs) {
    var seq = ent.seq;
    if (!seq || !seq.length) return;

    var CONTEXT = 0, LEADER = 1, LINE = 2;
    var where = CONTEXT;
    var lines = [], cur = null, landing = null;
    var text = '', height = 0, at = null;

    for (var s = 0; s + 1 < seq.length; s += 2) {
      var c = seq[s], v = seq[s + 1];

      if (c === 302 && v === 'LEADER{') { where = LEADER; landing = null; continue; }
      if (c === 303) { where = CONTEXT; continue; }
      if (c === 304 && v === 'LEADER_LINE{') { where = LINE; cur = []; continue; }
      if (c === 305) {
        if (cur && cur.length >= 4) {
          if (landing) cur.push(landing[0], landing[1]);   // 문자 쪽으로 이어지는 꺾임선
          lines.push(cur);
        }
        cur = null;
        where = LEADER;
        continue;
      }

      if (where === LINE) {
        if (c === 10) cur.push(v, 0);
        else if (c === 20 && cur.length) cur[cur.length - 1] = v;
      } else if (where === LEADER) {
        if (c === 10) landing = [v, 0];
        else if (c === 20 && landing) landing[1] = v;
      } else {
        if (c === 41 && !height) height = v;              // 문자 높이
        else if (c === 304) text = v;                     // 문자 내용
        else if (c === 12) at = [v, 0];                   // 문자 위치
        else if (c === 22 && at) at[1] = v;
      }
    }

    for (var i = 0; i < lines.length; i++) this.addPoly(attrs, mapPts(m, lines[i]), false);

    if (text && at) {
      var p = [0, 0];
      tx(m, at[0], at[1], p);
      this.addText(attrs, {
        x: p[0], y: p[1], h: (height || 2.5) * mScale(m), rot: mRot(m),
        str: stripMText(text), hAlign: 0, vAlign: 3, wf: 1
      });
    }
  };

  /**
   * HATCH 경계를 정확히 읽는다.
   *
   * 경계 정의에서는 같은 그룹코드가 문맥에 따라 뜻이 달라진다. 특히 원호 변에서
   * 10/20 은 정점이 아니라 "중심점"이라, 순서를 무시하고 모으면 거의 직선인 호의
   * 중심(수천만 단위 밖)이 경계 꼭짓점으로 섞여 도면 범위가 망가진다.
   * 그래서 파서가 보관한 등장 순서(ent.seq)를 따라 경로별로 해석한다.
   */
  Builder.prototype.hatch = function (ent, m, attrs) {
    var solid = g(ent, 70, 0) === 1;
    var seq = ent.seq;
    if (!seq || !seq.length) return;

    var n = seq.length;
    var i = 0;
    while (i < n && seq[i] !== 91) i += 2;      // 91 = 경계 경로 개수
    if (i >= n) return;
    var nPaths = seq[i + 1];
    i += 2;

    for (var p = 0; p < nPaths && i < n; p++) {
      while (i < n && seq[i] !== 92) i += 2;    // 92 = 경로 종류 플래그
      if (i >= n) break;
      var pathFlag = seq[i + 1];
      i += 2;

      var pts = [];
      if (pathFlag & 2) {
        i = this.hatchPolylinePath(seq, i, n, pts);
      } else {
        i = this.hatchEdgePath(seq, i, n, pts);
      }
      if (pts.length >= 6) this.addPoly(attrs, mapPts(m, pts), true, solid);
    }
  };

  // 폴리라인 형태의 경계: 72 벌지유무, 73 닫힘, 93 정점수, 이후 10/20/(42)
  Builder.prototype.hatchPolylinePath = function (seq, i, n, out) {
    var count = 0;
    while (i < n && seq[i] !== 93) i += 2;
    if (i >= n) return i;
    count = seq[i + 1];
    i += 2;

    var vx = [], vy = [], vb = [];
    var got = 0;
    while (i < n && got < count) {
      if (seq[i] === 10) {
        vx.push(seq[i + 1]); vy.push(0); vb.push(0);
        i += 2;
        if (i < n && seq[i] === 20) { vy[vy.length - 1] = seq[i + 1]; i += 2; }
        if (i < n && seq[i] === 42) { vb[vb.length - 1] = seq[i + 1]; i += 2; }
        got++;
      } else if (seq[i] === 97 || seq[i] === 92) {
        break;
      } else {
        i += 2;
      }
    }

    for (var k = 0; k < vx.length; k++) {
      if (k === 0) { out.push(vx[0], vy[0]); continue; }
      if (vb[k - 1]) bulgeArc(vx[k - 1], vy[k - 1], vx[k], vy[k], vb[k - 1], out);
      else out.push(vx[k], vy[k]);
    }
    if (vx.length > 1 && vb[vx.length - 1]) {
      bulgeArc(vx[vx.length - 1], vy[vy.length - 1], vx[0], vy[0], vb[vx.length - 1], out);
    }
    return i;
  };

  // 변(edge) 목록 형태의 경계: 93 변 개수, 각 변은 72 로 종류를 알린다
  Builder.prototype.hatchEdgePath = function (seq, i, n, out) {
    while (i < n && seq[i] !== 93) i += 2;
    if (i >= n) return i;
    var nEdges = seq[i + 1];
    i += 2;

    for (var e = 0; e < nEdges && i < n; e++) {
      while (i < n && seq[i] !== 72) i += 2;
      if (i >= n) break;
      var type = seq[i + 1];
      i += 2;

      // 다음 변(72) / 원본객체목록(97) / 다음 경로(92) 전까지가 이 변의 자료
      var v = Object.create(null);
      while (i < n && seq[i] !== 72 && seq[i] !== 97 && seq[i] !== 92) {
        var c = seq[i];
        (v[c] || (v[c] = [])).push(seq[i + 1]);
        i += 2;
      }
      var at = function (code, idx, dflt) {
        var a = v[code];
        return (a && a[idx || 0] !== undefined) ? a[idx || 0] : dflt;
      };

      if (type === 1) {                                   // 직선
        if (!out.length) out.push(at(10, 0, 0), at(20, 0, 0));
        out.push(at(11, 0, 0), at(21, 0, 0));
      } else if (type === 2) {                            // 원호
        var cx = at(10, 0, 0), cy = at(20, 0, 0), r = at(40, 0, 0);
        var a0 = at(50, 0, 0) * Math.PI / 180, a1 = at(51, 0, 360) * Math.PI / 180;
        var ccw = at(73, 0, 1);
        if (r > 0) appendArc(cx, cy, r, r, 0, a0, a1, ccw, out);
      } else if (type === 3) {                            // 타원호
        var ex = at(10, 0, 0), ey = at(20, 0, 0);
        var mx = at(11, 0, 1), my = at(21, 0, 0);
        var rx = Math.hypot(mx, my), ratio = at(40, 0, 1);
        var rot = Math.atan2(my, mx);
        var b0 = at(50, 0, 0) * Math.PI / 180, b1 = at(51, 0, 360) * Math.PI / 180;
        if (rx > 0) appendArc(ex, ey, rx, rx * ratio, rot, b0, b1, at(73, 0, 1), out);
      } else if (type === 4) {                            // 스플라인: 제어점으로 근사
        var sx = v[10] || [], sy = v[20] || [];
        for (var s = 0; s < sx.length && s < sy.length; s++) out.push(sx[s], sy[s]);
      }
    }
    return i;
  };

  // 원호 / 타원호의 점들을 out 에 이어 붙인다 (직전 점과 겹치면 건너뛴다)
  function appendArc(cx, cy, rx, ry, rot, a0, a1, ccw, out) {
    var sweep = a1 - a0;
    if (ccw) { while (sweep <= 1e-9) sweep += Math.PI * 2; }
    else { while (sweep >= -1e-9) sweep -= Math.PI * 2; }
    var steps = Math.max(2, Math.min(512, Math.ceil(Math.abs(sweep) / (Math.PI * 2) * ARC_SEGS)));
    var cr = Math.cos(rot), sr = Math.sin(rot);
    for (var k = 0; k <= steps; k++) {
      var t = a0 + sweep * (k / steps);
      var x = rx * Math.cos(t), y = ry * Math.sin(t);
      var px = cx + x * cr - y * sr, py = cy + x * sr + y * cr;
      if (k === 0 && out.length >= 2 &&
        Math.abs(out[out.length - 2] - px) < 1e-9 && Math.abs(out[out.length - 1] - py) < 1e-9) continue;
      out.push(px, py);
    }
  }

  /* ------------------------------------------------------------- 진입점 */

  function build(doc) {
    var b = new Builder(doc);

    // 모형 공간과 배치(paper) 공간이 한 섹션에 섞여 있다. 도곽·표제란만 있는
    // 배치 공간이 도면 범위를 지배하지 않도록 모형 공간을 우선 표시한다.
    var model = [], paper = [];
    for (var k = 0; k < doc.entities.length; k++) {
      (g(doc.entities[k], 67, 0) === 1 ? paper : model).push(doc.entities[k]);
    }
    var ents = model.length ? model : paper;

    for (var i = 0; i < ents.length; i++) {
      try {
        b.entity(ents[i], mIdent(), null, 0);
      } catch (e) {
        b.skipped['ERR:' + ents[i].type] = (b.skipped['ERR:' + ents[i].type] || 0) + 1;
      }
    }
    var bbox = isFinite(b.minX)
      ? [b.minX, b.minY, b.maxX, b.maxY]
      : [-100, -100, 100, 100];
    return {
      items: b.items, bbox: bbox, skipped: b.skipped, layersUsed: b.layerSet,
      space: model.length ? 'model' : 'paper',
      paperCount: paper.length
    };
  }

  global.Geom = {
    build: build,
    aciToRGB: aciToRGB,
    ACI: ACI,
    stripMText: stripMText,
    decodeSpecial: decodeSpecial
  };
})(window);
