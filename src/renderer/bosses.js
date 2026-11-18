// Boss spawn spots: groups tarkov.dev's boss spawn data into map markers, each listing the bosses
// that can appear there and how likely they are. Pure functions, shared by main (data build) and tests.
(function () {
  'use strict';

  // Not bosses: PvE PMC bots, event infected and bosses with no fixed spawn spot.
  const SKIP = new Set(['pmcUSEC', 'pmcBEAR', 'infectedScreamer', 'bossPartisan', 'bossTagillaAgro']);
  // tarkov.dev names a few of these by a short internal tag
  const NAME_FIX = { Sentry: 'Sentry', vsRFSniper: 'VSRF sniper', vsRF: 'VSRF' };
  const CLUSTER_M = 75; // spawn points this close together share one marker

  const r1 = (v) => Math.round(v * 10) / 10;
  const r2 = (v) => Math.round(v * 100) / 100;
  const pct = (c) => `${Math.max(1, Math.round(c * 100))}%`;

  /** Greedy grouping of points within `radius` metres (x/z plane). */
  function cluster(points, radius = CLUSTER_M) {
    const groups = [];
    for (const p of points) {
      const g = groups.find((g) => Math.hypot(g.cx - p.x, g.cz - p.z) <= radius);
      if (g) {
        g.pts.push(p);
        g.cx = g.pts.reduce((a, q) => a + q.x, 0) / g.pts.length;
        g.cz = g.pts.reduce((a, q) => a + q.z, 0) / g.pts.length;
      } else groups.push({ pts: [p], cx: p.x, cz: p.z });
    }
    // marker sits on a real spawn point: the one nearest the group's middle
    return groups.map((g) => {
      const mid = g.pts.reduce((best, q) => (Math.hypot(q.x - g.cx, q.z - g.cz) < Math.hypot(best.x - g.cx, best.z - g.cz) ? q : best));
      return { position: { x: r1(mid.x), y: r1(mid.y || 0), z: r1(mid.z) }, count: g.pts.length };
    });
  }

  function escortText(escorts, mobName) {
    const parts = [];
    for (const e of escorts || []) {
      const counts = (e.amount || []).map((a) => a.count).filter((n) => n > 0);
      if (!counts.length) continue;
      const lo = Math.min(...counts);
      const hi = Math.max(...counts);
      const name = mobName(e.mob);
      parts.push(hi === 1 ? name : `${lo === hi ? lo : `${lo}–${hi}`} ${name}${/s$/.test(name) ? '' : 's'}`);
    }
    return parts.join(', ');
  }

  /**
   * map: a tarkov.dev map ({ bosses, spawns }); mobs: { [id]: { name, imagePortraitLink } };
   * t: translate a tarkov.dev name key. Returns
   * [{ zone, label, position | null, bosses: [{ id, name, portrait, chance, mapChance, escorts }] }]
   * A spot with no position only has a zone name (the renderer places it by the map's area labels).
   */
  function bossSpots(map, mobs = {}, t = (s) => s) {
    const mobName = (id) => {
      const m = mobs[id];
      const tr = m ? t(m.name) : id;
      return NAME_FIX[id] || (tr && tr.length > 3 ? tr : id);
    };
    const zoneLabel = (zone) => {
      const tr = t(zone);
      if (tr && tr !== zone && !/^[0-9]/.test(tr)) return tr;
      return zone.replace(/^(Bot)?Zone_?/, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
    };
    const byZone = new Map();
    for (const b of map.bosses || []) {
      if (SKIP.has(b.mob) || !b.spawnLocations?.length) continue;
      for (const l of b.spawnLocations) {
        const z = byZone.get(l.spawnKey) || { zone: l.spawnKey, positions: l.positions || [], entries: [] };
        if (!z.positions.length && l.positions?.length) z.positions = l.positions;
        z.entries.push({ b, chance: (b.spawnChance || 0) * (l.chance || 0) });
        byZone.set(l.spawnKey, z);
      }
    }
    const spots = [];
    for (const z of byZone.values()) {
      let pts = z.positions;
      if (!pts.length) pts = (map.spawns || []).filter((s) => s.zoneName === z.zone && s.categories?.includes('boss')).map((s) => s.position);
      // the same boss listed several times (Rogue groups, Raider waves) folds into one row
      const rows = new Map();
      for (const { b, chance } of z.entries) {
        const name = mobName(b.mob);
        const row = rows.get(name) || { id: b.mob, name, portrait: mobs[b.mob]?.imagePortraitLink || null, miss: 1, mapMiss: 1, groups: 0, escorts: escortText(b.escorts, mobName) };
        row.miss *= 1 - chance;
        row.mapMiss *= 1 - (b.spawnChance || 0);
        row.groups++;
        rows.set(name, row);
      }
      const bosses = [...rows.values()]
        .map((r) => ({ id: r.id, name: r.name, portrait: r.portrait, chance: r2(1 - r.miss), mapChance: r2(1 - r.mapMiss), groups: r.groups, escorts: r.escorts }))
        .filter((r) => r.chance > 0)
        .sort((a, b) => b.chance - a.chance || a.name.localeCompare(b.name));
      if (!bosses.length) continue;
      const base = { zone: z.zone, label: zoneLabel(z.zone), bosses };
      if (!pts.length) spots.push({ ...base, position: null });
      else for (const c of cluster(pts)) spots.push({ ...base, position: c.position });
    }
    return spots;
  }

  /** Tooltip rows, plain text pieces for the renderer to escape. */
  function bossLine(b) {
    const here = pct(b.chance);
    const extra = b.mapChance && Math.abs(b.mapChance - b.chance) > 0.05 ? ` here · ${pct(b.mapChance)} per raid` : '';
    return `${b.name} ${here}${extra}`;
  }

  const Bosses = { bossSpots, bossLine, cluster, pct, SKIP };
  if (typeof module !== 'undefined' && module.exports) module.exports = Bosses;
  if (typeof window !== 'undefined') window.Bosses = Bosses;
})();
