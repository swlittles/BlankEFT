'use strict';
// Auto-update from GitHub Releases (github.com/swlittles/BlankEFT/releases).
//
// Only the installed app updates itself: the installer build carries resources/app-update.yml,
// which says where to look. Dev runs (`npm start`) and old unpacked copies just report that
// updates aren't available for them. New versions download in the background and install when
// you restart the app, or when you close it.
const fs = require('fs');
const path = require('path');
const { app, ipcMain } = require('electron');

const CHECK_EVERY_MS = 2 * 60 * 60 * 1000; // every 2 hours while the app is open
const FIRST_CHECK_MS = 8000; // shortly after start, once the window is up

const status = {
  version: app.getVersion(),
  supported: false,
  state: 'idle', // idle | checking | downloading | ready | latest | error
  latest: null, // version on GitHub when newer than ours
  percent: null,
  error: null,
  checkedAt: null,
};

let autoUpdater = null;
let send = () => {};

function update(patch) {
  Object.assign(status, patch);
  send('update', { ...status });
}

function check() {
  if (!autoUpdater) return Promise.resolve(status);
  if (status.state === 'checking' || status.state === 'downloading' || status.state === 'ready') return Promise.resolve(status);
  update({ state: 'checking', error: null });
  return autoUpdater.checkForUpdates().then(
    () => status,
    (err) => {
      update({ state: 'error', error: String(err?.message || err).split('\n')[0] });
      return status;
    },
  );
}

/**
 * @param {(channel: string, payload: any) => void} sendFn  sends to the window
 * @param {() => void} beforeInstall  saves anything unsaved before the app quits to update
 */
function initUpdater(sendFn, beforeInstall) {
  send = sendFn;
  ipcMain.handle('update:get', () => ({ ...status }));
  ipcMain.handle('update:check', () => check());
  ipcMain.handle('update:install', () => {
    if (status.state !== 'ready' || !autoUpdater) return false;
    try {
      beforeInstall?.();
    } catch {
      /* still update */
    }
    // silent install (the one-click installer has no pages), then start the new version
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return true;
  });

  const installed = app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'));
  // test runs (TQM_CAPTURE) skip updating unless TQM_UPDATE_TEST asks for it
  if (!installed || (process.env.TQM_CAPTURE && !process.env.TQM_UPDATE_TEST) || process.env.TQM_NO_UPDATE) return;

  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // closing the app installs a downloaded update
  autoUpdater.logger = null;
  autoUpdater.on('update-available', (info) => update({ state: 'downloading', latest: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => update({ state: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => {
    update({ state: 'ready', latest: info.version, percent: 100, checkedAt: Date.now() });
    send('toast', { kind: 'update', version: info.version });
  });
  autoUpdater.on('update-not-available', () => update({ state: 'latest', latest: null, percent: null, checkedAt: Date.now() }));
  autoUpdater.on('error', (err) => update({ state: 'error', error: String(err?.message || err).split('\n')[0], checkedAt: Date.now() }));
  status.supported = true;

  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, CHECK_EVERY_MS);
}

module.exports = { initUpdater };
