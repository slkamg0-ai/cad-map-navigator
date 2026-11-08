/**
 * app.js - 모바일 전용 UI
 *
 * 조작 원칙
 *  - 손가락 하나 = 화면 이동, 두 손가락 = 확대/축소, 두 번 탭 = 확대
 *  - 측정은 손가락에 가려지지 않도록 화면 중앙 십자선으로 조준하고 큰 버튼으로 찍는다.
 *    (도면을 직접 탭해도 찍히며, 이때는 스냅 반경을 넓게 잡는다)
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  // 삼성인터넷은 Chrome과 달리 보안 DNS/파일 선택 관련 동작이 달라, DWG 자동
  // 연결과 Google Drive 파일 열기가 조용히 실패하는 경우가 실제로 확인됐다.
  // Chrome(삼성 기기의 크롬 앱)에서는 둘 다 정상 동작한다.
  var IS_SAMSUNG_BROWSER = /SamsungBrowser/i.test(navigator.userAgent);

  var cv = $('cv');
  var renderer = new window.Renderer(cv);
  var measure = new window.Measure(renderer);
  var basemap = new window.Basemap($('mapCanvas'), renderer);
  var doc = null;
  var displayList = null;
  var currentName = '';

  var CROSS_SNAP_PX = 15;   // 십자선은 정밀하므로 좁게
  var TAP_SNAP_PX = 26;     // 손가락 탭은 넓게

  /* ------------------------------------------------------------ 알림/로딩 */

  var toastTimer = 0;
  function toast(msg, isError, ms) {
    var el = $('toast');
    el.textContent = msg;
    el.className = 'toast' + (isError ? ' error' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, ms || (isError ? 9000 : 3200));
  }
  function loading(on, text) {
    $('loading').hidden = !on;
    if (text) $('loadingText').textContent = text;
  }
  function fmtNum(n) { return n.toLocaleString('ko-KR'); }

  // 마지막 안전망: 어디서든 처리 안 된 예외/거부가 나면 로딩을 끄고 반드시
  // 뭔가를 보여준다. "화면이 그냥 멈춘 것처럼 보이는" 상황을 만들지 않기 위함 —
  // 실제로 파일 선택 흐름에서 이런 조용한 실패가 있었다.
  window.addEventListener('error', function (e) {
    loading(false);
    toast('예상하지 못한 오류가 발생했습니다.\n' + (e.message || e), true, 9000);
  });
  window.addEventListener('unhandledrejection', function (e) {
    loading(false);
    var reason = e.reason;
    toast('예상하지 못한 오류가 발생했습니다.\n' + (reason && reason.message || reason), true, 9000);
  });

  /* -------------------------------------------------------------- 파일 열기 */

  function pickFile() { $('fileInput').click(); }
  $('btnOpen').addEventListener('click', pickFile);
  $('btnOpen2').addEventListener('click', pickFile);
  $('fileInput').addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) {
      // 파일 선택 자체가 실패했을 때(특히 안드로이드에서 Google Drive 등
      // 클라우드 저장소의 파일을 고르면, 실제 내용을 내려받지 못한 채
      // 빈 선택으로 끝나는 경우가 있다). 예전에는 여기서 아무 반응이
      // 없어 사용자가 앱이 멈춘 줄 알았다 — 반드시 무언가를 보여준다.
      toast('파일을 선택하지 못했습니다.\nGoogle Drive 등 클라우드 앱에서 골랐다면, ' +
        '기기에 다운로드된 파일로 다시 시도해 보세요.', true, 8000);
      return;
    }
    try {
      openFile(f);
    } catch (err) {
      // openFile 안에서 예상 못 한 예외가 나도 절대 조용히 넘어가지 않는다.
      loading(false);
      toast('파일을 여는 중 오류가 발생했습니다.\n' + (err && err.message || err), true, 9000);
      console.error(err);
    }
  });

  $('btnSample').addEventListener('click', function () {
    loading(true, '샘플 도면을 불러오는 중…');
    currentName = '샘플 지적도';
    fetch('samples/sample-cadastral.dxf')
      .then(function (r) {
        if (!r.ok) throw new Error('샘플 파일을 찾을 수 없습니다 (' + r.status + ')');
        return r.arrayBuffer();
      })
      .then(parseAndShow)
      .catch(function (err) { loading(false); toast(err.message, true); });
  });

  /* -------------------------------------------------- DWG 변환 서버 유무 */

  // 이 앱은 두 곳에서 돈다.
  //   - PC 서버(로컬/Tailscale): DWG 변환기가 붙어 있어 DWG 도 열린다
  //   - 정적 호스팅(Vercel 등)  : 변환 서버가 없어 DXF 만 열린다
  // 큰 DWG 를 헛되이 올리지 않도록 시작할 때 한 번 확인해 둔다.
  var dwgSupported = null;          // null = 확인 전
  var NO_BACKEND_MSG = IS_SAMSUNG_BROWSER
    ? '삼성인터넷에서는 DWG 자동 연결이 되지 않습니다.\n' +
      '같은 주소를 Chrome 앱으로 열어서 다시 시도해 주세요 (Chrome에서는 정상 동작합니다).'
    : '이 주소에는 DWG 변환 서버가 없고, PC 서버로 자동 연결도 되지 않았습니다.\n' +
      'PC 서버가 켜져 있는데도 이 메시지가 뜨면, 폰 브라우저의 "보안 DNS"가 ' +
      '원인일 수 있습니다 — 설정 > 개인정보 보호 및 보안 > 보안 DNS를 꺼 보세요.\n' +
      '그래도 안 되면 PC에서 CAD 뷰어 서버를 켜고 그 주소로 직접 열거나, CAD에서 DXF로 저장해 오세요.';

  // 정적 호스팅(이 페이지에 변환 서버가 없음)일 때, 같은 사용자의 PC 서버로
  // 자동 연결을 시도할 주소. PC 서버가 Tailscale 의 HTTPS 인증서로 떠 있어야
  // 브라우저가 mixed-content 로 막지 않는다 - HTTP 면 이 시도는 조용히
  // 실패하고 기존처럼 수동 안내로 넘어간다 (openDWG 참고).
  var PC_FALLBACK_BASE = 'https://desktop-0sdpqa7.tailef545d.ts.net:8020/';

  fetch('api/converter')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { dwgSupported = !!(j && j.available); updateDwgHint(j); })
    .catch(function () { dwgSupported = false; updateDwgHint(null); });

  function updateDwgHint(status) {
    var el = document.querySelector('.splash .fine');
    if (!el) return;
    if (dwgSupported) {
      el.textContent = 'DXF는 바로 열리고, DWG는 서버에서 변환한 뒤 표시합니다.';
    } else if (status && !status.available) {
      el.textContent = 'DXF를 엽니다. 이 PC에 DWG 변환기가 설치되어 있지 않습니다.';
    } else {
      el.textContent = 'DXF는 바로 열립니다. DWG는 PC 서버가 켜져 있으면 자동으로 연결을 시도합니다.';
    }
    if (IS_SAMSUNG_BROWSER) {
      el.textContent += ' ⚠ 삼성인터넷에서는 DWG 자동 연결과 클라우드 파일 열기가 ' +
        '안 될 수 있습니다 — Chrome 앱으로 열어 주세요.';
    }
  }

  // PC_FALLBACK_BASE 가 지금 응답하는지 짧게 확인한다. 서버가 꺼져 있거나
  // HTTPS 가 아직 안 켜져 있으면(mixed-content) 몇 초 안에 실패로 끝난다.
  function probePcFallback() {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 3500);
    return fetch(PC_FALLBACK_BASE + 'api/converter', { signal: ctrl.signal })
      .then(function (r) { clearTimeout(timer); return r.ok ? r.json() : null; })
      .then(function (j) { return !!(j && j.available); })
      .catch(function () { clearTimeout(timer); return false; });
  }

  /**
   * File/Blob 을 ArrayBuffer 로 읽는다.
   *
   * 안드로이드에서 Google Drive 등 클라우드 저장소의 파일을 고르면, 선택창에는
   * "선택됨"으로 뜨지만 실제 바이트는 기기에 없고 그때그때 내려받아야 하는
   * 참조(content:// URI)일 뿐인 경우가 있다. 이 내려받기가 실패하면 증상이
   * 제각각이다 — 0바이트로 오거나, 여기서 바로 실패하거나, 심지어 여기는
   * 통과했다가 나중에 fetch() 단계에서야 애매한 "Failed to fetch"로 터진다.
   * 그래서 업로드를 시도하기 전에 이 자리에서 먼저 완전히 읽어 두고, 실패하면
   * 원인을 짚어 안내한다. 성공하면 이후로는 완전히 로컬 메모리의 바이트만
   * 다루므로 업로드 도중 다시 끊길 일도 없다.
   */
  function readFileBytes(file) {
    if (file.size === 0) {
      return Promise.reject(new Error(
        '선택한 파일이 비어 있습니다(0바이트).\n' +
        '클라우드 저장소의 파일이라면 기기에 다운로드한 뒤 다시 시도해 보세요.'));
    }
    var read = typeof file.arrayBuffer === 'function'
      ? file.arrayBuffer()
      : new Promise(function (resolve, reject) {
        var fr = new FileReader();
        fr.onerror = function () { reject(fr.error || new Error('읽기 실패')); };
        fr.onload = function () { resolve(fr.result); };
        fr.readAsArrayBuffer(file);
      });
    return read.catch(function (err) {
      throw new Error(
        '파일 내용을 읽지 못했습니다.\n' +
        'Google Drive 등 클라우드 저장소에서 고른 파일이면, 기기에 다운로드된 ' +
        '파일(다운로드 폴더 등)로 다시 선택해 보세요.\n' +
        '(' + (err && err.message || err) + ')');
    });
  }

  function openFile(file) {
    currentName = file.name;
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext !== 'dwg' && ext !== 'dxf') {
      toast('DXF 또는 DWG 파일만 열 수 있습니다.\n(' + file.name + ')', true);
      return;
    }
    // dwgSupported===false 여도 여기서 바로 막지 않는다 - openDWG 가 PC 서버로
    // 자동 연결을 먼저 시도하고, 그래도 안 되면 그때 안내한다.

    loading(true, '파일을 읽는 중…');
    readFileBytes(file)
      .then(function (buf) {
        if (ext === 'dwg') openDWG(buf, file.name);
        else parseAndShow(buf);
      })
      .catch(function (err) { loading(false); toast(err.message, true, 9000); });
  }

  function openDWG(buffer, filename) {
    if (dwgSupported === false) {
      // 이 페이지엔 변환 서버가 없다 - 같은 사용자의 PC 서버로 자동 연결을
      // 시도한다. HTTPS 로 떠 있어야 성공한다(PC 서버가 HTTP 뿐이면 브라우저가
      // mixed-content 로 막아 여기서 조용히 실패하고 수동 안내로 넘어간다).
      loading(true, 'PC 서버로 자동 연결하는 중…');
      probePcFallback().then(function (ok) {
        if (ok) {
          loading(true, 'DWG를 변환하는 중…\n파일이 크면 시간이 걸립니다');
          uploadDWG(PC_FALLBACK_BASE, buffer, filename);
        } else {
          loading(false);
          toast(NO_BACKEND_MSG, true, 9000);
        }
      });
      return;
    }
    loading(true, 'DWG를 변환하는 중…\n파일이 크면 시간이 걸립니다');
    uploadDWG('', buffer, filename);
  }

  function uploadDWG(base, buffer, filename) {
    var fd = new FormData();
    fd.append('file', new Blob([buffer]), filename || 'drawing.dwg');
    fetch(base + 'api/dwg2dxf', { method: 'POST', body: fd })
      .then(function (res) {
        if (res.ok) return res.arrayBuffer();
        // 정적 호스팅에는 이 엔드포인트가 아예 없다 (404/405). base 가 있을 때는
        // PC 서버 자체의 정상 오류 응답(예: 변환기 없음)일 수 있으니 이 판정을
        // 적용하지 않는다.
        if (!base && (res.status === 404 || res.status === 405)) {
          dwgSupported = false;
          throw new Error(NO_BACKEND_MSG);
        }
        return res.text().then(function (t) {
          var msg = t;
          try { msg = JSON.parse(t).detail || t; } catch (e) { /* 평문 응답 */ }
          throw new Error(msg);
        });
      })
      .then(function (buf) { loading(true, '변환된 도면을 읽는 중…'); parseAndShow(buf); })
      .catch(function (err) {
        loading(false);
        // 파일은 이미 메모리에 다 읽어 둔 뒤라, 여기서 나는 실패는 진짜
        // 네트워크/서버 문제다 (클라우드 저장소 읽기 실패는 위에서 걸러졌다).
        var hint = /fetch/i.test(String(err.message)) ? '\n(서버 PC가 켜져 있는지, 폰의 Tailscale이 연결돼 있는지 확인해 주세요.)' : '';
        toast('DWG 변환 실패\n' + err.message + hint, true, 14000);
      });
  }

  function parseAndShow(buffer) {
    setTimeout(function () {
      var t0 = performance.now();
      try {
        var text = window.DXF.decodeDXF(buffer);
        loading(true, '도면을 해석하는 중…');
        doc = window.DXF.parse(text);
        loading(true, '도형을 만드는 중…');
        displayList = window.Geom.build(doc);
      } catch (err) {
        loading(false);
        toast(err.message || '도면을 해석하지 못했습니다.', true, 12000);
        console.error(err);
        return;
      }

      renderer.setDrawing(displayList, doc);
      renderer.zoomExtents();
      basemap.setEnabled(false);          // 새 도면 - 좌표계가 다를 수 있으니 우선 끈다
      basemap.setDrawing(displayList, doc);
      $('chkBasemap').checked = false;
      buildLayerList();
      applyDetectedUnits();
      updateInfo(performance.now() - t0);

      $('splash').classList.add('gone');
      $('title').textContent = currentName;
      $('crosshair').hidden = false;      // 좌표 확인은 상시 기능
      $('coordbar').hidden = false;
      pick = null;
      loading(false);
      setTool('none');

      if (!displayList.items.length) {
        toast('표시할 도형이 없습니다.\n모형 공간이 비어 있거나 외부 참조(XREF)로만 이뤄진 도면일 수 있습니다.', true);
      }
    }, 30);
  }

  /* ---------------------------------------------------------------- 단위 */

  var INSUNITS = { 1: 'inch', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm', 7: 'km', 10: 'yd' };

  function applyDetectedUnits() {
    var v = doc.header['$INSUNITS'];
    var code = v && v.length ? parseInt(v[0], 10) : 0;
    var u = INSUNITS[code];
    var sel = $('selUnit');
    if (u) {
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === u + '|1') { sel.selectedIndex = i; break; }
      }
    }
    onUnitChange();
    if (!u) toast('도면에 단위 정보가 없습니다.\n측정 전에 [보기] → 도면 단위를 확인해 주세요.', false, 6500);
  }

  function onUnitChange() {
    var parts = $('selUnit').value.split('|');
    measure.setUnit(parts[0], parseFloat(parts[1]));
    renderMeasureList();
    updateReadout();
    refreshCrosshair(true);
  }
  $('selUnit').addEventListener('change', onUnitChange);

  function updateInfo(ms) {
    $('iFile').textContent = currentName || '—';
    $('iEnt').textContent = fmtNum(displayList.items.length) + ' 개  ·  ' + Math.round(ms) + 'ms';
    $('iLayers').textContent = Object.keys(renderer.layers).length + ' 개';
    var b = displayList.bbox;
    $('iExt').textContent = (b[2] - b[0]).toFixed(1) + ' × ' + (b[3] - b[1]).toFixed(1);

    var kinds = Object.keys(displayList.skipped);
    $('iSkipLabel').hidden = !kinds.length;
    $('iSkip').hidden = !kinds.length;
    if (kinds.length) {
      $('iSkip').textContent = kinds
        .sort(function (a, c) { return displayList.skipped[c] - displayList.skipped[a]; })
        .map(function (k) { return k + ' ' + displayList.skipped[k]; })
        .join(', ');
    }
  }

  /* ---------------------------------------------------------------- 시트 */

  function openSheet(id) {
    closeSheets();
    $(id).hidden = false;
    if (id === 'sheetView') refreshBasemapUI();
  }
  function closeSheets() {
    var s = document.querySelectorAll('.sheet');
    for (var i = 0; i < s.length; i++) s[i].hidden = true;
  }
  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('[data-close]')) closeSheets();
  });
  $('btnInfo').addEventListener('click', function () {
    if (!displayList) { toast('먼저 도면을 여세요.'); return; }
    openSheet('sheetInfo');
  });

  /* -------------------------------------------------------------- 레이어 */

  var layerNames = [];

  function buildLayerList() {
    layerNames = Object.keys(renderer.layers).sort(function (a, b) {
      return a.localeCompare(b, 'ko', { numeric: true });
    });
    $('layerCount').textContent = layerNames.length;
    renderLayerList();
  }

  function renderLayerList() {
    var q = $('layerFilter').value.trim().toLowerCase();
    var host = $('layerList');
    host.innerHTML = '';
    var frag = document.createDocumentFragment();
    var shown = 0;

    for (var i = 0; i < layerNames.length; i++) {
      var name = layerNames[i];
      if (q && name.toLowerCase().indexOf(q) === -1) continue;
      var L = renderer.layers[name];
      shown++;

      var row = document.createElement('label');
      row.className = 'lyr' + (L.visible ? '' : ' off');

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = L.visible;
      cb.dataset.layer = name;

      var sw = document.createElement('span');
      sw.className = 'sw';
      var rgb = (L.trueColor !== null && L.trueColor !== undefined)
        ? L.trueColor : window.Geom.aciToRGB(L.color);
      sw.style.background = '#' + ('000000' + (rgb >>> 0).toString(16)).slice(-6);

      var nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = name;

      var n = document.createElement('span');
      n.className = 'n';
      n.textContent = fmtNum(L.count);

      var solo = document.createElement('button');
      solo.className = 'solo';
      solo.textContent = '단독';
      solo.dataset.solo = name;

      row.appendChild(cb); row.appendChild(sw); row.appendChild(nm);
      row.appendChild(n); row.appendChild(solo);
      frag.appendChild(row);
    }

    if (!shown) {
      var p = document.createElement('p');
      p.className = 'empty';
      p.textContent = layerNames.length ? '검색 결과가 없습니다.' : '도면을 열면 레이어가 표시됩니다.';
      frag.appendChild(p);
    }
    host.appendChild(frag);
  }

  $('layerFilter').addEventListener('input', renderLayerList);

  $('layerList').addEventListener('change', function (e) {
    var name = e.target.dataset && e.target.dataset.layer;
    if (!name) return;
    renderer.layers[name].visible = e.target.checked;
    e.target.closest('.lyr').classList.toggle('off', !e.target.checked);
    renderer.invalidate();
  });

  $('layerList').addEventListener('click', function (e) {
    var name = e.target.dataset && e.target.dataset.solo;
    if (!name) return;
    e.preventDefault();
    for (var i = 0; i < layerNames.length; i++) {
      renderer.layers[layerNames[i]].visible = (layerNames[i] === name);
    }
    renderLayerList();
    renderer.invalidate();
  });

  function setAllLayers(on) {
    for (var i = 0; i < layerNames.length; i++) renderer.layers[layerNames[i]].visible = on;
    renderLayerList();
    renderer.invalidate();
  }
  $('btnAllOn').addEventListener('click', function () { setAllLayers(true); });
  $('btnAllOff').addEventListener('click', function () { setAllLayers(false); });

  /* ------------------------------------------------------------ 보기 설정 */

  function bindOpt(id, key) {
    $(id).addEventListener('change', function (e) {
      renderer.opts[key] = e.target.checked;
      renderer.invalidate();
    });
  }
  bindOpt('chkText', 'showText');
  bindOpt('chkFill', 'showHatchFill');
  bindOpt('chkLw', 'showLineweight');
  bindOpt('chkDark', 'dark');
  $('chkSnap').addEventListener('change', function (e) {
    measure.snapEnabled = e.target.checked;
    refreshCrosshair();
  });

  /* ------------------------------------------------------------ 배경지도 */

  // 좌표계 드롭다운은 한 번만 채운다
  (function fillCrsOptions() {
    var sel = $('selMapCrs');
    window.Geo.CRS_LIST.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.code; o.textContent = c.label;
      sel.appendChild(o);
    });
  })();

  function refreshBasemapUI() {
    var chk = $('chkBasemap'), hint = $('mapHint');
    var layerRow = $('mapLayerRow'), crsRow = $('mapCrsRow');

    if (basemap.available === false) {
      chk.checked = false; chk.disabled = true;
      layerRow.hidden = true; crsRow.hidden = true;
      hint.hidden = false; hint.className = 'hint warn';
      hint.textContent = '이 주소에는 배경지도 서버가 없습니다. PC에서 CAD 뷰어 서버를 켜서 여세요.';
      return;
    }

    chk.disabled = !displayList;
    chk.checked = basemap.enabled;
    layerRow.hidden = !basemap.enabled;
    crsRow.hidden = !basemap.enabled;
    $('selMapLayer').value = basemap.layer;
    if (basemap.crs) $('selMapCrs').value = basemap.crs;

    if (!basemap.enabled) { hint.hidden = true; return; }

    hint.hidden = false;
    var info = basemap.detectInfo;
    if (info && info.confidence === 'high') {
      hint.className = 'hint';
      hint.textContent = '도면에서 좌표계를 자동으로 찾았습니다 (' + info.reason + '). 지도가 어긋나면 아래에서 직접 바꾸세요.';
    } else if (info && info.confidence === 'medium') {
      hint.className = 'hint';
      hint.textContent = '도면 문구로 좌표계를 추정했습니다 (' + info.reason + '). 지도 위치가 맞는지 확인해 주세요.';
    } else {
      hint.className = 'hint warn';
      hint.textContent = '도면에서 좌표계 표기를 찾지 못해 기본값을 사용 중입니다. 지도가 실제 위치와 다르면 아래에서 좌표계를 바꿔 보세요.';
    }
  }

  $('chkBasemap').addEventListener('change', function (e) {
    if (!displayList) { e.target.checked = false; toast('먼저 도면을 여세요.'); return; }
    basemap.setEnabled(e.target.checked);
    refreshBasemapUI();
  });
  $('selMapLayer').addEventListener('change', function (e) { basemap.setLayer(e.target.value); });
  $('selMapCrs').addEventListener('change', function (e) {
    basemap.setCRS(e.target.value);
    refreshBasemapUI();
  });

  $('btnFit').addEventListener('click', function () {
    if (displayList) { renderer.zoomExtents(); refreshCrosshair(); }
  });

  /* ---------------------------------------------------------------- 도구 */

  function setTool(tool) {
    measure.setMode(tool);
    var btns = document.querySelectorAll('.dk[data-tool]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].dataset.tool === tool);
    }
    var on = tool !== 'none';
    document.body.classList.toggle('measuring', on);
    $('actionbar').hidden = !on;
    if (on) pick = null;              // 측정에 들어가면 좌표 확인 표식은 지운다
    refreshCrosshair(true);
    updateReadout();
  }

  var dockBtns = document.querySelectorAll('.dk');
  for (var d = 0; d < dockBtns.length; d++) {
    dockBtns[d].addEventListener('click', function () {
      if (this.dataset.tool !== undefined) {
        if (this.dataset.tool !== 'none' && !displayList) { toast('먼저 도면을 여세요.'); return; }
        setTool(this.dataset.tool);
      } else if (this.dataset.sheet) {
        if (!displayList) { toast('먼저 도면을 여세요.'); return; }
        openSheet(this.dataset.sheet);
      }
    });
  }

  /* ------------------------------------------------------- 측정 조작 버튼 */

  $('btnAddPt').addEventListener('click', function () {
    // 스냅 계산은 조작 중 프레임을 지키려고 지연시켜 두므로, 점을 확정하기 직전에
    // 반드시 지금 위치로 다시 구한다. (지연된 값을 쓰면 직전 위치가 찍힌다)
    refreshCrosshair(true);
    measure.onClick();
    refreshCrosshair(true);
  });
  $('btnUndoPt').addEventListener('click', function () {
    measure.undoPoint();
    refreshCrosshair();
  });
  $('btnDone').addEventListener('click', function () {
    var need = measure.mode === 'area' ? 6 : 4;
    if (measure.pts.length < need) {
      toast(measure.mode === 'area' ? '점을 3개 이상 찍어 주세요.' : '점을 2개 이상 찍어 주세요.');
      return;
    }
    measure.finish();
    refreshCrosshair(true);
    var last = measure.results[measure.results.length - 1];
    var s = measure.summary(last);
    toast(s.title + ' ' + s.main + (s.sub ? '\n' + s.sub : ''), false, 4500);
  });
  $('btnResults').addEventListener('click', function () { openSheet('sheetMeasure'); });
  $('btnClearMeasure').addEventListener('click', function () {
    measure.clearAll();
    closeSheets();
  });

  measure.onChange = function () {
    renderMeasureList();
    updateReadout();
    updateBadge();
    $('btnUndoPt').disabled = measure.pts.length === 0;
  };

  function updateBadge() {
    var n = measure.results.length;
    var pill = $('btnResults');
    pill.hidden = n === 0;
    pill.querySelector('em').textContent = n;
  }

  // 진행 중인 측정값을 화면 아래에 실시간으로 보여준다
  function updateReadout() {
    var el = $('readout');
    if (!measure.active() || !measure.pts.length) { el.hidden = true; return; }
    var live = measure.pts.slice();
    // 커서가 방금 찍은 점 위에 그대로 있으면 미리보기에 넣지 않는다 (0 이 뜨는 것 방지)
    var onLastPoint = measure.cursor &&
      Math.abs(measure.cursor.x - live[live.length - 2]) < 1e-9 &&
      Math.abs(measure.cursor.y - live[live.length - 1]) < 1e-9;
    if (measure.cursor && !onLastPoint) live.push(measure.cursor.x, measure.cursor.y);
    var need = measure.mode === 'area' ? 6 : 4;
    if (live.length < need) {
      el.innerHTML = '점 ' + (measure.pts.length / 2) + '개' +
        '<span class="sub">' + (measure.mode === 'area' ? '3개 이상 필요' : '한 점 더') + '</span>';
      el.hidden = false;
      return;
    }
    var s = measure.summary({ mode: measure.mode, pts: live });
    el.innerHTML = s.main + (s.sub ? '<span class="sub">' + s.sub + '</span>' : '');
    el.hidden = false;
  }

  function renderMeasureList() {
    var host = $('measureList');
    if (!host) return;
    host.innerHTML = '';
    if (!measure.results.length) {
      var p = document.createElement('p');
      p.className = 'empty';
      p.textContent = '완료된 측정이 없습니다.';
      host.appendChild(p);
      return;
    }
    for (var i = measure.results.length - 1; i >= 0; i--) {
      (function (res) {
        var sum = measure.summary(res);
        var row = document.createElement('div');
        row.className = 'mrow';
        var body = document.createElement('div');
        body.className = 'body';
        var t = document.createElement('div'); t.className = 't'; t.textContent = sum.title;
        var v = document.createElement('div'); v.className = 'v'; v.textContent = sum.main;
        var s = document.createElement('div'); s.className = 's'; s.textContent = sum.sub;
        body.appendChild(t); body.appendChild(v); body.appendChild(s);

        // 찍은 점들의 도면 좌표 (현장에서 그대로 옮겨 적을 수 있게)
        var pts = document.createElement('div');
        pts.className = 'pts';
        for (var k = 0; k < res.pts.length; k += 2) {
          var line = document.createElement('div');
          line.textContent = (k / 2 + 1) + ')  X ' + measure.fmtCoord(res.pts[k]) +
            '   Y ' + measure.fmtCoord(res.pts[k + 1]);
          pts.appendChild(line);
        }
        body.appendChild(pts);
        var x = document.createElement('button');
        x.className = 'x'; x.textContent = '×';
        x.setAttribute('aria-label', '삭제');
        x.addEventListener('click', function () { measure.remove(res.id); });
        row.appendChild(body); row.appendChild(x);
        host.appendChild(row);
      })(measure.results[i]);
    }
  }

  /* ------------------------------------------- 십자선 스냅 · 좌표 표시 */

  var snapTimer = 0;
  var pick = null;          // 이동 모드에서 탭으로 확인한 지점 {x, y, snap}

  // 탭으로 찍은 좌표 확인 지점을 도면 위에 표시한다
  renderer.overlays.push(function (ctx, r) {
    if (!pick) return;
    var p = r.toScreen(pick.x, pick.y);
    ctx.strokeStyle = '#7fe08a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p[0], p[1], 9, 0, Math.PI * 2);
    ctx.moveTo(p[0] - 15, p[1]); ctx.lineTo(p[0] - 4, p[1]);
    ctx.moveTo(p[0] + 4, p[1]); ctx.lineTo(p[0] + 15, p[1]);
    ctx.moveTo(p[0], p[1] - 15); ctx.lineTo(p[0], p[1] - 4);
    ctx.moveTo(p[0], p[1] + 4); ctx.lineTo(p[0], p[1] + 15);
    ctx.stroke();
  });

  function setCoord(x, y, srcLabel, snapped) {
    $('coordX').textContent = measure.fmtCoord(x);
    $('coordY').textContent = measure.fmtCoord(y);
    $('coordSrc').textContent = srcLabel;
    $('coordbar').classList.toggle('snapped', !!snapped);
    $('coordCopy').textContent = '복사';
  }

  /**
   * 화면 중앙을 재보고 십자선·좌표·측정 미리보기를 갱신한다.
   * 좌표 확인은 상시 기능이므로 측정 중이 아니어도 돈다.
   */
  function refreshCrosshair(immediate) {
    if (!displayList) return;
    clearTimeout(snapTimer);
    var run = function () {
      var p = measure.probe(renderer.cssW / 2, renderer.cssH / 2, CROSS_SNAP_PX);
      var label = window.Measure.snapLabelOf(p.snap);

      $('crosshair').classList.toggle('snapped', !!label);
      $('snapTag').hidden = !label;
      if (label) $('snapTag').textContent = label;

      // 탭으로 확인한 지점이 있으면 그 좌표를 우선 보여준다
      if (pick) setCoord(pick.x, pick.y, window.Measure.snapLabelOf(pick.snap) || '탭 지점', !!pick.snap);
      else setCoord(p.x, p.y, label || '화면 중앙', !!label);

      if (measure.active()) {
        measure.cursor = p;
        renderer.invalidate();
        updateReadout();
      }
    };
    // 조작 중에는 스냅 탐색을 미뤄 프레임을 지킨다
    if (immediate) run(); else snapTimer = setTimeout(run, 90);
  }

  $('coordbar').addEventListener('click', function () {
    var text = $('coordX').textContent + ', ' + $('coordY').textContent;
    var done = function () { $('coordCopy').textContent = '복사됨'; };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { toast(text); });
    } else {
      toast(text);
    }
  });

  /* ------------------------------------------------------------ 제스처 */

  var active = new Map();          // pointerId -> {x, y}
  var pinch = null;                // {d, cx, cy}
  var tapCandidate = null;         // {x, y, t}
  var lastTap = 0, lastTapX = 0, lastTapY = 0;
  var fastTimer = 0;

  function beginFast() {
    renderer.setFast(true);
    clearTimeout(fastTimer);
    fastTimer = setTimeout(function () {
      renderer.setFast(false);
      renderer.invalidate();
      refreshCrosshair(true);
    }, 160);
  }

  function localPos(e) {
    var r = cv.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  cv.addEventListener('pointerdown', function (e) {
    cv.setPointerCapture(e.pointerId);
    var p = localPos(e);
    active.set(e.pointerId, { x: p[0], y: p[1] });
    if (active.size === 1) {
      tapCandidate = { x: p[0], y: p[1], t: Date.now(), moved: 0 };
    } else if (active.size === 2) {
      tapCandidate = null;
      pinch = pinchState();
    }
  });

  cv.addEventListener('pointermove', function (e) {
    if (!active.has(e.pointerId)) return;
    var p = localPos(e);
    var prev = active.get(e.pointerId);
    active.set(e.pointerId, { x: p[0], y: p[1] });

    if (active.size === 1) {
      var dx = p[0] - prev.x, dy = p[1] - prev.y;
      if (tapCandidate) tapCandidate.moved += Math.abs(dx) + Math.abs(dy);
      if (dx || dy) { renderer.panBy(dx, dy); beginFast(); refreshCrosshair(); }
    } else if (active.size === 2 && pinch) {
      var now = pinchState();
      if (now.d > 0 && pinch.d > 0) renderer.zoomAt(pinch.cx, pinch.cy, now.d / pinch.d);
      renderer.panBy(now.cx - pinch.cx, now.cy - pinch.cy);
      pinch = now;
      beginFast();
      refreshCrosshair();
    }
  });

  function endPointer(e) {
    if (!active.has(e.pointerId)) return;
    active.delete(e.pointerId);
    if (active.size < 2) pinch = null;
    if (active.size === 0 && tapCandidate && tapCandidate.moved < 9 &&
        Date.now() - tapCandidate.t < 400) {
      handleTap(tapCandidate.x, tapCandidate.y);
    }
    if (active.size === 0) tapCandidate = null;
  }
  cv.addEventListener('pointerup', endPointer);
  cv.addEventListener('pointercancel', endPointer);

  function pinchState() {
    var it = active.values();
    var a = it.next().value, b = it.next().value;
    return {
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      d: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))
    };
  }

  function handleTap(x, y) {
    var now = Date.now();
    if (now - lastTap < 320 && Math.hypot(x - lastTapX, y - lastTapY) < 34) {
      renderer.zoomAt(x, y, 2);          // 두 번 탭 = 확대
      lastTap = 0;
      refreshCrosshair(true);
      return;
    }
    lastTap = now; lastTapX = x; lastTapY = y;

    if (!displayList) return;

    if (measure.active()) {
      // 도면을 직접 찍으면 그 자리에 점을 놓고, 커서는 다시 십자선으로 되돌린다
      measure.onMove(x, y, TAP_SNAP_PX);
      measure.onClick();
      refreshCrosshair(true);
    } else {
      // 이동 모드의 탭은 "좌표 확인" - 찍은 자리의 도면 좌표를 표시하고 표식을 남긴다
      var p = measure.probe(x, y, TAP_SNAP_PX);
      pick = (pick && Math.abs(pick.x - p.x) < 1e-9 && Math.abs(pick.y - p.y) < 1e-9) ? null : p;
      renderer.invalidate();
      refreshCrosshair(true);
    }
  }

  /* ------------------------------------------------------------- 화면 크기 */

  var ro = new ResizeObserver(function () {
    renderer.invalidate();
    refreshCrosshair();
  });
  ro.observe(document.body);
  window.addEventListener('orientationchange', function () {
    setTimeout(function () { renderer.invalidate(); refreshCrosshair(true); }, 250);
  });

  renderer.resize();
  renderer.draw();
  renderMeasureList();
  $('btnUndoPt').disabled = true;

  window.CADViewer = {
    renderer: renderer,
    measure: measure,
    basemap: basemap,
    get doc() { return doc; },
    get displayList() { return displayList; },
    openFile: openFile,
    setTool: setTool
  };
})();
