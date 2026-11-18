'use strict';
// (wrapped in a function so its helpers don't clash with other renderer scripts)
(function () {
// Loot spots for Scav runs: what each container type is good for, clustering spots into
// "hotspots" (rooms/buildings with lots of good containers), and picking a route through them.
// Pure functions. Loaded in the renderer, by the main process (container table) and by the tests.

// Categories shown in the legend and the Scav-run picker. `on` = picked by default for a Scav run.
const LOOT_CATS = [
  { id: 'weapons', label: 'Weapon boxes', short: 'weapon box', icon: '🔫', color: '#e39a3b', on: true, hint: 'Guns, mods and sometimes ammo' },
  { id: 'ammo', label: 'Ammo & grenade boxes', short: 'ammo box', icon: '🧨', color: '#e05a4f', on: true, hint: 'Loose ammo, ammo packs and grenades' },
  { id: 'bodies', label: 'Bodies', short: 'body', icon: '🦺', color: '#8fc45a', on: true, hint: 'Static PMC and Scav bodies: armor, rigs, helmets, guns' },
  { id: 'valuables', label: 'Safes, PCs & valuables', short: 'valuable', icon: '💰', color: '#f2d05c', on: false, hint: 'Safes, PCs, cash registers, suitcases, plus loose spots that can spawn 100k+ items' },
  { id: 'meds', label: 'Medical', short: 'med spot', icon: '💊', color: '#5cc3e6', on: false, hint: 'Medcases, medbags, medical crates and loose meds' },
  { id: 'tech', label: 'Toolboxes & tech crates', short: 'tech spot', icon: '🔧', color: '#a8a8d8', on: false, hint: 'Parts for hideout and barters' },
  { id: 'stashes', label: 'Hidden stashes', short: 'stash', icon: '📦', color: '#c08a58', on: false, hint: 'Ground caches and buried barrels: random, often good loot' },
  { id: 'keys', label: 'Loose key spawns', short: 'key spawn', icon: '🗝️', color: '#e8e8e8', on: false, hint: 'Spots where a key can spawn' },
  { id: 'misc', label: 'Jackets, bags, drawers, crates', short: 'small container', icon: '🎒', color: '#8a8f96', on: false, hint: 'Common, low-value containers' },
];
const CAT_BY_ID = Object.fromEntries(LOOT_CATS.map((c) => [c.id, c]));

// tarkov.dev container normalizedName -> category and how much it adds to a hotspot.
const CONTAINERS = {
  'weapon-box': { cat: 'weapons', w: 3 },
  'wooden-ammo-box': { cat: 'ammo', w: 3 },
  'grenade-box': { cat: 'ammo', w: 1.5 },
  'pmc-body': { cat: 'bodies', w: 3 },
  'dead-scav': { cat: 'bodies', w: 2 },
  'scav-body': { cat: 'bodies', w: 2 },
  'civilian-body': { cat: 'bodies', w: 1 },
  'lab-technician-body': { cat: 'bodies', w: 1 },
  safe: { cat: 'valuables', w: 3 },
  'bank-safe': { cat: 'valuables', w: 4 },
  'shturmans-stash': { cat: 'valuables', w: 4 },
  'plastic-suitcase': { cat: 'valuables', w: 2 },
  'pc-block': { cat: 'valuables', w: 1 },
  'cash-register': { cat: 'valuables', w: 1 },
  'bank-cash-register': { cat: 'valuables', w: 1 },
  medcase: { cat: 'meds', w: 2 },
  medbag: { cat: 'meds', w: 1 },
  'medical-supply-crate': { cat: 'meds', w: 2 },
  toolbox: { cat: 'tech', w: 1 },
  'technical-supply-crate': { cat: 'tech', w: 2 },
  'ground-cache': { cat: 'stashes', w: 2 },
  'buried-barrel-cache': { cat: 'stashes', w: 2 },
  jacket: { cat: 'misc', w: 0.5 },
  'duffle-bag': { cat: 'misc', w: 0.5 },
  drawer: { cat: 'misc', w: 0.5 },
  'wooden-crate': { cat: 'misc', w: 0.5 },
  'ration-supply-crate': { cat: 'misc', w: 1 },
};
// loose-loot spots (a spot can spawn one of several items) are worth less than a container
// ("this spot can spawn one of 40 items, one of which is a GPU" is a weak signal)
const LOOSE_WEIGHT = 0.4;

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * Group loot spots of the chosen categories into hotspots.
 * @param loot  [{ c: category, n: label, p: {x,y,z}, w? }]
 * @param cats  category ids to count
 * @returns [{ id, position, score, count, byType: [{label, cat, n}], label }] best first
 */
function lootHotspots(loot, cats, { radius = 30, max = 18, minScore = 3, areas = [] } = {}) {
  const want = new Set(cats);
  const pts = (loot || []).filter((l) => want.has(l.c) && l.p);
  if (!pts.length) return [];
  // bucket by grid cell so neighbour lookups stay fast on big maps
  const cell = radius;
  const key = (x, z) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
  const grid = new Map();
  pts.forEach((p, i) => {
    const k = key(p.p.x, p.p.z);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  const near = (i) => {
    const p = pts[i].p;
    const cx = Math.floor(p.x / cell);
    const cz = Math.floor(p.z / cell);
    const out = [];
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const j of grid.get(`${cx + dx},${cz + dz}`) || []) if (dist(p, pts[j].p) <= radius) out.push(j);
    return out;
  };
  // Rarer kinds count for more, so picking "weapons + ammo + bodies" doesn't give a route of
  // nothing but weapon boxes just because a map has five times as many of them.
  const perCat = {};
  for (const l of pts) perCat[l.c] = (perCat[l.c] || 0) + 1;
  const most = Math.max(...Object.values(perCat));
  const boost = Object.fromEntries(Object.entries(perCat).map(([c, n]) => [c, Math.min(3, Math.sqrt(most / n))]));
  const weight = (l) => (l.w ?? LOOSE_WEIGHT) * boost[l.c];
  const density = pts.map((_, i) => near(i).reduce((s, j) => s + weight(pts[j]), 0));
  const order = pts.map((_, i) => i).sort((a, b) => density[b] - density[a] || a - b);
  const used = new Set();
  const spots = [];
  for (const i of order) {
    if (used.has(i)) continue;
    const members = near(i).filter((j) => !used.has(j));
    for (const j of members) used.add(j);
    const score = members.reduce((s, j) => s + weight(pts[j]), 0);
    if (score < minScore) continue;
    let x = 0;
    let y = 0;
    let z = 0;
    let wsum = 0;
    const types = new Map();
    for (const j of members) {
      const w = weight(pts[j]);
      x += pts[j].p.x * w;
      y += pts[j].p.y * w;
      z += pts[j].p.z * w;
      wsum += w;
      const t = types.get(pts[j].n) || { label: pts[j].n, cat: pts[j].c, n: 0, value: 0 };
      t.n++;
      t.value += w;
      types.set(pts[j].n, t);
    }
    const position = { x: x / wsum, y: y / wsum, z: z / wsum };
    spots.push({
      id: `${Math.round(pts[i].p.x)}_${Math.round(pts[i].p.z)}`,
      position,
      score: Math.round(score * 10) / 10,
      count: members.length,
      // most valuable kind first
      byType: [...types.values()].sort((a, b) => b.value - a.value || b.n - a.n).map(({ value, ...t }) => t),
      points: members.map((j) => pts[j].p),
      label: areaName(areas, position),
    });
  }
  return spots.sort((a, b) => b.score - a.score).slice(0, max);
}

/** Nearest named area (from spawn zones) within reach, for labels like "Dorms". */
function areaName(areas, p, reach = 120) {
  let best = null;
  let bestD = reach;
  for (const a of areas || []) {
    const d = dist(a, p);
    if (d < bestD) {
      bestD = d;
      best = a.name;
    }
  }
  return best;
}

/** One-line summary of a hotspot: "3 weapon boxes, 1 PMC body". */
function hotspotSummary(h, max = 4) {
  const parts = h.byType.slice(0, max).map((t) => `${t.n} ${t.n === 1 ? t.label : plural(t.label)}`);
  if (h.byType.length > max) parts.push('more');
  return parts.join(', ');
}

function plural(label) {
  if (/body$/i.test(label)) return label.replace(/body$/i, 'bodies');
  if (/(box|stash)$/i.test(label)) return `${label}es`;
  if (/s$/i.test(label)) return label;
  return `${label}s`;
}

const pathLen = (seq, start, end) => {
  let len = 0;
  let prev = start || null;
  for (const s of seq) {
    if (prev) len += dist(prev, s.position);
    prev = s.position;
  }
  if (end && prev) len += dist(prev, end);
  return len;
};

/** Order stops (anything with .position) for a short path from start to end: nearest neighbour + 2-opt. */
function orderStops(stops, start, end) {
  const remaining = [...stops];
  const order = [];
  let cur = start;
  if (!cur && remaining.length) {
    // no start: begin with the stop farthest from the end, so the path sweeps toward it
    remaining.sort((a, b) => (end ? dist(b.position, end) - dist(a.position, end) : 0));
    cur = remaining[0].position;
  }
  while (remaining.length) {
    let bi = 0;
    for (let i = 1; i < remaining.length; i++) if (dist(cur, remaining[i].position) < dist(cur, remaining[bi].position)) bi = i;
    const [s] = remaining.splice(bi, 1);
    order.push(s);
    cur = s.position;
  }
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++) {
      for (let k = i + 1; k < order.length; k++) {
        const cand = [...order.slice(0, i), ...order.slice(i, k + 1).reverse(), ...order.slice(k + 1)];
        if (pathLen(cand, start, end) + 0.01 < pathLen(order, start, end)) {
          order.splice(0, order.length, ...cand);
          improved = true;
        }
      }
    }
  }
  return order;
}

const ROUTE_SIZES = {
  short: { label: 'Quick', budget: 700, maxStops: 3 },
  medium: { label: 'Normal', budget: 1300, maxStops: 5 },
  long: { label: 'Long', budget: 2200, maxStops: 8 },
};

/**
 * Pick the hotspots worth the detour: repeatedly add the one with the best loot per extra metre,
 * until the straight-line route would pass the length budget.
 */
function autoPick(hotspots, { start = null, end = null, size = 'medium' } = {}) {
  const { budget, maxStops } = ROUTE_SIZES[size] || ROUTE_SIZES.medium;
  const route = [];
  const left = [...hotspots];
  const base = start && end ? dist(start, end) : 0;
  let len = base;
  while (route.length < maxStops && left.length) {
    let best = null;
    for (const h of left) {
      // cheapest place to slot it in
      let delta = Infinity;
      let at = 0;
      for (let i = 0; i <= route.length; i++) {
        const prev = i === 0 ? start : route[i - 1].position;
        const next = i === route.length ? end : route[i].position;
        let d;
        if (prev && next) d = dist(prev, h.position) + dist(h.position, next) - dist(prev, next);
        else if (prev) d = dist(prev, h.position);
        else if (next) d = dist(h.position, next);
        else d = 0;
        if (d < delta) {
          delta = d;
          at = i;
        }
      }
      if (len + delta > Math.max(budget, base * 1.05)) continue;
      const value = h.score / (delta + 60);
      if (!best || value > best.value) best = { h, at, delta, value };
    }
    if (!best) break;
    route.splice(best.at, 0, best.h);
    left.splice(left.indexOf(best.h), 1);
    len += best.delta;
  }
  return route.map((h) => h.id);
}

/**
 * The Scav-run route.
 * @param hotspots  from lootHotspots
 * @param opts      { start, end, picks: [id]|null (null = auto), looted: [id], size,
 *                    pickFrom: where auto-pick plans from (the chosen spawn), so stops don't change
 *                    every time a new live position comes in; defaults to start }
 */
function planLootRoute(hotspots, opts = {}) {
  const looted = new Set(opts.looted || []);
  const from = 'pickFrom' in opts ? opts.pickFrom : opts.start;
  const ids = opts.picks || autoPick(hotspots, { start: from, end: opts.end, size: opts.size });
  const byId = new Map(hotspots.map((h) => [h.id, h]));
  const chosen = ids.map((id) => byId.get(id)).filter(Boolean);
  const todo = chosen.filter((h) => !looted.has(h.id));
  const order = orderStops(todo, opts.start || null, opts.end || null);
  return {
    stops: order.map((h) => ({ hotspot: h, point: { position: h.position } })),
    picked: chosen.map((h) => h.id),
    looted: chosen.filter((h) => looted.has(h.id)),
    length: Math.round(pathLen(order, opts.start || null, opts.end || null)),
  };
}

const Loot = { LOOT_CATS, CAT_BY_ID, CONTAINERS, ROUTE_SIZES, lootHotspots, hotspotSummary, autoPick, planLootRoute, orderStops, areaName };
if (typeof module !== 'undefined' && module.exports) module.exports = Loot;
if (typeof window !== 'undefined') window.Loot = Loot;
})();
