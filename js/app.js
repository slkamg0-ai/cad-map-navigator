/**
 * Main Application Controller - Dual Mode (Pure CAD Viewer + Field Map GPS Navigation)
 * CAD-to-Map Overlay & Mobile GPS Navigation
 */

import { DxfParser } from './dxfParser.js';
import { CoordinateTransformer, CRS_DEFINITIONS } from './coordinateTransform.js';
import { GpsNavigator } from './gpsNavigator.js';
import { MapManager } from './mapManager.js';
import { CadCanvasViewer } from './cadCanvasViewer.js';
import { SAMPLE_DXF_TEXT } from './sampleData.js';

class CadNavigatorApp {
  constructor() {
    this.parser = new DxfParser();
    this.transformer = new CoordinateTransformer();

    // Multi-CAD Drawings Stack: Array of { id, name, entities, layers, bounds, totalCount, visible, color, unitScale }
    this.drawings = [];
    this.uploadMode = 'replace'; // 'replace' | 'append'
    this.presetColors = ['#ffff00', '#00ffff', '#ff3399', '#00ff66', '#ff9900', '#a855f7', '#38bdf8', '#f43f5e'];

    // Dual Mode state: 'map' | 'cad'
    this.currentMode = 'map';

    // UI state
    this.isGpsActive = false;
    this.simMode = false;
    this.isUiHidden = false;
    this.isHudCollapsed = false;
    this.autoHideEnabled = true;
    this.autoHideTimer = null;
    this.statusToastTimer = null;
    this.calibrationMode = null;

    this.initMap();
    this.initCadViewer();
    this.initNavigator();
    this.initDomEvents();
    this.populateCrsOptions();
    this.setupAutoHideTimer();

    // Auto load sample CAD on first boot
    setTimeout(() => {
      this.loadSampleCad('replace');
    }, 400);
  }

  initMap() {
    this.mapMgr = new MapManager('map', {
      onCadPointSelect: (waypoint) => this.onCadWaypointSelected(waypoint),
      onMapClick: (latLng) => this.onMapClicked(latLng)
    });
  }

  initCadViewer() {
    this.cadViewer = new CadCanvasViewer('cad-viewer-container', {
      onSelectPointForMap: (vertex) => this.handoffCadPointToMap(vertex)
    });
  }

  initNavigator() {
    this.navigator = new GpsNavigator({
      onLocationUpdate: (pos, navState) => this.updateLocationUI(pos, navState),
      onOrientationUpdate: (heading, navState) => this.updateOrientationUI(heading, navState),
      onArrival: (waypoint, navState) => this.handleArrival(waypoint, navState),
      onGpsError: (err) => this.handleGpsError(err)
    });
  }

  populateCrsOptions() {
    const sel = document.getElementById('crs-select');
    sel.innerHTML = '';
    for (const [key, val] of Object.entries(CRS_DEFINITIONS)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = `${key} - ${val.name}`;
      if (key === 'EPSG:5186') opt.selected = true;
      sel.appendChild(opt);
    }
  }

  initDomEvents() {
    // -------------------------------------------------------------
    // Dual-Mode Switching (Field Map <--> Pure CAD Viewer)
    // -------------------------------------------------------------
    document.getElementById('tab-mode-map').addEventListener('click', () => {
      this.switchMode('map');
    });

    document.getElementById('tab-mode-cad').addEventListener('click', () => {
      this.switchMode('cad');
    });

    // -------------------------------------------------------------
    // CAD Mode Toolbar Buttons
    // -------------------------------------------------------------
    document.getElementById('btn-cad-fit').addEventListener('click', () => {
      if (this.cadViewer) {
        this.cadViewer.fitExtents();
        this.showStatusToast('📐 도면 전체 맞춤');
      }
      this.resetAutoHideTimer();
    });

    const btnMeasure = document.getElementById('btn-cad-measure');
    btnMeasure.addEventListener('click', () => {
      if (this.cadViewer) {
        const isMeasuring = this.cadViewer.toggleMeasureMode();
        if (isMeasuring) {
          btnMeasure.classList.add('border-amber-400', 'text-amber-300');
          this.showToast('📏 치수 측정 모드: 도면 상의 두 점을 터치하세요');
        } else {
          btnMeasure.classList.remove('border-amber-400', 'text-amber-300');
          this.showToast('치수 측정 모드 해제');
        }
      }
      this.resetAutoHideTimer();
    });

    document.getElementById('btn-close-cad-sel').addEventListener('click', () => {
      this.cadViewer.hideSelectionPopup();
    });

    // -------------------------------------------------------------
    // Settings Drawer Controls
    // -------------------------------------------------------------
    const openDrawer = () => {
      document.getElementById('settings-drawer-backdrop').classList.remove('hidden');
      this.wakeUpUI();
    };

    const closeDrawer = () => {
      document.getElementById('settings-drawer-backdrop').classList.add('hidden');
      this.resetAutoHideTimer();
    };

    document.getElementById('btn-open-settings').addEventListener('click', openDrawer);
    document.getElementById('top-info-pill').addEventListener('click', openDrawer);
    document.getElementById('btn-close-settings').addEventListener('click', closeDrawer);
    document.getElementById('btn-close-settings-bottom').addEventListener('click', closeDrawer);

    document.getElementById('settings-drawer-backdrop').addEventListener('click', (e) => {
      if (e.target.id === 'settings-drawer-backdrop') closeDrawer();
    });

    // -------------------------------------------------------------
    // Fullscreen / UI Hide Toggle
    // -------------------------------------------------------------
    document.getElementById('btn-toggle-ui').addEventListener('click', () => {
      this.isUiHidden = !this.isUiHidden;
      const elements = document.querySelectorAll('.ui-autohide');
      const icon = document.getElementById('icon-ui-toggle');

      if (this.isUiHidden) {
        elements.forEach((el) => {
          if (el.id !== 'btn-toggle-ui') el.classList.add('ui-hidden-completely');
        });
        icon.textContent = '🗺️';
        this.showToast('전체화면 모드 (터치하면 메뉴가 나타납니다)');
      } else {
        elements.forEach((el) => el.classList.remove('ui-hidden-completely', 'ui-dimmed'));
        icon.textContent = '👁️';
      }
      this.resetAutoHideTimer();
    });

    // -------------------------------------------------------------
    // Multi-CAD File Upload & Sample Controls
    // -------------------------------------------------------------
    const fileInput = document.getElementById('dxf-file-input');

    document.getElementById('btn-open-new-dxf').addEventListener('click', () => {
      this.uploadMode = 'replace';
      fileInput.value = '';
      fileInput.click();
    });

    document.getElementById('btn-append-dxf').addEventListener('click', () => {
      this.uploadMode = 'append';
      fileInput.value = '';
      fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        this.readDxfFile(file, this.uploadMode);
        closeDrawer();
      }
    });

    document.getElementById('btn-sample-cad').addEventListener('click', () => {
      const mode = this.drawings.length === 0 ? 'replace' : 'append';
      this.loadSampleCad(mode);
      closeDrawer();
    });

    document.getElementById('btn-clear-all-drawings').addEventListener('click', () => {
      if (confirm('모든 도면을 화면에서 삭제하시겠습니까?')) {
        this.drawings = [];
        this.reprojectAndRender();
        this.buildDrawingsList();
        this.buildLayerList();
        this.showStatusToast('모든 도면이 삭제되었습니다.');
      }
    });

    // -------------------------------------------------------------
    // Base Map Switching (For Map Mode)
    // -------------------------------------------------------------
    document.querySelectorAll('[data-map-base]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const baseKey = e.currentTarget.getAttribute('data-map-base');
        this.mapMgr.setBaseMap(baseKey);
        document.querySelectorAll('[data-map-base]').forEach((b) => b.classList.remove('active-map-tab'));
        e.currentTarget.classList.add('active-map-tab');

        const mapNames = {
          'vworld_sat': 'VWorld 항공사진',
          'vworld_base': 'VWorld 일반지도',
          'esri_sat': 'Esri 위성사진',
          'osm': 'OpenStreetMap'
        };
        this.showStatusToast(`🛰️ 배경 지도: ${mapNames[baseKey] || baseKey}`);
      });
    });

    const chkHybrid = document.getElementById('chk-hybrid');
    if (chkHybrid) {
      chkHybrid.addEventListener('change', (e) => {
        this.mapMgr.setHybridVisible(e.target.checked);
        this.showStatusToast(`지명/도로 라벨: ${e.target.checked ? 'ON' : 'OFF'}`);
      });
    }

    // -------------------------------------------------------------
    // Coordinate System & Scale
    // -------------------------------------------------------------
    document.getElementById('crs-select').addEventListener('change', (e) => {
      const crs = e.target.value;
      if (crs === 'LOCAL_CALIBRATED') {
        this.openCalibrationModal();
      } else {
        this.transformer.setCrs(crs);
        this.reprojectAndRender();
        this.showStatusToast(`📐 좌표계: ${crs}`);
      }
    });

    document.getElementById('unit-scale-select').addEventListener('change', (e) => {
      const scale = parseFloat(e.target.value);
      this.transformer.setUnitScale(scale);
      this.drawings.forEach((d) => { d.unitScale = scale; });
      this.reprojectAndRender();
      this.showStatusToast(`도면 단위: ${scale === 1.0 ? '미터(m)' : '밀리미터(mm)'}`);
    });

    // -------------------------------------------------------------
    // CAD Opacity & High Contrast
    // -------------------------------------------------------------
    const opacitySlider = document.getElementById('cad-opacity');
    opacitySlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      this.mapMgr.setCadOpacity(val);
      document.getElementById('cad-opacity-val').textContent = `${Math.round(val * 100)}%`;
    });

    document.getElementById('btn-color-mode').addEventListener('click', () => {
      const isHighContrast = this.mapMgr.cadColorMode === 'high_contrast';
      const nextMode = isHighContrast ? 'cad' : 'high_contrast';
      this.mapMgr.setCadColorMode(nextMode);
      document.getElementById('btn-color-mode').textContent = nextMode === 'high_contrast' ? '🎨 원본 색상' : '✨ 형광 노랑';
      this.showStatusToast(`도면 색상: ${nextMode === 'high_contrast' ? '형광 노랑' : '도면별 구분 색상'}`);
    });

    // -------------------------------------------------------------
    // Map Mode: GPS & Floating Buttons
    // -------------------------------------------------------------
    const btnGps = document.getElementById('btn-toggle-gps');
    btnGps.addEventListener('click', () => {
      if (this.isGpsActive) {
        this.navigator.stopTracking();
        this.isGpsActive = false;
        btnGps.classList.remove('bg-blue-600', 'text-white');
        btnGps.classList.add('bg-slate-800/90', 'text-slate-300');
        document.getElementById('gps-status-badge').innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-slate-500"></span>GPS';
        this.showStatusToast('🛰️ GPS 추적 중지됨');
      } else {
        try {
          this.navigator.startTracking();
          this.isGpsActive = true;
          this.simMode = false;
          btnGps.classList.remove('bg-slate-800/90', 'text-slate-300');
          btnGps.classList.add('bg-blue-600', 'text-white');
          document.getElementById('gps-status-badge').innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></span>GPS';
          this.showStatusToast('🛰️ GPS 연결 시도 중...');
        } catch (err) {
          alert('GPS 오류: ' + err.message);
        }
      }
      this.resetAutoHideTimer();
    });

    document.getElementById('btn-center-user').addEventListener('click', () => {
      this.mapMgr.centerOnUser();
      this.showStatusToast('📍 내 위치로 이동');
      this.resetAutoHideTimer();
    });

    document.getElementById('btn-center-cad').addEventListener('click', () => {
      this.mapMgr.centerOnCad();
      this.showStatusToast('🗺️ 도면 전체 보기');
      this.resetAutoHideTimer();
    });

    document.getElementById('btn-sim-gps').addEventListener('click', () => {
      this.simMode = !this.simMode;
      const btn = document.getElementById('btn-sim-gps');
      if (this.simMode) {
        btn.classList.add('border-amber-400', 'text-amber-300');
        this.showToast('🎮 모의 GPS: 지도를 클릭한 곳으로 내 위치가 이동합니다');
      } else {
        btn.classList.remove('border-amber-400', 'text-amber-300');
        this.showToast('모의 GPS 종료');
      }
      this.resetAutoHideTimer();
    });

    // -------------------------------------------------------------
    // Navigation HUD Controls
    // -------------------------------------------------------------
    const hud = document.getElementById('navigation-hud');
    document.getElementById('btn-collapse-hud').addEventListener('click', () => {
      hud.classList.add('is-collapsed');
      this.isHudCollapsed = true;
      this.resetAutoHideTimer();
    });

    document.getElementById('btn-expand-hud').addEventListener('click', () => {
      hud.classList.remove('is-collapsed');
      this.isHudCollapsed = false;
      this.resetAutoHideTimer();
    });

    const closeHud = () => {
      this.navigator.clearTargetWaypoint();
      this.mapMgr.clearTargetWaypoint();
      hud.classList.add('hidden');
      this.resetAutoHideTimer();
    };

    document.getElementById('btn-close-hud').addEventListener('click', closeHud);
    document.getElementById('btn-close-hud-mini').addEventListener('click', closeHud);

    // -------------------------------------------------------------
    // Calibration Modal Controls
    // -------------------------------------------------------------
    document.getElementById('btn-open-calibration').addEventListener('click', () => {
      closeDrawer();
      this.openCalibrationModal();
    });
    document.getElementById('btn-close-calib').addEventListener('click', () => {
      this.closeCalibrationModal();
    });
    document.getElementById('btn-apply-calib').addEventListener('click', () => {
      this.applyCalibration();
    });

    const chkAutoHide = document.getElementById('chk-auto-hide');
    if (chkAutoHide) {
      chkAutoHide.addEventListener('change', (e) => {
        this.autoHideEnabled = e.target.checked;
        if (!this.autoHideEnabled) this.wakeUpUI();
        else this.resetAutoHideTimer();
      });
    }

    ['touchstart', 'mousedown', 'mousemove'].forEach((evt) => {
      window.addEventListener(evt, () => this.handleUserActivity(), { passive: true });
    });
  }

  // ---------------------------------------------------------------
  // Dual-Mode Switching Controller
  // ---------------------------------------------------------------
  switchMode(mode) {
    if (this.currentMode === mode) return;
    this.currentMode = mode;

    const mapEl = document.getElementById('map');
    const cadEl = document.getElementById('cad-viewer-container');
    const mapFab = document.getElementById('right-fab-toolbar');
    const cadFab = document.getElementById('cad-fab-toolbar');
    const cadBottom = document.getElementById('cad-bottom-info');

    const tabMap = document.getElementById('tab-mode-map');
    const tabCad = document.getElementById('tab-mode-cad');

    if (mode === 'cad') {
      mapEl.classList.add('hidden');
      cadEl.classList.remove('hidden');

      mapFab.classList.add('hidden');
      cadFab.classList.remove('hidden');
      cadBottom.classList.remove('hidden');

      tabMap.classList.remove('active-mode-tab');
      tabMap.classList.add('text-slate-300');
      tabCad.classList.add('active-mode-tab');
      tabCad.classList.remove('text-slate-300');

      this.cadViewer.initCanvasSize();
      this.cadViewer.setDrawings(this.drawings);
      this.showStatusToast('📐 순수 CAD 뷰어 모드 (치수/도면 검토)');
    } else {
      cadEl.classList.add('hidden');
      mapEl.classList.remove('hidden');

      cadFab.classList.add('hidden');
      cadBottom.classList.add('hidden');
      mapFab.classList.remove('hidden');

      tabCad.classList.remove('active-mode-tab');
      tabCad.classList.add('text-slate-300');
      tabMap.classList.add('active-mode-tab');
      tabMap.classList.remove('text-slate-300');

      this.mapMgr.map.invalidateSize();
      this.mapMgr.renderMultiDrawings(this.drawings, this.transformer);
      this.showStatusToast('🛰️ 현장 지도/GPS 네비게이션 모드');
    }

    this.resetAutoHideTimer();
  }

  /**
   * Handoff CAD Selected Point into Map & GPS Navigation
   */
  handoffCadPointToMap(vertex) {
    const drawing = this.drawings.find((d) => d.name === vertex.drawingName) || this.drawings[0];
    const unitScale = drawing ? drawing.unitScale : this.transformer.unitScale;

    // Convert CAD coordinate to geographic lat/lng
    const latLng = this.transformer.cadToLatLng(
      vertex.x * unitScale / this.transformer.unitScale,
      vertex.y * unitScale / this.transformer.unitScale
    );

    if (!latLng) {
      alert('이 도면의 좌표를 위경도로 변환할 수 없습니다. 좌표계를 확인하거나 2점 보정을 설정하세요.');
      return;
    }

    // 1. Switch to Map Mode
    this.switchMode('map');

    // 2. Set as Target Waypoint
    const waypoint = {
      lat: latLng[0],
      lng: latLng[1],
      cadX: vertex.x,
      cadY: vertex.y,
      label: `[${vertex.drawingName}] ${vertex.label}`,
      drawingName: vertex.drawingName
    };

    this.onCadWaypointSelected(waypoint);

    // 3. Center map on this target
    this.mapMgr.map.setView([waypoint.lat, waypoint.lng], 19, { animate: true });
    this.showStatusToast(`🎯 [${vertex.drawingName}] 목표 지점으로 안내를 시작합니다!`, 4500);
  }

  // ---------------------------------------------------------------
  // Smart Auto-Hide & Auto-Status Toast
  // ---------------------------------------------------------------
  setupAutoHideTimer() {
    this.resetAutoHideTimer();
  }

  handleUserActivity() {
    if (this.isUiHidden) {
      this.isUiHidden = false;
      document.querySelectorAll('.ui-autohide').forEach((el) => {
        el.classList.remove('ui-hidden-completely');
      });
      document.getElementById('icon-ui-toggle').textContent = '👁️';
    }
    this.wakeUpUI();
    this.resetAutoHideTimer();
  }

  wakeUpUI() {
    document.querySelectorAll('.ui-autohide').forEach((el) => {
      el.classList.remove('ui-dimmed');
    });
  }

  resetAutoHideTimer() {
    if (this.autoHideTimer) clearTimeout(this.autoHideTimer);
    if (!this.autoHideEnabled) return;

    this.autoHideTimer = setTimeout(() => {
      const isDrawerOpen = !document.getElementById('settings-drawer-backdrop').classList.contains('hidden');
      const isModalOpen = !document.getElementById('calib-modal').classList.contains('hidden');
      if (isDrawerOpen || isModalOpen) return;

      document.querySelectorAll('.ui-autohide').forEach((el) => {
        el.classList.add('ui-dimmed');
      });
    }, 4500);
  }

  showStatusToast(text, duration = 3500) {
    const toast = document.getElementById('auto-status-toast');
    const toastText = document.getElementById('auto-status-text');
    if (!toast || !toastText) return;

    toastText.textContent = text;
    toast.classList.remove('opacity-0', '-translate-y-4');
    toast.classList.add('opacity-100', 'translate-y-0');

    if (this.statusToastTimer) clearTimeout(this.statusToastTimer);
    this.statusToastTimer = setTimeout(() => {
      toast.classList.remove('opacity-100', 'translate-y-0');
      toast.classList.add('opacity-0', '-translate-y-4');
    }, duration);
  }

  // ---------------------------------------------------------------
  // Multi-CAD Loading & Management
  // ---------------------------------------------------------------
  loadSampleCad(mode = 'replace') {
    const parsed = this.parser.parse(SAMPLE_DXF_TEXT);
    const colorIdx = this.drawings.length % this.presetColors.length;

    const newDrawing = {
      id: 'dxf_sample_' + Date.now(),
      name: mode === 'append' ? `샘플부지_${this.drawings.length + 1}.dxf` : '서울시청_샘플부지.dxf',
      entities: parsed.entities,
      layers: parsed.layers,
      bounds: parsed.bounds,
      totalCount: parsed.totalCount,
      visible: true,
      color: this.presetColors[colorIdx],
      unitScale: 1.0
    };

    if (mode === 'append') {
      this.drawings.push(newDrawing);
      this.showStatusToast(`➕ '${newDrawing.name}' 추가 중첩됨 (총 ${this.drawings.length}개)`);
    } else {
      this.drawings = [newDrawing];
      this.showStatusToast(`🏛️ 서울시청 샘플 도면 (EPSG:5186) 로드 완료`);
    }

    this.transformer.setCrs('EPSG:5186');
    this.transformer.setUnitScale(1.0);
    document.getElementById('crs-select').value = 'EPSG:5186';
    document.getElementById('unit-scale-select').value = '1.0';

    this.reprojectAndRender();
    this.buildDrawingsList();
    this.buildLayerList();

    this.navigator.setSimulatedPosition(37.5661, 126.9775, 2.5);
    this.mapMgr.updateUserLocation(this.navigator.currentPosition, 45);
  }

  readDxfFile(file, mode = 'replace') {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      try {
        const parsed = this.parser.parse(text);
        const autoScale = this.transformer.autoDetectUnitScale(parsed.bounds);
        document.getElementById('unit-scale-select').value = autoScale.toString();

        const colorIdx = this.drawings.length % this.presetColors.length;
        const newDrawing = {
          id: 'dxf_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
          name: file.name,
          entities: parsed.entities,
          layers: parsed.layers,
          bounds: parsed.bounds,
          totalCount: parsed.totalCount,
          visible: true,
          color: this.presetColors[colorIdx],
          unitScale: autoScale
        };

        if (mode === 'append') {
          this.drawings.push(newDrawing);
          this.showStatusToast(`➕ '${file.name}' 기존 도면 위에 중첩 추가됨 (총 ${this.drawings.length}개)`);
        } else {
          this.drawings = [newDrawing];
          this.showStatusToast(`📁 '${file.name}' 도면 새로 열림 (객체 ${parsed.totalCount}개)`);
        }

        this.reprojectAndRender();
        this.buildDrawingsList();
        this.buildLayerList();
      } catch (err) {
        alert('DXF 파일 파싱 실패: ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  reprojectAndRender() {
    if (this.currentMode === 'map') {
      this.mapMgr.renderMultiDrawings(this.drawings, this.transformer);
    } else if (this.cadViewer) {
      this.cadViewer.setDrawings(this.drawings);
    }

    const countEl = document.getElementById('drawer-drawings-count');
    if (countEl) countEl.textContent = `${this.drawings.length}개`;
  }

  buildDrawingsList() {
    const container = document.getElementById('drawings-list');
    if (!container) return;
    container.innerHTML = '';

    if (this.drawings.length === 0) {
      container.innerHTML = '<p class="text-[11px] text-slate-500 italic py-1">불러온 도면이 없습니다.</p>';
      return;
    }

    this.drawings.forEach((drawing, index) => {
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between py-1.5 px-2 bg-slate-900 rounded-lg border border-slate-700/80 text-xs';

      row.innerHTML = `
        <div class="flex items-center space-x-2 truncate flex-1 mr-2">
          <button class="btn-color-pick w-3.5 h-3.5 rounded-full shrink-0 border border-white/50 shadow" style="background-color: ${drawing.color}" title="클릭하여 색상 변경"></button>
          <label class="flex items-center space-x-1.5 cursor-pointer truncate">
            <input type="checkbox" ${drawing.visible ? 'checked' : ''} class="chk-drawing-vis rounded text-blue-500 bg-slate-800 border-slate-600 focus:ring-0">
            <span class="truncate text-slate-200 font-medium">${drawing.name}</span>
          </label>
        </div>
        <div class="flex items-center space-x-1.5 shrink-0">
          <span class="text-[10px] text-slate-400 font-mono">${drawing.totalCount}개</span>
          <button class="btn-delete-drawing text-slate-400 hover:text-red-400 p-0.5 text-xs" title="도면 제거">🗑️</button>
        </div>
      `;

      row.querySelector('.chk-drawing-vis').addEventListener('change', (e) => {
        drawing.visible = e.target.checked;
        this.reprojectAndRender();
      });

      row.querySelector('.btn-color-pick').addEventListener('click', () => {
        const currIdx = this.presetColors.indexOf(drawing.color);
        const nextColor = this.presetColors[(currIdx + 1) % this.presetColors.length];
        drawing.color = nextColor;
        this.reprojectAndRender();
        this.buildDrawingsList();
      });

      row.querySelector('.btn-delete-drawing').addEventListener('click', () => {
        this.drawings.splice(index, 1);
        this.reprojectAndRender();
        this.buildDrawingsList();
        this.buildLayerList();
        this.showStatusToast(`'${drawing.name}' 도면이 제거되었습니다.`);
      });

      container.appendChild(row);
    });
  }

  buildLayerList() {
    const container = document.getElementById('layers-list');
    if (!container) return;
    container.innerHTML = '';

    if (this.drawings.length === 0) {
      container.innerHTML = '<p class="text-[11px] text-slate-500 italic py-1">레이어가 없습니다.</p>';
      return;
    }

    this.drawings.forEach((drawing) => {
      for (const [name, layer] of Object.entries(drawing.layers)) {
        const row = document.createElement('div');
        row.className = 'flex items-center justify-between py-1 px-2 bg-slate-900 rounded border border-slate-800 text-[11px]';
        
        row.innerHTML = `
          <label class="flex items-center space-x-2 cursor-pointer flex-1 truncate">
            <input type="checkbox" checked class="rounded text-blue-500 bg-slate-800 border-slate-600 focus:ring-0">
            <span class="w-2.5 h-2.5 rounded-full inline-block shrink-0" style="background-color: ${layer.color || drawing.color || '#fff'}"></span>
            <span class="truncate text-slate-300">[${drawing.name.replace('.dxf', '')}] ${name}</span>
          </label>
        `;

        const chk = row.querySelector('input');
        chk.addEventListener('change', (e) => {
          layer.visible = e.target.checked;
          this.reprojectAndRender();
        });

        container.appendChild(row);
      }
    });
  }

  // ---------------------------------------------------------------
  // Waypoint & Navigation HUD
  // ---------------------------------------------------------------
  onCadWaypointSelected(waypoint) {
    this.navigator.setTargetWaypoint(waypoint);
    this.mapMgr.setTargetWaypoint(waypoint);

    const hud = document.getElementById('navigation-hud');
    hud.classList.remove('hidden');

    const label = waypoint.label || '선택 지점';
    document.getElementById('hud-target-name').textContent = label;
    document.getElementById('mini-hud-name').textContent = label;

    if (waypoint.cadX !== null && waypoint.cadY !== null) {
      document.getElementById('hud-cad-coords').textContent = 
        `CAD: X=${waypoint.cadX.toFixed(2)}, Y=${waypoint.cadY.toFixed(2)}`;
    } else {
      document.getElementById('hud-cad-coords').textContent = 
        `GPS: ${waypoint.lat.toFixed(6)}, ${waypoint.lng.toFixed(6)}`;
    }

    const nav = this.navigator.getNavState();
    this.updateNavHudUI(nav);

    this.showStatusToast(`🎯 목표 지점 설정: ${label}`);
    this.resetAutoHideTimer();
  }

  onMapClicked(latLng) {
    if (this.simMode) {
      this.navigator.setSimulatedPosition(latLng.lat, latLng.lng, 2.0);
      this.mapMgr.updateUserLocation(this.navigator.currentPosition, this.navigator.compassHeading);
    }

    if (this.calibrationMode && this.calibrationMode.targetType === 'geo') {
      const step = this.calibrationMode.step;
      document.getElementById(`calib-geo-${step}-lat`).value = latLng.lat.toFixed(7);
      document.getElementById(`calib-geo-${step}-lng`).value = latLng.lng.toFixed(7);
      this.showToast(`기준점 ${step} 지도 좌표 등록됨`);
    }

    this.handleUserActivity();
  }

  updateLocationUI(pos, navState) {
    this.mapMgr.updateUserLocation(pos, this.navigator.compassHeading);

    const statusBadge = document.getElementById('gps-status-badge');
    statusBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>GPS`;

    if (navState && navState.hasTarget) {
      this.updateNavHudUI(navState);
    }
  }

  updateOrientationUI(heading, navState) {
    this.mapMgr.updateUserLocation(this.navigator.currentPosition, heading);

    if (navState && navState.hasTarget) {
      this.updateNavHudUI(navState);
    }
  }

  updateNavHudUI(nav) {
    if (!nav.hasTarget) return;

    if (nav.waitingGps) {
      document.getElementById('hud-distance').textContent = 'GPS 대기 중';
      document.getElementById('mini-hud-dist').textContent = '대기 중';
      return;
    }

    const distStr = nav.distance < 1000 
      ? `${nav.distance.toFixed(1)}m` 
      : `${(nav.distance / 1000).toFixed(2)}km`;

    const distEl = document.getElementById('hud-distance');
    if (nav.distance < 1000) {
      distEl.innerHTML = `<span class="text-3xl font-black text-amber-300">${nav.distance.toFixed(1)}</span> <span class="text-sm text-gray-300">m</span>`;
    } else {
      distEl.innerHTML = `<span class="text-3xl font-black text-amber-300">${(nav.distance / 1000).toFixed(2)}</span> <span class="text-sm text-gray-300">km</span>`;
    }

    document.getElementById('mini-hud-dist').textContent = distStr;
    document.getElementById('mini-hud-bearing').textContent = `${nav.directionName} ${Math.round(nav.bearing)}°`;

    document.getElementById('hud-bearing').textContent = 
      `${nav.directionName} (${Math.round(nav.bearing)}°)`;

    const arrow = document.getElementById('hud-nav-arrow');
    if (arrow) {
      arrow.style.transform = `rotate(${nav.relativeAngle}deg)`;
    }

    const arrivalBadge = document.getElementById('hud-arrival-badge');
    if (nav.isArrived) {
      arrivalBadge.classList.remove('hidden');
      arrivalBadge.textContent = '🎉 도착!';
      arrivalBadge.className = 'px-2 py-0.5 bg-green-500 text-white font-bold rounded-full text-[10px] animate-bounce';
    } else if (nav.isClose) {
      arrivalBadge.classList.remove('hidden');
      arrivalBadge.textContent = '⚠️ 10m 이내';
      arrivalBadge.className = 'px-2 py-0.5 bg-amber-500 text-black font-bold rounded-full text-[10px]';
    } else {
      arrivalBadge.classList.add('hidden');
    }
  }

  handleArrival(waypoint, navState) {
    this.showStatusToast(`🎉 목표 지점(${waypoint.label})에 도착했습니다!`, 5000);
  }

  handleGpsError(err) {
    const statusBadge = document.getElementById('gps-status-badge');
    statusBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-red-500"></span>GPS`;
    
    if (window.isSecureContext === false && location.protocol !== 'https:' && location.hostname !== 'localhost') {
      alert('⚠️ 모바일 브라우저 보안 규정 안내:\n스마트폰 실제 GPS 위치를 수신하려면 HTTPS 주소(https://...:8443)로 접속하셔야 위치 권한이 열립니다.\n\n(사무실이나 PC에서는 우측 🎮 모의 GPS 버튼을 켜고 지도를 클릭하여 테스트할 수 있습니다.)');
    } else if (err.code === 1) {
      alert('스마트폰 브라우저 설정에서 위치(GPS) 권한을 "허용"으로 설정해주세요.');
    } else {
      this.showToast('GPS 위치 수신 실패: 실외에서 스마트폰 GPS를 활성화해주세요.');
    }
  }

  // ---------------------------------------------------------------
  // 2-Point Ground Control Calibration
  // ---------------------------------------------------------------
  openCalibrationModal() {
    document.getElementById('calib-modal').classList.remove('hidden');
    if (this.drawings.length > 0) {
      const b = this.drawings[0].bounds;
      document.getElementById('calib-cad-1-x').value = b.minX.toFixed(2);
      document.getElementById('calib-cad-1-y').value = b.minY.toFixed(2);
      document.getElementById('calib-cad-2-x').value = b.maxX.toFixed(2);
      document.getElementById('calib-cad-2-y').value = b.maxY.toFixed(2);
    }
  }

  closeCalibrationModal() {
    document.getElementById('calib-modal').classList.add('hidden');
    this.calibrationMode = null;
  }

  applyCalibration() {
    try {
      const p1 = {
        cad: {
          x: parseFloat(document.getElementById('calib-cad-1-x').value),
          y: parseFloat(document.getElementById('calib-cad-1-y').value)
        },
        geo: {
          lat: parseFloat(document.getElementById('calib-geo-1-lat').value),
          lng: parseFloat(document.getElementById('calib-geo-1-lng').value)
        }
      };

      const p2 = {
        cad: {
          x: parseFloat(document.getElementById('calib-cad-2-x').value),
          y: parseFloat(document.getElementById('calib-cad-2-y').value)
        },
        geo: {
          lat: parseFloat(document.getElementById('calib-geo-2-lat').value),
          lng: parseFloat(document.getElementById('calib-geo-2-lng').value)
        }
      };

      if (isNaN(p1.geo.lat) || isNaN(p1.geo.lng) || isNaN(p2.geo.lat) || isNaN(p2.geo.lng)) {
        alert('지도 기준점 좌표(위도/경도)를 입력하거나 지도에서 찍어주세요.');
        return;
      }

      const res = this.transformer.set2PointCalibration(p1, p2);
      this.transformer.setCrs('LOCAL_CALIBRATED');
      document.getElementById('crs-select').value = 'LOCAL_CALIBRATED';

      this.reprojectAndRender();
      this.closeCalibrationModal();

      this.showStatusToast(`🎯 2점 보정 완료: 축척=${res.params.scale.toFixed(4)}, 회전=${res.params.rotationDeg.toFixed(2)}°`);
    } catch (e) {
      alert('보정 계산 실패: ' + e.message);
    }
  }

  showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.remove('opacity-0', 'pointer-events-none');
    setTimeout(() => {
      toast.classList.add('opacity-0', 'pointer-events-none');
    }, 3000);
  }
}

// Boot on window load
window.addEventListener('DOMContentLoaded', () => {
  window.cadApp = new CadNavigatorApp();
});
