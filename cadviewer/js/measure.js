/**
 * measure.js - 거리 / 면적 측정 도구
 *
 * 객체 스냅(끝점·중점·중심·사분점·근처점)을 지원하고, 측정 결과를 캔버스에 겹쳐 그린다.
 * 면적은 신발끈 공식으로 계산하며, 한국 실무를 고려해 제곱미터와 평을 함께 표시한다.
 */
(function (global) {
  'use strict';

  var PYEONG = 3.305785;   // 1평 = 3.305785 m^2

  var SNAP_ORDER = { end: 0, center: 1, mid: 2, quad: 3, near: 4 };
  var SNAP_LABEL = { end: '끝점', center: '중심', mid: '중점', quad: '사분점', near: '근처' };

  function dist(ax, ay, bx, by) { return Math.hypot(bx - ax, by - ay); }

  /* --------------------------------------------------------------- 스냅 */

  function findSnap(renderer, wx, wy, worldTol, enabled) {
    if (!enabled) return null;
    var cands = renderer.itemsNear(wx, wy, worldTol);
    var best = null;

    function offer(type, x, y) {
      var d = dist(wx, wy, x, y);
      if (d > worldTol) return;
      if (!best || SNAP_ORDER[type] < SNAP_ORDER[best.type] ||
        (SNAP_ORDER[type] === SNAP_ORDER[best.type] && d < best.d)) {
        best = { type: type, x: x, y: y, d: d };
      }
    }

    for (var i = 0; i < cands.length && i < 4000; i++) {
      var it = cands[i];
      if (it.kind === 'poly') {
        var p = it.pts;
        for (var k = 0; k < p.length; k += 2) offer('end', p[k], p[k + 1]);
        for (var m = 0; m + 3 < p.length; m += 2) {
          var mx = (p[m] + p[m + 2]) / 2, my = (p[m + 1] + p[m + 3]) / 2;
          offer('mid', mx, my);
          // 선분 위의 가장 가까운 점
          var vx = p[m + 2] - p[m], vy = p[m + 3] - p[m + 1];
          var len2 = vx * vx + vy * vy;
          if (len2 > 0) {
            var t = ((wx - p[m]) * vx + (wy - p[m + 1]) * vy) / len2;
            if (t > 0 && t < 1) offer('near', p[m] + vx * t, p[m + 1] + vy * t);
          }
        }
      } else if (it.kind === 'arc') {
        offer('center', it.cx, it.cy);
        for (var q = 0; q < 4; q++) {
          var a = q * Math.PI / 2;
          offer('quad', it.cx + it.r * Math.cos(a), it.cy + it.r * Math.sin(a));
        }
        var ang = Math.atan2(wy - it.cy, wx - it.cx);
        offer('near', it.cx + it.r * Math.cos(ang), it.cy + it.r * Math.sin(ang));
        offer('end', it.cx + it.r * Math.cos(it.a0), it.cy + it.r * Math.sin(it.a0));
        offer('end', it.cx + it.r * Math.cos(it.a1), it.cy + it.r * Math.sin(it.a1));
      } else if (it.kind === 'point') {
        offer('end', it.x, it.y);
      }
    }
    return best;
  }

  /* ------------------------------------------------------------- 도구 본체 */

  function Measure(renderer) {
    this.r = renderer;
    this.mode = 'none';            // none | dist | area
    this.snapEnabled = true;
    this.pts = [];                 // 진행 중인 측정의 확정 점들
    this.cursor = null;            // {x, y, snap}
    this.results = [];             // 완료된 측정 목록
    this.unit = { label: 'm', factor: 1 };   // 도면 1단위 -> 표시 단위 배율
    this.onChange = null;
    var self = this;
    renderer.overlays.push(function (ctx) { self.render(ctx); });
  }

  Measure.prototype.setMode = function (mode) {
    if (this.mode !== mode) this.pts = [];
    this.mode = mode;
    this.cursor = null;
    this.r.invalidate();
    this.emit();
  };

  Measure.prototype.setUnit = function (label, factor) {
    this.unit = { label: label, factor: factor };
    this.emit();
    this.r.invalidate();
  };

  Measure.prototype.emit = function () { if (this.onChange) this.onChange(this); };

  Measure.prototype.active = function () { return this.mode !== 'none'; };

  /**
   * 화면 좌표 한 점을 도면 좌표로 바꾼다. 근처에 스냅 대상이 있으면 그 점을 돌려준다.
   * 측정 중이 아니어도 쓸 수 있어 좌표 확인에도 그대로 사용한다.
   * radiusPx 는 스냅 탐색 반경(화면 픽셀). 십자선은 정밀하므로 좁게, 손가락 탭은 넓게 준다.
   */
  Measure.prototype.probe = function (px, py, radiusPx) {
    var w = this.r.toWorld(px, py);
    var tol = (radiusPx || 16) / this.r.scale;
    var snap = findSnap(this.r, w[0], w[1], tol, this.snapEnabled);
    return snap ? { x: snap.x, y: snap.y, snap: snap.type } : { x: w[0], y: w[1], snap: null };
  };

  Measure.prototype.onMove = function (px, py, radiusPx) {
    if (!this.active()) { this.cursor = null; return; }
    this.cursor = this.probe(px, py, radiusPx);
    this.r.invalidate();
  };

  Measure.prototype.onClick = function () {
    if (!this.active() || !this.cursor) return;
    this.pts.push(this.cursor.x, this.cursor.y);
    this.r.invalidate();
    this.emit();
  };

  Measure.prototype.undoPoint = function () {
    if (this.pts.length >= 2) this.pts.length -= 2;
    this.r.invalidate();
    this.emit();
  };

  Measure.prototype.finish = function () {
    var need = this.mode === 'area' ? 6 : 4;
    if (this.pts.length >= need) {
      this.results.push({
        mode: this.mode,
        pts: this.pts.slice(),
        id: Date.now() + Math.random()
      });
    }
    this.pts = [];
    this.r.invalidate();
    this.emit();
  };

  Measure.prototype.cancel = function () {
    this.pts = [];
    this.r.invalidate();
    this.emit();
  };

  Measure.prototype.clearAll = function () {
    this.pts = [];
    this.results = [];
    this.r.invalidate();
    this.emit();
  };

  Measure.prototype.remove = function (id) {
    this.results = this.results.filter(function (x) { return x.id !== id; });
    this.r.invalidate();
    this.emit();
  };

  /* ---------------------------------------------------------------- 계산 */

  function polyLength(p) {
    var s = 0;
    for (var i = 0; i + 3 < p.length; i += 2) s += dist(p[i], p[i + 1], p[i + 2], p[i + 3]);
    return s;
  }
  function polyArea(p) {
    var a = 0, n = p.length / 2;
    for (var i = 0; i < n; i++) {
      var j = (i + 1) % n;
      a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
    }
    return Math.abs(a) / 2;
  }

  // 정수부에만 천 단위 구분 기호를 넣는다
  function grouped(x, dec) {
    var s = x.toFixed(dec);
    var neg = s.charAt(0) === '-';
    if (neg) s = s.slice(1);
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + parts.join('.');
  }

  Measure.prototype.fmtLen = function (v) {
    var x = v * this.unit.factor;
    var abs = Math.abs(x);
    var dec = abs >= 1000 ? 2 : abs >= 1 ? 3 : 4;
    return grouped(x, dec) + ' ' + this.unit.label;
  };

  Measure.prototype.fmtArea = function (v) {
    var f = this.unit.factor;
    var x = v * f * f;
    var s = grouped(x, x >= 1000 ? 2 : 3) + ' ' + this.unit.label + '²';
    if (this.unit.label === 'm') {
      s += '  (' + grouped(x / PYEONG, 2) + ' 평)';
    } else if (this.unit.label === 'mm') {
      s += '  (' + grouped(x / 1e6, 3) + ' m²)';
    }
    return s;
  };

  Measure.prototype.summary = function (res) {
    if (res.mode === 'dist') {
      var total = polyLength(res.pts);
      var n = res.pts.length / 2;
      return { title: '거리', main: this.fmtLen(total), sub: n > 2 ? (n - 1) + '개 구간' : '' };
    }
    var area = polyArea(res.pts);
    var peri = polyLength(res.pts) + dist(res.pts[res.pts.length - 2], res.pts[res.pts.length - 1], res.pts[0], res.pts[1]);
    return { title: '면적', main: this.fmtArea(area), sub: '둘레 ' + this.fmtLen(peri) };
  };

  /* ---------------------------------------------------------------- 표시 */

  Measure.prototype.render = function (ctx) {
    var r = this.r;
    var accent = '#ffb454';
    var done = '#4ec9b0';

    for (var i = 0; i < this.results.length; i++) {
      this.drawShape(ctx, this.results[i].pts, this.results[i].mode, done, true);
    }

    if (this.active() && this.pts.length) {
      var live = this.pts.slice();
      if (this.cursor) live.push(this.cursor.x, this.cursor.y);
      this.drawShape(ctx, live, this.mode, accent, false);
    }

    // 스냅이 걸린 위치는 화면 중앙(십자선)에서 벗어나므로 캔버스에 따로 표시한다.
    // 스냅이 없을 때의 커서 표시는 HTML 십자선이 담당한다.
    if (this.active() && this.cursor && this.cursor.snap) {
      var p = r.toScreen(this.cursor.x, this.cursor.y);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#7fe08a';
      ctx.strokeRect(p[0] - 7, p[1] - 7, 14, 14);
    }
  };

  Measure.prototype.snapLabel = function () {
    return this.cursor && this.cursor.snap ? SNAP_LABEL[this.cursor.snap] : null;
  };

  Measure.prototype.drawShape = function (ctx, pts, mode, color, finished) {
    if (pts.length < 2) return;
    var r = this.r;
    var scr = [];
    for (var i = 0; i < pts.length; i += 2) {
      var s = r.toScreen(pts[i], pts[i + 1]);
      scr.push(s[0], s[1]);
    }

    ctx.lineWidth = 1.8;
    ctx.strokeStyle = color;
    ctx.setLineDash(finished ? [] : [6, 4]);
    ctx.beginPath();
    ctx.moveTo(scr[0], scr[1]);
    for (var k = 2; k < scr.length; k += 2) ctx.lineTo(scr[k], scr[k + 1]);
    if (mode === 'area' && scr.length >= 6) {
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.15;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = color;
    for (var j = 0; j < scr.length; j += 2) {
      ctx.beginPath();
      ctx.arc(scr[j], scr[j + 1], 3.2, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.font = '12px "Malgun Gothic", sans-serif';
    if (mode === 'dist') {
      for (var m = 0; m + 3 < pts.length; m += 2) {
        var segLen = dist(pts[m], pts[m + 1], pts[m + 2], pts[m + 3]);
        if (segLen <= 0) continue;
        var mx = (scr[m] + scr[m + 2]) / 2, my = (scr[m + 1] + scr[m + 3]) / 2;
        this.label(ctx, this.fmtLen(segLen), mx, my - 8, color);
      }
      if (pts.length > 4) {
        this.label(ctx, 'Σ ' + this.fmtLen(polyLength(pts)),
          scr[scr.length - 2] + 10, scr[scr.length - 1] + 16, color);
      }
    } else if (pts.length >= 6) {
      var cxs = 0, cys = 0, n = scr.length / 2;
      for (var c = 0; c < scr.length; c += 2) { cxs += scr[c]; cys += scr[c + 1]; }
      this.label(ctx, this.fmtArea(polyArea(pts)), cxs / n, cys / n, color);
    }
  };

  Measure.prototype.label = function (ctx, text, x, y, color) {
    var w = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(15,17,21,0.82)';
    ctx.fillRect(x - w / 2 - 5, y - 12, w + 10, 17);
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(text, x, y);
    ctx.textAlign = 'left';
  };

  // 도면 좌표를 표시용 문자열로. 측량 좌표는 자릿수가 커서 천단위 기호 없이 쓴다.
  Measure.prototype.fmtCoord = function (v) {
    return (v * this.unit.factor).toFixed(3);
  };

  global.Measure = Measure;
  global.Measure.PYEONG = PYEONG;
  global.Measure.snapLabelOf = function (type) { return SNAP_LABEL[type] || null; };
})(window);
