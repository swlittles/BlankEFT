'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tqm', {
  getState: () => ipcRenderer.invoke('state:get'),
  getData: (opts) => ipcRenderer.invoke('data:get', opts || {}),
  getSvg: (url) => ipcRenderer.invoke('svg:get', url),
  getArmory: (opts) => ipcRenderer.invoke('armory:get', opts || {}),
  setTask: (taskId, status) => ipcRenderer.invoke('task:set', { taskId, status }),
  setObjective: (objectiveId, done) => ipcRenderer.invoke('objective:set', { objectiveId, done }),
  setProfile: (patch) => ipcRenderer.invoke('profile:set', patch),
  setPlan: (mapId, plan) => ipcRenderer.invoke('plan:set', { mapId, plan }),
  saveBuild: (weaponId, build) => ipcRenderer.invoke('builds:save', { weaponId, build }),
  deleteBuild: (weaponId, id) => ipcRenderer.invoke('builds:delete', { weaponId, id }),
  resetManual: () => ipcRenderer.invoke('profile:resetManual'),
  wipe: (modes, time, resetPrestige) => ipcRenderer.invoke('profile:wipe', { modes, time, resetPrestige }),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  pickFolder: (kind) => ipcRenderer.invoke('folder:pick', kind),
  openLink: (url) => ipcRenderer.invoke('link:open', url),
  on: (channel, fn) => {
    if (!['state', 'position', 'toast'].includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
