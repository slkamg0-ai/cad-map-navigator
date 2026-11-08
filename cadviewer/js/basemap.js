/**
 * basemap.js - VWorld 배경지도를 CAD 캔버스 뒤에 지리참조해 그린다.
 *
 * 원리: 도면좌표 두 점(보통 bbox 대각선)을 Geo.fitSimilarity 로 Web Mercator 에
 * 맞춰, "Mercator 좌표 -> 가상 도면좌표" 역변환을 얻는다. 이러면 지도 타일의
 * 네 모서리도 "가상 도면좌표"로 바뀌고, 거기에 CAD 렌더러의 카메라(toScreen)를
 * 그대로 적용하면 지도가 도면과 완전히 같은 화면 좌표계에서 팬/줌된다.
 * 등각변환(회전+등방스케일)이므로 정사각형 타일은 화면에서도 정확히 평행사변형
 * (실제로는 회전된 정사각형)으로 매핑되어, canvas 의 setTransform 한 번으로
 * 왜곡 없이 그릴 수 있다.
 */
(function (global) {
  'use strict';

  var R = 6378137;                 // Web Mercator 구체 반지름
  var WORLD = Math.PI * R;         // Mercator 좌표 범위: -WORLD ~ +WORLD
  var TILE = 256;

  function Basemap(mapCanvas, renderer) {
    this.canvas = mapCanvas;
    this.ctx = mapCanvas.getContext('2d', { alpha: true });
    this.renderer = renderer;

    this.enabled = false;
    this.layer = 'base';           // 'base' | 'satellite' | 'hybrid'
    this.crs = null;
    this.fit = null;               // Geo.fitSimilarity 결과
    this.detectInfo = null;        // {code, confidence, reason}
    this.available = null;         // 서버에 타일 프록시가 있는지 (null=확인 전)

    this._cache = new Map();       // "layer/z/y/x" -> Image | 'loading' | 'error'
    this._maxCache = 600;

    var self = this;
    fetch('api/maptiles')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { self.available = !!(j && j.available); })
      .catch(function () { self.available = false; });

    renderer.preDraw.push(function () { self.render(); });
  }

  var LAYER_EXT = { base: 'png', satellite: 'jpeg', hybrid_label: 'png' };

  /**
   * 도면(displayList, doc)이 바뀔 때마다 호출한다. CRS 를 추정해 두고,
   * 실제 지도 정합(fit 계산)은 setEnabled(true) 시점에 한다 - 지도를 안 켠
   * 도면에서까지 미리 계산할 필요는 없다.
   */
  Basemap.prototype.setDrawing = function (displayList, doc) {
    this.fit = null;
    this.bbox = displayList.bbox;

    var texts = [];
    for (var i = 0; i < displayList.items.length && texts.length < 400; i++) {
      var it = displayList.items[i];
      if (it.kind === 'text' && it.str) texts.push(it.str);
    }
    this.detectInfo = global.Geo.detectCRS(texts);
    this.crs = this.detectInfo.code;
  };

  Basemap.prototype.setCRS = function (code) {
    this.crs = code;
    this.fit = null;   // 다음 render 에서 다시 계산
    this.renderer.invalidate();
  };

  Basemap.prototype.setLayer = function (layer) {
    this.layer = layer;
    this.renderer.invalidate();
  };

  Basemap.prototype.setEnabled = function (on) {
    this.enabled = on;
    this.renderer.opts.showBasemap = on;
    this.renderer.opts.basemapDim = on ? 0.32 : 0;
    if (on) this._ensureFit();
    this.renderer.invalidate();
  };

  Basemap.prototype._ensureFit = function () {
    if (this.fit || !this.bbox) return;
    var b = this.bbox;
    var w = b[2] - b[0], h = b[3] - b[1];
    if (w < 1e-6 || h < 1e-6) return;
    try {
      // bbox 의 두 대각 모서리를 기준점으로 쓴다 - 도면 전체를 가로지르는
      // 만큼 두 점 사이 거리가 커서, 회전/스케일 추정이 안정적이다.
      this.fit = global.Geo.fitSimilarity(this.crs, [b[0], b[1]], [b[2], b[3]]);
    } catch (e) {
      console.error('지도 정합 실패:', e);
      this.fit = null;
    }
  };

  /* ------------------------------------------------------------- 좌표 변환 */

  function mercToPixel(mx, my, z) {
    var scale = (TILE * Math.pow(2, z)) / (2 * WORLD);
    return [(mx + WORLD) * scale, (WORLD - my) * scale];
  }
  function pixelToMerc(px, py, z) {
    var scale = (TILE * Math.pow(2, z)) / (2 * WORLD);
    return [px / scale - WORLD, WORLD - py / scale];
  }

  /* ------------------------------------------------------------------ 타일 */

  Basemap.prototype._tileUrl = function (sub, z, y, x) {
    var ext = LAYER_EXT[sub];
    return 'api/maptile/' + sub + '/' + z + '/' + y + '/' + x + '.' + ext;
  };

  Basemap.prototype._getTile = function (sub, z, y, x) {
    var n = Math.pow(2, z);
    if (y < 0 || y >= n) return null;
    x = ((x % n) + n) % n;   // 경도 180도 경계 랩어라운드

    var key = sub + '/' + z + '/' + y + '/' + x;
    var hit = this._cache.get(key);
    if (hit === 'error') return null;
    if (hit && hit !== 'loading') return hit;

    if (hit !== 'loading') {
      this._cache.set(key, 'loading');
      var img = new Image();
      var self = this;
      img.onload = function () {
        if (self._cache.size > self._maxCache) self._cache.clear();
        self._cache.set(key, img);
        self.renderer.invalidate();
      };
      img.onerror = function () { self._cache.set(key, 'error'); };
      img.src = this._tileUrl(sub, z, y, x);
    }
    return null;
  };

  /* ------------------------------------------------------------------ 렌더 */

  Basemap.prototype.render = function () {
    var r = this.renderer;
    var cv = this.canvas;
    // CAD 캔버스와 같은 CSS/backing 크기를 유지한다
    var w = Math.max(1, Math.round(r.cssW * r.dpr));
    var h = Math.max(1, Math.round(r.cssH * r.dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }

    var ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);

    if (!this.enabled || !this.available) return;
    this._ensureFit();
    if (!this.fit) return;

    ctx.setTransform(r.dpr, 0, 0, r.dpr, 0, 0);

    // 화면 네 모서리(CSS px) -> 도면좌표 -> Mercator 로 바꿔 보이는 범위를 구한다
    var corners = [[0, 0], [r.cssW, 0], [0, r.cssH], [r.cssW, r.cssH]];
    var minMX = Infinity, minMY = Infinity, maxMX = -Infinity, maxMY = -Infinity;
    for (var i = 0; i < 4; i++) {
      var wpt = r.toWorld(corners[i][0], corners[i][1]);
      var m = this.fit.forward(wpt[0], wpt[1]);
      if (m[0] < minMX) minMX = m[0]; if (m[0] > maxMX) maxMX = m[0];
      if (m[1] < minMY) minMY = m[1]; if (m[1] > maxMY) maxMY = m[1];
    }

    // 목표 확대단계: 화면픽셀/Mercator미터 비율이 타일 해상도와 가장 가깝게
    var pxPerMerc = r.scale / this.fit.scale;
    var z = Math.round(Math.log2(pxPerMerc * 2 * WORLD / TILE));
    z = Math.max(5, Math.min(19, z));

    var tl = mercToPixel(minMX, maxMY, z);   // Mercator Y 는 위로 증가 -> 화면 위쪽은 maxY
    var br = mercToPixel(maxMX, minMY, z);
    var x0 = Math.floor(tl[0] / TILE) - 1, x1 = Math.floor(br[0] / TILE) + 1;
    var y0 = Math.floor(tl[1] / TILE) - 1, y1 = Math.floor(br[1] / TILE) + 1;

    var tileCountCap = 400;   // 극단적인 줌/회전에서도 폭주하지 않도록
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > tileCountCap) return;

    var subLayers = this.layer === 'hybrid' ? ['satellite', 'hybrid_label'] : [this.layer];

    for (var s = 0; s < subLayers.length; s++) {
      var sub = subLayers[s];
      for (var ty = y0; ty <= y1; ty++) {
        for (var tx = x0; tx <= x1; tx++) {
          var img = this._getTile(sub, z, ty, tx);
          if (!img) continue;
          this._drawTile(ctx, img, z, ty, tx);
        }
      }
    }
  };

  // 타일 하나를 등각변환+카메라를 합성한 아핀행렬로 그린다 (왜곡 없이 회전만 반영)
  Basemap.prototype._drawTile = function (ctx, img, z, ty, tx) {
    var r = this.renderer;
    var pxTL = [tx * TILE, ty * TILE];
    var pxTR = [(tx + 1) * TILE, ty * TILE];
    var pxBL = [tx * TILE, (ty + 1) * TILE];

    var screenOf = function (px) {
      var merc = pixelToMerc(px[0], px[1], z);
      var vd = self_inverse(merc);
      return r.toScreen(vd[0], vd[1]);
    };
    var self_inverse = function (merc) { return self.fit.inverse(merc[0], merc[1]); };
    var self = this;

    var sTL = screenOf(pxTL), sTR = screenOf(pxTR), sBL = screenOf(pxBL);

    var a = (sTR[0] - sTL[0]) / TILE;
    var b = (sTR[1] - sTL[1]) / TILE;
    var c = (sBL[0] - sTL[0]) / TILE;
    var d = (sBL[1] - sTL[1]) / TILE;

    ctx.save();
    ctx.transform(a, b, c, d, sTL[0], sTL[1]);
    // 타일 경계에 미세한 헤어라인 틈이 보이지 않도록 살짝 겹쳐 그린다
    ctx.drawImage(img, -0.5, -0.5, TILE + 1, TILE + 1);
    ctx.restore();
  };

  global.Basemap = Basemap;
})(window);
