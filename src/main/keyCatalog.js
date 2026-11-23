'use strict';
// Keys tab: every key and keycard, which map it belongs to (the locks it opens, the quests that need
// it there), where it spawns in raid, and whether quests hand it out. Trader, barter and flea sources
// live on the item itself (items[id].sources). Pure function, used by tarkovData.buildModel and tests.

// Keys whose locks tarkov.dev hasn't placed, but whose name says where they're used
const NAME_MAP = [
  [/health resort|pumping station|weather station|cottage safe/i, 'shoreline'],
  [/^(oli|idea|goshan) cash register/i, 'interchange'],
  [/shturman's stash/i, 'woods'],
  [/primorsky ave|pinewood hotel|unity credit bank/i, 'streets-of-tarkov'],
  [/ariadne/i, 'the-labyrinth'],
];

/**
 * @param o.keyIds    ids of every key item
 * @param o.maps      raw tarkov.dev maps to look at ({ id, locks, lootLoose, accessKeys })
 * @param o.nameOf    id → English item name (for the name fallback)
 * @param o.tasks     raw tarkov.dev tasks ({ id, neededKeys, objectives, finishRewards, startRewards })
 * @returns [{ id, maps: [mapId], locks: { [mapId]: { door, trunk, other } }, spawns: { [mapId]: count },
 *             access: [mapId], rewards: [{ task, start }], neededBy: [taskId] }]
 */
function keyCatalog({ keyIds, maps = [], tasks = [], nameOf = () => '' }) {
  const keys = new Map();
  for (const id of keyIds) keys.set(id, { id, maps: new Set(), locks: {}, spawns: {}, access: new Set(), rewards: [], neededBy: new Set() });
  const idOf = (x) => (typeof x === 'string' ? x : x?.id || x?.item || null);

  for (const m of maps) {
    for (const l of m.locks || []) {
      const k = keys.get(idOf(l.key));
      if (!k) continue;
      const kind = l.lockType === 'door' || l.lockType === 'trunk' ? l.lockType : 'other';
      const c = (k.locks[m.id] ||= { door: 0, trunk: 0, other: 0 });
      c[kind]++;
      k.maps.add(m.id);
    }
    for (const id of m.accessKeys || []) {
      const k = keys.get(idOf(id));
      if (!k) continue;
      k.access.add(m.id);
      k.maps.add(m.id);
    }
    for (const spot of m.lootLoose || []) {
      for (const id of new Set(spot.items || [])) {
        const k = keys.get(idOf(id));
        if (k) k.spawns[m.id] = (k.spawns[m.id] || 0) + 1;
      }
    }
  }
  const mapIds = new Set(maps.map((m) => m.id));
  for (const t of tasks) {
    for (const nk of t.neededKeys || []) {
      for (const key of nk.keys || []) {
        const k = keys.get(idOf(key));
        if (!k) continue;
        k.neededBy.add(t.id);
        const mapId = idOf(nk.map);
        if (mapId && mapIds.has(mapId)) k.maps.add(mapId);
      }
    }
    for (const o of t.objectives || []) {
      for (const alt of o.requiredKeys || []) for (const key of Array.isArray(alt) ? alt : [alt]) keys.get(idOf(key))?.neededBy.add(t.id);
    }
    for (const [list, start] of [
      [t.startRewards?.items, true],
      [t.finishRewards?.items, false],
    ]) {
      for (const r of list || []) {
        const k = keys.get(idOf(r.item));
        if (k && !k.rewards.some((x) => x.task === t.id)) k.rewards.push({ task: t.id, start });
      }
    }
  }
  const byNormalized = new Map(maps.map((m) => [m.normalizedName, m.id]));
  for (const k of keys.values()) {
    if (k.maps.size) continue;
    const hit = NAME_MAP.find(([re]) => re.test(nameOf(k.id) || ''));
    const mapId = hit && byNormalized.get(hit[1]);
    if (mapId) k.maps.add(mapId);
  }
  return [...keys.values()].map((k) => ({
    id: k.id,
    maps: [...k.maps],
    locks: k.locks,
    spawns: k.spawns,
    access: [...k.access],
    rewards: k.rewards,
    neededBy: [...k.neededBy],
  }));
}

module.exports = { keyCatalog };
