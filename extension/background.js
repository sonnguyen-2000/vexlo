/* Vexlo extension - background page (Firefox, Manifest V2).
 * 1. Sniffs media responses per tab (classification lives in lib/classify.js).
 * 2. Takes over browser downloads and forwards them, with cookies/referer, to the desktop app.
 * 3. Serves the floating button, popup and context menu. */
'use strict';

const DEFAULTS = {
  enabled: true,
  takeover: true,
  floating: true,
  port: 6877,
  token: '',
  excludeDomains: '',
  minMediaKB: 150,
  minTakeoverKB: 0,
};
let settings = { ...DEFAULTS };

const tabMedia = new Map();      // tabId -> Map(key -> item)
const reqInfo = new Map();       // requestId -> { headers, range }
const urlHeaders = new Map();    // url -> { headers, time }  (for download takeover)
const hlsChildren = new Map();   // tabId -> Set(key) of variant/audio playlists that belong to a master we already listed
const MAX_PER_TAB = 60;
const HEADER_TTL = 5 * 60 * 1000;

// ---------------------------------------------------------------- settings

async function loadSettings() {
  try { settings = { ...DEFAULTS, ...(await browser.storage.local.get(DEFAULTS)) }; } catch { settings = { ...DEFAULTS }; }
  buildMenus();
}
browser.storage.onChanged.addListener(() => { loadSettings(); });
let settingsReady = Promise.resolve();

function excluded(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return String(settings.excludeDomains || '').split(/\s+/).map((s) => s.trim().toLowerCase()).filter(Boolean)
    .some((d) => host === d || host.endsWith('.' + d));
}

// ---------------------------------------------------------------- app connection

function appUrl(path) { return `http://127.0.0.1:${settings.port}${path}`; }
function appHeaders(extra = {}) {
  const h = { ...extra };
  if (settings.token) { h['x-vexlo-token'] = settings.token; }
  return h;
}

let aliveCache = { at: 0, ok: false, version: '' };
async function pingOnce(timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(appUrl('/api/ping'), { headers: appHeaders(), signal: ctl.signal, cache: 'no-store' });
    // The app is there but refuses us (wrong pairing code): that is not "app not running".
    if (res.status === 401 || res.status === 403) { return { ok: false, version: '', reason: 'unauthorized' }; }
    const j = res.ok ? await res.json() : null;
    return { ok: !!(j && j.app === 'Vexlo'), version: j?.version || '' };
  } catch { return { ok: false, version: '' }; } finally { clearTimeout(timer); }
}

/** Ask the installed app (native messaging) for this PC's port + pairing code, so the user never types a code.
 *  Each PC has its own random code, so a browser can only be paired with the app on the same PC. */
let lastPair = 0;
async function pairWithApp(force = false) {
  if (!browser.runtime || typeof browser.runtime.sendNativeMessage !== 'function') { return false; }
  if (!force && Date.now() - lastPair < 5000) { return false; }
  lastPair = Date.now();
  try {
    const r = await browser.runtime.sendNativeMessage('dev.vexlo.host', { cmd: 'config' });
    if (r && r.ok && r.token && (r.token !== settings.token || r.port !== settings.port)) {
      settings.token = r.token;
      settings.port = r.port;
      await browser.storage.local.set({ token: r.token, port: r.port });
      return true;
    }
  } catch { /* host not installed: manual code in options still works */ }
  return false;
}

async function appStatus(force = false) {
  if (!force && Date.now() - aliveCache.at < 3000) { return aliveCache; }
  // One retry with a longer timeout: the app can be busy for a moment (opening a window, just started) without being down.
  let r = await pingOnce(1500);
  if (!r.ok && await pairWithApp()) { r = await pingOnce(1500); } // new code from the app on this PC? try again
  if (!r.ok) { r = await pingOnce(3500); }
  if (!r.ok) { r = await pingOnce(10000); } // a busy app can need several seconds: do not call it "not running" too early
  aliveCache = { at: Date.now(), ...r };
  return aliveCache;
}

/** Error with a machine-readable code: 'app-down' (cannot connect) or 'app-error' (the app answered with a failure). */
function appError(code, message) { return Object.assign(new Error(message || code), { code }); }

async function sendToApp(items, { show = false } = {}) {
  let res;
  try {
    res = await fetch(appUrl('/api/add'), {
      method: 'POST',
      headers: appHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ items, show }),
    });
  } catch { throw appError('app-down', 'app-down'); }
  if (res.status === 401 || res.status === 403) { throw appError('app-error', t('errToken')); }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch { /* body not JSON */ }
    throw appError('app-error', detail || ('HTTP ' + res.status));
  }
  return res.json();
}

// ---------------------------------------------------------------- request header capture

function pickHeaders(list) {
  const out = {};
  for (const h of list || []) {
    const n = h.name.toLowerCase();
    if (n === 'cookie' || n === 'referer' || n === 'user-agent' || n === 'authorization' || n === 'origin' || n === 'range') { out[n] = h.value; }
  }
  return out;
}

browser.webRequest.onBeforeSendHeaders.addListener((d) => {
  const headers = pickHeaders(d.requestHeaders);
  reqInfo.set(d.requestId, headers);
  const { range, ...forward } = headers;
  urlHeaders.set(d.url, { headers: forward, time: Date.now() });
  if (urlHeaders.size > 600) {
    const cutoff = Date.now() - HEADER_TTL;
    for (const [k, v] of urlHeaders) { if (v.time < cutoff || urlHeaders.size > 500) { urlHeaders.delete(k); } }
  }
}, { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame', 'media', 'xmlhttprequest', 'object', 'other'] }, ['requestHeaders', ...(globalThis.SG_EXTRA_HEADERS || [])]);

const forget = (d) => { reqInfo.delete(d.requestId); };
browser.webRequest.onCompleted.addListener(forget, { urls: ['<all_urls>'] });
browser.webRequest.onErrorOccurred.addListener(forget, { urls: ['<all_urls>'] });

// ---------------------------------------------------------------- sniffing

function getHeader(list, name) {
  const n = name.toLowerCase();
  const h = (list || []).find((x) => x.name.toLowerCase() === n);
  return h ? h.value : '';
}

browser.webRequest.onHeadersReceived.addListener((d) => {
  if (!settings.enabled || d.tabId < 0) { return; }
  const c = SGClassify.classify({
    url: d.url, status: d.statusCode, method: d.method, mime: getHeader(d.responseHeaders, 'content-type'),
    contentLength: getHeader(d.responseHeaders, 'content-length'), contentRange: getHeader(d.responseHeaders, 'content-range'),
  }, { minFileSize: settings.minMediaKB * 1024 });
  if (!c) { return; }
  const sent = reqInfo.get(d.requestId) || {};
  addMedia(d.tabId, d, c, sent);
}, { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame', 'media', 'xmlhttprequest', 'object', 'other'] }, ['responseHeaders']);

async function addMedia(tabId, d, c, sent) {
  // A variant / audio playlist of a master we already know is part of that one entry, not a video of its own.
  if (hlsChildren.get(tabId)?.has(c.key)) { return; }
  let tab = null;
  try { tab = await browser.tabs.get(tabId); } catch { return; }
  if (!tab || tab.incognito) { return; }
  let map = tabMedia.get(tabId);
  if (!map) { map = new Map(); tabMedia.set(tabId, map); }
  const { range, ...forward } = sent;
  if (!forward.referer && tab.url) { forward.referer = tab.url; }
  const prev = map.get(c.key);
  const item = {
    id: c.key, url: d.url, kind: c.kind, ext: c.ext, mime: c.mime, size: c.size || prev?.size || 0, audioOnly: c.audioOnly,
    title: tab.title || '', page: tab.url || '', headers: forward, time: prev?.time || Date.now(),
    frameId: d.frameId, info: prev?.info || null,
  };
  map.delete(c.key); // re-insert to keep newest-last ordering
  map.set(c.key, item);
  while (map.size > MAX_PER_TAB) { map.delete(map.keys().next().value); }
  updateBadge(tabId);
  if (item.kind === 'hls' && !item.info && !item.inspecting) { inspectHls(tabId, item); }
}

// ---------------------------------------------------------------- playlist inspection (name / duration / quality like IDM)

const INSPECT_TIMEOUT = 8000;
const INSPECT_MAX_BYTES = 2 * 1024 * 1024;

async function fetchPlaylistText(url, item) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), INSPECT_TIMEOUT);
  try {
    const res = await fetch(url, { credentials: 'include', cache: 'no-store', signal: ctl.signal });
    if (!res.ok) { throw new Error('http ' + res.status); }
    const text = await res.text();
    if (text.length > INSPECT_MAX_BYTES) { throw new Error('too big'); }
    return text;
  } catch (err) {
    // Some CDNs only answer with the page's own Origin/Referer/cookies: ask the frame that made the request.
    if (item && item.tabId !== undefined && browser.tabs && browser.tabs.sendMessage) {
      try {
        const r = await browser.tabs.sendMessage(item.tabId, { type: 'fetchText', url }, item.frameId >= 0 ? { frameId: item.frameId } : undefined);
        if (r && r.ok && typeof r.text === 'string') { return r.text; }
      } catch { /* frame gone or no content script */ }
    }
    throw err;
  } finally { clearTimeout(timer); }
}

async function inspectHls(tabId, item) {
  item.inspecting = true;
  item.tabId = tabId;
  const stillThere = () => tabMedia.get(tabId)?.get(item.id) === item;
  try {
    if (typeof SGHlsInfo === 'undefined') { return; }
    const pl = SGHlsInfo.parsePlaylist(await fetchPlaylistText(item.url, item), item.url);
    if (!pl || !stillThere()) { return; }
    let info;
    if (pl.type === 'master') {
      const best = SGHlsInfo.pickBest(pl.variants);
      // Variant and audio playlists are parts of this video: hide them (also those that arrived before we parsed this one).
      const kids = hlsChildren.get(tabId) || new Set();
      hlsChildren.set(tabId, kids);
      const map = tabMedia.get(tabId);
      for (const child of [...pl.variants, ...pl.audios]) {
        const key = SGClassify.mediaKey(child.url, 'hls', 0);
        if (key === item.id) { continue; }
        kids.add(key);
        if (map) { map.delete(key); }
      }
      info = best ? { height: best.height, width: best.width, bandwidth: best.bandwidth, variants: pl.variants.length } : {};
      if (best) {
        try {
          const vp = SGHlsInfo.parsePlaylist(await fetchPlaylistText(best.url, item), best.url);
          if (vp && vp.type === 'media') { info.duration = vp.duration; info.live = !vp.endlist; info.drm = vp.drm; }
        } catch { /* duration stays unknown */ }
      }
    } else {
      info = { duration: pl.duration, live: !pl.endlist, drm: pl.drm };
    }
    if (!stillThere()) { return; }
    item.info = info;
    // The tab title is often only set after the player starts; refresh it so the name is the video's.
    try { const tab = await browser.tabs.get(tabId); if (tab && tab.title) { item.title = tab.title; } } catch { /* tab closed */ }
    updateBadge(tabId);
  } catch { /* leave the entry without details */ }
  finally { item.inspecting = false; }
}

function updateBadge(tabId) {
  const n = tabMedia.get(tabId)?.size || 0;
  browser.browserAction.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
  if (n) { browser.browserAction.setBadgeBackgroundColor({ tabId, color: '#1f9d55' }).catch(() => {}); }
}

// Clear the list when the tab navigates to a new page (not for iframes / same-page changes).
browser.webNavigation?.onCommitted?.addListener?.((d) => {
  if (d.frameId === 0 && d.transitionType !== 'auto_subframe') { tabMedia.delete(d.tabId); hlsChildren.delete(d.tabId); updateBadge(d.tabId); }
});
browser.tabs.onRemoved.addListener((id) => { tabMedia.delete(id); hlsChildren.delete(id); });

const hlsLabels = () => ({
  hls: t('hlsStream'), dash: t('dashStream'), fileWord: t('fileWord'), quality: t('qualityWord'), live: t('liveWord'), drm: t('drmWord'),
  units: { h: t('unitH'), m: t('unitMin'), s: t('unitSec') }, size: (n) => fmtSize(n),
});

function listFor(tabId) {
  const map = tabMedia.get(tabId);
  if (!map) { return []; }
  const labels = hlsLabels();
  return [...map.values()].reverse().map((i) => ({
    id: i.id, url: i.url, kind: i.kind, ext: i.ext, size: i.size, audioOnly: i.audioOnly, title: i.title, time: i.time,
    name: SGClassify.displayName(i, i.title),
    meta: typeof SGHlsInfo !== 'undefined' ? SGHlsInfo.describe(i, labels) : '',
  }));
}

function toAppItem(item) {
  return {
    url: item.url, kind: item.kind === 'file' ? 'file' : item.kind, headers: item.headers, page: item.page, title: item.title,
    filename: SGClassify.suggestName(item, item.title) || undefined,
  };
}

async function sendMediaItem(tabId, id) {
  await (globalThis.SGReady || Promise.resolve());
  const item = tabMedia.get(tabId)?.get(id);
  if (!item) { throw appError('app-error', t('errGone')); }
  // No separate ping first: the request itself waits for a busy app and reports 'app-down' only when it cannot connect at all.
  await sendToApp([toAppItem(item)]);
}

// ---------------------------------------------------------------- download takeover

const handled = new Set();

// Why a download was or was not taken over is logged to the extension console ("[Vexlo]"), so a missed download can be explained.
const dbg = (...a) => { try { console.info('[Vexlo]', ...a); } catch { /* no console */ } };
let lastTakeoverNotice = 0;
function noticeOnce(message) {
  if (Date.now() - lastTakeoverNotice < 20000) { return; }
  lastTakeoverNotice = Date.now();
  notify(message);
}

browser.downloads.onCreated.addListener(async (item) => {
  try {
    await settingsReady; // a download that fires right at browser start must still honour the user's settings
    const url = item.finalUrl || item.url;
    if (!settings.enabled || !settings.takeover) { dbg('download left to the browser: takeover is off', url); return; }
    if (item.incognito) { dbg('download left to the browser: private window', url); return; }
    if (handled.has(item.id)) { return; }
    // Firefox also reports downloads from earlier sessions (the history) when the extension starts: only take over NEW ones.
    if (item.state && item.state !== 'in_progress') { dbg('download left alone: already finished or stopped (history)', item.state, url); return; }
    const startedAt = Date.parse(item.startTime || '');
    if (Number.isFinite(startedAt) && Date.now() - startedAt > 60 * 1000) { dbg('download left alone: started long ago (history)', url); return; }
    if (!/^https?:\/\//i.test(url)) { dbg('download left to the browser: not an http(s) link (blob:/data:/file:)', String(url).slice(0, 80)); return; }
    if (excluded(url)) { dbg('download left to the browser: domain is excluded in options', url); return; }
    if (settings.minTakeoverKB > 0 && item.totalBytes > 0 && item.totalBytes < settings.minTakeoverKB * 1024) { dbg('download left to the browser: smaller than the minimum size', url); return; }
    handled.add(item.id);
    try { await browser.downloads.pause(item.id); } catch { /* may already be finishing */ }
    const st = await appStatus(true);
    if (!st.ok) {
      dbg('download left to the browser: Vexlo is not reachable', st.reason || '', url);
      try { await browser.downloads.resume(item.id); } catch { /* ignore */ }
      noticeOnce(st.reason === 'unauthorized' ? t('errToken') : t('noApp'));
      return;
    }
    const cached = urlHeaders.get(item.finalUrl)?.headers || urlHeaders.get(item.url)?.headers || {};
    const headers = { ...cached };
    if (!headers.referer && item.referrer) { headers.referer = item.referrer; }
    if (!headers.cookie) {
      try {
        const cookies = await browser.cookies.getAll({ url });
        if (cookies.length) { headers.cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; '); }
      } catch { /* cookies unavailable */ }
    }
    const base = item.filename ? item.filename.split(/[\\/]/).pop() : '';
    await sendToApp([{ url, headers, filename: base || undefined, page: item.referrer || '' }], { show: true });
    dbg('download handed to Vexlo', url);
    try { await browser.downloads.cancel(item.id); } catch { /* ignore */ }
    // Firefox keeps the half-written "name.part" (and an empty placeholder file) of a cancelled download: remove them too.
    try { await browser.downloads.removeFile(item.id); } catch { /* nothing to remove, or not supported for unfinished downloads */ }
    try { await browser.downloads.erase({ id: item.id }); } catch { /* ignore */ }
  } catch (err) {
    // Anything unexpected: never lose the user's download, but say why the browser kept it.
    dbg('takeover failed, the browser keeps the download:', err && err.message);
    try { await browser.downloads.resume(item.id); } catch { /* ignore */ }
    noticeOnce(err && err.message ? err.message : t('noApp'));
  }
});

// ---------------------------------------------------------------- context menu

function buildMenus() {
  browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({ id: 'sg-link', title: t('menuLink'), contexts: ['link'] });
    browser.contextMenus.create({ id: 'sg-media', title: t('menuMedia'), contexts: ['video', 'audio'] });
  }).catch(() => {});
}

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.menuItemId === 'sg-link' ? info.linkUrl : info.srcUrl;
  if (!url || !/^https?:\/\//i.test(url)) { return; }
  try {
    const st = await appStatus(true);
    if (!st.ok) { notify(t('noApp')); return; }
    const cached = urlHeaders.get(url)?.headers || {};
    const headers = { ...cached, referer: cached.referer || info.pageUrl || tab?.url || '' };
    await sendToApp([{ url, headers, page: info.pageUrl || '', title: tab?.title || '' }], { show: true });
  } catch { notify(t('noApp')); }
});

function notify(message) {
  browser.notifications.create({ type: 'basic', iconUrl: browser.runtime.getURL(globalThis.SG_ICON || 'icons/icon.svg'), title: 'Vexlo', message }).catch(() => {});
}

// ---------------------------------------------------------------- messages from content script / popup

browser.runtime.onMessage.addListener((msg, sender) => {
  const tabId = msg.tabId ?? sender.tab?.id;
  switch (msg.type) {
    case 'getSettings': return Promise.resolve({ floating: settings.floating && settings.enabled });
    case 'status': return appStatus(true);
    case 'getMedia': return (globalThis.SGReady || Promise.resolve()).then(() => listFor(tabId));
    case 'send':
      return sendMediaItem(tabId, msg.id).then(() => ({ ok: true }), (e) => ({ ok: false, error: e.message, code: e.code || '' }));
    case 'sendUrl': {
      // Fallback for a plain <video src> that was not seen by the sniffer.
      return (async () => {
        if (!/^https?:\/\//i.test(msg.url || '')) { return { ok: false, error: 'bad-url' }; }
        const st = await appStatus(true);
        if (!st.ok) { return { ok: false, error: 'app-down', code: 'app-down' }; }
        const cached = urlHeaders.get(msg.url)?.headers || {};
        const headers = { ...cached, referer: cached.referer || sender.tab?.url || '' };
        await sendToApp([{ url: msg.url, headers, page: sender.tab?.url || '', title: sender.tab?.title || '' }]);
        return { ok: true };
      })().catch((e) => ({ ok: false, error: e.message, code: e.code || '' }));
    }
    case 'clear': tabMedia.delete(tabId); updateBadge(tabId); return Promise.resolve({ ok: true });
    default: return undefined;
  }
});

settingsReady = loadSettings().then(() => pairWithApp(true));
