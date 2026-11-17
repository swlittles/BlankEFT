'use strict';
// Downloads and caches quest + map data from tarkov.dev (https://tarkov.dev, community API).
const fs = require('fs');
const path = require('path');
const { buildArmory } = require('./armoryData');

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
    const [tasks, tasksEn, maps, mapsEn, traders, tradersEn, items, itemsEn, mapsConfig] = await Promise.all([
      get('tasks'),
      get('tasks_en'),
      get('maps'),
      get('maps_en'),
      get('traders'),
      get('traders_en'),
      get('items'),
      get('items_en'),
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

function buildModel({ dataMode, tasks, tasksEn, maps, mapsEn, traders, tradersEn, items: itemsJson, itemsEn, mapsConfig }) {
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

  const mapList = Object.values(maps.data.maps).map((m) => ({
    id: m.id,
    name: tMap(m.name),
    normalizedName: m.normalizedName,
    nameId: m.nameId,
    scenePath: m.scenePath,
    extracts: (m.extracts || []).map((e) => ({
      name: tMap(e.name),
      faction: e.faction,
      position: e.position,
      outline: e.outline,
      top: e.top,
      bottom: e.bottom,
    })),
    transits: (m.transits || []).map((e) => ({ name: tMap(e.description), position: e.position, top: e.top, bottom: e.bottom })),
    pmcSpawns: (m.spawns || [])
      .filter((sp) => sp.sides?.includes('pmc') && sp.categories?.includes('player'))
      .map((sp) => ({ position: sp.position })),
  }));
  const mapById = Object.fromEntries(mapList.map((m) => [m.id, m]));

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
        questItem: qi ? { id: qi.id, name: tTask(qi.name), iconLink: qi.iconLink } : null,
        foundInRaid: !!o.foundInRaid,
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
