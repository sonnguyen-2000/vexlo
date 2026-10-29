'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
  app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, clipboard, Notification, nativeImage, nativeTheme,
} = require('electron');
const { detectKind } = require('../core/manager');
const { EngineClient } = require('../core/engine-client');
const { createApi } = require('../core/api');
const { folderFor } = require('../core/category');
const { findDuplicate } = require('../core/dupes');
const { uniquePath } = require('../core/util');
const { dueActions } = require('../core/schedule');
const { execFile } = require('child_process');
const I18N = require('../renderer/i18n');

const VERSION = require('../../package.json').version;
const RENDERER = path.join(__dirname, '..', 'renderer');
const ICON = path.join(__dirname, '..', '..', 'build', 'icon.png');
const TRAY_ICON = path.join(__dirname, '..', '..', 'build', 'tray.png');
const EXT_DIR = app.isPackaged ? path.join(process.resourcesPath, 'extension') : path.join(__dirname, '..', '..', 'extension');

const DEFAULTS = {
  downloadDir: '', categorize: true, maxConcurrent: 2, connections: 8, speedLimitKB: 0, confirm: true,
  closeToTray: true, startWithOS: false, notify: true, port: 6877, token: '', deleteMode: 'ask',
  progressWindow: true, progressFloat: true, progressAutoClose: true, progressOnError: 'ask',
  scheduleEnabled: false, scheduleStart: '01:00', scheduleStop: '', scheduleDays: [0, 1, 2, 3, 4, 5, 6],
  autoUpdate: true, language: 'auto',
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
    deleteMode: ['ask', 'list', 'files'].includes(s.deleteMode) ? s.deleteMode : 'ask',
    port: n(s.port, 1024, 65535, DEFAULTS.port),
    token: typeof s.token === 'string' && s.token ? s.token : crypto.randomBytes(12).toString('hex'),
  };
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

function applySettings(prev) {
  manager.downloadDir = settings.downloadDir;
  manager.connections = settings.connections;
  manager.setMaxConcurrent(settings.maxConcurrent);
  manager.setSpeedLimit(settings.speedLimitKB * 1024);
  try { app.setLoginItemSettings({ openAtLogin: settings.startWithOS, args: ['--hidden'] }); } catch { /* unsupported platform */ }
  if (!prev || prev.port !== settings.port || prev.token !== settings.token) { startApi(); }
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
    onAdd: handleExternalAdd, onShowWindow: () => {}, getSettings: () => ({ confirm: settings.confirm }),
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
function handleExternalAdd(items) {
  const ask = settings.confirm && items.length <= 3;
  return items.map((it) => {
    const kind = detectKind(it.url, it.kind);
    const dir = categoryDir(it.filename || it.url, kind);
    const dup = findDuplicate(manager.list(), { url: it.url, filename: it.filename, dir, page: it.page, kind }, { exists: fs.existsSync });
    if (dup && dup.type === 'active') { notifyDuplicate(dup.task); return dup.task.id; } // already in the list: never download twice
    const replaceId = dup && dup.type === 'error' ? dup.task.id : undefined; // failed before: replace it, keep the plain name
    const filename = it.filename || (replaceId ? dup.task.filename : undefined);
    const id = manager.add({
      ...it, filename, replaceId, dir, connections: settings.connections, start: !ask, pending: ask,
    });
    if (ask) { openConfirm(id, { replaced: !!replaceId }); } else if (items.length <= 3) { openProgress(id); }
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
  mainWin.on('close', (e) => {
    if (!quitting && settings.closeToTray && tray) { e.preventDefault(); mainWin.hide(); }
  });
  mainWin.on('closed', () => { mainWin = null; });
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
function openProgress(id) {
  if (!settings.progressWindow || !manager.get(id)) { return; }
  const existing = progressByTask.get(id);
  if (existing && !existing.isDestroyed()) { existing.setAlwaysOnTop(!!settings.progressFloat, 'floating'); existing.show(); existing.focus(); return; }
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
    // Floating: stays above other apps without stealing keyboard focus. Quiet: a normal window that can sit behind others.
    if (settings.progressFloat) { win.setAlwaysOnTop(true, 'floating'); }
    win.showInactive();
  });
  win.on('closed', () => { progressWins.delete(wcId); if (progressByTask.get(id) === win) { progressByTask.delete(id); } });
}

function broadcast(channel, data) {
  for (const w of BrowserWindow.getAllWindows()) { if (!w.isDestroyed()) { w.webContents.send(channel, data); } }
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
    platform: process.platform, defaultDir: settings.downloadDir,
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
  manager.on('removed', (s) => { throttle.delete(s.id); broadcast('dl:removed', s); checkAfterAll(); });
  manager.on('done', (s) => {
    broadcast('dl:update', s);
    if (afterAll !== 'none') { afterArmed++; checkAfterAll(); }
    if (settings.notify && Notification.isSupported()) {
      const n = new Notification({ title: T('Đã tải xong'), body: s.filename, silent: false });
      n.on('click', () => { if (s.path) { shell.showItemInFolder(s.path); } });
      n.show();
    }
  });
  manager.on('error', (s) => { broadcast('dl:update', s); checkAfterAll(); });
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
function startAutoUpdate() {
  if (!app.isPackaged || !settings.autoUpdate) { return; }
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.on('error', () => {});
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    setInterval(() => { if (settings.autoUpdate) { autoUpdater.checkForUpdatesAndNotify().catch(() => {}); } }, 6 * 3600 * 1000);
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
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !tray) { app.quit(); } });
}

main();
