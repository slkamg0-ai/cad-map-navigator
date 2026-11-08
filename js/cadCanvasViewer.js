/**
 * Pure 2D Canvas CAD Viewer Engine (AutoCAD-Style Blueprint Inspection)
 * Features: High-performance pan/zoom, coordinate grid, vertex snapping,
 * distance measurement, and seamless "Find on Map" waypoint handoff.
 */

export class CadCanvasViewer {
  constructor(canvasContainerId, options = {}) {
    this.container = document.getElementById(canvasContainerId);
    this.canvas = document.createElement('canvas');
    this.container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this.options = options;
    this.onSelectPointForMap = options.onSelectPointForMap || null;

    // Multi-CAD drawings: Array of { id, name, entities, layers, bounds, visible, color, unitScale }
    this.drawings = [];
    
    // Viewport transform (World CAD -> Screen Canvas)
    // Screen X = (World X - originX) * scale + canvasWidth / 2
    // Screen Y = canvasHeight / 2 - (World Y - originY) * scale
    this.originX = 0;
    this.originY = 0;
    this.scale = 1.0;
    this.minScale = 0.0001;
    this.maxScale = 100000;

    // Interaction state
    this.isDragging = false;
    this.dragStart = { x: 0, y: 0 };
    this.touchPinchDist = null;
    this.selectedVertex = null; // { x, y, layer, drawingName, entityType }
    
    // Measure Tool State: null | { p1: {x, y}, p2: null | {x, y} }
    this.measureMode = false;
    this.measurePoints = [];

    this.initCanvasSize();
    this.bindEvents();
    window.addEventListener('resize', () => this.initCanvasSize());
  }

  initCanvasSize() {
    const rect = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width || window.innerWidth;
    this.height = rect.height || window.innerHeight;

    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    this.ctx.scale(dpr, dpr);
    this.render();
  }

  setDrawings(drawings) {
    this.drawings = drawings;
    this.fitExtents();
  }

  // World to Screen
  toScreen(wx, wy) {
    const sx = (wx - this.originX) * this.scale + this.width / 2;
    const sy = this.height / 2 - (wy - this.originY) * this.scale;
    return { x: sx, y: sy };
  }

  // Screen to World
  toWorld(sx, sy) {
    const wx = (sx - this.width / 2) / this.scale + this.originX;
    const wy = (this.height / 2 - sy) / this.scale + this.originY;
    return { x: wx, y: wy };
  }

  fitExtents() {
    if (!this.drawings || this.drawings.length === 0) {
      this.originX = 0;
      this.originY = 0;
      this.scale = 1.0;
      this.render();
      return;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let hasEntities = false;

    this.drawings.forEach((drawing) => {
      if (drawing.visible === false || !drawing.bounds) return;
      if (drawing.bounds.minX < minX) minX = drawing.bounds.minX;
      if (drawing.bounds.minY < minY) minY = drawing.bounds.minY;
      if (drawing.bounds.maxX > maxX) maxX = drawing.bounds.maxX;
      if (drawing.bounds.maxY > maxY) maxY = drawing.bounds.maxY;
      hasEntities = true;
    });

    if (!hasEntities || minX === Infinity) return;

    this.originX = (minX + maxX) / 2;
    this.originY = (minY + maxY) / 2;

    const dx = Math.max(maxX - minX, 10);
    const dy = Math.max(maxY - minY, 10);

    const padding = 60;
    const scaleX = (this.width - padding * 2) / dx;
    const scaleY = (this.height - padding * 2) / dy;

    this.scale = Math.max(Math.min(scaleX, scaleY), 0.0001);
    this.render();
  }

  render() {
    const ctx = this.ctx;
    ctx.save();
    ctx.clearRect(0, 0, this.width, this.height);

    // 1. Dark CAD Background & Coordinate Grid
    ctx.fillStyle = '#0f172a'; // Deep blueprint dark
    ctx.fillRect(0, 0, this.width, this.height);
    this.drawGrid(ctx);

    // 2. Render CAD Entities from all active drawings
    this.drawings.forEach((drawing) => {
      if (drawing.visible === false) return;
      this.renderDrawingEntities(ctx, drawing);
    });

    // 3. Render Measurement Overlay
    if (this.measurePoints.length > 0) {
      this.renderMeasurement(ctx);
    }

    // 4. Highlight Selected Vertex
    if (this.selectedVertex) {
      const sp = this.toScreen(this.selectedVertex.x, this.selectedVertex.y);
      ctx.strokeStyle = '#ef4444';
      ctx.fillStyle = '#f87171';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  drawGrid(ctx) {
    // Dynamic grid based on scale
    const targetScreenStep = 80; // ~80px
    const rawStep = targetScreenStep / this.scale;
    const pow10 = Math.pow(10, Math.floor(Math.log10(rawStep)));
    let step = pow10;
    if (rawStep / pow10 >= 5) step = pow10 * 5;
    else if (rawStep / pow10 >= 2) step = pow10 * 2;

    const topLeft = this.toWorld(0, 0);
    const bottomRight = this.toWorld(this.width, this.height);

    const startX = Math.floor(topLeft.x / step) * step;
    const endX = Math.ceil(bottomRight.x / step) * step;
    const startY = Math.floor(bottomRight.y / step) * step;
    const endY = Math.ceil(topLeft.y / step) * step;

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;

    for (let x = startX; x <= endX; x += step) {
      const sp = this.toScreen(x, 0);
      ctx.beginPath();
      ctx.moveTo(sp.x, 0);
      ctx.lineTo(sp.x, this.height);
      ctx.stroke();
    }

    for (let y = startY; y <= endY; y += step) {
      const sp = this.toScreen(0, y);
      ctx.beginPath();
      ctx.moveTo(0, sp.y);
      ctx.lineTo(this.width, sp.y);
      ctx.stroke();
    }
  }

  renderDrawingEntities(ctx, drawing) {
    const fallbackColor = drawing.color || '#38bdf8';

    drawing.entities.forEach((entity) => {
      const layer = drawing.layers[entity.layer];
      if (layer && layer.visible === false) return;

      const color = drawing.color || entity.color || (layer ? layer.color : fallbackColor);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1.5;

      switch (entity.type) {
        case 'LINE': {
          const p1 = this.toScreen(entity.x1, entity.y1);
          const p2 = this.toScreen(entity.x2, entity.y2);
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.stroke();
          break;
        }

        case 'LWPOLYLINE':
        case 'POLYLINE': {
          if (!entity.vertices || entity.vertices.length < 2) break;
          ctx.beginPath();
          const first = this.toScreen(entity.vertices[0].x, entity.vertices[0].y);
          ctx.moveTo(first.x, first.y);
          for (let i = 1; i < entity.vertices.length; i++) {
            const p = this.toScreen(entity.vertices[i].x, entity.vertices[i].y);
            ctx.lineTo(p.x, p.y);
          }
          if (entity.closed) {
            ctx.closePath();
          }
          ctx.stroke();
          break;
        }

        case 'CIRCLE': {
          const c = this.toScreen(entity.cx, entity.cy);
          const r = entity.radius * this.scale;
          ctx.beginPath();
          ctx.arc(c.x, c.y, Math.max(r, 1), 0, Math.PI * 2);
          ctx.stroke();
          break;
        }

        case 'POINT': {
          const p = this.toScreen(entity.x, entity.y);
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
          ctx.fill();
          break;
        }

        case 'TEXT':
        case 'MTEXT': {
          if (!entity.text) break;
          const p = this.toScreen(entity.x, entity.y);
          const fontSize = Math.max(Math.min((entity.height || 2.5) * this.scale, 32), 9);
          ctx.font = `${fontSize}px sans-serif`;
          const cleanText = entity.text.replace(/\\P/g, ' ').replace(/\\[A-Za-z0-9]+;/g, '');
          ctx.fillText(cleanText, p.x, p.y);
          break;
        }
      }
    });
  }

  renderMeasurement(ctx) {
    const p1 = this.measurePoints[0];
    const p2 = this.measurePoints[1] || p1;

    const s1 = this.toScreen(p1.x, p1.y);
    const s2 = this.toScreen(p2.x, p2.y);

    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);

    ctx.beginPath();
    ctx.moveTo(s1.x, s1.y);
    ctx.lineTo(s2.x, s2.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Distance Label
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    const midX = (s1.x + s2.x) / 2;
    const midY = (s1.y + s2.y) / 2;

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(midX - 45, midY - 14, 90, 22);
    ctx.strokeStyle = '#f59e0b';
    ctx.strokeRect(midX - 45, midY - 14, 90, 22);

    ctx.fillStyle = '#fbbf24';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${dist.toFixed(2)} m`, midX, midY + 2);
    ctx.textAlign = 'start';
  }

  bindEvents() {
    const el = this.canvas;

    // Mouse Events
    el.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      this.dragStart = { x: e.clientX, y: e.clientY };
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) {
        // Update coordinate HUD
        const rect = el.getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
          const w = this.toWorld(e.clientX - rect.left, e.clientY - rect.top);
          this.updateCoordDisplay(w.x, w.y);
        }
        return;
      }
      const dx = e.clientX - this.dragStart.x;
      const dy = e.clientY - this.dragStart.y;
      this.dragStart = { x: e.clientX, y: e.clientY };

      this.originX -= dx / this.scale;
      this.originY += dy / this.scale;
      this.render();
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
    });

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const worldBefore = this.toWorld(mouseX, mouseY);
      const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
      this.scale = Math.max(Math.min(this.scale * zoomFactor, this.maxScale), this.minScale);

      const worldAfter = this.toWorld(mouseX, mouseY);
      this.originX += (worldBefore.x - worldAfter.x);
      this.originY += (worldBefore.y - worldAfter.y);
      this.render();
    }, { passive: false });

    // Touch Events (Mobile)
    el.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        this.isDragging = true;
        this.dragStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      } else if (e.touches.length === 2) {
        this.isDragging = false;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        this.touchPinchDist = Math.sqrt(dx * dx + dy * dy);
      }
    }, { passive: true });

    el.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1 && this.isDragging) {
        const dx = e.touches[0].clientX - this.dragStart.x;
        const dy = e.touches[0].clientY - this.dragStart.y;
        this.dragStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };

        this.originX -= dx / this.scale;
        this.originY += dy / this.scale;
        this.render();
      } else if (e.touches.length === 2 && this.touchPinchDist) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        const zoomFactor = dist / this.touchPinchDist;
        this.touchPinchDist = dist;

        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;

        const rect = el.getBoundingClientRect();
        const screenX = midX - rect.left;
        const screenY = midY - rect.top;

        const worldBefore = this.toWorld(screenX, screenY);
        this.scale = Math.max(Math.min(this.scale * zoomFactor, this.maxScale), this.minScale);
        const worldAfter = this.toWorld(screenX, screenY);

        this.originX += (worldBefore.x - worldAfter.x);
        this.originY += (worldBefore.y - worldAfter.y);
        this.render();
      }
    }, { passive: true });

    el.addEventListener('touchend', () => {
      this.isDragging = false;
      this.touchPinchDist = null;
    }, { passive: true });

    // Click / Tap Handler: Nearest Vertex Selection & Measure Tool
    el.addEventListener('click', (e) => {
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const world = this.toWorld(sx, sy);

      // Find nearest vertex
      const nearest = this.findNearestVertex(world.x, world.y, 25 / this.scale);

      if (this.measureMode) {
        const pt = nearest ? { x: nearest.x, y: nearest.y } : world;
        if (this.measurePoints.length >= 2) {
          this.measurePoints = [pt];
        } else {
          this.measurePoints.push(pt);
        }
        this.render();
        return;
      }

      if (nearest) {
        this.selectedVertex = nearest;
        this.render();
        this.showSelectionPopup(nearest);
      } else {
        this.selectedVertex = null;
        this.render();
        this.hideSelectionPopup();
      }
    });
  }

  findNearestVertex(wx, wy, maxRadius) {
    let closest = null;
    let minDist = maxRadius;

    this.drawings.forEach((drawing) => {
      if (drawing.visible === false) return;

      drawing.entities.forEach((entity) => {
        const checkPoint = (x, y, label) => {
          const d = Math.hypot(x - wx, y - wy);
          if (d < minDist) {
            minDist = d;
            closest = {
              x,
              y,
              layer: entity.layer,
              drawingName: drawing.name,
              entityType: entity.type,
              label: label || entity.layer
            };
          }
        };

        if (entity.type === 'LINE') {
          checkPoint(entity.x1, entity.y1, `선 모서리`);
          checkPoint(entity.x2, entity.y2, `선 모서리`);
        } else if (entity.vertices) {
          entity.vertices.forEach((v, idx) => checkPoint(v.x, v.y, `정점 #${idx + 1}`));
        } else if (entity.type === 'CIRCLE') {
          checkPoint(entity.cx, entity.cy, `원 중심`);
        } else if (entity.type === 'POINT') {
          checkPoint(entity.x, entity.y, `측점`);
        } else if (entity.type === 'TEXT') {
          checkPoint(entity.x, entity.y, entity.text);
        }
      });
    });

    return closest;
  }

  updateCoordDisplay(x, y) {
    const el = document.getElementById('cad-coords-live');
    if (el) {
      el.textContent = `X: ${x.toFixed(2)}, Y: ${y.toFixed(2)}`;
    }
  }

  showSelectionPopup(vertex) {
    const popup = document.getElementById('cad-selection-card');
    if (!popup) return;

    popup.classList.remove('hidden');
    document.getElementById('cad-sel-label').textContent = `[${vertex.drawingName}] ${vertex.label}`;
    document.getElementById('cad-sel-coords').textContent = `CAD: X=${vertex.x.toFixed(2)}, Y=${vertex.y.toFixed(2)}`;

    // Wire "Find on Map" button
    const btnNav = document.getElementById('btn-cad-find-on-map');
    btnNav.onclick = () => {
      if (this.onSelectPointForMap) {
        this.onSelectPointForMap(vertex);
      }
    };
  }

  hideSelectionPopup() {
    const popup = document.getElementById('cad-selection-card');
    if (popup) popup.classList.add('hidden');
  }

  toggleMeasureMode() {
    this.measureMode = !this.measureMode;
    this.measurePoints = [];
    this.render();
    return this.measureMode;
  }
}
