'use strict';
// Locate the Escape from Tarkov install, its Logs folder, and the screenshots folder.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

function regQuery(key, value) {
  return new Promise((resolve) => {
    const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
    execFile(reg, ['query', key, '/v', value], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const m = new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`, 'i').exec(stdout);
      resolve(m ? m[1].trim() : null);
    });
  });
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function steamLibraries() {
  const libs = new Set();
  const steamPath =
    (await regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath')) ||
    (await regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'));
  if (!steamPath) return [];
  libs.add(path.normalize(steamPath));
  try {
    const vdf = fs.readFileSync(path.join(steamPath, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(path.normalize(m[1].replace(/\\\\/g, '\\')));
  } catch {
    /* no library file */
  }
  return [...libs];
}

async function installCandidates() {
  const out = [];
  // BSG launcher install
  for (const key of [
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\EscapeFromTarkov',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\EscapeFromTarkov',
  ]) {
    const loc = await regQuery(key, 'InstallLocation');
    if (loc) out.push(loc);
  }
  // Steam install (app 3932890)
  for (const lib of await steamLibraries()) out.push(path.join(lib, 'steamapps', 'common', 'Escape from Tarkov'));
  for (const drive of ['C', 'D', 'E', 'F']) {
    out.push(`${drive}:\\Battlestate Games\\EFT`);
    out.push(`${drive}:\\Battlestate Games\\Escape from Tarkov`);
  }
  return out;
}

function logsDirFor(installDir) {
  for (const sub of [['build', 'Logs'], ['Logs']]) {
    const p = path.join(installDir, ...sub);
    if (isDir(p)) return p;
  }
  return null;
}

/** Returns { installDir, logsDir } or nulls. `override` is a user-picked folder (install or Logs). */
async function findLogsDir(override) {
  if (override) {
    if (isDir(override) && /logs$/i.test(override)) return { installDir: path.dirname(override), logsDir: override };
    const l = override && logsDirFor(override);
    if (l) return { installDir: override, logsDir: l };
  }
  for (const dir of await installCandidates()) {
    const logsDir = logsDirFor(dir);
    if (logsDir) return { installDir: dir, logsDir };
  }
  return { installDir: null, logsDir: null };
}

function findScreenshotsDir(documentsDir, override) {
  if (override && isDir(override)) return override;
  const p = path.join(documentsDir || path.join(os.homedir(), 'Documents'), 'Escape from Tarkov', 'Screenshots');
  return isDir(p) ? p : null;
}

module.exports = { findLogsDir, findScreenshotsDir, isDir };
