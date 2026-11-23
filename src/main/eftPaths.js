'use strict';
// Locate the Escape from Tarkov install, its Logs folder, and the screenshots folder.
//
// Tries, in order: the BSG launcher's settings and uninstall entries, Steam (registry, every Steam
// library, its uninstall entry), the running game's own location, common folder names on every
// drive, and finally a shallow scan of each drive for EscapeFromTarkov.exe. When several installs
// turn up, the one with the newest log session wins. Everything here is read-only.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const STEAM_APP_ID = '3932890';
const GAME_EXE = 'EscapeFromTarkov.exe';

function run(file, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

async function regQuery(key, value) {
  const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  const out = await run(reg, ['query', key, '/v', value]);
  const m = out && new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`, 'i').exec(out);
  return m ? m[1].trim() : null;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

async function steamLibraries() {
  const libs = new Set();
  const steamPath =
    (await regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath')) ||
    (await regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath')) ||
    (await regQuery('HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'));
  if (!steamPath) return [];
  libs.add(path.normalize(steamPath));
  for (const vdfPath of [path.join(steamPath, 'steamapps', 'libraryfolders.vdf'), path.join(steamPath, 'config', 'libraryfolders.vdf')]) {
    try {
      const vdf = fs.readFileSync(vdfPath, 'utf8');
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(path.normalize(m[1].replace(/\\\\/g, '\\')));
    } catch {
      /* no library file */
    }
  }
  return [...libs];
}

/** Where the BSG launcher says the game is (its settings file keeps the game folder). */
function bsgLauncherDirs() {
  const out = [];
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  for (const f of ['settings', 'settings.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(appData, 'Battlestate Games', 'BsgLauncher', f), 'utf8'));
      for (const k of ['gameRootDir', 'GameRootDir', 'gamesRootDir', 'GamesRootDir']) {
        if (typeof j[k] !== 'string') continue;
        out.push(j[k], path.join(j[k], 'EFT'), path.join(j[k], 'Escape from Tarkov'));
      }
    } catch {
      /* no launcher settings */
    }
  }
  return out;
}

/** Folder of the running game, if it's open right now. */
async function runningGameDir() {
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const out = await run(ps, ['-NoProfile', '-NonInteractive', '-Command', "(Get-Process EscapeFromTarkov -ErrorAction SilentlyContinue | Select-Object -First 1).Path"], 6000);
  const exe = out && out.trim();
  if (!exe || !isFile(exe)) return [];
  const dir = path.dirname(exe);
  return [dir, path.dirname(dir)]; // Steam keeps the exe in <install>\build
}

function fixedDrives() {
  const out = [];
  for (let c = 67; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    if (isDir(root)) out.push(root);
  }
  return out;
}

const COMMON = [
  ['Battlestate Games', 'EFT'],
  ['Battlestate Games', 'Escape from Tarkov'],
  ['Games', 'Battlestate Games', 'EFT'],
  ['Games', 'Battlestate Games', 'Escape from Tarkov'],
  ['Program Files', 'Battlestate Games', 'EFT'],
  ['Program Files', 'Battlestate Games', 'Escape from Tarkov'],
  ['Escape from Tarkov'],
  ['EFT'],
  ['Games', 'EFT'],
  ['Games', 'Escape from Tarkov'],
  ['SteamLibrary', 'steamapps', 'common', 'Escape from Tarkov'],
  ['Steam', 'steamapps', 'common', 'Escape from Tarkov'],
  ['Program Files (x86)', 'Steam', 'steamapps', 'common', 'Escape from Tarkov'],
  ['Program Files', 'Steam', 'steamapps', 'common', 'Escape from Tarkov'],
  ['Games', 'Steam', 'steamapps', 'common', 'Escape from Tarkov'],
  ['Games', 'SteamLibrary', 'steamapps', 'common', 'Escape from Tarkov'],
];

async function installCandidates() {
  const out = [];
  for (const root of ['HKLM\\SOFTWARE\\WOW6432Node', 'HKLM\\SOFTWARE', 'HKCU\\SOFTWARE']) {
    for (const app of ['EscapeFromTarkov', `Steam App ${STEAM_APP_ID}`]) {
      const loc = await regQuery(`${root}\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${app}`, 'InstallLocation');
      if (loc) out.push(loc);
    }
  }
  out.push(...bsgLauncherDirs());
  for (const lib of await steamLibraries()) out.push(path.join(lib, 'steamapps', 'common', 'Escape from Tarkov'));
  out.push(...(await runningGameDir()));
  for (const drive of fixedDrives()) for (const parts of COMMON) out.push(path.join(drive, ...parts));
  return out;
}

/**
 * Last resort: look for EscapeFromTarkov.exe on every drive, breadth first so shallow installs
 * turn up quickly, folders named like games/Steam/Tarkov first. Skips system folders and gives up
 * after a few seconds, so it can't hang the app.
 */
function scanDrives({ maxDepth = 6, budget = 40000, maxMs = 5000 } = {}) {
  const SKIP = /^(windows|\$recycle\.bin|system volume information|programdata|recovery|perflogs|msocache|config\.msi|users|appdata|node_modules|\$windows\.~\w+|windowsapps|\..*)$/i;
  const LIKELY = /tarkov|battlestate|\beft\b|steam|games?|program files/i;
  const exe = GAME_EXE.toLowerCase();
  const found = [];
  const until = Date.now() + maxMs;
  let level = fixedDrives();
  for (let depth = 0; depth <= maxDepth && level.length && !found.length; depth++) {
    const next = [];
    for (const dir of level) {
      if (budget-- <= 0 || Date.now() > until) return found;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      if (entries.some((e) => e.isFile() && e.name.toLowerCase() === exe)) found.push(dir, path.dirname(dir));
      const subs = entries.filter((e) => e.isDirectory() && !SKIP.test(e.name)).map((e) => path.join(dir, e.name));
      next.push(...subs.filter((p) => LIKELY.test(path.basename(p))), ...subs.filter((p) => !LIKELY.test(path.basename(p))));
    }
    // likely-named folders (and everything under them) go first on the next level
    level = [...next.filter((p) => LIKELY.test(p)), ...next.filter((p) => !LIKELY.test(p))];
  }
  return found;
}

function logsDirFor(installDir) {
  for (const sub of [['build', 'Logs'], ['Logs']]) {
    const p = path.join(installDir, ...sub);
    if (isDir(p)) return p;
  }
  return null;
}

/** Newest log session in a Logs folder (by folder modified time), 0 if none. */
function newestSession(logsDir) {
  let best = 0;
  try {
    for (const e of fs.readdirSync(logsDir, { withFileTypes: true })) {
      if (!e.isDirectory() || !/^log_/.test(e.name)) continue;
      best = Math.max(best, fs.statSync(path.join(logsDir, e.name)).mtimeMs);
    }
  } catch {
    /* unreadable */
  }
  return best;
}

function pickBest(dirs) {
  const seen = new Set();
  let best = null;
  for (const dir of dirs) {
    if (!dir) continue;
    const key = path.normalize(dir).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const logsDir = logsDirFor(dir);
    if (!logsDir) continue;
    const newest = newestSession(logsDir);
    if (!best || newest > best.newest) best = { installDir: dir, logsDir, newest };
  }
  return best && { installDir: best.installDir, logsDir: best.logsDir };
}

/** Returns { installDir, logsDir } or nulls. `override` is a user-picked folder (install or Logs). */
async function findLogsDir(override, { deep = true } = {}) {
  if (override) {
    if (isDir(override) && /logs$/i.test(override)) return { installDir: path.dirname(override), logsDir: override };
    const l = logsDirFor(override);
    if (l) return { installDir: override, logsDir: l };
  }
  const found = pickBest(await installCandidates()) || (deep ? pickBest(scanDrives()) : null);
  return found || { installDir: null, logsDir: null };
}

/** Documents\Escape from Tarkov\Screenshots, also under OneDrive. Null until the game has made it. */
function findScreenshotsDir(documentsDir, override) {
  if (override && isDir(override)) return override;
  const home = os.homedir();
  const docs = [documentsDir, path.join(home, 'Documents'), path.join(home, 'OneDrive', 'Documents'), path.join(home, 'OneDrive', 'Dokumente'), path.join(home, 'OneDrive', 'Documents')];
  try {
    for (const e of fs.readdirSync(home, { withFileTypes: true })) if (e.isDirectory() && /^OneDrive/i.test(e.name)) docs.push(path.join(home, e.name, 'Documents'));
  } catch {
    /* ignore */
  }
  for (const d of docs) {
    if (!d) continue;
    const p = path.join(d, 'Escape from Tarkov', 'Screenshots');
    if (isDir(p)) return p;
  }
  return null;
}

module.exports = { findLogsDir, findScreenshotsDir, isDir, scanDrives, pickBest };
