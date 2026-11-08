/**
 * High-performance Pure JavaScript DXF Parser for CAD-to-Map Overlay
 * Supports standard AutoCAD 2000-2024 ASCII DXF files.
 */

// AutoCAD 256 Index Color (ACI) to Hex mapping (Standard base colors + key ranges)
const ACI_COLORS = {
  1: '#ff0000', // Red
  2: '#ffff00', // Yellow
  3: '#00ff00', // Green
  4: '#00ffff', // Cyan
  5: '#0000ff', // Blue
  6: '#ff00ff', // Magenta
  7: '#ffffff', // White / Black (rendered as high-contrast white on dark/satellite)
  8: '#808080', // Dark Gray
  9: '#c0c0c0', // Light Gray
};

export class DxfParser {
  constructor() {
    this.layers = {};
    this.entities = [];
    this.header = {};
    this.bounds = {
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity
    };
  }

  /**
   * Parse a DXF file string into structured entities and layers
   * @param {string} text 
   * @returns {Object} { entities, layers, bounds, stats }
   */
  parse(text) {
    const lines = text.split(/\r?\n/);
    const n = lines.length;
    let i = 0;

    this.layers = {
      '0': { name: '0', color: '#00ffff', visible: true }
    };
    this.entities = [];
    this.bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

    let currentSection = null;

    while (i < n - 1) {
      const code = parseInt(lines[i].trim(), 10);
      const val = lines[i + 1] ? lines[i + 1].trim() : '';
      i += 2;

      if (code === 0 && val === 'SECTION') {
        // Read section name (code 2)
        if (i < n - 1 && parseInt(lines[i].trim(), 10) === 2) {
          currentSection = lines[i + 1].trim();
          i += 2;
        }
        continue;
      }

      if (code === 0 && val === 'ENDSEC') {
        currentSection = null;
        continue;
      }

      if (code === 0 && val === 'EOF') {
        break;
      }

      if (currentSection === 'TABLES') {
        if (code === 0 && val === 'LAYER') {
          i = this.parseLayer(lines, i, n);
        }
      } else if (currentSection === 'ENTITIES') {
        if (code === 0) {
          i = this.parseEntity(val, lines, i, n);
        }
      }
    }

    return {
      entities: this.entities,
      layers: this.layers,
      bounds: this.bounds,
      totalCount: this.entities.length
    };
  }

  parseLayer(lines, startIndex, n) {
    let i = startIndex;
    let layerName = 'Unnamed';
    let colorIndex = 7;

    while (i < n - 1) {
      const code = parseInt(lines[i].trim(), 10);
      const val = lines[i + 1] ? lines[i + 1].trim() : '';

      if (code === 0) {
        break; // Next table item or section end
      }

      if (code === 2) {
        layerName = val;
      } else if (code === 62) {
        colorIndex = Math.abs(parseInt(val, 10));
      }

      i += 2;
    }

    this.layers[layerName] = {
      name: layerName,
      color: ACI_COLORS[colorIndex] || '#00e5ff',
      colorIndex,
      visible: true
    };

    return i;
  }

  updateBounds(x, y) {
    if (isNaN(x) || isNaN(y)) return;
    if (x < this.bounds.minX) this.bounds.minX = x;
    if (y < this.bounds.minY) this.bounds.minY = y;
    if (x > this.bounds.maxX) this.bounds.maxX = x;
    if (y > this.bounds.maxY) this.bounds.maxY = y;
  }

  parseEntity(type, lines, startIndex, n) {
    let i = startIndex;
    const entity = {
      type,
      layer: '0',
      color: null,
      vertices: []
    };

    let currVertex = null;
    let polylineVertices = [];

    while (i < n - 1) {
      const code = parseInt(lines[i].trim(), 10);
      const val = lines[i + 1] ? lines[i + 1].trim() : '';

      if (code === 0) {
        if (type === 'POLYLINE' && val === 'VERTEX') {
          // Continue reading polyline vertex
          i += 2;
          const v = this.parseVertex(lines, i, n);
          i = v.nextIndex;
          if (v.point) {
            polylineVertices.push(v.point);
            this.updateBounds(v.point.x, v.point.y);
          }
          continue;
        } else if (type === 'POLYLINE' && val === 'SEQEND') {
          i += 2;
          break;
        } else {
          break; // End of this entity
        }
      }

      // Common codes
      if (code === 8) {
        entity.layer = val;
      } else if (code === 62) {
        entity.color = ACI_COLORS[Math.abs(parseInt(val, 10))] || null;
      } else if (code === 420) {
        // True color RGB (24-bit integer)
        const rgb = parseInt(val, 10);
        const r = (rgb >> 16) & 255;
        const g = (rgb >> 8) & 255;
        const b = rgb & 255;
        entity.color = `rgb(${r},${g},${b})`;
      }

      // Entity-specific codes
      switch (type) {
        case 'LINE':
          if (code === 10) entity.x1 = parseFloat(val);
          else if (code === 20) entity.y1 = parseFloat(val);
          else if (code === 30) entity.z1 = parseFloat(val);
          else if (code === 11) entity.x2 = parseFloat(val);
          else if (code === 21) entity.y2 = parseFloat(val);
          else if (code === 31) entity.z2 = parseFloat(val);
          break;

        case 'POINT':
          if (code === 10) entity.x = parseFloat(val);
          else if (code === 20) entity.y = parseFloat(val);
          else if (code === 30) entity.z = parseFloat(val);
          break;

        case 'CIRCLE':
        case 'ARC':
          if (code === 10) entity.cx = parseFloat(val);
          else if (code === 20) entity.cy = parseFloat(val);
          else if (code === 30) entity.cz = parseFloat(val);
          else if (code === 40) entity.radius = parseFloat(val);
          else if (code === 50) entity.startAngle = parseFloat(val);
          else if (code === 51) entity.endAngle = parseFloat(val);
          break;

        case 'LWPOLYLINE':
          if (code === 70) entity.closed = (parseInt(val, 10) & 1) === 1;
          else if (code === 10) {
            currVertex = { x: parseFloat(val), y: 0 };
            entity.vertices.push(currVertex);
          } else if (code === 20 && currVertex) {
            currVertex.y = parseFloat(val);
            this.updateBounds(currVertex.x, currVertex.y);
          } else if (code === 42 && currVertex) {
            currVertex.bulge = parseFloat(val); // arc segment
          }
          break;

        case 'TEXT':
        case 'MTEXT':
          if (code === 1) entity.text = val;
          else if (code === 10) entity.x = parseFloat(val);
          else if (code === 20) entity.y = parseFloat(val);
          else if (code === 30) entity.z = parseFloat(val);
          else if (code === 40) entity.height = parseFloat(val);
          else if (code === 50) entity.rotation = parseFloat(val);
          break;
      }

      i += 2;
    }

    // Finalize entity bounds & geometry
    if (type === 'LINE') {
      if (!isNaN(entity.x1) && !isNaN(entity.y1)) this.updateBounds(entity.x1, entity.y1);
      if (!isNaN(entity.x2) && !isNaN(entity.y2)) this.updateBounds(entity.x2, entity.y2);
    } else if (type === 'POINT' || type === 'TEXT' || type === 'MTEXT') {
      if (!isNaN(entity.x) && !isNaN(entity.y)) this.updateBounds(entity.x, entity.y);
    } else if (type === 'CIRCLE' || type === 'ARC') {
      if (!isNaN(entity.cx) && !isNaN(entity.cy) && !isNaN(entity.radius)) {
        this.updateBounds(entity.cx - entity.radius, entity.cy - entity.radius);
        this.updateBounds(entity.cx + entity.radius, entity.cy + entity.radius);
      }
    } else if (type === 'POLYLINE') {
      entity.vertices = polylineVertices;
    }

    this.entities.push(entity);
    return i;
  }

  parseVertex(lines, startIndex, n) {
    let i = startIndex;
    const pt = { x: 0, y: 0, z: 0 };

    while (i < n - 1) {
      const code = parseInt(lines[i].trim(), 10);
      const val = lines[i + 1] ? lines[i + 1].trim() : '';

      if (code === 0) break;

      if (code === 10) pt.x = parseFloat(val);
      else if (code === 20) pt.y = parseFloat(val);
      else if (code === 30) pt.z = parseFloat(val);

      i += 2;
    }

    return { point: pt, nextIndex: i };
  }
}
