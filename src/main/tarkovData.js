'use strict';
// Downloads and caches quest + map data from tarkov.dev (https://tarkov.dev, community API).
const fs = require('fs');
const path = require('path');
const { buildArmory } = require('./armoryData');
const { CONTAINERS } = require('../renderer/loot');
const Bosses = require('../renderer/bosses');

const JSON_BASE = 'https://json.tarkov.dev';
const MAPS_CONFIG_URL = 'https://raw.githubusercontent.com/the-hideout/tarkov-dev/main/src/data/maps.json';
const BUNDLED_MAPS_CONFIG = path.join(__dirname, '..', 'data', 'maps.json');
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const SVG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const USER_AGENT = 'TarkovQuestMap/0.1 (personal desktop app)';

class TarkovData {
  constructor(cacheDir) {
    this.cacheDir = cacheDir;
    fs.mkdirSync(path.join(cacheDir, 'svg'), { recursive: true });
    this.models = new Map(); // dataMode -> model
  }

  cachePath(name) {
    return path.join(this.cacheDir, name.replace(/[^a-z0-9_.-]/gi, '_'));
  }

  async fetchText(url) {
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res.text();
  }

  /** Fetch with on-disk cache. Uses a fresh cache, else network, else a stale cache. */
  async cachedJson(url, name, { force = false } = {}) {
    const file = this.cachePath(name);
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      /* not cached */
    }
    if (stat && !force && Date.now() - stat.mtimeMs < MAX_AGE_MS) {
      return { json: JSON.parse(fs.readFileSync(file, 'utf8')), fetchedAt: stat.mtimeMs, stale: false };
    }
    try {
      const text = await this.fetchText(url);
      const json = JSON.parse(text);
      fs.writeFileSync(file, text);
      return { json, fetchedAt: Date.now(), stale: false };
    } catch (err) {
      if (stat) return { json: JSON.parse(fs.readFileSync(file, 'utf8')), fetchedAt: stat.mtimeMs, stale: true, error: String(err.message || err) };
      throw err;
    }
  }

  async mapsConfig(force) {
    try {
      return (await this.cachedJson(MAPS_CONFIG_URL, 'maps-config.json', { force })).json;
    } catch {
      return JSON.parse(fs.readFileSync(BUNDLED_MAPS_CONFIG, 'utf8'));
    }
  }

  /** Build (or return cached) the compact model for a data mode ('regular' | 'pve'). */
  async load(dataMode, { force = false } = {}) {
    if (!force && this.models.has(dataMode)) return this.models.get(dataMode);
    const get = (p) => this.cachedJson(`${JSON_BASE}/${dataMode}/${p}`, `${dataMode}_${p}.json`, { force });
    const [tasks, tasksEn, maps, mapsEn, traders, tradersEn, items, itemsEn, barters, mapsConfig] = await Promise.all([
      get('tasks'),
      get('tasks_en'),
      get('maps'),
      get('maps_en'),
      get('traders'),
      get('traders_en'),
      get('items'),
      get('items_en'),
      get('barters'),
      this.mapsConfig(force),
    ]);
    const model = buildModel({
      dataMode,
      tasks: tasks.json,
      tasksEn: tasksEn.json,
      maps: maps.json,
      mapsEn: mapsEn.json,
      traders: traders.json,
      tradersEn: tradersEn.json,
      items: items.json,
      itemsEn: itemsEn.json,
      barters: barters.json,
      mapsConfig,
    });
    model.fetchedAt = Math.min(tasks.fetchedAt, maps.fetchedAt);
    model.stale = [tasks, maps].some((r) => r.stale);
    this.models.set(dataMode, model);
    return model;
  }

  /** Ammo, weapons and attachments with where to get them (see armoryData.js). */
  async armory(dataMode, { force = false } = {}) {
    this.armories = this.armories || new Map();
    if (!force && this.armories.has(dataMode)) return this.armories.get(dataMode);
    const get = (p) => this.cachedJson(`${JSON_BASE}/${dataMode}/${p}`, `${dataMode}_${p}.json`, { force });
    const [items, itemsEn, barters, traders, tradersEn] = await Promise.all([get('items'), get('items_en'), get('barters'), get('traders'), get('traders_en')]);
    const armory = buildArmory({ dataMode, items: items.json, itemsEn: itemsEn.json, barters: barters.json, traders: traders.json, tradersEn: tradersEn.json });
    this.armories.set(dataMode, armory);
    return armory;
  }

  /** Map SVG text, cached on disk. Only tarkov.dev hosts are allowed. */
  async svg(url) {
    const u = new URL(url);
    if (!['assets.tarkov.dev', 'raw.githubusercontent.com'].includes(u.hostname)) throw new Error('Blocked SVG host');
    const file = path.join(this.cacheDir, 'svg', path.basename(u.pathname).replace(/[^a-z0-9_.-]/gi, '_'));
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      /* not cached */
    }
    if (stat && Date.now() - stat.mtimeMs < SVG_MAX_AGE_MS) return fs.readFileSync(file, 'utf8');
    try {
      const text = await this.fetchText(url);
      fs.writeFileSync(file, text);
      return text;
    } catch (err) {
      if (stat) return fs.readFileSync(file, 'utf8');
      throw err;
    }
  }
}

function buildModel({ dataMode, tasks, tasksEn, maps, mapsEn, traders, tradersEn, items: itemsJson, itemsEn, barters, mapsConfig }) {
  const tTask = (k) => tasksEn?.data?.[k] ?? k;
  const tMap = (k) => mapsEn?.data?.[k] ?? k;
  const tTrader = (k) => tradersEn?.data?.[k] ?? k;
  const tItem = (k) => itemsEn?.data?.[k] ?? null;
  const items = tasks.data.questItems || {};

  // Only items quests reference (keys, markers, plant items, required weapons/gear) go to the UI.
  const allItems = itemsJson?.data?.items || {};
  const itemRefs = {};
  const ref = (x) => {
    const id = typeof x === 'string' ? x : x?.id;
    if (!id) return null;
    if (!itemRefs[id]) {
      const it = allItems[id];
      itemRefs[id] = {
        id,
        name: (it && tItem(it.name)) || (typeof x === 'object' && x.name) || id,
        shortName: (it && tItem(it.shortName)) || null,
        iconLink: it?.iconLink || null,
        image: it?.image512pxLink || it?.inspectImageLink || null,
        wikiLink: it?.wikiLink || null,
      };
    }
    return id;
  };
  const refList = (arr) => (arr || []).map(ref).filter(Boolean);
  const refAlts = (arr) => (arr || []).map((alt) => refList(Array.isArray(alt) ? alt : [alt])).filter((a) => a.length);

  const traderById = {};
  for (const tr of Object.values(traders.data || {})) {
    traderById[tr.id] = { id: tr.id, name: tTrader(tr.name), normalizedName: tr.normalizedName, imageLink: tr.imageLink || null };
  }

  // Some map variants (Ground Zero 21+, Night Factory) leave extract factions blank; borrow them by extract id.
  const factionById = {};
  for (const m of Object.values(maps.data.maps)) for (const e of m.extracts || []) if (e.faction) factionById[e.name] = e.faction;

  // What kind of extract it is, from its internal id and English name.
  const extractKinds = (raw, name) => {
    const s = `${raw} ${name}`;
    const kinds = [];
    if (/_secret_/i.test(raw)) kinds.push('secret');
    if (/\(flare\)/i.test(name)) kinds.push('flare');
    if (/co-?op/i.test(s)) kinds.push('coop');
    if (/v-ex/i.test(name)) kinds.push('vehicle');
    if (/train/i.test(s)) kinds.push('train');
    if (/alpinist|cliff descent/i.test(s)) kinds.push('cliff');
    if (/elevator/i.test(name)) kinds.push('elevator');
    return kinds;
  };

  // Loot containers (by type) and loose-loot spots, for the loot layer and Scav runs.
  const containerDefs = {};
  for (const c of Object.values(maps.data.lootContainers || {})) containerDefs[c.id] = { name: tMap(c.name), kind: CONTAINERS[c.normalizedName] || null };
  const itemPrice = (it) => it?.avg24hPrice || it?.lastLowPrice || it?.basePrice || 0;
  const r1 = (n) => Math.round(n * 10) / 10;
  const P = (p) => ({ x: r1(p.x), y: r1(p.y), z: r1(p.z) });
  const lootFor = (m) => {
    const out = [];
    for (const lc of m.lootContainers || []) {
      const def = containerDefs[lc.lootContainer];
      if (!def?.kind || !lc.position) continue;
      out.push({ c: def.kind.cat, n: def.name, w: def.kind.w, p: P(lc.position) });
    }
    for (const l of m.lootLoose || []) {
      if (!l.position) continue;
      const its = (l.items || []).map((id) => allItems[id]).filter(Boolean);
      const name = (it) => tItem(it.shortName) || tItem(it.name) || it.normalizedName;
      const keys = its.filter((it) => it.types?.includes('keys'));
      if (keys.length) out.push({ c: 'keys', n: 'Loose key spawn', p: P(l.position), x: keys.slice(0, 3).map(name).join(', ') + (keys.length > 3 ? '…' : '') });
      const rich = its.filter((it) => !it.types?.some((t) => t === 'keys' || t === 'poster') && itemPrice(it) >= 100000).sort((a, b) => itemPrice(b) - itemPrice(a));
      if (rich.length) out.push({ c: 'valuables', n: 'Loose valuable spot', p: P(l.position), x: rich.slice(0, 3).map(name).join(', ') + (rich.length > 3 ? '…' : '') });
      if (its.some((it) => it.types?.includes('meds'))) out.push({ c: 'meds', n: 'Loose meds spot', p: P(l.position) });
    }
    return out;
  };
  // Named areas (from spawn zone names) so loot hotspots get labels like "Dorms".
  const areaLabel = (zone) => {
    if (!zone) return null;
    const t = tMap(zone);
    let name = t !== zone ? t : /^(Bot)?Zone[A-Z][a-z]/.test(zone) ? zone.replace(/^(Bot)?Zone/, '').replace(/([a-z])([A-Z])/g, '$1 $2') : null;
    if (!name || /[0-9]|any scav spawn/i.test(name)) return null;
    return name;
  };
  const areasFor = (m) => {
    const acc = new Map();
    for (const sp of m.spawns || []) {
      const name = areaLabel(sp.zoneName);
      if (!name || !sp.position) continue;
      const a = acc.get(name) || { name, x: 0, z: 0, n: 0 };
      a.x += sp.position.x;
      a.z += sp.position.z;
      a.n++;
      acc.set(name, a);
    }
    return [...acc.values()].map((a) => ({ name: a.name, x: r1(a.x / a.n), z: r1(a.z / a.n) }));
  };

  const mapList = Object.values(maps.data.maps).map((m) => ({
    id: m.id,
    name: tMap(m.name),
    normalizedName: m.normalizedName,
    nameId: m.nameId,
    scenePath: m.scenePath,
    wiki: m.wiki || null,
    extracts: (m.extracts || []).map((e) => ({
      name: tMap(e.name),
      faction: e.faction || factionById[e.name] || 'shared',
      kinds: extractKinds(e.name, tMap(e.name)),
      position: e.position,
      outline: e.outline,
      top: e.top,
      bottom: e.bottom,
      // tarkov.dev links every extract on a map to the same switch, so switch requirements
      // aren't trustworthy and are left out.
      switches: [],
      // car extracts: pay to leave
      payment: e.transferItem?.item ? { id: ref(e.transferItem.item), count: e.transferItem.count || 1 } : null,
    })),
    transits: (m.transits || []).map((e) => ({ name: tMap(e.description), position: e.position, top: e.top, bottom: e.bottom })),
    // Locked doors and car trunks, and the key that opens each.
    locks: (m.locks || [])
      .filter((l) => l.key && l.position)
      .map((l) => ({ type: l.lockType || 'door', key: ref(l.key), needsPower: !!l.needsPower, position: l.position, top: l.top, bottom: l.bottom })),
    pmcSpawns: (m.spawns || [])
      .filter((sp) => sp.sides?.includes('pmc') && sp.categories?.includes('player'))
      .map((sp) => ({ position: sp.position })),
    scavSpawns: (m.spawns || [])
      .filter((sp) => sp.sides?.includes('scav') && sp.categories?.includes('player'))
      .map((sp) => ({ position: sp.position })),
    loot: lootFor(m),
    areas: areasFor(m),
    bosses: Bosses.bossSpots(m, maps.data.mobs || {}, tMap),
  }));
  const mapById = Object.fromEntries(mapList.map((m) => [m.id, m]));

  // Where to get each key that opens something on a map (trader, barter, flea).
  const keyIds = new Set(mapList.flatMap((m) => m.locks.map((l) => l.key)));
  const bartersFor = {};
  for (const b of barters?.data || []) {
    const id = b.offeredItem?.item;
    if (keyIds.has(id)) (bartersFor[id] ||= []).push(b);
  }
  for (const id of keyIds) {
    const it = allItems[id];
    const sources = [];
    for (const b of it?.buyFromTrader || []) {
      sources.push({ kind: 'trader', trader: traderById[b.trader]?.name || b.trader, level: b.minTraderLevel || 1, taskUnlock: b.taskUnlock || null, price: b.price, currency: b.currency });
    }
    for (const b of bartersFor[id] || []) {
      sources.push({ kind: 'barter', trader: traderById[b.trader]?.name || b.trader, level: b.minTraderLevel || 1, taskUnlock: b.taskUnlock || null });
    }
    const flea = it?.avg24hPrice || it?.lastLowPrice;
    if (it && !it.types?.includes('noFlea') && flea) sources.push({ kind: 'flea', price: flea });
    if (itemRefs[id]) itemRefs[id].sources = sources;
  }

  // Trader offers and barters that a quest unlocks, from both the quest rewards and the item data.
  const unlocksByTask = {};
  const addUnlock = (taskId, itemId, traderId, level, kind) => {
    if (!taskId || !itemId) return;
    const list = (unlocksByTask[taskId] ||= []);
    if (list.some((u) => u.id === itemId && u.kind === kind)) return;
    list.push({ id: ref(itemId), trader: traderById[traderId]?.name || traderId || '', level: level || 1, kind });
  };
  for (const t of Object.values(tasks.data.tasks)) {
    for (const u of t.finishRewards?.offerUnlock || []) addUnlock(t.id, u.item, u.trader, u.level, 'buy');
  }
  for (const it of Object.values(allItems)) {
    for (const b of it.buyFromTrader || []) if (b.taskUnlock) addUnlock(b.taskUnlock, it.id, b.trader, b.minTraderLevel, 'buy');
  }
  for (const b of barters?.data || []) if (b.taskUnlock) addUnlock(b.taskUnlock, b.offeredItem?.item, b.trader, b.minTraderLevel, 'barter');

  const zone = (z) => ({ id: z.id, map: z.map, position: z.position, outline: z.outline, top: z.top, bottom: z.bottom });

  const taskList = Object.values(tasks.data.tasks).map((t) => ({
    id: t.id,
    name: tTask(t.name),
    normalizedName: t.normalizedName,
    trader: traderById[t.trader] || { id: t.trader, name: t.trader },
    mapId: t.map || null,
    minPlayerLevel: t.minPlayerLevel || 0,
    kappaRequired: !!t.kappaRequired,
    lightkeeperRequired: !!t.lightkeeperRequired,
    factionName: t.factionName || 'Any',
    wikiLink: t.wikiLink || null,
    taskRequirements: (t.taskRequirements || []).map((r) => ({ task: r.task, status: r.status || [] })),
    neededKeys: (t.neededKeys || []).map((nk) => ({ map: nk.map, keys: refList(nk.keys) })),
    image: t.taskImageLink || null,
    unlocks: unlocksByTask[t.id] || [],
    rewards: {
      items: (t.finishRewards?.items || []).map((r) => ({ id: ref(r.item), count: r.count })).filter((r) => r.id),
      standing: (t.finishRewards?.traderStanding || []).map((r) => ({ trader: traderById[r.trader]?.name || r.trader, standing: r.standing })),
      offerUnlock: (t.finishRewards?.offerUnlock || []).map((u) => ({ id: ref(u.item), trader: traderById[u.trader]?.name || u.trader, level: u.level })).filter((u) => u.id),
      startItems: (t.startRewards?.items || []).map((r) => ({ id: ref(r.item), count: r.count })).filter((r) => r.id),
    },
    experience: t.experience || 0,
    objectives: (t.objectives || []).map((o) => {
      const qi = o.questItem && items[o.questItem];
      return {
        id: o.id,
        type: o.type,
        description: tTask(o.description),
        optional: !!o.optional,
        count: o.count || null,
        maps: o.maps || [],
        zones: (o.zones || []).map(zone),
        possibleLocations: (o.possibleLocations || []).map((l) => ({ map: l.map, positions: l.positions })),
        questItem: qi
          ? {
              id: qi.id,
              name: tTask(qi.name),
              iconLink: qi.iconLink,
              image: qi.image512pxLink || qi.inspectImageLink || qi.iconLink,
              description: tasksEn?.data?.[qi.description] || null,
            }
          : null,
        foundInRaid: !!o.foundInRaid,
        // "Complete quest X" objectives link quests together like prerequisites do
        task: o.type === 'taskStatus' ? o.task || null : null,
        items: refList(o.items),
        markerItem: o.markerItem ? ref(o.markerItem) : null,
        useAny: refList(o.useAny),
        requiredKeys: refAlts(o.requiredKeys),
        usingWeapon: refList(o.usingWeapon),
        usingWeaponMods: refAlts(o.usingWeaponMods),
        wearing: refAlts(o.wearing),
      };
    }),
  }));

  // tarkov.dev map display config (projection + svg). Keep interactive ones, index by every alias.
  const displayByNormalized = {};
  for (const group of mapsConfig) {
    for (const m of group.maps || []) {
      if (m.projection !== 'interactive') continue;
      const cfg = { ...m };
      displayByNormalized[group.normalizedName] = cfg;
      for (const alt of m.altMaps || []) displayByNormalized[alt] = cfg;
    }
  }

  return {
    dataMode,
    maps: mapList,
    mapById,
    tasks: taskList,
    items: itemRefs,
    display: displayByNormalized,
  };
}

module.exports = { TarkovData, buildModel };
