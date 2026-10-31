'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
  app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, clipboard, Notification, nativeImage, nativeTheme, screen, net,
} = require('electron');
const { detectKind } = require('../core/manager');
const { EngineClient } = require('../core/engine-client');
const { createApi } = require('../core/api');
const { folderFor } = require('../core/category');
const { findDuplicate } = require('../core/dupes');
const { uniquePath, downloadLinkIn, plainNotes } = require('../core/util');
const { dueActions, effectiveLimitKB } = require('../core/schedule');
const { execFile } = require('child_process');
const I18N = require('../renderer/i18n');

const VERSION = require('../../package.json').version;
const RENDERER = path.join(__dirname, '..', 'renderer');
const ICON = path.join(__dirname, '..', '..', 'build', 'icon.png');
const TRAY_ICON = path.join(__dirname, '..', '..', 'build', 'tray.png');
const EXT_DIR = app.isPackaged ? path.join(process.resourcesPath, 'extension') : path.join(__dirname, '..', '..', 'extension');

const DEFAULTS = {
  downloadDir: '', categorize: true, maxConcurrent: 2, connections: 8, speedLimitKB: 0, confirm: true,
  closeToTray: true, startWithOS: false, startHidden: true, notify: true, port: 6877, token: '', deleteMode: 'ask',
  progressWindow: true, progressFloat: true, progressAutoClose: true, progressOnError: 'ask',
  scheduleEnabled: false, scheduleStart: '01:00', scheduleStop: '', scheduleDays: [0, 1, 2, 3, 4, 5, 6],
  autoUpdate: true, language: 'auto', clipboardWatch: false,
  limitWindowEnabled: false, limitWindowFrom: '08:00', limitWindowTo: '22:00', limitWindowKB: 500,
};

let settings = { ...DEFAULTS };
let manager = null;
let api = null;
let apiError = '';
let mainWin = null;
let tray = null;
let quitting = false;
const confirmWins = new Map(); // webContents.id -> { id, win }
const progressWins = new Map(); // webContents.id -> { id, win }
const progressByTask = new Map(); // task id -> BrowserWindow

// ------------------------------------------------------------------ settings

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function clampSettings(s) {
  const n = (v, lo, hi, d) => { const x = Math.round(Number(v)); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  return {
    downloadDir: typeof s.downloadDir === 'string' && s.downloadDir ? s.downloadDir : '',
    categorize: !!s.categorize,
    maxConcurrent: n(s.maxConcurrent, 1, 10, DEFAULTS.maxConcurrent),
    connections: n(s.connections, 1, 32, DEFAULTS.connections),
    speedLimitKB: n(s.speedLimitKB, 0, 10 * 1024 * 1024, 0),
    confirm: !!s.confirm,
    closeToTray: !!s.closeToTray,
    startWithOS: !!s.startWithOS,
    startHidden: s.startHidden !== false,
    notify: !!s.notify,
    progressWindow: s.progressWindow !== false,
    language: ['auto', 'vi', 'en'].includes(s.language) ? s.language : 'auto',
    progressFloat: s.progressFloat !== false,
    progressAutoClose: s.progressAutoClose !== false,
    progressOnError: ['ask', 'close', 'keep'].includes(s.progressOnError) ? s.progressOnError : 'ask',
    scheduleEnabled: !!s.scheduleEnabled,
    scheduleStart: /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s.scheduleStart || '')) ? String(s.scheduleStart) : DEFAULTS.scheduleStart,
    scheduleStop: /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s.scheduleStop || '')) ? String(s.scheduleStop) : '',
    scheduleDays: Array.isArray(s.scheduleDays) ? [...new Set(s.scheduleDays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))] : DEFAULTS.scheduleDays,
    autoUpdate: s.autoUpdate !== false,
    clipboardWatch: !!s.clipboardWatch,
    limitWindowEnabled: !!s.limitWindowEnabled,
    limitWindowFrom: /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s.limitWindowFrom || '')) ? String(s.limitWindowFrom) : DEFAULTS.limitWindowFrom,
    limitWindowTo: /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s.limitWindowTo || '')) ? String(s.limitWindowTo) : DEFAULTS.limitWindowTo,
    limitWindowKB: n(s.limitWindowKB, 0, 10 * 1024 * 1024, DEFAULTS.limitWindowKB),
    deleteMode: ['ask', 'list', 'files'].includes(s.deleteMode) ? s.deleteMode : 'ask',
    port: n(s.port, 1024, 65535, DEFAULTS.port),
    token: typeof s.token === 'string' && s.token ? s.token : crypto.randomBytes(12).toString('hex'),
  };
}

/** The installer can ask "start Vexlo with Windows?" and leaves a flag file; the app turns it into the real setting once. */
function applyInstallerOptions() {
  const flag = path.join(app.getPath('userData'), 'autostart.flag');
  try {
    if (fs.existsSync(flag)) {
      const yes = fs.readFileSync(flag, 'utf8').trim() === '1';
      settings = clampSettings({ ...settings, startWithOS: yes });
      saveSettings();
      fs.unlinkSync(flag);
    }
  } catch { /* ignore */ }
}

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { /* first run */ }
  settings = clampSettings({ ...DEFAULTS, downloadDir: app.getPath('downloads'), ...saved });
  saveSettings();
}

function saveSettings() {
  try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch { /* ignore */ }
}

/** 'vi' or 'en': the chosen language, or the system language when set to automatic. */
function uiLang() {
  if (settings && settings.language === 'vi') { return 'vi'; }
  if (settings && settings.language === 'en') { return 'en'; }
  return String(app.getLocale() || '').toLowerCase().startsWith('vi') ? 'vi' : 'en';
}
function T(key, vars) { I18N.setLang(uiLang()); return I18N.tr(key, vars); }
const pageOpts = () => ({ query: { lang: uiLang() } });

/** The speed limit in force now: the normal one, or the "limit during these hours" one while inside the window. */
let appliedLimit = -1;
function currentLimitKB() {
  return effectiveLimitKB(new Date(), {
    limit: settings.speedLimitKB, windowEnabled: settings.limitWindowEnabled, windowFrom: settings.limitWindowFrom,
    windowTo: settings.limitWindowTo, windowLimit: settings.limitWindowKB,
  });
}
function applyLimit() {
  if (!manager) { return; }
  const kb = currentLimitKB();
  if (kb !== appliedLimit) { appliedLimit = kb; manager.setSpeedLimit(kb * 1024); }
}

function applySettings(prev) {
  manager.downloadDir = settings.downloadDir;
  manager.connections = settings.connections;
  manager.setMaxConcurrent(settings.maxConcurrent);
  appliedLimit = -1;
  applyLimit();
  try { app.setLoginItemSettings({ openAtLogin: settings.startWithOS, path: process.execPath, args: settings.startHidden ? ['--hidden'] : [] }); } catch { /* unsupported platform */ }
  if (!prev || prev.port !== settings.port || prev.token !== settings.token) { startApi(); }
  setClipboardWatch(settings.clipboardWatch);
}

// ---- optional: offer to download when a file link is copied (off by default, polls only while enabled)
let clipTimer = null;
let clipLast = '';
function setClipboardWatch(on) {
  if (!on) { if (clipTimer) { clearInterval(clipTimer); clipTimer = null; } return; }
  if (clipTimer) { return; }
  try { clipLast = clipboard.readText(); } catch { clipLast = ''; } // what is already there is not offered
  clipTimer = setInterval(() => {
    let text = '';
    try { text = clipboard.readText(); } catch { return; }
    if (text === clipLast) { return; }
    clipLast = text;
    const url = downloadLinkIn(text);
    if (!url || !manager || !Notification.isSupported()) { return; }
    if (manager.list().some((t) => t.url === url && t.status !== 'error')) { return; }
    const n = new Notification({ title: T('Vexlo: phát hiện link tải'), body: T('{u}\nBấm để tải bằng Vexlo', { u: url.length > 90 ? url.slice(0, 87) + '...' : url }), silent: true });
    n.on('click', () => { if (manager) { handleExternalAdd([{ url }]); } });
    n.show();
  }, 1500);
}


// ------------------------------------------------------------------ pairing with the Firefox extension (native messaging)

const NATIVE_NAME = 'dev.vexlo.host';
const EXT_ID = 'vexlo@local.app';
// Edge/Chrome extension IDs allowed to ask for the pairing code. The first one is the unpacked build (fixed by tools/edge-key.txt);
// add the ID that Edge Add-ons / Chrome Web Store give the published extension here too.
const CHROMIUM_EXT_IDS = ['akbbekifmiapbocjcejgjdhdkciljhnj'];

/** Lets the extension ask this app for its port + pairing code, so nothing has to be typed. Windows/Firefox only; never fatal. */
function registerNativeHost() {
  if (process.platform !== 'win32') { return; }
  try {
    const hostJs = app.isPackaged ? path.join(process.resourcesPath, 'native', 'host.js') : path.join(__dirname, '..', '..', 'native', 'host.js');
    const dir = path.join(app.getPath('userData'), 'native');
    fs.mkdirSync(dir, { recursive: true });
    const cmd = path.join(dir, 'host.cmd');
    fs.writeFileSync(cmd, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${hostJs}" "${settingsFile()}" "${app.isPackaged ? process.execPath : ''}"\r\n`);
    const reg = (key, file) => execFile('reg', ['add', key + '\\' + NATIVE_NAME, '/ve', '/t', 'REG_SZ', '/d', file, '/f'], { windowsHide: true }, () => {});
    // Firefox
    const ffManifest = path.join(dir, 'host.json');
    fs.writeFileSync(ffManifest, JSON.stringify({
      name: NATIVE_NAME, description: 'Vexlo pairing', path: cmd, type: 'stdio', allowed_extensions: [EXT_ID],
    }, null, 2));
    reg('HKCU\\Software\\Mozilla\\NativeMessagingHosts', ffManifest);
    // Edge / Chrome (the extension ID is fixed by the "key" in the Edge build's manifest)
    const crManifest = path.join(dir, 'host-chromium.json');
    fs.writeFileSync(crManifest, JSON.stringify({
      name: NATIVE_NAME, description: 'Vexlo pairing', path: cmd, type: 'stdio', allowed_origins: CHROMIUM_EXT_IDS.map((id) => `chrome-extension://${id}/`),
    }, null, 2));
    reg('HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts', crManifest);
    reg('HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts', crManifest);
  } catch { /* the extension can still be paired by hand in its options */ }
}

// ------------------------------------------------------------------ API for the browser extension

async function startApi() {
  if (api) { try { await api.close(); } catch { /* ignore */ } api = null; }
  apiError = '';
  api = createApi(manager, {
    port: settings.port, token: settings.token, version: VERSION,
    onAdd: handleExternalAdd, getRefreshPending, onShowWindow: () => {}, getSettings: () => ({ confirm: settings.confirm }),
  });
  try { await api.listen(); } catch (e) {
    apiError = e.code === 'EADDRINUSE' ? T('Cổng {port} đang được chương trình khác dùng', { port: settings.port }) : String(e.message || e);
    api = null;
  }
  broadcast('app:status', appInfo());
}

function categoryDir(nameOrUrl, kind) {
  return settings.categorize ? folderFor(settings.downloadDir, nameOrUrl, kind) : settings.downloadDir;
}

/** "Tệp trùng tên" warning shown in the confirmation window; '' when there is nothing to warn about. */
function dupNote(filename, dir) {
  if (!filename || !dir) { return ''; }
  const full = path.join(dir, filename);
  if (!fs.existsSync(full)) { return ''; }
  const alt = path.basename(uniquePath(dir, filename));
  return T('Tệp "{f}" đã có trong thư mục này. Bản mới sẽ được lưu thành "{alt}".', { f: filename, alt });
}

function notifyDuplicate(task) {
  if (Notification.isSupported()) { new Notification({ title: 'Vexlo', body: T('Đã có trong danh sách tải: {f}', { f: task.filename || task.url }), silent: true }).show(); }
}

/** Items coming from the browser: show an IDM-style confirmation window unless the user turned it off. */
// ---- "Refresh link": a failed download whose signed link expired waits here for a fresh capture of its page
const refreshWanted = new Map(); // task id -> { page, kind, at }
const stripHash = (u) => String(u || '').split('#')[0];
function getRefreshPending() {
  const out = [];
  for (const [id, w] of refreshWanted) {
    const t = manager && manager.get(id);
    if (!t || t.state.status !== 'error' || Date.now() - w.at > 30 * 60 * 1000) { refreshWanted.delete(id); continue; }
    out.push({ page: w.page, kind: w.kind });
  }
  return out;
}
function takeRefresh(page) {
  for (const [id, w] of refreshWanted) { if (stripHash(w.page) === stripHash(page)) { refreshWanted.delete(id); return id; } }
  return '';
}

function handleExternalAdd(items) {
  const ask = settings.confirm && items.length <= 3;
  return items.map((it) => {
    const refreshed = takeRefresh(it.meta && it.meta.page ? it.meta.page : it.page);
    const kind = detectKind(it.url, it.kind);
    const dir = categoryDir(it.filename || it.url, kind);
    const dup = findDuplicate(manager.list(), { url: it.url, filename: it.filename, dir, page: it.page, kind }, { exists: fs.existsSync });
    if (dup && dup.type === 'active') { notifyDuplicate(dup.task); return dup.task.id; } // already in the list: never download twice
    const replaceId = dup && dup.type === 'error' ? dup.task.id : undefined; // failed before: replace it, keep the plain name
    const filename = it.filename || (replaceId ? dup.task.filename : undefined);
    const askNow = ask && !refreshed; // a link the user asked to refresh starts at once, no confirmation window
    const id = manager.add({
      ...it, filename, replaceId, dir, connections: settings.connections, start: !askNow, pending: askNow,
    });
    if (askNow) { openConfirm(id, { replaced: !!replaceId }); } else if (items.length <= 3) { openProgress(id); }
    return id;
  });
}

// ------------------------------------------------------------------ windows

function secureWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function baseOptions(extra) {
  return {
    show: false, autoHideMenuBar: true, backgroundColor: nativeTheme.shouldUseDarkColors ? '#17191c' : '#f4f6f8',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    ...extra,
  };
}

function createMainWindow({ hidden = false } = {}) {
  mainWin = new BrowserWindow(baseOptions({ width: 1060, height: 660, minWidth: 780, minHeight: 440, title: 'Vexlo' }));
  secureWindow(mainWin);
  mainWin.loadFile(path.join(RENDERER, 'index.html'), pageOpts());
  mainWin.once('ready-to-show', () => { if (!hidden) { mainWin.show(); } });
  // Closing to the tray really closes the window (its page is freed from memory); showMain() builds it again on demand.
  mainWin.on('closed', () => { mainWin = null; });
  // A hidden/minimized window skips live updates (see broadcast); when it comes back it asks the list again.
  const resync = () => { if (mainWin && !mainWin.isDestroyed()) { mainWin.webContents.send('app:resync'); } };
  mainWin.on('show', resync);
  mainWin.on('restore', resync);
}

function showMain() {
  if (!mainWin) { createMainWindow(); return; }
  if (mainWin.isMinimized()) { mainWin.restore(); }
  mainWin.show();
  mainWin.focus();
}

function openConfirm(id, { replaced = false } = {}) {
  const win = new BrowserWindow(baseOptions({
    width: 440, height: 260, useContentSize: true, resizable: false, minimizable: false, maximizable: false, alwaysOnTop: true,
    title: T('Thông tin tải xuống'),
  }));
  secureWindow(win);
  const wcId = win.webContents.id;
  confirmWins.set(wcId, { id, win, done: false, replaced });
  // Never leave the user with an empty window (or lose the download) if the dialog cannot be loaded: just start it.
  const fallbackStart = () => {
    const c = confirmWins.get(wcId);
    if (!c || c.done) { return; }
    c.done = true;
    try { manager.confirm(id, { start: true }); } catch { /* task already gone */ }
    if (!win.isDestroyed()) { win.close(); }
  };
  win.webContents.once('did-fail-load', fallbackStart);
  win.loadFile(path.join(RENDERER, 'confirm.html'), pageOpts()).catch(fallbackStart);
  // Show only once the page has reported its real height (no jump from a default size); fall back after a moment.
  const reveal = () => { if (!win.isDestroyed() && !win.isVisible()) { win.show(); win.focus(); } };
  win.once('ready-to-show', () => setTimeout(reveal, 350));
  win.webContents.on('ipc-message', (_e, channel, h) => {
    if (channel !== 'confirm:resize' || !Number.isFinite(h) || win.isDestroyed()) { return; }
    win.setContentSize(440, Math.max(200, Math.min(720, Math.round(h))));
    reveal();
  });
  win.webContents.once('did-finish-load', () => {
    manager.probeInfo(id).then((info) => {
      if (!info || win.isDestroyed()) { return; }
      win.webContents.send('confirm:info', { ...info, suggestedDir: categoryDir(info.filename || info.url, info.kind) });
    }).catch(() => {});
  });
  win.on('closed', () => {
    const c = confirmWins.get(wcId);
    confirmWins.delete(wcId);
    if (c && !c.done) { manager.remove(id).catch(() => {}); } // closing the window = cancel
  });
}

/** IDM-style small window that follows one download. Closing it only hides it; the download keeps going. */
/** Brings the window to the front ONCE, then it is a normal window: switching to another app covers it.
 *  (Turning "always on top" on and straight off raises the window without keeping it above everything.) */
function popOnTop(win) {
  if (!settings.progressFloat || win.isDestroyed()) { return; }
  win.setAlwaysOnTop(true, 'floating');
  win.setAlwaysOnTop(false);
  win.moveTop();
}

function openProgress(id) {
  if (!settings.progressWindow || !manager.get(id)) { return; }
  const existing = progressByTask.get(id);
  if (existing && !existing.isDestroyed()) { popOnTop(existing); existing.show(); existing.focus(); return; }
  const n = progressByTask.size % 6;
  const win = new BrowserWindow(baseOptions({
    width: 440, height: 210, useContentSize: true, resizable: false, minimizable: true, maximizable: false,
    title: T('Đang tải'), x: undefined, y: undefined,
  }));
  win.setMenu(null);
  secureWindow(win);
  const wcId = win.webContents.id;
  progressWins.set(wcId, { id, win });
  progressByTask.set(id, win);
  win.loadFile(path.join(RENDERER, 'progress.html'), pageOpts()).catch(() => { if (!win.isDestroyed()) { win.close(); } });
  win.once('ready-to-show', () => {
    if (n) { const [x, y] = win.getPosition(); win.setPosition(x + n * 28, y + n * 28); }
    // Pop-up on: raised to the front once, without stealing keyboard focus. Off: a normal window, no raise.
    popOnTop(win);
    win.showInactive();
  });
  win.on('closed', () => { progressWins.delete(wcId); if (progressByTask.get(id) === win) { progressByTask.delete(id); } });
}

function broadcast(channel, data) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) { continue; }
    // Nobody looks at a hidden or minimized main window: skip its progress traffic (it resyncs when shown again).
    if (w === mainWin && (channel === 'dl:update' || channel === 'dl:added') && (!w.isVisible() || w.isMinimized())) { continue; }
    w.webContents.send(channel, data);
  }
}

function buildTrayMenu() {
  if (!tray) { return; }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: T('Mở Vexlo'), click: showMain },
    { label: T('Tạm dừng tất cả'), click: () => manager.pauseAll() },
    { label: T('Tiếp tục tất cả'), click: () => manager.resumeAll() },
    { type: 'separator' },
    { label: T('Thoát'), click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  const src = fs.existsSync(TRAY_ICON) ? TRAY_ICON : ICON;
  if (!fs.existsSync(src)) { return; }
  // A dedicated, simpler glyph stays readable at 16-24 px; Electron picks the right size for the display scale.
  tray = new Tray(nativeImage.createFromPath(src).resize({ width: 20, height: 20, quality: 'best' }));
  tray.setToolTip('Vexlo');
  buildTrayMenu();
  tray.on('click', showMain);
}

// ------------------------------------------------------------------ IPC

function appInfo() {
  return {
    version: VERSION, port: settings.port, token: settings.token, apiOk: !!api && !apiError, apiError, extensionDir: EXT_DIR,
    platform: process.platform, defaultDir: settings.downloadDir, justUpdated,
  };
}

const taskPath = (id) => manager.get(id)?.state.path || '';
const ids = (v) => (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string');

function registerIpc() {
  ipcMain.handle('dl:list', () => manager.list().filter((x) => !x.pending));
  ipcMain.handle('dl:add', (_e, o) => {
    const urls = (Array.isArray(o.urls) ? o.urls : []).map((u) => String(u).trim()).filter(Boolean);
    const out = []; const errors = [];
    for (const url of urls) {
      try {
        const kind = detectKind(url, o.kind);
        const name = urls.length === 1 && o.filename ? o.filename : undefined;
        const dir = o.dir || categoryDir(name || url, kind);
        out.push(manager.add({
          url, filename: name, dir, quality: o.quality, connections: Number(o.connections) || settings.connections, start: o.start !== false,
        }));
      } catch (err) { errors.push({ url, error: err.message }); }
    }
    return { ids: out, errors };
  });
  ipcMain.handle('dl:pause', (_e, v) => Promise.all(ids(v).map((id) => manager.pause(id))).then(() => true));
  ipcMain.handle('dl:resume', (_e, v) => { ids(v).forEach((id) => manager.resume(id)); return true; });
  ipcMain.handle('dl:remove', (_e, v, deleteFile) => Promise.all(ids(v).map((id) => manager.remove(id, { deleteFile: !!deleteFile }))).then(() => true));
  ipcMain.handle('dl:taskLimit', (_e, v, kb) => manager.setTaskLimit(ids(v), kb));
  ipcMain.handle('dl:prioritize', (_e, v, mode) => manager.prioritize(ids(v), mode === 'bottom' ? 'bottom' : 'top'));
  ipcMain.handle('dl:pauseAll', () => manager.pauseAll().then(() => true));
  ipcMain.handle('dl:resumeAll', () => { manager.resumeAll(); return true; });
  ipcMain.handle('dl:clearDone', async () => {
    for (const t of manager.list()) { if (t.status === 'done') { await manager.remove(t.id); } }
    return true;
  });
  ipcMain.handle('dl:open', async (_e, id) => {
    const p = taskPath(id);
    if (!p || !fs.existsSync(p)) { return T('Không tìm thấy tệp (có thể đã bị xóa hoặc di chuyển)'); }
    return (await shell.openPath(p)) || '';
  });
  ipcMain.handle('dl:showInFolder', (_e, id) => {
    const p = taskPath(id);
    const st = manager.get(id)?.state;
    if (p && fs.existsSync(p)) { shell.showItemInFolder(p); }
    else if (st && fs.existsSync(st.dir)) { shell.openPath(st.dir); }
    return true;
  });
  ipcMain.handle('dl:openPage', (_e, id) => {
    const t = manager.get(id);
    const page = t && t.state.meta && t.state.meta.page;
    if (page && /^https?:\/\//i.test(page)) { shell.openExternal(page); return true; }
    return false;
  });
  ipcMain.handle('dl:refresh', (_e, id) => {
    const t = manager.get(id);
    const page = t && t.state.meta && t.state.meta.page;
    if (!t || t.state.status !== 'error' || !page || !/^https?:\/\//i.test(page)) { return false; }
    refreshWanted.set(id, { page, kind: t.state.kind, at: Date.now() });
    // The marker in the address tells the extension this tab is a refresh: it plays the video by itself, sends the new link
    // and closes the tab. (Servers ignore the part after #.)
    shell.openExternal(stripHash(page) + '#vexlo-refresh');
    return true;
  });
  ipcMain.handle('dl:hash', async (e, id) => {
    const t = manager.get(id);
    const file = t && t.state.path;
    if (!file || !fs.existsSync(file)) { return false; }
    let expected = '';
    try { const c = clipboard.readText().trim().toLowerCase(); if (/^[0-9a-f]{64}$/.test(c)) { expected = c; } } catch { /* no clipboard */ }
    const hex = await new Promise((resolve) => {
      const h = crypto.createHash('sha256');
      fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', () => resolve('')).on('end', () => resolve(h.digest('hex')));
    });
    if (!hex) { return false; }
    clipboard.writeText(hex);
    const win = BrowserWindow.fromWebContents(e.sender) || undefined;
    const verdict = !expected ? T('Mã đã được chép vào clipboard. Muốn so khớp, hãy sao chép mã gốc của nhà phát hành rồi chọn lại mục này.')
      : expected === hex ? T('Khớp với mã trong clipboard: tệp nguyên vẹn.') : T('KHÔNG khớp với mã trong clipboard: tệp có thể bị lỗi hoặc bị thay đổi.');
    await dialog.showMessageBox(win, { type: expected && expected !== hex ? 'warning' : 'info', title: 'SHA-256', message: path.basename(file), detail: `${hex}\n\n${verdict}`, buttons: [T('Đóng')] });
    return true;
  });
  ipcMain.handle('dl:copyLink', (_e, id) => { const t = manager.get(id); if (t) { clipboard.writeText(t.state.url); } return true; });

  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', (_e, patch) => {
    const prev = settings;
    settings = clampSettings({ ...settings, ...patch });
    saveSettings();
    applySettings(prev);
    if (prev.language !== settings.language) {
      buildTrayMenu();
      if (mainWin && !mainWin.isDestroyed()) { mainWin.loadFile(path.join(RENDERER, 'index.html'), pageOpts()); }
    }
    broadcast('settings:changed', settings);
    return settings;
  });
  ipcMain.handle('app:info', () => appInfo());
  ipcMain.handle('update:check', () => checkUpdateNow());
  const releaseRepo = () => {
    const pub = ((require('../../package.json').build || {}).publish || [])[0] || {};
    return !pub.owner || /^YOUR_/.test(pub.owner) || !pub.repo ? null : pub;
  };
  ipcMain.handle('app:releaseNotes', () => {
    const pub = releaseRepo();
    if (!pub) { return false; }
    shell.openExternal(`https://github.com/${pub.owner}/${pub.repo}/releases/tag/v${VERSION}`);
    return true;
  });
  // The text of this version's GitHub release for the "What's new" window; null when it cannot be read.
  ipcMain.handle('app:whatsNew', async () => {
    const pub = releaseRepo();
    if (!pub) { return null; }
    try {
      const res = await net.fetch(`https://api.github.com/repos/${pub.owner}/${pub.repo}/releases/tags/v${VERSION}`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Vexlo' }, signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) { return null; }
      const j = await res.json();
      const text = plainNotes(j.body);
      return text ? { version: VERSION, text, url: j.html_url || '' } : null;
    } catch { return null; }
  });
  ipcMain.handle('app:exportLog', async (e) => {
    // One plain-text file the user can attach to a bug report. No pairing code and no download links in it.
    const lines = [];
    const safe = { ...settings, token: settings.token ? '(set)' : '' };
    lines.push(`Vexlo ${VERSION}`, `Electron ${process.versions.electron}, Chrome ${process.versions.chrome}, Node ${process.versions.node}`,
      `${process.platform} ${process.arch} ${require('os').release()}, locale ${app.getLocale()}, packaged ${app.isPackaged}`,
      `Browser connection: ${!!api && !apiError ? 'ready on port ' + settings.port : 'not ready ' + apiError}`, '', '== settings', JSON.stringify(safe, null, 2), '', '== downloads (status and error only)');
    const counts = {};
    for (const t of manager ? manager.list() : []) {
      counts[t.status] = (counts[t.status] || 0) + 1;
      if (t.status === 'error') { lines.push(`error: ${String(t.error || '').slice(0, 200)} (${t.kind})`); }
    }
    lines.push('count by status: ' + JSON.stringify(counts), '', '== update.log (last 200 lines)');
    try { lines.push(...fs.readFileSync(path.join(app.getPath('userData'), 'update.log'), 'utf8').split('\n').slice(-200)); } catch { lines.push('(no update.log)'); }
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('desktop'), `vexlo-log-${VERSION}.txt`), filters: [{ name: 'Text', extensions: ['txt'] }] });
    if (r.canceled || !r.filePath) { return ''; }
    fs.writeFileSync(r.filePath, lines.join('\n'), 'utf8');
    return r.filePath;
  });
  ipcMain.handle('update:status', () => updStatus);
  ipcMain.handle('update:install', () => { if (updater && updStatus.state === 'ready') { applyUpdateNow(); } return true; });
  ipcMain.handle('app:openExtensionFolder', () => shell.openPath(EXT_DIR));
  ipcMain.handle('dialog:chooseFolder', async (e, defaultPath) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: defaultPath || settings.downloadDir });
    return r.canceled ? '' : r.filePaths[0];
  });

  // confirmation window
  ipcMain.handle('confirm:get', (e) => {
    const c = confirmWins.get(e.sender.id);
    if (!c) { return null; }
    const t = manager.get(c.id);
    if (!t) { return null; }
    const snap = manager.snapshot(t);
    return { ...snap, suggestedDir: snap.dir, probing: true, replaced: !!c.replaced };
  });
  // "when everything is finished" + its countdown window
  ipcMain.handle('after:get', () => afterAll);
  ipcMain.handle('after:set', (_e, v) => setAfterAll(v));
  ipcMain.handle('after:countdown', (e) => (countdownWin && e.sender.id === countdownWin.webContents.id ? { action: afterAll, seconds: 60 } : null));
  ipcMain.handle('after:now', (e) => { if (countdownWin && e.sender.id === countdownWin.webContents.id) { runAfterAction(); } return true; });
  ipcMain.handle('after:cancel', (e) => {
    if (countdownWin && e.sender.id === countdownWin.webContents.id) { const w = countdownWin; setAfterAll('none'); if (!w.isDestroyed()) { w.close(); } }
    return true;
  });

  // progress window
  ipcMain.handle('progress:get', (e) => {
    const c = progressWins.get(e.sender.id);
    const t = c && manager.get(c.id);
    return t ? manager.snapshot(t) : null;
  });
  ipcMain.handle('progress:close', (e) => {
    const c = progressWins.get(e.sender.id);
    if (c && !c.win.isDestroyed()) { c.win.close(); }
    return true;
  });
  ipcMain.handle('confirm:check', (_e, o) => dupNote(String((o && o.filename) || ''), String((o && o.dir) || '')));
  ipcMain.handle('confirm:resolve', async (e, res) => {
    const c = confirmWins.get(e.sender.id);
    if (!c) { return false; }
    c.done = true;
    const action = res && res.action;
    if (action === 'cancel') { await manager.remove(c.id); }
    else {
      manager.update(c.id, { filename: res.filename, dir: res.dir, quality: res.quality, connections: res.connections });
      manager.confirm(c.id, { start: action === 'start' });
      if (action === 'start') { openProgress(c.id); }
    }
    if (res && res.dontAsk) { settings = clampSettings({ ...settings, confirm: false }); saveSettings(); broadcast('settings:changed', settings); }
    if (!c.win.isDestroyed()) { c.win.close(); }
    return true;
  });
}

// ------------------------------------------------------------------ download schedule + "when everything is finished"

const schedState = {};
function runSchedule() {
  if (!manager) { return; }
  applyLimit();
  const acts = dueActions(new Date(), {
    enabled: settings.scheduleEnabled, start: settings.scheduleStart, stop: settings.scheduleStop, days: settings.scheduleDays,
  }, schedState);
  for (const a of acts) {
    if (a === 'start') {
      let n = 0;
      for (const t of manager.list()) { if (!t.pending && t.status === 'paused') { manager.resume(t.id); n++; } }
      note(T('Lịch tải: bắt đầu'), n ? T('Đang tải {n} tệp đã hẹn.', { n }) : T('Không có tệp nào đang chờ.'));
    } else {
      manager.pauseAll();
      note(T('Lịch tải: đã dừng'), T('Các tệp đang tải được tạm dừng theo giờ đã hẹn.'));
    }
  }
}
function note(title, body) {
  if (settings.notify && Notification.isSupported()) { new Notification({ title, body, silent: true }).show(); }
}

const AFTER_ACTIONS = ['none', 'shutdown', 'sleep', 'hibernate', 'exit'];
let afterAll = 'none'; // chosen once; one single countdown appears when the LAST file has finished
let afterArmed = 0;    // downloads that finished since it was chosen (choosing it while idle must not fire at once)
let afterTimer = null;
let countdownWin = null;

function setAfterAll(v) {
  afterAll = AFTER_ACTIONS.includes(v) ? v : 'none';
  afterArmed = 0;
  clearTimeout(afterTimer);
  afterTimer = null;
  broadcast('after:changed', afterAll);
  return afterAll;
}
const stillBusy = () => manager.list().some((t) => !t.pending && (t.status === 'downloading' || t.status === 'queued'));

function checkAfterAll() {
  if (afterAll === 'none' || afterArmed === 0 || countdownWin || !manager) { return; }
  if (stillBusy()) { clearTimeout(afterTimer); afterTimer = null; return; }
  if (afterTimer) { return; }
  // Wait a moment: the next queued file may be about to start, and that must not trigger the action.
  afterTimer = setTimeout(() => { afterTimer = null; if (afterAll !== 'none' && !stillBusy()) { openCountdown(); } }, 4000);
}

function openCountdown() {
  if (countdownWin && !countdownWin.isDestroyed()) { return; }
  const win = new BrowserWindow(baseOptions({
    width: 400, height: 170, useContentSize: true, resizable: false, minimizable: false, maximizable: false, alwaysOnTop: true, title: 'Vexlo',
  }));
  win.setMenu(null);
  secureWindow(win);
  countdownWin = win;
  win.loadFile(path.join(RENDERER, 'countdown.html'), pageOpts()).catch(() => { runAfterAction(); });
  win.once('ready-to-show', () => { win.show(); win.focus(); });
  win.on('closed', () => { if (countdownWin === win) { countdownWin = null; if (!win.__acting) { setAfterAll('none'); } } }); // closing = cancel
}

function runAfterAction() {
  const action = afterAll;
  if (countdownWin && !countdownWin.isDestroyed()) { countdownWin.__acting = true; countdownWin.close(); }
  setAfterAll('none');
  if (action === 'exit') { quitting = true; app.quit(); return; }
  if (process.platform !== 'win32') { return; }
  if (action === 'shutdown') { execFile('shutdown', ['/s', '/t', '5'], { windowsHide: true }, () => {}); }
  else if (action === 'hibernate') { execFile('shutdown', ['/h'], { windowsHide: true }, () => {}); }
  else if (action === 'sleep') { execFile('rundll32.exe', ['powrprof.dll,SetSuspendState', '0', '1', '0'], { windowsHide: true }, () => {}); }
}

// ---- automatic retry when the network drops (Wi-Fi off, server restarting): try again later instead of staying failed
const retryState = new Map(); // id -> { n, timer }
const TRANSIENT = /ENOTFOUND|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EPIPE|socket hang up|timeout|ngắt sớm|HTTP 5\d\d|HTTP 429|HTTP 408/i;
const RETRY_DELAYS = [15, 30, 60, 120, 300, 300, 600, 600]; // seconds, then give up and leave the error visible

function maybeAutoRetry(s) {
  if (!manager || s.status !== 'error' || !TRANSIENT.test(String(s.error || ''))) { return; }
  const st = retryState.get(s.id) || { n: 0, timer: null };
  retryState.set(s.id, st);
  if (st.timer || st.n >= RETRY_DELAYS.length) { return; }
  const arm = (seconds) => {
    st.timer = setTimeout(() => {
      st.timer = null;
      const t = manager && manager.get(s.id);
      if (!t || !t.state || t.state.status !== 'error') { return; } // user paused/removed it or it recovered
      if (!net.isOnline()) { arm(10); return; } // still offline: look again soon without using up an attempt
      st.n++;
      manager.resume(s.id);
    }, seconds * 1000);
  };
  arm(RETRY_DELAYS[st.n]);
}
function forgetRetry(id) { const st = retryState.get(id); if (st && st.timer) { clearTimeout(st.timer); } retryState.delete(id); }

function wireManager() {
  const throttle = new Map();
  manager.on('update', (s) => {
    if (s.pending) { return; }
    const now = Date.now();
    if (s.status === 'downloading' && now - (throttle.get(s.id) || 0) < 200) { return; }
    throttle.set(s.id, now);
    broadcast('dl:update', s);
    if (s.status !== 'downloading') { checkAfterAll(); }
  });
  manager.on('added', (s) => { if (!s.pending) { broadcast('dl:added', s); } });
  manager.on('removed', (s) => { throttle.delete(s.id); forgetRetry(s.id); broadcast('dl:removed', s); checkAfterAll(); });
  manager.on('done', (s) => {
    forgetRetry(s.id);
    broadcast('dl:update', s);
    if (afterAll !== 'none') { afterArmed++; checkAfterAll(); }
    if (settings.notify && Notification.isSupported()) {
      const n = new Notification({ title: T('Đã tải xong'), body: s.filename, silent: false });
      n.on('click', () => { if (s.path) { shell.showItemInFolder(s.path); } });
      n.show();
    }
  });
  manager.on('error', (s) => { broadcast('dl:update', s); maybeAutoRetry(s); checkAfterAll(); });
  manager.on('warn', () => {});
}

// ------------------------------------------------------------------ lifecycle

/** The app used to be called ZapGet (earlier SwiftGet): carry its settings (and pairing code) and download list over once. */
function migrateOldData() {
  try {
    const dst = app.getPath('userData');
    const base = path.dirname(dst);
    if (fs.existsSync(path.join(dst, 'settings.json'))) { return; }
    for (const old of ['ZapGet', 'zapget', 'SwiftGet', 'swiftget']) {
      const src = path.join(base, old);
      if (src === dst || !fs.existsSync(path.join(src, 'settings.json'))) { continue; }
      fs.mkdirSync(dst, { recursive: true });
      for (const f of ['settings.json', 'downloads.json']) { if (fs.existsSync(path.join(src, f))) { fs.copyFileSync(path.join(src, f), path.join(dst, f)); } }
      return;
    }
  } catch { /* start fresh */ }
}

/** Updates come from the GitHub release of this project (see docs/PUBLISHING.md). Never fatal: no updater, no network, dev run. */
// ------------------------------------------------------------------ updates

function updLog(m) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'update.log'), `${new Date().toISOString()} ${m}\n`); } catch { /* ignore */ }
}

let updater = null;
let updStatus = { state: 'idle', version: '', message: '' }; // idle | checking | available | downloading | ready | latest | error | dev
function setUpd(patch) {
  updStatus = { ...updStatus, ...patch };
  broadcast('update:status', updStatus);
}

function getUpdater() {
  if (updater) { return updater; }
  const { autoUpdater } = require('electron-updater');
  // Everything the updater does is written to update.log (next to settings.json) so a failed update can be diagnosed.
  updLog(`running ${VERSION}`);
  const log = updLog;
  autoUpdater.on('checking-for-update', () => { log('checking'); setUpd({ state: 'checking', message: '' }); });
  autoUpdater.on('update-available', (i) => { log('update available: ' + i.version); setUpd({ state: 'downloading', version: i.version }); });
  autoUpdater.on('update-not-available', (i) => { log('no update (latest ' + i.version + ')'); setUpd({ state: 'latest', version: i.version }); });
  autoUpdater.on('download-progress', (p) => { setUpd({ state: 'downloading', message: String(Math.round(p.percent)) }); });
  autoUpdater.autoInstallOnAppQuit = false; // the app lives in the tray and never "quits" by itself: we install on our own below
  autoUpdater.on('update-downloaded', (i) => {
    log('downloaded ' + i.version);
    setUpd({ state: 'ready', version: i.version });
    if (settings.autoUpdate) { installWhenIdle(); }
  });
  autoUpdater.on('error', (e) => { const m = String(e && e.message || e).split('\n')[0]; log('ERROR: ' + m); setUpd({ state: 'error', message: m }); });
  updater = autoUpdater;
  return updater;
}

const UPDATED_FILE = () => path.join(app.getPath('userData'), 'updated.json');
let installTimer = null;
let installing = false;

/** Waits until nothing is downloading (a restart would interrupt it), then installs. Checks every 15 s. */
function installWhenIdle() {
  if (installTimer || installing) { return; }
  let logged = false;
  const tick = () => {
    const busy = manager && manager.list().some((t) => t.status === 'downloading' || t.status === 'queued');
    if (busy) { if (!logged) { updLog('waiting for active downloads to finish'); logged = true; } return; }
    clearInterval(installTimer);
    installTimer = null;
    applyUpdateNow();
  };
  installTimer = setInterval(tick, 15000);
  tick();
}

/** The app window disappears while the silent installer works: a tiny separate window (PowerShell) keeps saying so
 *  until the new Vexlo is running again, so nobody thinks the app crashed. Best effort: failures are ignored. */
function showInstallSplash(version) {
  if (process.platform !== 'win32') { return; }
  try {
    const ps1 = path.join(app.getPath('userData'), 'updating.ps1');
    fs.writeFileSync(ps1, [
      'param([string]$Title,[string]$Msg,[int]$OwnerPid,[string]$ProcName)',
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$f = New-Object System.Windows.Forms.Form',
      '$f.Text = $Title; $f.Size = New-Object System.Drawing.Size(400,130); $f.StartPosition = "CenterScreen"',
      '$f.FormBorderStyle = "FixedDialog"; $f.ControlBox = $false; $f.TopMost = $true; $f.ShowInTaskbar = $false',
      '$f.BackColor = [System.Drawing.Color]::FromArgb(27,30,34); $f.ForeColor = [System.Drawing.Color]::White',
      '$l = New-Object System.Windows.Forms.Label; $l.Text = $Msg; $l.Location = New-Object System.Drawing.Point(16,14); $l.Size = New-Object System.Drawing.Size(360,44)',
      '$f.Controls.Add($l)',
      '$b = New-Object System.Windows.Forms.ProgressBar; $b.Style = "Marquee"; $b.MarqueeAnimationSpeed = 30; $b.Location = New-Object System.Drawing.Point(16,68); $b.Size = New-Object System.Drawing.Size(360,14)',
      '$f.Controls.Add($b)',
      '$t0 = Get-Date',
      '$tm = New-Object System.Windows.Forms.Timer; $tm.Interval = 700',
      '$tm.Add_Tick({',
      '  $s = ((Get-Date) - $t0).TotalSeconds',
      '  $old = Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue',
      '  $new = Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $OwnerPid }',
      '  if (($s -gt 4 -and -not $old -and $new) -or $s -gt 240) { $tm.Stop(); $f.Close() }',
      '})',
      '$tm.Start()',
      '[void]$f.ShowDialog()',
    ].join('\r\n'), 'utf8');
    const child = require('child_process').spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1,
      '-Title', T('Cập nhật Vexlo'),
      '-Msg', T('Đang cài bản {v}. Vexlo sẽ tự mở lại sau khoảng một phút, bạn không cần làm gì.', { v: version }),
      '-OwnerPid', String(process.pid), '-ProcName', path.basename(process.execPath, '.exe'),
    ], { detached: true, stdio: 'ignore' }); // not windowsHide: that flag would hide the form as well; -WindowStyle Hidden hides the console
    child.unref();
  } catch { /* no splash: the update still installs */ }
}

/** Tells the user why the app is about to restart, stops the engine cleanly, then runs the installer silently. */
async function applyUpdateNow() {
  if (installing || !updater || updStatus.state !== 'ready') { return; }
  installing = true;
  const v = updStatus.version;
  updLog('installing ' + v);
  try { fs.writeFileSync(UPDATED_FILE(), JSON.stringify({ from: VERSION, to: v })); } catch { /* ignore */ }
  broadcast('update:restarting', { version: v });
  if (Notification.isSupported()) {
    new Notification({ title: T('Vexlo đang cập nhật'), body: T('Đang cập nhật lên bản {v}. Vexlo sẽ tự khởi động lại sau vài giây.', { v }), silent: true }).show();
  }
  await new Promise((ok) => setTimeout(ok, 4000)); // time to read the message
  try {
    if (manager) { const m = manager; await m.shutdown(); manager = null; }
    if (api) { await api.close().catch(() => {}); api = null; }
  } catch { /* going down anyway */ }
  quitting = true;
  showInstallSplash(v);
  updLog('quitAndInstall');
  updater.quitAndInstall(true, true); // silent installer (no wizard), start Vexlo again afterwards
}

/** After a restart caused by an update: remember it once so the window can say "updated to x". */
let justUpdated = null;
function readJustUpdated() {
  try {
    const j = JSON.parse(fs.readFileSync(UPDATED_FILE(), 'utf8'));
    fs.unlinkSync(UPDATED_FILE());
    if (j && j.to === VERSION) { justUpdated = j; }
  } catch { /* no update happened */ }
}

/** Manual "check for updates": resolves with the final state (latest / downloading / ready / error / dev). */
async function checkUpdateNow() {
  if (!app.isPackaged) { setUpd({ state: 'dev', message: '' }); return updStatus; }
  try {
    const u = getUpdater();
    const r = await u.checkForUpdates();
    if (r && r.updateInfo && updStatus.state === 'checking') { setUpd({ state: 'latest', version: r.updateInfo.version }); }
  } catch (e) { setUpd({ state: 'error', message: String(e && e.message || e).split('\n')[0] }); }
  return updStatus;
}

function startAutoUpdate() {
  if (!app.isPackaged || !settings.autoUpdate) { return; }
  try {
    const u = getUpdater();
    const check = () => { if (settings.autoUpdate) { u.checkForUpdates().catch(() => {}); } };
    setTimeout(check, 20000);
    setInterval(check, 4 * 3600 * 1000);
  } catch { /* electron-updater not installed */ }
}

function main() {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on('second-instance', (_e, argv) => { if (!(argv || []).includes('--hidden')) { showMain(); } });
  app.setAppUserModelId('dev.vexlo.app');
  Menu.setApplicationMenu(null);

  app.whenReady().then(async () => {
    migrateOldData();
    loadSettings();
    readJustUpdated();
    applyInstallerOptions();
    fs.mkdirSync(settings.downloadDir, { recursive: true });
    manager = new EngineClient({
      dataDir: app.getPath('userData'), downloadDir: settings.downloadDir, maxConcurrent: settings.maxConcurrent,
      connections: settings.connections, speedLimit: settings.speedLimitKB * 1024,
    });
    await manager.ready; // the engine process has loaded the saved downloads
    wireManager();
    registerIpc();
    registerNativeHost();
    applySettings(null);
    createTray();
    createMainWindow({ hidden: process.argv.includes('--hidden') && !!tray });
    app.on('activate', showMain);
    setInterval(runSchedule, 20000);
    startAutoUpdate();
  });

  app.on('before-quit', (e) => {
    if (quitting && !manager) { return; }
    quitting = true;
    if (manager) {
      e.preventDefault();
      const m = manager;
      manager = null;
      Promise.resolve()
        .then(() => m.shutdown())
        .then(() => (api ? api.close() : null))
        .catch(() => {})
        .finally(() => app.exit(0));
    }
  });
  // With "close to tray" the app stays alive without windows; otherwise closing the last window quits.
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' && (!tray || !settings.closeToTray)) { app.quit(); } });
}

main();
