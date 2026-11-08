/**
 * renderer.js - 캔버스 2D 기반 CAD 렌더러
 *
 * - 월드 좌표 -> 화면 좌표 카메라 (줌 / 팬)
 * - 균일 격자 공간색인으로 뷰포트 밖 요소를 걸러낸다
 * - 색상 / 선종류 / 선가중치별로 경로를 묶어 상태 변경을 최소화한다
 */
(function (global) {
  'use strict';

  var aciToRGB = global.Geom.aciToRGB;

  function rgbCss(v) {
    return '#' + ('000000' + (v >>> 0).toString(16)).slice(-6);
  }

  // Defpoints 는 치수 정의점이 놓이는 비출력 보조 레이어다. 도면 곳곳에 흩어져 있어
  // 켜 두면 "전체 보기"가 실제 도면 대신 빈 공간을 잡는다. 기본값은 꺼짐.
  function isHelperLayer(name) {
    return /^defpoints$/i.test(name);
  }

  function Renderer(canvas) {
    this.canvas = canvas;
    // alpha:true 로 열어 둔다 - 배경지도 모드에서는 이 캔버스 뒤에 지도 캔버스를
    // 깔고, 여기서는 배경을 채우지 않아 지도가 비쳐 보이게 한다(draw() 참고).
    this.ctx = canvas.getContext('2d', { alpha: true });
    this.dpr = Math.min(global.devicePixelRatio || 1, 2);

    this.items = [];
    this.bbox = [0, 0, 100, 100];
    this.doc = null;
    this.layers = Object.create(null);       // name -> {visible, color, ltype, lineweight}
    this.grid = null;

    this.scale = 1;
    this.ox = 0;
    this.oy = 0;

    this.opts = {
      dark: true,
      showText: true,
      showHatchFill: true,
      showLineweight: false,
      ltScale: 1,
      minTextPx: 5,
      fastTargetMs: 16,   // 조작 중 목표 프레임 시간
      fastMaxPx: 10,      // 조작 중 생략 기준의 상한 (픽셀)
      showBasemap: false, // 켜져 있으면 배경을 채우지 않아 아래 지도 캔버스가 비친다
      basemapDim: 0       // 지도 위 도면 대비를 위한 어둡게/밝게 오버레이 (0~1)
    };
    this._fastPx = 0;     // 프레임 시간에 맞춰 자동 조절되는 생략 기준

    this.overlays = [];                      // 측정 등 상위 모듈이 CAD 캔버스 "위"에 그리는 콜백
    this.preDraw = [];                       // 배경지도 등 CAD 캔버스보다 "먼저"(아래) 그려야 하는 콜백
    this._raf = 0;
    this._fast = false;                      // 조작 중 간이 렌더 모드
    this.stats = { drawn: 0, ms: 0 };
  }

  /* ------------------------------------------------------------ 도면 설정 */

  Renderer.prototype.setDrawing = function (dl, doc) {
    this.items = dl.items;
    this.bbox = dl.bbox;
    this.doc = doc;

    this.layers = Object.create(null);
    var names = Object.keys(doc.layers);
    for (var i = 0; i < names.length; i++) {
      var L = doc.layers[names[i]];
      this.layers[names[i]] = {
        name: L.name, visible: L.on && !L.frozen && !isHelperLayer(L.name),
        color: L.color, trueColor: L.trueColor,
        ltype: L.ltype, lineweight: L.lineweight, count: 0
      };
    }
    // 테이블에 없는 레이어가 엔티티에 등장하는 경우를 보정한다
    for (var j = 0; j < this.items.length; j++) {
      var ln = this.items[j].layer;
      if (!this.layers[ln]) {
        this.layers[ln] = {
          name: ln, visible: !isHelperLayer(ln), color: 7, trueColor: null,
          ltype: 'CONTINUOUS', lineweight: -3, count: 0
        };
      }
      this.layers[ln].count++;
    }
    this.buildIndex();
  };

  Renderer.prototype.buildIndex = function () {
    var b = this.bbox;
    var w = Math.max(1e-9, b[2] - b[0]), h = Math.max(1e-9, b[3] - b[1]);
    var n = this.items.length;
    var cells = Math.max(1, Math.min(128, Math.round(Math.sqrt(n / 12))));
    var cw = w / cells, ch = h / cells;
    var buckets = new Array(cells * cells);
    for (var i = 0; i < buckets.length; i++) buckets[i] = [];

    for (var k = 0; k < n; k++) {
      var bb = this.items[k].bbox;
      var c0 = Math.max(0, Math.min(cells - 1, Math.floor((bb[0] - b[0]) / cw)));
      var c1 = Math.max(0, Math.min(cells - 1, Math.floor((bb[2] - b[0]) / cw)));
      var r0 = Math.max(0, Math.min(cells - 1, Math.floor((bb[1] - b[1]) / ch)));
      var r1 = Math.max(0, Math.min(cells - 1, Math.floor((bb[3] - b[1]) / ch)));
      // 화면 전체를 덮는 거대 요소는 모든 셀에 넣지 않고 별도 목록으로 관리한다
      if ((c1 - c0 + 1) * (r1 - r0 + 1) > cells * cells * 0.25) {
        buckets.big = buckets.big || [];
        buckets.big.push(k);
        continue;
      }
      for (var c = c0; c <= c1; c++) {
        for (var r = r0; r <= r1; r++) buckets[r * cells + c].push(k);
      }
    }
    this.grid = { cells: cells, cw: cw, ch: ch, x0: b[0], y0: b[1], buckets: buckets, big: buckets.big || [] };
    this.seen = new Int32Array(this.items.length);
    this.seenStamp = 0;
    this._fastPx = 0;
  };

  /* -------------------------------------------------------------- 좌표계 */

  Renderer.prototype.resize = function () {
    var r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(global.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(r.width * this.dpr));
    var h = Math.max(1, Math.round(r.height * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    var oldW = this.cssW, oldH = this.cssH;
    this.cssW = r.width;
    this.cssH = r.height;

    if (oldW === undefined) return;
    if (oldW === this.cssW && oldH === this.cssH) return;

    // 패널이 접혀 있거나 아직 배치되지 않아 크기가 0에 가까웠다면 배율 자체가
    // 잘못 잡혔으므로 다시 맞춘다. 그 밖에는 화면 중심의 위치를 유지한다.
    if (oldW < 20 || oldH < 20) this._needFit = true;
    else { this.ox += (this.cssW - oldW) / 2; this.oy += (this.cssH - oldH) / 2; }
  };

  Renderer.prototype.toScreen = function (x, y) {
    return [x * this.scale + this.ox, -y * this.scale + this.oy];
  };
  Renderer.prototype.toWorld = function (px, py) {
    return [(px - this.ox) / this.scale, -(py - this.oy) / this.scale];
  };

  Renderer.prototype.viewBounds = function () {
    var a = this.toWorld(0, 0);
    var b = this.toWorld(this.cssW, this.cssH);
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  };

  // 켜져 있는 레이어의 요소만으로 도면 범위를 구한다.
  // 꺼진 레이어(예: Defpoints)의 멀리 떨어진 요소가 화면을 지배하지 않도록 한다.
  Renderer.prototype.visibleBounds = function () {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < this.items.length; i++) {
      var it = this.items[i];
      var L = this.layers[it.layer];
      if (L && !L.visible) continue;
      var b = it.bbox;
      if (b[0] < minX) minX = b[0];
      if (b[1] < minY) minY = b[1];
      if (b[2] > maxX) maxX = b[2];
      if (b[3] > maxY) maxY = b[3];
    }
    return isFinite(minX) ? [minX, minY, maxX, maxY] : this.bbox;
  };

  Renderer.prototype.zoomExtents = function (bbox) {
    var b = bbox || this.visibleBounds();
    this.resize();
    var w = Math.max(1e-9, b[2] - b[0]), h = Math.max(1e-9, b[3] - b[1]);
    var pad = 0.94;
    this.scale = Math.min(this.cssW / w, this.cssH / h) * pad;
    if (!isFinite(this.scale) || this.scale <= 0) this.scale = 1;
    var cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    this.ox = this.cssW / 2 - cx * this.scale;
    this.oy = this.cssH / 2 + cy * this.scale;
    this.invalidate();
  };

  Renderer.prototype.zoomAt = function (px, py, factor) {
    var before = this.toWorld(px, py);
    this.scale = Math.max(1e-9, Math.min(1e12, this.scale * factor));
    var after = this.toWorld(px, py);
    this.ox += (after[0] - before[0]) * this.scale;
    this.oy -= (after[1] - before[1]) * this.scale;
    this.invalidate();
  };

  Renderer.prototype.panBy = function (dx, dy) {
    this.ox += dx;
    this.oy += dy;
    this.invalidate();
  };

  /* -------------------------------------------------------------- 스타일 */

  Renderer.prototype.fg = function () { return this.opts.dark ? '#e8e8e8' : '#101010'; };
  Renderer.prototype.bg = function () { return this.opts.dark ? '#1b1e24' : '#ffffff'; };

  Renderer.prototype.colorOf = function (it) {
    if (it.rgb !== null && it.rgb !== undefined) return rgbCss(it.rgb);
    var aci = it.aci;
    if (aci === null || aci === undefined) {
      var L = this.layers[it.layer];
      if (L && L.trueColor !== null && L.trueColor !== undefined) return rgbCss(L.trueColor);
      aci = L ? L.color : 7;
    }
    if (aci === 7 || aci === 0) return this.fg();          // 흰색/검정은 배경에 맞춰 반전
    return rgbCss(aciToRGB(aci));
  };

  Renderer.prototype.dashOf = function (it) {
    var name = it.lt;
    if (!name || name === 'BYLAYER') {
      var L = this.layers[it.layer];
      name = L ? L.ltype : 'CONTINUOUS';
    }
    if (!name || name === 'CONTINUOUS' || name === 'ByBlock' || name === 'BYBLOCK') return null;
    var lt = this.doc && this.doc.ltypes[name];
    if (!lt || !lt.pattern.length) return null;
    var out = [];
    var any = false;
    for (var i = 0; i < lt.pattern.length; i++) {
      var v = Math.abs(lt.pattern[i]) * this.scale * this.opts.ltScale;
      if (v > 0.01) any = true;
      out.push(Math.max(0.5, v));
    }
    if (!any) return null;
    // 화면에서 너무 촘촘하거나 너무 성기면 실선 취급 (성능 보호)
    var sum = out.reduce(function (a, b) { return a + b; }, 0);
    if (sum < 3 || sum > 4000) return null;
    return out;
  };

  Renderer.prototype.widthOf = function (it) {
    if (!this.opts.showLineweight) return 1;
    var lw = it.lw;
    if (lw === null || lw === undefined || lw < 0) {
      var L = this.layers[it.layer];
      lw = L ? L.lineweight : -3;
    }
    if (lw === null || lw === undefined || lw < 0) return 1;
    return Math.max(1, Math.min(24, lw / 100 * 3.78));
  };

  /* --------------------------------------------------------------- 렌더 */

  Renderer.prototype.invalidate = function () {
    if (this._raf) return;
    var self = this;
    this._raf = requestAnimationFrame(function () {
      self._raf = 0;
      self.draw();
    });
  };

  Renderer.prototype.visibleItems = function () {
    var vb = this.viewBounds();
    var out = [];
    var gr = this.grid;
    if (!gr) return out;
    this.seenStamp++;
    var stamp = this.seenStamp;
    var seen = this.seen;
    var items = this.items;

    var c0 = Math.max(0, Math.floor((vb[0] - gr.x0) / gr.cw));
    var c1 = Math.min(gr.cells - 1, Math.floor((vb[2] - gr.x0) / gr.cw));
    var r0 = Math.max(0, Math.floor((vb[1] - gr.y0) / gr.ch));
    var r1 = Math.min(gr.cells - 1, Math.floor((vb[3] - gr.y0) / gr.ch));

    function consider(k) {
      if (seen[k] === stamp) return;
      seen[k] = stamp;
      var it = items[k];
      var bb = it.bbox;
      if (bb[2] < vb[0] || bb[0] > vb[2] || bb[3] < vb[1] || bb[1] > vb[3]) return;
      var L = this._layers[it.layer];
      if (L && !L.visible) return;
      out.push(it);
    }
    this._layers = this.layers;
    var bound = consider.bind(this);

    for (var i = 0; i < gr.big.length; i++) bound(gr.big[i]);
    for (var c = c0; c <= c1; c++) {
      for (var r = r0; r <= r1; r++) {
        var arr = gr.buckets[r * gr.cells + c];
        for (var j = 0; j < arr.length; j++) bound(arr[j]);
      }
    }
    return out;
  };

  /**
   * (wx, wy) 를 중심으로 반지름 wr 안에 걸치는 요소를 모은다. 스냅/선택에 쓴다.
   */
  Renderer.prototype.itemsNear = function (wx, wy, wr) {
    var gr = this.grid, out = [];
    if (!gr) return out;
    var c0 = Math.max(0, Math.floor((wx - wr - gr.x0) / gr.cw));
    var c1 = Math.min(gr.cells - 1, Math.floor((wx + wr - gr.x0) / gr.cw));
    var r0 = Math.max(0, Math.floor((wy - wr - gr.y0) / gr.ch));
    var r1 = Math.min(gr.cells - 1, Math.floor((wy + wr - gr.y0) / gr.ch));
    this.seenStamp++;
    var stamp = this.seenStamp, seen = this.seen, items = this.items, layers = this.layers;

    function take(k) {
      if (seen[k] === stamp) return;
      seen[k] = stamp;
      var it = items[k];
      var bb = it.bbox;
      if (bb[2] < wx - wr || bb[0] > wx + wr || bb[3] < wy - wr || bb[1] > wy + wr) return;
      var L = layers[it.layer];
      if (L && !L.visible) return;
      out.push(it);
    }
    for (var i = 0; i < gr.big.length; i++) take(gr.big[i]);
    for (var c = c0; c <= c1; c++) {
      for (var r = r0; r <= r1; r++) {
        var arr = gr.buckets[r * gr.cells + c];
        for (var j = 0; j < arr.length; j++) take(arr[j]);
      }
    }
    return out;
  };

  Renderer.prototype.draw = function () {
    var t0 = performance.now();
    this.resize();
    if (this._needFit && this.items.length) {
      this._needFit = false;
      this.zoomExtents();
    }
    // 지도 등 배경 레이어는 CAD 캔버스가 다시 그려질 때마다(같은 카메라로)
    // 함께 갱신해야 어긋나지 않는다. 이 시점엔 아직 배경을 지우기 전이라,
    // 콜백 쪽에서 알아서 자기 캔버스를 그린다(이 캔버스를 직접 건드리지 않는다).
    for (var pi = 0; pi < this.preDraw.length; pi++) {
      try { this.preDraw[pi](this); } catch (e) { /* 배경 오류가 도면 렌더를 막지 않는다 */ }
    }
    var ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.opts.showBasemap) {
      // 배경을 채우지 않아 뒤에 깔린 지도 캔버스가 비쳐 보인다.
      // 도면 선이 지도 위에서 묻히지 않도록 옅게 어둡게/밝게만 깔아 대비를 준다.
      ctx.clearRect(0, 0, this.cssW, this.cssH);
      if (this.opts.basemapDim > 0) {
        ctx.fillStyle = this.opts.dark
          ? 'rgba(0,0,0,' + this.opts.basemapDim + ')'
          : 'rgba(255,255,255,' + this.opts.basemapDim + ')';
        ctx.fillRect(0, 0, this.cssW, this.cssH);
      }
    } else {
      ctx.fillStyle = this.bg();
      ctx.fillRect(0, 0, this.cssW, this.cssH);
    }

    if (!this.items.length) { this.stats = { drawn: 0, ms: 0 }; this.runOverlays(ctx); return; }

    var vis = this.visibleItems();

    // 조작 중에는 화면에서 점 하나 크기로 뭉개지는 요소를 건너뛰어 반응성을 지킨다.
    // 손을 뗀 뒤 180ms 후 전체 품질로 다시 그린다(setFast 참고).
    var minPx = this._fast ? this._fastPx : 0;
    var step = 1;
    if (this._fast && vis.length > 200000) step = Math.ceil(vis.length / 200000);

    var groups = new Map();
    var texts = [];
    var points = [];
    var fills = [];

    for (var i = 0; i < vis.length; i += step) {
      var it = vis[i];
      if (minPx) {
        var bb = it.bbox;
        if ((bb[2] - bb[0]) * this.scale < minPx && (bb[3] - bb[1]) * this.scale < minPx) continue;
      }
      if (it.kind === 'text') { if (this.opts.showText) texts.push(it); continue; }
      if (it.kind === 'point') { points.push(it); continue; }
      if (it.fill && this.opts.showHatchFill) { fills.push(it); continue; }
      var col = this.colorOf(it);
      var dash = this.dashOf(it);
      var wid = this.widthOf(it);
      var key = col + '|' + wid + '|' + (dash ? dash.join(',') : '');
      var grp = groups.get(key);
      if (!grp) { grp = { col: col, dash: dash, wid: wid, list: [] }; groups.set(key, grp); }
      grp.list.push(it);
    }

    // 채움면 먼저
    ctx.globalAlpha = 0.55;
    for (var f = 0; f < fills.length; f++) {
      var fi = fills[f];
      ctx.fillStyle = this.colorOf(fi);
      ctx.beginPath();
      this.pathPoly(ctx, fi);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    var drawn = 0;
    var self = this;
    groups.forEach(function (grp) {
      ctx.strokeStyle = grp.col;
      ctx.lineWidth = grp.wid;
      if (grp.dash) ctx.setLineDash(grp.dash); else ctx.setLineDash([]);
      ctx.beginPath();
      for (var k = 0; k < grp.list.length; k++) {
        var it = grp.list[k];
        if (it.kind === 'arc') self.pathArc(ctx, it);
        else self.pathPoly(ctx, it);
        drawn++;
        // 경로가 너무 길어지면 중간에 한 번 그린다 (메모리/속도 균형)
        if ((k & 2047) === 2047) { ctx.stroke(); ctx.beginPath(); }
      }
      ctx.stroke();
    });
    ctx.setLineDash([]);

    // 점
    if (points.length) {
      ctx.fillStyle = this.fg();
      for (var p = 0; p < points.length; p++) {
        var pt = this.toScreen(points[p].x, points[p].y);
        ctx.fillRect(pt[0] - 1.5, pt[1] - 1.5, 3, 3);
      }
    }

    // 텍스트
    if (this.opts.showText) this.drawTexts(ctx, texts);

    var ms = performance.now() - t0;
    if (this._fast) {
      // 목표 프레임 시간에 수렴하도록 생략 기준을 조절한다
      var target = this.opts.fastTargetMs;
      var over = ms / target;
      if (over > 1.4) {
        this._fastPx = Math.min(this.opts.fastMaxPx, (this._fastPx + 0.5) * Math.min(3, Math.sqrt(over)));
      } else if (over < 0.6) {
        this._fastPx = Math.max(0, this._fastPx * 0.75 - 0.05);
      }
    }
    this.stats = { drawn: drawn + texts.length + points.length, total: this.items.length, ms: ms };
    this.runOverlays(ctx);
  };

  Renderer.prototype.pathPoly = function (ctx, it) {
    var p = it.pts, s = this.scale, ox = this.ox, oy = this.oy;
    if (p.length < 4) {
      if (p.length === 2) {
        ctx.moveTo(p[0] * s + ox, -p[1] * s + oy);
        ctx.lineTo(p[0] * s + ox + 0.01, -p[1] * s + oy);
      }
      return;
    }
    ctx.moveTo(p[0] * s + ox, -p[1] * s + oy);
    for (var i = 2; i < p.length; i += 2) {
      ctx.lineTo(p[i] * s + ox, -p[i + 1] * s + oy);
    }
    if (it.closed) ctx.closePath();
  };

  Renderer.prototype.pathArc = function (ctx, it) {
    var s = this.scale;
    var cx = it.cx * s + this.ox, cy = -it.cy * s + this.oy;
    var r = it.r * s;
    if (r < 0.35) { ctx.moveTo(cx, cy); ctx.lineTo(cx + 0.01, cy); return; }
    // 화면 Y축이 뒤집혀 있으므로 각도를 반전하고 시계방향으로 그린다.
    // arc() 는 현재 점에서 시작점까지 직선을 잇기 때문에 반드시 먼저 moveTo 한다.
    ctx.moveTo(cx + r * Math.cos(-it.a0), cy + r * Math.sin(-it.a0));
    ctx.arc(cx, cy, r, -it.a0, -it.a1, true);
  };

  Renderer.prototype.drawTexts = function (ctx, texts) {
    var minPx = this.opts.minTextPx;
    ctx.textBaseline = 'alphabetic';
    var lastCol = null;
    for (var i = 0; i < texts.length; i++) {
      var t = texts[i];
      var px = t.h * this.scale;
      if (px < minPx) continue;
      if (px > 4000) continue;
      var p = this.toScreen(t.x, t.y);
      var col = this.colorOf(t);
      if (col !== lastCol) { ctx.fillStyle = col; lastCol = col; }
      ctx.save();
      ctx.translate(p[0], p[1]);
      if (t.rot) ctx.rotate(-t.rot);
      ctx.font = px.toFixed(2) + 'px "Malgun Gothic", "맑은 고딕", Arial, sans-serif';
      ctx.textAlign = t.hAlign === 1 ? 'center' : t.hAlign === 2 ? 'right' : 'left';
      var lines = t.str.split('\n');
      var dy = 0;
      if (t.vAlign === 3) dy = px * 0.85;              // 상단 기준
      else if (t.vAlign === 2) dy = px * 0.36;         // 중앙
      else if (t.vAlign === 1) dy = 0;                 // 하단
      if (t.wf && t.wf !== 1) ctx.scale(t.wf, 1);
      for (var l = 0; l < lines.length; l++) {
        ctx.fillText(lines[l], 0, dy + l * px * 1.25);
      }
      ctx.restore();
    }
  };

  Renderer.prototype.runOverlays = function (ctx) {
    for (var i = 0; i < this.overlays.length; i++) {
      ctx.save();
      try { this.overlays[i](ctx, this); } catch (e) { /* 오버레이 오류는 렌더를 막지 않는다 */ }
      ctx.restore();
    }
  };

  Renderer.prototype.setFast = function (on) { this._fast = !!on; };

  global.Renderer = Renderer;
})(window);
