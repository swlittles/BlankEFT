'use strict';
// Raid planning: order the planned quest objectives into a route and work out what to bring.
// Pure functions. Loaded in the renderer and by the Node tests.

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function objectiveRelevant(o, mapId) {
  // Objectives with no map list apply to any map (e.g. "kill PMCs with a suppressed weapon").
  return o.maps.length === 0 || o.maps.includes(mapId) || o.zones.some((z) => z.map === mapId) || o.possibleLocations.some((l) => l.map === mapId);
}

/** Candidate points for one objective on this map. */
function objectivePoints(o, mapId) {
  const pts = [];
  for (const z of o.zones) if (z.map === mapId && z.position) pts.push({ position: z.position, kind: 'zone', item: z });
  for (const l of o.possibleLocations) {
    if (l.map !== mapId) continue;
    for (const p of l.positions) pts.push({ position: p, kind: 'item', item: { position: p } });
  }
  return pts;
}

/**
 * @param tasks   planned task objects
 * @param mapId   API map id
 * @param opts    { start: {x,z}|null, end: {x,z}|null, objectivesDone: {} }
 * @returns { stops: [{task, objective, point}], anywhere: [{task, objective}], length }
 */
function planRoute(tasks, mapId, opts = {}) {
  const done = opts.objectivesDone || {};
  const groups = []; // each needs one visit: pick the best candidate point
  const anywhere = [];
  for (const task of tasks) {
    for (const objective of task.objectives) {
      if (done[objective.id] || !objectiveRelevant(objective, mapId)) continue;
      const pts = objectivePoints(objective, mapId);
      if (pts.length) groups.push({ task, objective, pts });
      else if (objective.maps.includes(mapId) || objective.maps.length === 0) {
        if (!['giveItem', 'giveQuestItem', 'traderLevel', 'traderStanding', 'taskStatus', 'skill', 'buildWeapon', 'sellItem', 'experience'].includes(objective.type)) {
          anywhere.push({ task, objective });
        }
      }
    }
  }

  // Greedy nearest-neighbour from the start, choosing the closest candidate of each objective.
  const order = [];
  const remaining = new Set(groups.map((_, i) => i));
  let cur = opts.start || null;
  if (!cur && groups.length) {
    // no start: begin at the objective farthest from the end (or the first), so the path sweeps
    let best = 0;
    if (opts.end) best = [...remaining].sort((a, b) => dist(groups[b].pts[0].position, opts.end) - dist(groups[a].pts[0].position, opts.end))[0];
    cur = groups[best].pts[0].position;
  }
  while (remaining.size) {
    let bestI = -1;
    let bestP = null;
    let bestD = Infinity;
    for (const i of remaining) {
      for (const p of groups[i].pts) {
        const d = dist(cur, p.position);
        if (d < bestD) {
          bestD = d;
          bestI = i;
          bestP = p;
        }
      }
    }
    remaining.delete(bestI);
    order.push({ ...groups[bestI], point: bestP });
    cur = bestP.position;
  }

  // 2-opt cleanup with fixed start/end.
  const pathLen = (seq) => {
    let len = 0;
    let prev = opts.start;
    for (const s of seq) {
      if (prev) len += dist(prev, s.point.position);
      prev = s.point.position;
    }
    if (opts.end && prev) len += dist(prev, opts.end);
    return len;
  };
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++) {
      for (let k = i + 1; k < order.length; k++) {
        const cand = [...order.slice(0, i), ...order.slice(i, k + 1).reverse(), ...order.slice(k + 1)];
        if (pathLen(cand) + 0.01 < pathLen(order)) {
          order.splice(0, order.length, ...cand);
          improved = true;
        }
      }
    }
  }

  return {
    stops: order.map(({ task, objective, point }) => ({ task, objective, point })),
    anywhere,
    length: Math.round(pathLen(order)),
  };
}

/**
 * What to bring into the raid for the planned quests.
 * Every requirement is a list of alternatives (any one of them works).
 */
function buildLoadout(tasks, mapId, objectivesDone = {}) {
  const keys = new Map(); // altsKey -> { alts, reasons:Set }
  const bring = new Map(); // altsKey -> { alts, count, reasons }
  const gear = []; // { label, alts:[[ids]], task }
  const questItems = []; // { item, task, objective }
  const findInRaid = []; // { alts, count, task }

  const addKey = (alts, why) => {
    const k = alts.join('|');
    if (!keys.has(k)) keys.set(k, { alts, reasons: new Set() });
    keys.get(k).reasons.add(why);
  };
  const addBring = (alts, count, why) => {
    const k = alts.join('|');
    if (!bring.has(k)) bring.set(k, { alts, count: 0, reasons: new Set() });
    const e = bring.get(k);
    e.count += count || 1;
    e.reasons.add(why);
  };

  for (const task of tasks) {
    for (const nk of task.neededKeys || []) if (nk.map === mapId && nk.keys.length) addKey(nk.keys, task.name);
    for (const o of task.objectives) {
      if (objectivesDone[o.id] || !objectiveRelevant(o, mapId)) continue;
      for (const alts of o.requiredKeys || []) addKey(alts, task.name);
      if (o.type === 'plantItem' && o.items.length) addBring(o.items, o.count, task.name);
      if (o.type === 'mark' && o.markerItem) addBring([o.markerItem], 1, task.name);
      if (o.type === 'useItem' && o.useAny.length) addBring(o.useAny, o.count, task.name);
      if (o.type === 'plantQuestItem' && o.questItem) questItems.push({ item: o.questItem, task, objective: o });
      if (o.type === 'shoot') {
        if (o.usingWeapon?.length) gear.push({ label: 'Weapon (any one)', alts: [o.usingWeapon], task, objective: o });
        if (o.usingWeaponMods?.length) gear.push({ label: 'Weapon mods', alts: o.usingWeaponMods, task, objective: o });
        if (o.wearing?.length) gear.push({ label: 'Wear', alts: o.wearing, task, objective: o });
      }
      if (o.type === 'findItem' && o.foundInRaid && o.items.length) findInRaid.push({ alts: o.items, count: o.count || 1, task });
    }
  }
  const fin = (m) => [...m.values()].map((e) => ({ ...e, reasons: [...e.reasons] }));
  return { keys: fin(keys), bring: fin(bring), gear, questItems, findInRaid };
}

/** Nearest PMC spawn to a position (used to guess where you spawned from your first screenshot). */
function nearestSpawn(spawns, p) {
  let best = null;
  let bestD = Infinity;
  for (const s of spawns || []) {
    const d = dist(s.position, p);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best ? { spawn: best, distance: bestD } : null;
}

const Planner = { planRoute, buildLoadout, nearestSpawn, objectiveRelevant, objectivePoints };
if (typeof module !== 'undefined' && module.exports) module.exports = Planner;
if (typeof window !== 'undefined') window.Planner = Planner;
