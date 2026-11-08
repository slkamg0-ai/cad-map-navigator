/**
 * geo.js - 한국 좌표계 처리 + 도면좌표 <-> 지도좌표 정합
 *
 * 도면은 보통 한국 TM 좌표계(EPSG:5174/5181/5186/5187/5188 등) 실측 좌표로
 * 그려져 있다고 가정한다. 이 파일은:
 *   1) proj4 정의 등록 (epsg.io 에서 확인한 정확한 파라미터)
 *   2) 도면 문자열에서 좌표계를 추정
 *   3) 도면좌표 두 점을 지도(Web Mercator) 좌표 두 점에 맞춰, 등각변환
 *      (이동+회전+등방스케일)으로 나머지 모든 점을 옮기는 정합기
 * 를 제공한다.
 */
(function (global) {
  'use strict';

  if (typeof proj4 === 'undefined') {
    console.error('proj4 라이브러리가 로드되지 않았습니다. 지도 배경 기능을 쓸 수 없습니다.');
    return;
  }

  /* ------------------------------------------------------------ 좌표계 정의 */

  // epsg.io 에서 직접 받아 확인한 정확한 파라미터 (pyproj 로 왕복 변환 검증 완료).
  var DEFS = {
    'EPSG:4326': '+proj=longlat +datum=WGS84 +no_defs +type=crs',
    'EPSG:3857': '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs +type=crs',
    // 구 중부원점(Bessel, 수정중부원점) - 옛 수치지형도·지적도에서 흔하다
    'EPSG:5174': '+proj=tmerc +lat_0=38 +lon_0=127.002890277778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +towgs84=-145.907,505.034,685.756,-1.162,2.347,1.592,6.342 +units=m +no_defs +type=crs',
    // Korea 2000, 2000~2009년 체계(y_0=500000)
    'EPSG:5180': '+proj=tmerc +lat_0=38 +lon_0=125 +k=1 +x_0=200000 +y_0=500000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
    'EPSG:5181': '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=500000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
    'EPSG:5182': '+proj=tmerc +lat_0=38 +lon_0=129 +k=1 +x_0=200000 +y_0=500000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
    'EPSG:5183': '+proj=tmerc +lat_0=38 +lon_0=131 +k=1 +x_0=200000 +y_0=500000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
    // Korea 2000, 2010년 개정 체계(y_0=600000) - 현재 표준
    'EPSG:5185': '+proj=tmerc +lat_0=38 +lon_0=125 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
    'EPSG:5186': '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
    'EPSG:5187': '+proj=tmerc +lat_0=38 +lon_0=129 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
    'EPSG:5188': '+proj=tmerc +lat_0=38 +lon_0=131 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs'
  };
  proj4.defs(Object.keys(DEFS).map(function (k) { return [k, DEFS[k]]; }));

  // UI 드롭다운/자동감지에 쓰는 목록 (흔한 순서 - 2010년 체계가 현재 표준)
  var CRS_LIST = [
    { code: 'EPSG:5186', label: '중부원점 2010 (EPSG:5186)', keywords: ['5186', '중부원점'] },
    { code: 'EPSG:5185', label: '서부원점 2010 (EPSG:5185)', keywords: ['5185', '서부원점'] },
    { code: 'EPSG:5187', label: '동부원점 2010 (EPSG:5187)', keywords: ['5187', '동부원점'] },
    { code: 'EPSG:5188', label: '동해원점 2010 (EPSG:5188)', keywords: ['5188', '동해원점'] },
    { code: 'EPSG:5181', label: '중부원점 구계열 (EPSG:5181)', keywords: ['5181'] },
    { code: 'EPSG:5174', label: '수정중부원점 - 구지적도 (EPSG:5174)', keywords: ['5174', '수정중부', 'bessel', '베셀'] },
    { code: 'EPSG:5180', label: '서부원점 구계열 (EPSG:5180)', keywords: ['5180'] },
    { code: 'EPSG:5182', label: '동부원점 구계열 (EPSG:5182)', keywords: ['5182'] },
    { code: 'EPSG:5183', label: '동해원점 구계열 (EPSG:5183)', keywords: ['5183'] },
    { code: 'EPSG:4326', label: '위경도 (EPSG:4326)', keywords: ['4326', 'wgs84', '위경도'] }
  ];
  var DEFAULT_CRS = 'EPSG:5186';

  /**
   * 도면 안의 문자열들을 훑어 좌표계를 추정한다.
   * "EPSG:5186", "EPSG 5186", "중부원점" 같은 표기를 찾는다.
   * 확신 순위: 명시적 EPSG 코드 > 원점 이름 키워드.
   */
  function detectCRS(texts) {
    var joined = texts.join(' ').toLowerCase();
    // 1순위: "EPSG:####" 또는 "EPSG ####" 명시적 표기
    var m = /epsg[\s:]*([0-9]{4,5})/i.exec(joined);
    if (m) {
      var code = 'EPSG:' + m[1];
      if (DEFS[code]) return { code: code, confidence: 'high', reason: 'EPSG 코드 발견: ' + code };
    }
    // 2순위: 원점 이름 키워드
    for (var i = 0; i < CRS_LIST.length; i++) {
      var entry = CRS_LIST[i];
      for (var k = 0; k < entry.keywords.length; k++) {
        if (joined.indexOf(entry.keywords[k]) !== -1) {
          return { code: entry.code, confidence: 'medium', reason: '"' + entry.keywords[k] + '" 표기 발견' };
        }
      }
    }
    return { code: DEFAULT_CRS, confidence: 'none', reason: '좌표계 표기를 찾지 못해 기본값 사용' };
  }

  /* --------------------------------------------------------- 좌표 변환 */

  function toWebMercator(lon, lat) {
    return proj4('EPSG:4326', 'EPSG:3857', [lon, lat]);
  }

  function drawingToMercator(crsCode, x, y) {
    var lonlat = proj4(crsCode, 'EPSG:4326', [x, y]);
    return toWebMercator(lonlat[0], lonlat[1]);
  }

  /**
   * 등각변환(2D similarity transform: 이동+회전+등방스케일) 정합기.
   *
   * 도면좌표계(임의의 TM 좌표)와 Web Mercator 사이에는 축척 왜곡과 자오선
   * 수차(작은 회전)가 있어 단순 평행이동만으로는 안 맞는다. 도면 bbox의
   * 대각 두 점을 실제 좌표계로 변환한 값과 짝지어 복소수 나눗셈 한 번으로
   * 정확한 이동+회전+스케일을 구한다 (Helmert 4-parameter, 최소 2점으로 유일 해).
   *
   * 이렇게 구한 변환의 역함수로 "지도의 임의 지점 -> 가상 도면좌표"를 얻으면,
   * 기존 renderer 의 카메라(scale/ox/oy)를 그대로 재사용해 지도 타일을
   * CAD 도형과 같은 화면 좌표계에 그릴 수 있다.
   */
  function fitSimilarity(crsCode, p1, p2) {
    // 도면좌표 두 점을 Web Mercator 로
    var q1 = drawingToMercator(crsCode, p1[0], p1[1]);
    var q2 = drawingToMercator(crsCode, p2[0], p2[1]);

    var dpx = p2[0] - p1[0], dpy = p2[1] - p1[1];
    var dqx = q2[0] - q1[0], dqy = q2[1] - q1[1];
    var denom = dpx * dpx + dpy * dpy;
    if (denom < 1e-9) throw new Error('기준점 두 개가 너무 가깝습니다.');

    // 복소수 나눗셈 a = dq / dp  (dp, dq 를 복소수로 본다)
    var ar = (dqx * dpx + dqy * dpy) / denom;
    var ai = (dqy * dpx - dqx * dpy) / denom;
    // b = q1 - a*p1
    var br = q1[0] - (ar * p1[0] - ai * p1[1]);
    var bi = q1[1] - (ai * p1[0] + ar * p1[1]);

    var scale = Math.hypot(ar, ai);
    var rotationDeg = Math.atan2(ai, ar) * 180 / Math.PI;

    return {
      crs: crsCode,
      scale: scale,
      rotationDeg: rotationDeg,
      // 도면좌표 -> Web Mercator
      forward: function (x, y) {
        return [ar * x - ai * y + br, ai * x + ar * y + bi];
      },
      // Web Mercator -> "가상 도면좌표" (지도를 CAD 캔버스 좌표계에 그리기 위함)
      inverse: function (mx, my) {
        var dx = mx - br, dy = my - bi;
        var det = ar * ar + ai * ai;
        return [(ar * dx + ai * dy) / det, (ar * dy - ai * dx) / det];
      }
    };
  }

  global.Geo = {
    CRS_LIST: CRS_LIST,
    DEFAULT_CRS: DEFAULT_CRS,
    detectCRS: detectCRS,
    toWebMercator: toWebMercator,
    drawingToMercator: drawingToMercator,
    fitSimilarity: fitSimilarity
  };
})(window);
