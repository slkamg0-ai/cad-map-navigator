/**
 * Coordinate Systems and Transformation Engine
 * Handles Korean Spatial Reference Systems (EPSG:5186, 5185, 5187, 5174, 5179)
 * and 2-Point Helmert 2D Affine Calibration for local CAD coordinates.
 */

export const CRS_DEFINITIONS = {
  'EPSG:5186': {
    name: '한국 중부원점 (GRS80 / 2010 - 표준)',
    proj4: '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs'
  },
  'EPSG:5185': {
    name: '한국 서부원점 (GRS80 / 2010)',
    proj4: '+proj=tmerc +lat_0=38 +lon_0=125 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs'
  },
  'EPSG:5187': {
    name: '한국 동부원점 (GRS80 / 2010)',
    proj4: '+proj=tmerc +lat_0=38 +lon_0=129 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs'
  },
  'EPSG:5188': {
    name: '한국 동해원점 (GRS80 / 울릉도/독도)',
    proj4: '+proj=tmerc +lat_0=38 +lon_0=131 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs'
  },
  'EPSG:5174': {
    name: '한국 구 중부원점 (Bessel 1841 - 과거 지적도)',
    proj4: '+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +units=m +no_defs +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43'
  },
  'EPSG:5179': {
    name: 'UTM-K (GRS80 / 네이버/카카오/국토정보 표준)',
    proj4: '+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs'
  },
  'LOCAL_CALIBRATED': {
    name: '현장 상대좌표 (2점 기준점 보정/매칭)',
    isLocal: true
  }
};

export class CoordinateTransformer {
  constructor() {
    this.selectedCrs = 'EPSG:5186';
    this.unitScale = 1.0; // 1.0 for meters, 0.001 for millimeters
    this.calibration = null; // { p1: {cad, geo}, p2: {cad, geo}, params: {a, b, c, d, scale, rotationDeg} }
    this.initProj4();
  }

  initProj4() {
    if (typeof window.proj4 === 'undefined') {
      console.warn('proj4js not yet loaded');
      return;
    }
    // Register definitions
    for (const [code, def] of Object.entries(CRS_DEFINITIONS)) {
      if (def.proj4) {
        window.proj4.defs(code, def.proj4);
      }
    }
  }

  setCrs(crsKey) {
    this.selectedCrs = crsKey;
  }

  setUnitScale(scale) {
    this.unitScale = scale;
  }

  /**
   * Automatically detect if CAD coordinates are in millimeters (e.g. > 1,000,000 for standard Korean coords)
   */
  autoDetectUnitScale(bounds) {
    const maxVal = Math.max(Math.abs(bounds.minX), Math.abs(bounds.maxX), Math.abs(bounds.minY), Math.abs(bounds.maxY));
    if (maxVal > 5000000) {
      // Very likely in millimeters (e.g. 200,000,000 mm = 200,000 m)
      this.unitScale = 0.001;
      return 0.001;
    }
    this.unitScale = 1.0;
    return 1.0;
  }

  /**
   * Set 2-Point Ground Control Calibration
   * @param {Object} pt1 { cad: {x, y}, geo: {lat, lng} }
   * @param {Object} pt2 { cad: {x, y}, geo: {lat, lng} }
   * @param {string} baseProj Projection to project geo (lat/lng) into meters (defaults to EPSG:5186 or EPSG:5179)
   */
  set2PointCalibration(pt1, pt2, baseProj = 'EPSG:5186') {
    // Project geographic lat/lng to projected meter coordinates
    const p1_proj = window.proj4('EPSG:4326', baseProj, [pt1.geo.lng, pt1.geo.lat]);
    const p2_proj = window.proj4('EPSG:4326', baseProj, [pt2.geo.lng, pt2.geo.lat]);

    const x1 = pt1.cad.x;
    const y1 = pt1.cad.y;
    const x2 = pt2.cad.x;
    const y2 = pt2.cad.y;

    const X1 = p1_proj[0];
    const Y1 = p1_proj[1];
    const X2 = p2_proj[0];
    const Y2 = p2_proj[1];

    const dx = x2 - x1;
    const dy = y2 - y1;
    const dX = X2 - X1;
    const dY = Y2 - Y1;

    const denom = dx * dx + dy * dy;
    if (denom === 0) {
      throw new Error('기준점 1과 기준점 2의 캐드 좌표가 동일합니다.');
    }

    // 2D Helmert conformal transformation:
    // [ X ] = [ a -b ] [ x ] + [ c ]
    // [ Y ]   [ b  a ] [ y ]   [ d ]
    const a = (dx * dX + dy * dY) / denom;
    const b = (dx * dY - dy * dX) / denom;
    const c = X1 - (a * x1 - b * y1);
    const d = Y1 - (b * x1 + a * y1);

    const scale = Math.sqrt(a * a + b * b);
    const rotationRad = Math.atan2(b, a);
    const rotationDeg = (rotationRad * 180) / Math.PI;

    this.calibration = {
      baseProj,
      pt1,
      pt2,
      params: { a, b, c, d, scale, rotationDeg }
    };

    return this.calibration;
  }

  clearCalibration() {
    this.calibration = null;
  }

  /**
   * Convert CAD (x, y) to Geographic [lat, lng]
   * @param {number} rawX 
   * @param {number} rawY 
   * @returns {[number, number]} [lat, lng]
   */
  cadToLatLng(rawX, rawY) {
    if (this.selectedCrs === 'LOCAL_CALIBRATED' || this.calibration) {
      if (!this.calibration) {
        throw new Error('2점 기준점 캘리브레이션이 설정되지 않았습니다.');
      }
      const { a, b, c, d } = this.calibration.params;
      const projX = a * rawX - b * rawY + c;
      const projY = b * rawX + a * rawY + d;
      const wgs84 = window.proj4(this.calibration.baseProj, 'EPSG:4326', [projX, projY]);
      return [wgs84[1], wgs84[0]]; // [lat, lng]
    }

    const x = rawX * this.unitScale;
    const y = rawY * this.unitScale;

    try {
      const wgs84 = window.proj4(this.selectedCrs, 'EPSG:4326', [x, y]);
      if (isNaN(wgs84[0]) || isNaN(wgs84[1])) {
        return null;
      }
      return [wgs84[1], wgs84[0]]; // [lat, lng]
    } catch (err) {
      console.error('Coordinate transform error:', err);
      return null;
    }
  }

  /**
   * Convert Geographic [lat, lng] to CAD (x, y)
   * @param {number} lat 
   * @param {number} lng 
   * @returns {[number, number]} [cadX, cadY]
   */
  latLngToCad(lat, lng) {
    if (this.selectedCrs === 'LOCAL_CALIBRATED' || this.calibration) {
      if (!this.calibration) return null;
      const { a, b, c, d } = this.calibration.params;
      const proj = window.proj4('EPSG:4326', this.calibration.baseProj, [lng, lat]);
      const X = proj[0] - c;
      const Y = proj[1] - d;
      const det = a * a + b * b;
      const x = (a * X + b * Y) / det;
      const y = (-b * X + a * Y) / det;
      return [x, y];
    }

    try {
      const proj = window.proj4('EPSG:4326', this.selectedCrs, [lng, lat]);
      return [proj[0] / this.unitScale, proj[1] / this.unitScale];
    } catch (err) {
      return null;
    }
  }
}
