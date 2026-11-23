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

  /** "ZoneGasStation" → "Gas Station" (or the game's own name for it). */
  function spawnZoneLabel(zone, t = (s) => s) {
    const tr = t(zone);
    if (tr && tr !== zone && !/^[0-9]/.test(tr)) return tr;
    return zone.replace(/^(Bot)?Zone_?/, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  }

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
    const zoneLabel = (zone) => spawnZoneLabel(zone, t);
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


  // ------------------------------------------------------------------ Bosses tab
  // Everything worth recognising: bosses, their guards and other dangerous AI. Not PMC bots or plain infected.
  const NOT_LISTED = new Set(['pmcUSEC', 'pmcBEAR', 'infectedScreamer', 'infectedAssault', 'infectedCivil', 'infectedPmc', 'infectedLaborant']);
  const NAMED_FOLLOWERS = new Set(['followerBigPipe', 'followerBirdEye']); // the Goons are bosses in their own right
  const NAME_OVERRIDE = { bossBullyBlackDiv: 'Black Div. leader', followerBullyBlackDiv: 'Black Div. leader guard', followerBoarClose2: 'Gus' };
  // The wiki page with in-game pictures of them, words a picture's name must have (any), and words it
  // must not have (so a boss card doesn't show its guards and the other way round)
  const G = ['guard', 'follower', 'oneof'];
  const WIKI = {
    bossBully: ['Reshala', ['reshala'], G],
    followerBully: ['Reshala', G, []],
    bossKilla: ['Killa', ['killa'], G],
    bossKillaAgro: ['Killa', ['killa'], G],
    bossTagilla: ['Tagilla', ['tagilla', 'kuvalda'], G],
    bossTagillaAgro: ['Tagilla', ['tagilla', 'kuvalda'], G],
    infectedTagilla: ['Tagilla', ['tagilla', 'kuvalda'], G],
    bossGluhar: ['Glukhar', ['gluhar', 'glukhar'], G],
    followerGluharAssault: ['Glukhar', G, []],
    followerGluharSecurity: ['Glukhar', G, []],
    followerGluharScout: ['Glukhar', G, []],
    bossKojaniy: ['Shturman', ['shturman', 'sthurman'], G],
    followerKojaniy: ['Shturman', G, []],
    bossSanitar: ['Sanitar', ['sanitar'], G],
    followerSanitar: ['Sanitar', G, []],
    bossBoar: ['Kaban', ['kaban'], [...G, 'kguard', 'sniper']],
    followerBoar: ['Kaban', ['kguard', 'kabanguard'], []],
    followerBoarClose1: ['Kaban', ['basmach'], []],
    followerBoarClose2: ['Kaban', ['gus'], []],
    bossBoarSniper: ['Kaban', ['ksniper', 'kabansniper'], []],
    bossKolontay: ['Kollontay', ['kollontay', 'kollon', 'kolon'], [...G, 'kollonguard']],
    followerKolontayAssault: ['Kollontay', ['kollonguard', ...G], []],
    followerKolontaySecurity: ['Kollontay', ['kollonguard', ...G], []],
    bossZryachiy: ['Zryachiy', ['zryachiy'], G],
    bossKnight: ['Knight', ['knight'], G],
    followerBigPipe: ['Big_Pipe', ['bigpipe'], []],
    followerBirdEye: ['Birdeye', ['birdeye'], []],
    bossPartisan: ['Partisan', ['partisan'], []],
    sectantPriest: ['Cultists', ['cultistpriest', 'priest'], ['warrior']],
    sectantWarrior: ['Cultists', ['cultistwarrior', 'warrior'], ['priest']],
    PmcBot: ['Raiders', ['raider'], []],
    ExUsec: ['Rogues', ['rogue'], []],
    exUsecFree: ['Rogues', ['rogue'], []],
    bossWedge: ['The_Wedge', ['wedge'], G],
    bossWedgeLab: ['The_Wedge', ['wedge'], G],
    followerWedgeLab: ['The_Wedge', G, []],
    blackDivision: ['Black_Division', ['blackdivision'], []],
    pmcBotBlackDiv: ['Black_Division', ['blackdivision'], []],
    bossBullyBlackDiv: ['Black_Division', ['blackdivision'], []],
    followerBullyBlackDiv: ['Black_Division', ['blackdivision'], []],
  };
  // Short field notes, only where the behaviour is well known
  const NOTES = {
    bossBully: 'Carries a golden TT and rarely wears armor. His guards do most of the fighting.',
    bossKilla: 'Fast and aggressive: pushes you through the mall firing long bursts. Heavy armor and a visored helmet, so legs are the easy target.',
    bossTagilla: 'Welding mask and sledgehammer. Charges you for melee; also carries a shotgun.',
    bossGluhar: 'Big escort of assault, security and scout guards that spreads out around him.',
    bossKojaniy: 'Snipes from range around the sawmill while his guards close in.',
    bossSanitar: 'Heals himself and his guards with stims and medkits, so finish him fast.',
    bossBoar: 'Holds the car dealership with mounted guns, rooftop snipers and his close guards Basmach and Gus.',
    bossKolontay: 'Moves with a police-style escort and carries a baton for melee.',
    bossZryachiy: 'Sniper on the Lighthouse island, covered by guards.',
    bossKnight: 'The Goons (Knight, Big Pipe, Birdeye) travel together and move between maps.',
    followerBigPipe: 'One of the Goons. Travels with Knight and Birdeye.',
    followerBirdEye: 'One of the Goons. Marksman who picks you off from range while the others push.',
    bossPartisan: 'Wanders the map and leaves tripwire grenades on paths.',
    sectantPriest: 'Only out at night. Cultists move quietly in hooded robes and stab with poisoned knives.',
    sectantWarrior: 'Only out at night, in hooded robes, with poisoned knives.',
    PmcBot: 'Top-tier gear and accurate. On Reserve they come out of the bunkers when the D-2 lever is pulled; on Labs they patrol from the start.',
    ExUsec: 'Ex-USEC at the Lighthouse water treatment plant. Use mounted machine guns and spot you from far away.',
  };
  const WEAR_SLOTS = ['Headwear', 'FaceCover', 'Eyewear', 'ArmorVest', 'TacticalVest', 'Backpack'];
  const WEAPON_SLOTS = ['FirstPrimaryWeapon', 'SecondPrimaryWeapon', 'Holster', 'Scabbard'];
  const sectionOf = (id) => {
    if (NAMED_FOLLOWERS.has(id) || id === 'sectantPriest' || /^boss/.test(id)) return 'bosses';
    if (/^follower/.test(id) || id === 'sectantWarrior') return 'guards';
    return 'others';
  };

  /**
   * One card per enemy for the Bosses tab.
   * maps: raw tarkov.dev maps ({ id, name, bosses }) to include; mobs: { [id]: mob };
   * t: translate a name key; ref: register an item id for the UI (returns the id).
   * Returns [{ key, ids, name, section, portrait, poster, health, wiki, picWords, note,
   *            maps: [{ map, name, chance, zones }], guards: [{ key, name, count }], guardOf: [{ key, name }],
   *            wears: { slot: [itemId] }, weapons: [itemId] }]
   */
  function bossCatalog(maps, mobs = {}, t = (s) => s, ref = (id) => id) {
    const mobName = (id) => {
      if (NAME_OVERRIDE[id]) return NAME_OVERRIDE[id];
      const m = mobs[id];
      const tr = m ? t(m.name) : id;
      return NAME_FIX[id] || (tr && tr.length > 3 ? tr : id);
    };
    const keyOf = (id) => `${sectionOf(id)}:${mobName(id)}`;
    const cards = new Map();
    const card = (id) => {
      const key = keyOf(id);
      let c = cards.get(key);
      if (!c) {
        const w = WIKI[id];
        c = { key, ids: [], name: mobName(id), section: sectionOf(id), portrait: null, poster: null, health: 0, wiki: w ? w[0] : null, picWords: w ? w[1] : [], picAvoid: w ? w[2] : [], note: NOTES[id] || '', mapMiss: new Map(), zones: new Map(), guards: new Map(), guardOf: new Map(), wears: {}, weapons: new Set() };
        cards.set(key, c);
      }
      if (!c.ids.includes(id)) {
        c.ids.push(id);
        const m = mobs[id] || {};
        c.portrait = c.portrait || m.imagePortraitLink || null;
        c.poster = c.poster || m.imagePosterLink || null;
        if (!c.health) c.health = (m.health || []).reduce((a, p) => a + (p.max || 0), 0);
        if (!c.note && NOTES[id]) c.note = NOTES[id];
        if (!c.wiki && WIKI[id]) [c.wiki, c.picWords, c.picAvoid] = WIKI[id];
        for (const e of m.equipment || []) {
          const slot = e.attributes?.slot;
          if (!e.item) continue;
          if (WEAR_SLOTS.includes(slot)) {
            const list = (c.wears[slot] ||= []);
            if (!list.includes(e.item) && ref(e.item)) list.push(e.item);
          } else if (WEAPON_SLOTS.includes(slot) && ref(e.item)) c.weapons.add(e.item);
        }
      }
      return c;
    };
    const addMap = (c, map, chance, zones) => {
      c.mapMiss.set(map.id, (c.mapMiss.get(map.id) ?? 1) * (1 - chance));
      const z = c.zones.get(map.id) || new Set();
      for (const s of zones) z.add(s);
      c.zones.set(map.id, z);
    };
    for (const map of maps) {
      for (const b of map.bosses || []) {
        if (NOT_LISTED.has(b.mob)) continue;
        const chance = b.spawnChance || 0;
        if (!chance) continue;
        const zones = (b.spawnLocations || []).map((l) => spawnZoneLabel(l.spawnKey || l.name, t)).filter((z) => z && !/\d/.test(z));
        const boss = card(b.mob);
        addMap(boss, map, chance, zones);
        for (const e of b.escorts || []) {
          if (!e.mob || NOT_LISTED.has(e.mob) || keyOf(e.mob) === boss.key) continue;
          const counts = (e.amount || []).map((a) => a.count).filter((n) => n > 0);
          if (!counts.length) continue;
          const g = card(e.mob);
          addMap(g, map, chance, zones);
          const prev = boss.guards.get(g.key) || { key: g.key, name: g.name, lo: Infinity, hi: 0 };
          prev.lo = Math.min(prev.lo, ...counts);
          prev.hi = Math.max(prev.hi, ...counts);
          boss.guards.set(g.key, prev);
          g.guardOf.set(boss.key, { key: boss.key, name: boss.name });
        }
      }
    }
    const mapNames = new Map(maps.map((m) => [m.id, t(m.name)]));
    const order = { bosses: 0, guards: 1, others: 2 };
    return [...cards.values()]
      .map((c) => ({
        key: c.key,
        ids: c.ids,
        name: c.name,
        section: c.section,
        portrait: c.portrait,
        poster: c.poster,
        health: c.health,
        wiki: c.wiki,
        picWords: c.picWords,
        picAvoid: c.picAvoid,
        note: c.note,
        maps: [...c.mapMiss]
          .map(([map, miss]) => ({ map, name: mapNames.get(map) || map, chance: r2(1 - miss), zones: [...(c.zones.get(map) || [])] }))
          .sort((a, b) => b.chance - a.chance || a.name.localeCompare(b.name)),
        guards: [...c.guards.values()].map((g) => ({ key: g.key, name: g.name, count: g.lo === g.hi ? String(g.lo) : `${g.lo}–${g.hi}` })),
        guardOf: [...c.guardOf.values()],
        wears: c.wears,
        weapons: [...c.weapons],
      }))
      .filter((c) => c.maps.length)
      .sort((a, b) => order[a.section] - order[b.section] || a.name.localeCompare(b.name));
  }

  // Wiki pictures that show what the enemy looks like in game: the infobox render, "X with his …"
  // screenshots, faces and event outfits. Not health charts, spawn maps, weapon builds or concept art.
  const NOT_A_LOOK = /health|spawn|marked|location|concept|wallpaper|steam|inspiration|ryzhy|birthday|promotional|chronicles|lore/;
  const LOOK = /infobox|ingame|screenshot|withhis|withher|face|unmasked|close|oneof|festive|halloween|christmas|vengeful|soldier|squad|friends/;
  function lookPictures(images, words = [], avoid = []) {
    const norm = (s) => String(s || '').toLowerCase().replace(/&#0?39;|&apos;/g, '').replace(/[^a-z0-9]/g, '');
    const want = words.map(norm).filter(Boolean);
    const not = avoid.map(norm).filter(Boolean);
    return (images || []).filter((p) => {
      let file = '';
      try {
        file = decodeURIComponent(String(p.full || '').split('/revision')[0].split('/').pop());
      } catch {
        file = String(p.full || '');
      }
      const stem = norm(file.replace(/\.\w+$/, ''));
      const text = `${stem} ${norm(p.caption)}`;
      if (NOT_A_LOOK.test(text) || !want.some((w) => text.includes(w)) || not.some((w) => text.includes(w))) return false;
      if (LOOK.test(text)) return true;
      // a picture named just after them ("Sanitar.png", "Rogue_1.png")
      let rest = stem.replace(/\d$/, ''); // "Rogue_1" yes, "Gluhar_153" (a gun) no
      for (const w of [...want, 'guard', 'nr', 'boss']) rest = rest.split(w).join('');
      return rest === '';
    });
  }

  const Bosses = { bossSpots, bossLine, cluster, pct, SKIP, bossCatalog, lookPictures, spawnZoneLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = Bosses;
  if (typeof window !== 'undefined') window.Bosses = Bosses;
})();
