'use strict';
// Small JSON file store for settings and quest progress (in %APPDATA%\Tarkov Quest Map).
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  version: 2,
  settings: {
    logsDirOverride: null,
    screenshotsDirOverride: null,
    viewMode: 'pve', // 'pve' | 'regular' | 'pvpseason'; null = follow the game's current session mode
    markerFilter: 'active', // 'active' | 'available' | 'all'
    showExtracts: true,
    followRaidMap: true,
    alwaysOnTop: false,
    sidebarCollapsed: false,
    showLocks: false,
    extractFactions: ['pmc', 'scav', 'shared'], // which extracts to show
    showLoot: false,
    lootCats: ['weapons', 'ammo', 'bodies'], // loot layer categories (see src/renderer/loot.js)
    questSort: 'recent', // All quests tab: 'recent' | 'oldest' | 'trader' | 'name'
  },
  // per session mode ('pve' | 'regular' | 'pvpseason')
  profiles: {},
  // saved weapon builds, shared by every mode: { [weaponId]: [{ id, name, goal, tree, createdAt, updatedAt }] }
  builds: {},
};

function emptyProfile() {
  // plans: { [mapId]: { type: 'pmc'|'scav', tasks: [taskId], start: {x,y,z,label}|null, extract: name|null,
  //   scav: { start, extract, cats: [lootCat], picks: [hotspotId]|null, size } } }
  // prestiges: [time] detected from logs; quest progress before the latest one is ignored unless ignorePrestige
  // prestigeManual: { level, time } = "I was prestige <level> at <time>"; later detected prestiges add to it
  // sinceReason: why `since` is set ('wipe' | 'date')
  return {
    logEvents: {},
    manual: {},
    manualAt: {}, // taskId -> when you set it by hand
    objectivesDone: {},
    plans: {},
    prestiges: [],
    prestigeManual: null,
    ignorePrestige: false,
    since: null,
    sinceReason: null,
    level: null,
    faction: null,
  };
}

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'progress.json');
    fs.mkdirSync(dir, { recursive: true });
    this.data = structuredClone(DEFAULTS);
    try {
      const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...this.data, ...loaded, settings: { ...DEFAULTS.settings, ...(loaded.settings || {}) } };
      if ((loaded.version || 1) < 2) {
        // v2: PvE is the default view instead of following the game
        if (!this.data.settings.viewMode) this.data.settings.viewMode = 'pve';
        this.data.version = 2;
      }
    } catch {
      /* first run */
    }
    this.timer = null;
  }

  profile(mode) {
    if (!this.data.profiles[mode]) this.data.profiles[mode] = emptyProfile();
    return Object.assign(emptyProfile(), this.data.profiles[mode]);
  }

  updateProfile(mode, fn) {
    const p = this.profile(mode);
    fn(p);
    this.data.profiles[mode] = p;
    this.save();
  }

  /** Remember a task event from the logs (kept even after EFT deletes old logs). */
  /** Remember a prestige seen in the logs. Returns true if it is new. */
  addPrestige(mode, time) {
    const p = this.data.profiles[mode] || (this.data.profiles[mode] = emptyProfile());
    p.prestiges = p.prestiges || [];
    // the same call shows up in backend_000.log and output_000.log; treat within a minute as one
    if (p.prestiges.some((t) => Math.abs(t - time) < 60000)) return false;
    p.prestiges.push(time);
    p.prestiges.sort((a, b) => a - b);
    this.save();
    return true;
  }

  addLogEvent(mode, ev) {
    const p = this.data.profiles[mode] || (this.data.profiles[mode] = emptyProfile());
    const key = `${ev.taskId}|${ev.status}|${ev.time}`;
    if (p.logEvents[key]) return false;
    p.logEvents[key] = { taskId: ev.taskId, status: ev.status, time: ev.time };
    this.save();
    return true;
  }

  get settings() {
    return this.data.settings;
  }

  setSettings(patch) {
    Object.assign(this.data.settings, patch);
    this.save();
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.trySave(), 300);
  }

  /** Save with a few retries (another program can briefly lock the file); report failure instead of losing it. */
  trySave(attempt = 0) {
    try {
      this.flush();
      if (this.lastError) {
        this.lastError = null;
        this.onSaveStatus?.(null);
      }
    } catch (err) {
      if (attempt < 4) {
        this.timer = setTimeout(() => this.trySave(attempt + 1), 500 * (attempt + 1));
        return;
      }
      this.lastError = String(err.message || err);
      this.onSaveStatus?.(this.lastError);
    }
  }

  flush() {
    clearTimeout(this.timer);
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
