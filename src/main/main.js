'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { Store } = require('./store');
const { TarkovData } = require('./tarkovData');
const { LogWatcher } = require('./logWatcher');
const { findLogsDir, findScreenshotsDir } = require('./eftPaths');
const { computeTaskStates } = require('./questState');
const { dataModeFor, parseScreenshotName } = require('./logParser');

const MODES = ['pve', 'regular', 'pvpseason'];
const MODE_LABELS = { pve: 'PvE', regular: 'PvP', pvpseason: 'PvP Season' };

let win = null;
let store;
let data;
let watcher = null;
let screenshotWatcher = null;

// Live state shared with the UI
const live = {
  logsDir: null,
  installDir: null,
  screenshotsDir: null,
  gameMode: null, // session mode the game is currently/last in
  sessions: [],
  raid: { status: 'unknown', map: null, since: null }, // map = API map id
  lastMapEvent: null,
  position: null, // { x, y, z, yaw, time, map }
  logError: null,
  dataError: null,
};

function viewMode() {
  return store.settings.viewMode || live.gameMode || 'pve';
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------------------------------------------------------------- map detection
async function resolveMap(ev) {
  try {
    const model = await data.load(dataModeFor(ev.mode || viewMode()));
    const m = model.maps.find((x) => (ev.scenePath && x.scenePath === ev.scenePath) || (ev.nameId && x.nameId.toLowerCase() === ev.nameId.toLowerCase()));
    return m ? m.id : null;
  } catch {
    return null;
  }
}

async function applyMapEvent(ev, { quiet = false } = {}) {
  const raid = live.raid;
  switch (ev.type) {
    case 'mapLoading':
    case 'raidLocation': {
      const id = await resolveMap(ev);
      live.position = null; // new raid: old position no longer applies
      if (id) raid.map = id;
      raid.status = 'loading';
      raid.since = ev.time;
      break;
    }
    case 'raidStarted':
      raid.status = 'inRaid';
      raid.since = ev.time;
      break;
    case 'matchCancelled':
    case 'raidEnded':
      raid.status = 'menu';
      raid.since = ev.time;
      break;
    default:
      return;
  }
  if (!quiet) pushState();
}

// ---------------------------------------------------------------- log watching
async function startWatching() {
  if (watcher) watcher.stop();
  watcher = null;
  const found = await findLogsDir(store.settings.logsDirOverride);
  live.logsDir = found.logsDir;
  live.installDir = found.installDir;
  live.logError = found.logsDir ? null : 'Could not find the Escape from Tarkov Logs folder. Pick it in Settings.';
  if (!found.logsDir) return pushState();

  watcher = new LogWatcher(found.logsDir);
  watcher.on('history', async ({ events, sessions }) => {
    live.sessions = sessions;
    const newest = [...sessions].reverse().find((s) => s.mode);
    if (newest) live.gameMode = newest.mode;
    for (const ev of events) {
      if (ev.type === 'task' && ev.mode) store.addLogEvent(ev.mode, ev);
      if (ev.type === 'prestige' && prestigeMode(ev)) store.addPrestige(prestigeMode(ev), ev.time);
    }
    // Last map seen in the logs; only the newest session can still be "in raid".
    const newestFolder = sessions.length ? sessions[sessions.length - 1].name : null;
    for (const ev of events) await applyMapEvent(ev, { quiet: true });
    if (live.raid.status !== 'menu' && events.length && events[events.length - 1].folder !== newestFolder) live.raid.status = 'menu';
    if (live.raid.status === 'unknown') live.raid.status = 'menu';
    pushState();
  });
  watcher.on('session', ({ mode }) => {
    if (mode) live.gameMode = mode;
    pushState();
  });
  watcher.on('event', async (ev) => {
    if (ev.type === 'mode') {
      live.gameMode = ev.mode;
      pushState();
    } else if (ev.type === 'logPosition') {
      // The game logs your position now and then (sprint/overweight checks). No facing direction.
      if (live.raid.map && live.raid.status === 'inRaid') {
        live.position = { x: ev.x, y: ev.y, z: ev.z, yaw: null, time: Date.now(), map: live.raid.map, source: 'log' };
        send('position', live.position);
      }
    } else if (ev.type === 'prestige') {
      const mode = prestigeMode(ev);
      if (mode && store.addPrestige(mode, ev.time)) {
        // a fresh prestige wipes quest progress, so hand-made marks from before it no longer apply
        store.updateProfile(mode, (p) => {
          p.manual = {};
          p.objectivesDone = {};
          p.plans = {};
        });
        pushState();
        send('toast', { kind: 'prestige', mode, modeLabel: MODE_LABELS[mode] });
      }
    } else if (ev.type === 'task') {
      if (ev.mode && store.addLogEvent(ev.mode, ev)) {
        pushState();
        send('toast', { kind: 'task', status: ev.status, taskId: ev.taskId, mode: ev.mode });
      }
    } else {
      await applyMapEvent(ev);
    }
  });
  watcher.on('error', (err) => {
    live.logError = String(err.message || err);
    pushState();
  });
  watcher.start();
}

function startScreenshotWatcher() {
  if (screenshotWatcher) screenshotWatcher.close();
  screenshotWatcher = null;
  live.screenshotsDir = findScreenshotsDir(app.getPath('documents'), store.settings.screenshotsDirOverride);
  if (!live.screenshotsDir) return;
  try {
    screenshotWatcher = fs.watch(live.screenshotsDir, (event, filename) => {
      if (!filename || !/\.png$/i.test(filename)) return;
      const p = parseScreenshotName(filename);
      if (!p || !live.raid.map) return;
      live.position = { ...p, time: Date.now(), map: live.raid.map, source: 'screenshot' };
      send('position', live.position);
    });
  } catch {
    screenshotWatcher = null;
  }
}

// ---------------------------------------------------------------- state for the UI
// Which progress bucket a prestige belongs to: the session's mode, else guess from the server host.
function prestigeMode(ev) {
  if (ev.mode) return ev.mode;
  return /pve/i.test(ev.host || '') ? 'pve' : null;
}

// Progress before your latest prestige (or the wipe date you set) doesn't count.
function effectiveSince(p) {
  const prestige = !p.ignorePrestige && p.prestiges?.length ? p.prestiges[p.prestiges.length - 1] : 0;
  return Math.max(p.since || 0, prestige) || null;
}

const MAX_PRESTIGE = 6;

// Prestige level = what you told us (as of a time) + prestiges detected after that; else count of detected ones.
function prestigeLevel(p) {
  const detected = p.prestiges || [];
  const base = p.prestigeManual;
  const level = base ? base.level + detected.filter((t) => t > base.time).length : detected.length;
  return Math.min(MAX_PRESTIGE, Math.max(0, level));
}

function profileSummary(mode) {
  const p = store.profile(mode);
  return {
    prestigeLevel: prestigeLevel(p),
    prestigeManual: p.prestigeManual,
    sinceReason: p.sinceReason,
    since: p.since,
    effectiveSince: effectiveSince(p),
    prestiges: p.prestiges || [],
    ignorePrestige: !!p.ignorePrestige,
    level: p.level,
    faction: p.faction,
    manualCount: Object.keys(p.manual).length,
    logEventCount: Object.keys(p.logEvents).length,
    countedEventCount: Object.values(p.logEvents).filter((e) => !effectiveSince(p) || e.time >= effectiveSince(p)).length,
  };
}

async function taskStatesFor(mode) {
  const model = await data.load(dataModeFor(mode));
  const p = store.profile(mode);
  return computeTaskStates(model.tasks, Object.values(p.logEvents), p.manual, { since: effectiveSince(p), level: p.level, faction: p.faction });
}

async function buildState() {
  const mode = viewMode();
  let taskStates = {};
  try {
    taskStates = await taskStatesFor(mode);
    live.dataError = null;
  } catch (err) {
    live.dataError = `Could not load tarkov.dev data: ${err.message || err}`;
  }
  const sessionCounts = {};
  for (const s of live.sessions) sessionCounts[s.mode || 'unknown'] = (sessionCounts[s.mode || 'unknown'] || 0) + 1;
  return {
    mode,
    modeLabel: MODE_LABELS[mode],
    dataMode: dataModeFor(mode),
    gameMode: live.gameMode,
    modes: MODES.map((m) => ({ id: m, label: MODE_LABELS[m], prestigeLevel: prestigeLevel(store.profile(m)) })),
    raid: live.raid,
    position: live.position,
    logsDir: live.logsDir,
    screenshotsDir: live.screenshotsDir,
    logError: live.logError,
    dataError: live.dataError,
    sessions: { total: live.sessions.length, byMode: sessionCounts, first: live.sessions[0]?.time || null },
    settings: store.settings,
    profile: profileSummary(mode),
    objectivesDone: store.profile(mode).objectivesDone,
    plans: store.profile(mode).plans,
    taskStates,
  };
}

let pushPending = null;
function pushState() {
  if (pushPending) return;
  pushPending = setTimeout(async () => {
    pushPending = null;
    send('state', await buildState());
  }, 50);
}

// ---------------------------------------------------------------- IPC
function registerIpc() {
  ipcMain.handle('state:get', () => buildState());

  ipcMain.handle('data:get', async (_e, { mode, force } = {}) => {
    const model = await data.load(dataModeFor(mode || viewMode()), { force: !!force });
    const { mapById, ...rest } = model;
    if (force) pushState();
    return rest;
  });

  ipcMain.handle('svg:get', (_e, url) => data.svg(String(url)));

  ipcMain.handle('task:set', (_e, { taskId, status }) => {
    const mode = viewMode();
    store.updateProfile(mode, (p) => {
      if (status === null || status === 'auto') delete p.manual[taskId];
      else p.manual[taskId] = status;
    });
    pushState();
  });

  ipcMain.handle('objective:set', (_e, { objectiveId, done }) => {
    store.updateProfile(viewMode(), (p) => {
      if (done) p.objectivesDone[objectiveId] = true;
      else delete p.objectivesDone[objectiveId];
    });
    pushState();
  });

  ipcMain.handle('plan:set', (_e, { mapId, plan }) => {
    store.updateProfile(viewMode(), (p) => {
      if (!plan || (!plan.tasks?.length && !plan.start && !plan.extract)) delete p.plans[mapId];
      else
        p.plans[mapId] = {
          tasks: (plan.tasks || []).filter((t) => typeof t === 'string'),
          start: plan.start && Number.isFinite(plan.start.x) ? { x: plan.start.x, y: plan.start.y, z: plan.start.z, label: String(plan.start.label || '') } : null,
          extract: plan.extract ? String(plan.extract) : null,
        };
    });
    pushState();
  });

  ipcMain.handle('profile:set', (_e, patch) => {
    const allowed = ['since', 'level', 'faction', 'ignorePrestige'];
    store.updateProfile(viewMode(), (p) => {
      for (const k of allowed) if (k in patch) p[k] = patch[k];
      if ('since' in patch) p.sinceReason = patch.since ? 'date' : null;
      if ('prestigeLevel' in patch) {
        const level = Number(patch.prestigeLevel);
        p.prestigeManual = Number.isInteger(level) && level >= 0 && level <= MAX_PRESTIGE ? { level, time: Date.now() } : null;
      }
    });
    pushState();
  });

  // Game wipe: progress before `time` stops counting for the chosen modes. Logs themselves are untouched.
  ipcMain.handle('profile:wipe', (_e, { modes, time, resetPrestige }) => {
    const when = Number.isFinite(time) ? time : Date.now();
    for (const mode of (modes || []).filter((m) => MODES.includes(m))) {
      store.updateProfile(mode, (p) => {
        p.since = when;
        p.sinceReason = 'wipe';
        p.manual = {};
        p.objectivesDone = {};
        p.plans = {};
        if (resetPrestige) p.prestigeManual = { level: 0, time: when };
      });
    }
    pushState();
  });

  ipcMain.handle('profile:resetManual', () => {
    store.updateProfile(viewMode(), (p) => {
      p.manual = {};
      p.objectivesDone = {};
    });
    pushState();
  });

  ipcMain.handle('settings:set', (_e, patch) => {
    const allowed = ['viewMode', 'markerFilter', 'showExtracts', 'showSpawns', 'followRaidMap', 'alwaysOnTop'];
    const clean = {};
    for (const k of allowed) if (k in patch) clean[k] = patch[k];
    store.setSettings(clean);
    if ('alwaysOnTop' in clean && win) win.setAlwaysOnTop(!!clean.alwaysOnTop);
    pushState();
  });

  ipcMain.handle('folder:pick', async (_e, kind) => {
    const r = await dialog.showOpenDialog(win, {
      title: kind === 'screenshots' ? 'Select the EFT Screenshots folder' : 'Select the Escape from Tarkov install folder (or its Logs folder)',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    if (kind === 'screenshots') {
      store.setSettings({ screenshotsDirOverride: r.filePaths[0] });
      startScreenshotWatcher();
    } else {
      store.setSettings({ logsDirOverride: r.filePaths[0] });
      await startWatching();
    }
    pushState();
    return r.filePaths[0];
  });

  ipcMain.handle('link:open', (_e, url) => {
    const u = new URL(String(url));
    if (u.protocol === 'https:') shell.openExternal(u.toString());
  });
}

// ---------------------------------------------------------------- app
function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#14161a',
    title: 'Tarkov Quest Map',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    alwaysOnTop: !!store.settings.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Dev aid: TQM_CAPTURE=<file.png> saves a screenshot of the window after it settles,
  // and renderer console output is echoed to the terminal.
  if (process.env.TQM_CAPTURE) {
    win.webContents.on('console-message', (e) => console.log(`[renderer:${e.level}] ${e.message}`));
    win.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        if (process.env.TQM_JS) {
          console.log('js result:', JSON.stringify(await win.webContents.executeJavaScript(process.env.TQM_JS)));
          await new Promise((r) => setTimeout(r, 4000));
        }
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.TQM_CAPTURE, img.toPNG());
        console.log('captured', process.env.TQM_CAPTURE);
        if (process.env.TQM_EXIT) app.quit();
      }, Number(process.env.TQM_CAPTURE_DELAY || 6000));
    });
  }
}

// Dev aid: TQM_USER_DATA=<folder> keeps test runs away from your real progress file.
if (process.env.TQM_USER_DATA) app.setPath('userData', process.env.TQM_USER_DATA);

// Lets Windows group the window with its taskbar/desktop shortcuts.
app.setAppUserModelId('TarkovQuestMap.App');

app.whenReady().then(async () => {
  store = new Store(app.getPath('userData'));
  data = new TarkovData(path.join(app.getPath('userData'), 'cache'));
  registerIpc();
  createWindow();
  startScreenshotWatcher();
  await startWatching();
});

app.on('window-all-closed', () => {
  if (watcher) watcher.stop();
  if (screenshotWatcher) screenshotWatcher.close();
  try {
    store.flush();
  } catch {
    /* ignore */
  }
  app.quit();
});
