/**
 * Leaflet Map Controller with VWorld Satellite & Multi-CAD Vector Overlay
 */

export class MapManager {
  constructor(mapContainerId, options = {}) {
    this.containerId = mapContainerId;
    this.options = options;
    this.map = null;
    this.tileLayers = {};
    this.currentTileKey = 'vworld_sat';
    this.hybridLayer = null;

    // Multi-CAD Drawing Layer Groups: drawingId -> L.featureGroup()
    this.drawingGroups = new Map();
    this.cadOpacity = 0.9;
    this.cadColorMode = 'cad'; // 'cad' | 'high_contrast'
    this.highContrastColor = '#ffff00';

    // User & Target Markers
    this.userMarker = null;
    this.userAccuracyCircle = null;
    this.targetMarker = null;
    this.guidePolyline = null; // Line between user and target

    // Interaction callbacks
    this.onCadPointSelect = options.onCadPointSelect || null;
    this.onMapClick = options.onMapClick || null;

    this.initMap();
  }

  initMap() {
    this.map = L.map(this.containerId, {
      center: [37.5665, 126.9780],
      zoom: 17,
      maxZoom: 22,
      zoomControl: false, // Disabled for clean full-screen mobile experience
      attributionControl: false
    });

    this.setupTileLayers();

    this.map.on('click', (e) => {
      if (this.onMapClick) {
        this.onMapClick(e.latlng);
      }
    });
  }

  setupTileLayers() {
    this.tileLayers['vworld_sat'] = L.tileLayer(
      'https://xdworld.vworld.kr/2d/Satellite/service/{z}/{x}/{y}.jpeg',
      { minZoom: 6, maxZoom: 19, subdomains: [] }
    );

    this.hybridLayer = L.tileLayer(
      'https://xdworld.vworld.kr/2d/Hybrid/service/{z}/{x}/{y}.png',
      { minZoom: 6, maxZoom: 19, zIndex: 5 }
    );

    this.tileLayers['vworld_base'] = L.tileLayer(
      'https://xdworld.vworld.kr/2d/Base/service/{z}/{x}/{y}.png',
      { minZoom: 6, maxZoom: 19 }
    );

    this.tileLayers['esri_sat'] = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19 }
    );

    this.tileLayers['osm'] = L.tileLayer(
      'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      { maxZoom: 19 }
    );

    // Default: VWorld Satellite + Hybrid
    this.tileLayers['vworld_sat'].addTo(this.map);
    this.hybridLayer.addTo(this.map);
  }

  setBaseMap(key) {
    if (!this.tileLayers[key]) return;

    if (this.tileLayers[this.currentTileKey]) {
      this.map.removeLayer(this.tileLayers[this.currentTileKey]);
    }

    this.tileLayers[key].addTo(this.map);
    this.currentTileKey = key;

    if (key === 'vworld_sat' || key === 'esri_sat') {
      if (!this.map.hasLayer(this.hybridLayer)) {
        this.hybridLayer.addTo(this.map);
      }
    } else {
      if (this.map.hasLayer(this.hybridLayer)) {
        this.map.removeLayer(this.hybridLayer);
      }
    }
  }

  setHybridVisible(visible) {
    if (visible) {
      if (!this.map.hasLayer(this.hybridLayer)) this.hybridLayer.addTo(this.map);
    } else {
      if (this.map.hasLayer(this.hybridLayer)) this.map.removeLayer(this.hybridLayer);
    }
  }

  setCadOpacity(opacity) {
    this.cadOpacity = opacity;
    this.drawingGroups.forEach((group) => {
      group.eachLayer((layer) => {
        if (layer.setStyle) {
          layer.setStyle({ opacity, fillOpacity: opacity * 0.4 });
        }
      });
    });
  }

  setCadColorMode(mode, customColor = '#ffff00') {
    this.cadColorMode = mode;
    this.highContrastColor = customColor;
    this.refreshAllStyles();
  }

  refreshAllStyles() {
    this.drawingGroups.forEach((group, drawingId) => {
      const drawingColor = group.drawingColorOverride;
      group.eachLayer((layer) => {
        if (!layer.dxfMeta) return;
        const color = drawingColor || (this.cadColorMode === 'high_contrast' ? this.highContrastColor : (layer.dxfMeta.color || '#00ffff'));
        if (layer.setStyle) {
          layer.setStyle({
            color: color,
            opacity: this.cadOpacity,
            fillOpacity: this.cadOpacity * 0.3
          });
        }
      });
    });
  }

  /**
   * Render Multi-CAD Drawings onto Map
   * @param {Array} drawings Array of { id, name, entities, layers, visible, color, unitScale }
   * @param {CoordinateTransformer} transformer 
   */
  renderMultiDrawings(drawings, transformer) {
    // Clear old drawing groups
    this.drawingGroups.forEach((grp) => {
      if (this.map.hasLayer(grp)) {
        this.map.removeLayer(grp);
      }
    });
    this.drawingGroups.clear();

    const allBoundsLatLngs = [];

    drawings.forEach((drawing) => {
      if (drawing.visible === false) return;

      const group = L.featureGroup();
      group.drawingId = drawing.id;
      group.drawingColorOverride = drawing.color || null;

      drawing.entities.forEach((entity, index) => {
        const layerInfo = drawing.layers[entity.layer] || { visible: true };
        if (layerInfo.visible === false) return;

        const baseColor = drawing.color || (this.cadColorMode === 'high_contrast'
          ? this.highContrastColor
          : (entity.color || layerInfo.color || '#00e5ff'));

        const meta = {
          drawingId: drawing.id,
          drawingName: drawing.name,
          index,
          type: entity.type,
          layer: entity.layer,
          color: baseColor
        };

        const commonStyle = {
          color: baseColor,
          weight: 2.5,
          opacity: this.cadOpacity,
          lineCap: 'round',
          lineJoin: 'round'
        };

        const unitScale = drawing.unitScale || transformer.unitScale;

        switch (entity.type) {
          case 'LINE': {
            const pt1 = transformer.cadToLatLng(entity.x1 * unitScale / transformer.unitScale, entity.y1 * unitScale / transformer.unitScale);
            const pt2 = transformer.cadToLatLng(entity.x2 * unitScale / transformer.unitScale, entity.y2 * unitScale / transformer.unitScale);
            if (pt1 && pt2) {
              const line = L.polyline([pt1, pt2], commonStyle);
              line.dxfMeta = meta;
              line.cadEndpoints = [
                { x: entity.x1, y: entity.y1, latLng: pt1 },
                { x: entity.x2, y: entity.y2, latLng: pt2 }
              ];
              this.bindCadEntityClick(line, `선 (${entity.layer})`, drawing.name);
              group.addLayer(line);
              allBoundsLatLngs.push(pt1, pt2);
            }
            break;
          }

          case 'LWPOLYLINE':
          case 'POLYLINE': {
            if (!entity.vertices || entity.vertices.length < 2) break;
            const latLngs = [];
            const endpoints = [];

            entity.vertices.forEach((v) => {
              const ll = transformer.cadToLatLng(v.x * unitScale / transformer.unitScale, v.y * unitScale / transformer.unitScale);
              if (ll) {
                latLngs.push(ll);
                endpoints.push({ x: v.x, y: v.y, latLng: ll });
                allBoundsLatLngs.push(ll);
              }
            });

            if (latLngs.length >= 2) {
              let poly;
              if (entity.closed && latLngs.length >= 3) {
                poly = L.polygon(latLngs, {
                  ...commonStyle,
                  fillColor: baseColor,
                  fillOpacity: this.cadOpacity * 0.25
                });
              } else {
                poly = L.polyline(latLngs, commonStyle);
              }
              poly.dxfMeta = meta;
              poly.cadEndpoints = endpoints;
              this.bindCadEntityClick(poly, `폴리라인 (${entity.layer})`, drawing.name);
              group.addLayer(poly);
            }
            break;
          }

          case 'CIRCLE': {
            const center = transformer.cadToLatLng(entity.cx * unitScale / transformer.unitScale, entity.cy * unitScale / transformer.unitScale);
            if (center) {
              const radiusM = entity.radius * unitScale;
              const circle = L.circle(center, {
                ...commonStyle,
                radius: radiusM,
                fillColor: baseColor,
                fillOpacity: this.cadOpacity * 0.2
              });
              circle.dxfMeta = meta;
              circle.cadCenter = { x: entity.cx, y: entity.cy, latLng: center };
              this.bindCadEntityClick(circle, `원 (r=${radiusM.toFixed(1)}m)`, drawing.name);
              group.addLayer(circle);
              allBoundsLatLngs.push(center);
            }
            break;
          }

          case 'POINT': {
            const pt = transformer.cadToLatLng(entity.x * unitScale / transformer.unitScale, entity.y * unitScale / transformer.unitScale);
            if (pt) {
              const marker = L.circleMarker(pt, {
                radius: 5,
                color: '#ffffff',
                weight: 1.5,
                fillColor: baseColor,
                fillOpacity: 1.0
              });
              marker.dxfMeta = meta;
              marker.cadPoint = { x: entity.x, y: entity.y, latLng: pt };
              this.bindCadEntityClick(marker, `측점 (${entity.layer})`, drawing.name);
              group.addLayer(marker);
              allBoundsLatLngs.push(pt);
            }
            break;
          }

          case 'TEXT':
          case 'MTEXT': {
            const pt = transformer.cadToLatLng(entity.x * unitScale / transformer.unitScale, entity.y * unitScale / transformer.unitScale);
            if (pt && entity.text) {
              const cleanText = entity.text.replace(/\\P/g, ' ').replace(/\\[A-Za-z0-9]+;/g, '');
              const textIcon = L.divIcon({
                className: 'cad-text-label',
                html: `<span style="color:${baseColor}; text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000; font-size: 11px; font-weight: bold; white-space: nowrap;">${cleanText}</span>`,
                iconAnchor: [0, 0]
              });
              const textMarker = L.marker(pt, { icon: textIcon });
              textMarker.dxfMeta = meta;
              textMarker.cadPoint = { x: entity.x, y: entity.y, latLng: pt };
              this.bindCadEntityClick(textMarker, `텍스트: ${cleanText}`, drawing.name);
              group.addLayer(textMarker);
              allBoundsLatLngs.push(pt);
            }
            break;
          }
        }
      });

      group.addTo(this.map);
      this.drawingGroups.set(drawing.id, group);
    });

    if (allBoundsLatLngs.length > 0) {
      const bounds = L.latLngBounds(allBoundsLatLngs);
      this.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 19 });
    }
  }

  bindCadEntityClick(leafletLayer, defaultLabel, drawingName) {
    leafletLayer.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      const clickedLatLng = e.latlng;

      let targetCad = null;
      let targetLatLng = clickedLatLng;

      if (leafletLayer.cadCenter) {
        targetCad = leafletLayer.cadCenter;
        targetLatLng = L.latLng(leafletLayer.cadCenter.latLng[0], leafletLayer.cadCenter.latLng[1]);
      } else if (leafletLayer.cadPoint) {
        targetCad = leafletLayer.cadPoint;
        targetLatLng = L.latLng(leafletLayer.cadPoint.latLng[0], leafletLayer.cadPoint.latLng[1]);
      } else if (leafletLayer.cadEndpoints && leafletLayer.cadEndpoints.length > 0) {
        let closest = leafletLayer.cadEndpoints[0];
        let minDist = clickedLatLng.distanceTo(L.latLng(closest.latLng[0], closest.latLng[1]));
        for (let i = 1; i < leafletLayer.cadEndpoints.length; i++) {
          const pt = leafletLayer.cadEndpoints[i];
          const dist = clickedLatLng.distanceTo(L.latLng(pt.latLng[0], pt.latLng[1]));
          if (dist < minDist) {
            minDist = dist;
            closest = pt;
          }
        }
        targetCad = closest;
        targetLatLng = L.latLng(closest.latLng[0], closest.latLng[1]);
      }

      const waypoint = {
        lat: targetLatLng.lat,
        lng: targetLatLng.lng,
        cadX: targetCad ? targetCad.x : null,
        cadY: targetCad ? targetCad.y : null,
        label: `[${drawingName}] ${defaultLabel}`,
        drawingName: drawingName
      };

      if (this.onCadPointSelect) {
        this.onCadPointSelect(waypoint);
      }
    });
  }

  /**
   * Update User Position Marker & Accuracy Circle
   */
  updateUserLocation(pos, compassHeading = null) {
    const latLng = [pos.lat, pos.lng];

    if (!this.userMarker) {
      const userIcon = L.divIcon({
        className: 'user-gps-container',
        html: `
          <div class="user-gps-marker">
            <div class="user-gps-beam" id="user-heading-beam"></div>
            <div class="user-gps-dot"></div>
          </div>
        `,
        iconSize: [36, 36],
        iconAnchor: [18, 18]
      });

      this.userMarker = L.marker(latLng, { icon: userIcon, zIndexOffset: 1000 }).addTo(this.map);
      this.userAccuracyCircle = L.circle(latLng, {
        radius: pos.accuracy || 5,
        color: '#3b82f6',
        weight: 1,
        fillColor: '#60a5fa',
        fillOpacity: 0.15
      }).addTo(this.map);
    } else {
      this.userMarker.setLatLng(latLng);
      this.userAccuracyCircle.setLatLng(latLng);
      if (pos.accuracy) {
        this.userAccuracyCircle.setRadius(pos.accuracy);
      }
    }

    const beam = document.getElementById('user-heading-beam');
    if (beam && compassHeading !== null) {
      beam.style.transform = `rotate(${compassHeading}deg)`;
      beam.style.display = 'block';
    } else if (beam) {
      beam.style.display = 'none';
    }

    this.updateGuidePolyline();
  }

  setTargetWaypoint(waypoint) {
    const latLng = [waypoint.lat, waypoint.lng];

    if (this.targetMarker) {
      this.map.removeLayer(this.targetMarker);
    }

    const targetIcon = L.divIcon({
      className: 'target-pin-container',
      html: `
        <div class="target-pin-pulse"></div>
        <div class="target-pin-flag">🎯</div>
      `,
      iconSize: [36, 36],
      iconAnchor: [18, 18]
    });

    this.targetMarker = L.marker(latLng, { icon: targetIcon, zIndexOffset: 999 }).addTo(this.map);
    this.updateGuidePolyline();
  }

  clearTargetWaypoint() {
    if (this.targetMarker) {
      this.map.removeLayer(this.targetMarker);
      this.targetMarker = null;
    }
    if (this.guidePolyline) {
      this.map.removeLayer(this.guidePolyline);
      this.guidePolyline = null;
    }
  }

  updateGuidePolyline() {
    if (!this.userMarker || !this.targetMarker) {
      if (this.guidePolyline) {
        this.map.removeLayer(this.guidePolyline);
        this.guidePolyline = null;
      }
      return;
    }

    const userLatLng = this.userMarker.getLatLng();
    const targetLatLng = this.targetMarker.getLatLng();

    if (!this.guidePolyline) {
      this.guidePolyline = L.polyline([userLatLng, targetLatLng], {
        color: '#f59e0b',
        weight: 3,
        dashArray: '8, 8',
        opacity: 0.85
      }).addTo(this.map);
    } else {
      this.guidePolyline.setLatLngs([userLatLng, targetLatLng]);
    }
  }

  centerOnUser() {
    if (this.userMarker) {
      this.map.setView(this.userMarker.getLatLng(), Math.max(this.map.getZoom(), 18), { animate: true });
    }
  }

  centerOnCad() {
    const allLayers = [];
    this.drawingGroups.forEach((group) => {
      if (this.map.hasLayer(group) && group.getLayers().length > 0) {
        allLayers.push(...group.getLayers());
      }
    });

    if (allLayers.length > 0) {
      const tempGroup = L.featureGroup(allLayers);
      this.map.fitBounds(tempGroup.getBounds(), { padding: [40, 40], animate: true });
    }
  }
}
