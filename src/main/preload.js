'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['dl:update', 'dl:added', 'dl:removed', 'settings:changed', 'app:status', 'confirm:info', 'after:changed', 'update:status', 'update:restarting', 'app:resync']);
const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

// The renderer never gets Node or Electron objects, only this narrow, validated surface.
contextBridge.exposeInMainWorld('vexlo', {
  list: call('dl:list'),
  add: call('dl:add'),
  pause: call('dl:pause'),
  resume: call('dl:resume'),
  remove: call('dl:remove'),
  pauseAll: call('dl:pauseAll'),
  resumeAll: call('dl:resumeAll'),
  clearDone: call('dl:clearDone'),
  open: call('dl:open'),
  showInFolder: call('dl:showInFolder'),
  copyLink: call('dl:copyLink'),
  hashFile: call('dl:hash'),
  prioritize: call('dl:prioritize'),
  taskLimit: call('dl:taskLimit'),
  openPage: call('dl:openPage'),
  refreshLink: call('dl:refresh'),
  getSettings: call('settings:get'),
  setSettings: call('settings:set'),
  appInfo: call('app:info'),
  updateCheck: call('update:check'),
  releaseNotes: call('app:releaseNotes'),
  exportList: call('app:exportList'),
  importList: call('app:importList'),
  scanFile: call('dl:scan'),
  extractFile: call('dl:extract'),
  whatsNew: call('app:whatsNew'),
  exportLog: call('app:exportLog'),
  updateStatus: call('update:status'),
  updateInstall: call('update:install'),
  openExtensionFolder: call('app:openExtensionFolder'),
  chooseFolder: call('dialog:chooseFolder'),
  confirmGet: call('confirm:get'),
  confirmCheck: call('confirm:check'),
  confirmResolve: call('confirm:resolve'),
  afterGet: call('after:get'),
  afterSet: call('after:set'),
  afterCountdown: call('after:countdown'),
  afterNow: call('after:now'),
  afterCancel: call('after:cancel'),
  progressGet: call('progress:get'),
  progressClose: call('progress:close'),
  confirmResize: (h) => { if (Number.isFinite(h)) { ipcRenderer.send('confirm:resize', Math.round(h)); } },
  on(channel, cb) {
    if (!EVENTS.has(channel) || typeof cb !== 'function') { return () => {}; }
    const h = (_e, data) => cb(data);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
