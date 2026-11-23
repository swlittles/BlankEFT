// Walking paths: a grid made from the map art (what's water, fence, rock, road, building…) and an
// A* search over it, so a route follows the ground instead of cutting straight across.
//
// It's an approximation: the map art has outdoor obstacles but no interior walls, doors or stairs,
// so paths through and inside buildings are rough. Pure functions, shared with the tests.
(function () {
  'use strict';

  const BLOCKED = 0;
  const ROAD = 1;
  const OPEN = 2;
  const BUILDING = 3;
  const DANGER = 4;
  // cost per cell walked: roads are quicker and safer to follow, buildings and danger zones (mines,
  // sniper zones) are avoided unless they save a lot of walking
  // (the map art has no interior walls or doors, and most buildings can't be walked straight through,
  // so a building costs 4x open ground: paths go around them and only enter for a stop inside)
  const COST = [Infinity, 0.75, 1, 4, 8];

  // colours the map art is redrawn in (see mapView.js); every pixel is read back as the nearest one
  const PALETTE = [
    [BLOCKED, 255, 0, 0],
    [ROAD, 255, 255, 0],
    [OPEN, 0, 255, 0],
    [BUILDING, 0, 0, 255],
    [DANGER, 255, 128, 0],
  ];

  /** CSS that redraws tarkov.dev's map SVG in PALETTE colours (classes from its own stylesheet). */
  // (the default is set on the root and inherited, not forced on every element: shapes drawn with
  // <use> take their colour from the group around the <use>, as in the real art)
  const RASTER_CSS = `
    svg { fill: none; stroke: none; }
    .land, .land *, .trees, .trees *, .cement, .cement *, .tarmac, .tarmac *, .gravel, .gravel *, .wood, .wood * { fill: rgb(0,255,0) !important; }
    .building, .building *, .floor, .floor *, .locked, .locked *, .structure, .structure *, .plane, .plane *, .chopper, .chopper * { fill: rgb(0,0,255) !important; }
    .water, .water *, .rock, .rock * { fill: rgb(255,0,0) !important; }
    .road_tarmac, .road_tarmac *, .road_gravel, .road_gravel * { stroke: rgb(255,255,0) !important; }
    .road_small, .road_small * { stroke-width: 5 !important; }
    .road_medium, .road_medium * { stroke-width: 8 !important; }
    .road_large, .road_large * { stroke-width: 12 !important; }
    .fence, .fence * { stroke: rgb(255,0,0) !important; stroke-width: 1.6 !important; }
    .map_border, .map_border * { stroke: rgb(255,0,0) !important; stroke-width: 3 !important; }
    .danger, .danger *, .danger_small, .danger_small * { fill: rgb(255,128,0) !important; }
  `;

  /** RGBA pixels → a cell per pixel (BLOCKED/ROAD/OPEN/BUILDING/DANGER). Transparent = off the map. */
  function classify(rgba, w, h) {
    const grid = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      if (rgba[o + 3] < 128) {
        grid[i] = BLOCKED;
        continue;
      }
      let best = BLOCKED;
      let bestD = Infinity;
      for (const [code, r, g, b] of PALETTE) {
        const d = (rgba[o] - r) ** 2 + (rgba[o + 1] - g) ** 2 + (rgba[o + 2] - b) ** 2;
        if (d < bestD) {
          bestD = d;
          best = code;
        }
      }
      grid[i] = best;
    }
    return grid;
  }

  /** Nearest walkable cell to (x, y) within `radius` cells, or null. */
  function snap(grid, w, h, x, y, radius = 15) {
    x = Math.round(x);
    y = Math.round(y);
    let best = null;
    let bestD = Infinity;
    for (let r = 0; r <= radius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring r only
          const cx = x + dx;
          const cy = y + dy;
          if (cx < 0 || cy < 0 || cx >= w || cy >= h || grid[cy * w + cx] === BLOCKED) continue;
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            bestD = d;
            best = { x: cx, y: cy };
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  // binary min-heap of cell indexes keyed by f
  function heap() {
    const ids = [];
    const keys = [];
    return {
      get size() {
        return ids.length;
      },
      push(id, key) {
        let i = ids.length;
        ids.push(id);
        keys.push(key);
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (keys[p] <= key) break;
          ids[i] = ids[p];
          keys[i] = keys[p];
          i = p;
        }
        ids[i] = id;
        keys[i] = key;
      },
      pop() {
        const top = ids[0];
        const lastId = ids.pop();
        const lastKey = keys.pop();
        if (ids.length) {
          let i = 0;
          for (;;) {
            const l = 2 * i + 1;
            if (l >= ids.length) break;
            const r = l + 1;
            const c = r < ids.length && keys[r] < keys[l] ? r : l;
            if (keys[c] >= lastKey) break;
            ids[i] = ids[c];
            keys[i] = keys[c];
            i = c;
          }
          ids[i] = lastId;
          keys[i] = lastKey;
        }
        return top;
      },
    };
  }

  const DIRS = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [-1, -1, Math.SQRT2],
  ];

  /**
   * Cheapest path between two grid points ({x, y} in cells, need not be whole or walkable: they're
   * snapped to the nearest walkable cell). Returns [{x, y}, …] cells from start to goal, or null.
   * Diagonal steps can't squeeze between two blocked cells (so a 1-cell fence holds).
   */
  function findPath(grid, w, h, from, to, { snapRadius = 15, maxVisits = 4e6 } = {}) {
    const s = snap(grid, w, h, from.x, from.y, snapRadius);
    const t = snap(grid, w, h, to.x, to.y, snapRadius);
    if (!s || !t) return null;
    const start = s.y * w + s.x;
    const goal = t.y * w + t.x;
    if (start === goal) return [s];
    const g = new Float32Array(w * h).fill(Infinity);
    const came = new Int32Array(w * h).fill(-1);
    const closed = new Uint8Array(w * h);
    const hMin = COST[ROAD];
    const hf = (i) => {
      const dx = Math.abs((i % w) - t.x);
      const dy = Math.abs(((i / w) | 0) - t.y);
      return hMin * (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy));
    };
    const open = heap();
    g[start] = 0;
    open.push(start, hf(start));
    let visits = 0;
    while (open.size) {
      const cur = open.pop();
      if (cur === goal) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (++visits > maxVisits) return null;
      const cx = cur % w;
      const cy = (cur / w) | 0;
      const cCost = COST[grid[cur]];
      for (const [dx, dy, len] of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        const code = grid[n];
        if (code === BLOCKED || closed[n]) continue;
        if (dx && dy && (grid[cy * w + nx] === BLOCKED || grid[ny * w + cx] === BLOCKED)) continue;
        const ng = g[cur] + (len * (cCost + COST[code])) / 2;
        if (ng < g[n]) {
          g[n] = ng;
          came[n] = cur;
          open.push(n, ng + hf(n));
        }
      }
    }
    if (came[goal] === -1) return null;
    const out = [];
    for (let i = goal; i !== -1; i = came[i]) out.push({ x: i % w, y: (i / w) | 0 });
    return out.reverse();
  }

  /** Cost of walking the straight line a→b (Infinity if it crosses a blocked cell). */
  function lineCost(grid, w, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 2));
    let cost = 0;
    for (let i = 0; i <= steps; i++) {
      const c = COST[grid[Math.round(a.y + (dy * i) / steps) * w + Math.round(a.x + (dx * i) / steps)]];
      if (c === Infinity) return Infinity;
      cost += (c * len) / (steps + 1);
    }
    return cost;
  }

  /** Cost of walking along a cell path, cumulative: out[k] = cost from path[0] to path[k]. */
  function pathCosts(grid, w, path) {
    const out = [0];
    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1];
      const b = path[k];
      out.push(out[k - 1] + (Math.hypot(b.x - a.x, b.y - a.y) * (COST[grid[a.y * w + a.x]] + COST[grid[b.y * w + b.x]])) / 2);
    }
    return out;
  }

  /**
   * Straightens a cell path: skips ahead to the furthest point a straight line can reach without
   * costing more than the path it replaces. So it cuts corners across open ground, but never
   * shortcuts through a building or danger zone the path went around.
   */
  function smoothPath(grid, w, path) {
    if (!path || path.length < 3) return path;
    const cum = pathCosts(grid, w, path);
    const out = [path[0]];
    let i = 0;
    while (i < path.length - 1) {
      let best = i + 1;
      for (let j = i + 2; j < path.length; j++) {
        if (lineCost(grid, w, path[i], path[j]) <= (cum[j] - cum[i]) * 1.001 + 1e-6) best = j;
        else if (j - best > 40) break; // well past the last good shortcut: stop looking
      }
      out.push(path[best]);
      i = best;
    }
    return out;
  }

  const Pathing = { BLOCKED, ROAD, OPEN, BUILDING, DANGER, COST, PALETTE, RASTER_CSS, classify, snap, findPath, smoothPath, lineCost };
  if (typeof module !== 'undefined' && module.exports) module.exports = Pathing;
  if (typeof window !== 'undefined') window.Pathing = Pathing;
})();
