'use strict';
/* Runs extension/background.js in a VM with a fake `browser` object, talking to the REAL local API server.
 * This verifies the extension logic (sniffing -> list -> send, download takeover, fallbacks) without Firefox. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { createApi } = require('../src/core/api');

const EXT = path.join(__dirname, '..', 'extension');
const read = (f) => fs.readFileSync(path.join(EXT, f), 'utf8');
const MB = 1024 * 1024;
const plain = (x) => JSON.parse(JSON.stringify(x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeManager() {
  const m = new EventEmitter();
  m.added = [];
  m.add = (opts) => { m.added.push(opts); return 'id' + m.added.length; };
  m.list = () => [];
  m.get = () => null;
  return m;
}

const opened = [];
test.after(async () => { for (const a of opened) { try { await a.close(); } catch { /* already closed */ } } });

async function startApp({ addImpl } = {}) {
  const manager = fakeManager();
  if (addImpl) { manager.add = addImpl; }
  const api = createApi(manager, { port: 0 });
  await api.listen();
  opened.push(api);
  return { manager, api };
}

// Firefox attaches "Origin: moz-extension://<uuid>" to cross-origin fetches made by an extension page.
const extFetch = (url, opts = {}) => fetch(url, { ...opts, headers: { origin: 'moz-extension://test-uuid', ...(opts.headers || {}) } });

async function loadBackground({ port, settings = {}, tabs = {}, cookies = [], native }) {
  const calls = { pause: [], resume: [], cancel: [], erase: [], badge: [], notify: [], menus: [] };
  const L = {}; // captured listeners
  const cap = (name) => ({ addListener: (fn) => { L[name] = fn; } });
  const browser = {
    storage: { local: { get: async (d) => ({ ...d, port, ...settings }) }, onChanged: { addListener() {} } },
    webRequest: { onBeforeSendHeaders: cap('beforeSend'), onHeadersReceived: cap('headers'), onCompleted: cap('completed'), onErrorOccurred: cap('error') },
    webNavigation: { onCommitted: cap('nav') },
    tabs: { get: async (id) => { if (!tabs[id]) { throw new Error('no tab'); } return { id, ...tabs[id] }; }, onRemoved: cap('tabRemoved') },
    browserAction: { setBadgeText: async (o) => { calls.badge.push(o); }, setBadgeBackgroundColor: async () => {} },
    downloads: {
      onCreated: cap('dlCreated'),
      pause: async (id) => { calls.pause.push(id); }, resume: async (id) => { calls.resume.push(id); },
      cancel: async (id) => { calls.cancel.push(id); }, erase: async (q) => { calls.erase.push(q.id); },
    },
    cookies: { getAll: async () => cookies },
    contextMenus: { removeAll: async () => {}, create: (o) => { calls.menus.push(o.id); }, onClicked: cap('menu') },
    notifications: { create: async (o) => { calls.notify.push(o.message); } },
    runtime: { getURL: (p) => 'moz-extension://x/' + p, onMessage: cap('message'), ...(native ? { sendNativeMessage: native } : {}) },
  };
  const sandbox = {
    browser, fetch: extFetch, AbortController, URL, console, setTimeout, clearTimeout, Promise, Map, Set, JSON, Date, Math, Error, Number, String, Object, Array, RegExp, encodeURIComponent, decodeURIComponent,
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const f of ['lib/i18n.js', 'lib/classify.js', 'lib/hlsinfo.js', 'background.js']) { vm.runInContext(read(f), sandbox, { filename: f }); }
  const send = (msg, sender = {}) => L.message(msg, sender);
  await sleep(25); // let loadSettings()/buildMenus() finish
  return { L, calls, send };
}

// helpers to simulate Firefox events
const reqHeaders = (h) => Object.entries(h).map(([name, value]) => ({ name, value }));
async function sniff(bg, { tabId = 5, requestId = 'r' + Math.random(), url, status = 200, resp = {}, req = {} }) {
  bg.L.beforeSend({ requestId, url, requestHeaders: reqHeaders(req) });
  bg.L.headers({ requestId, tabId, url, statusCode: status, method: 'GET', responseHeaders: reqHeaders(resp) });
  await sleep(30);
}

const TAB = { 5: { url: 'https://site.example/watch/42', title: 'Phim hay tập 1', incognito: false }, 6: { url: 'https://p.example/', title: 'Private', incognito: true } };

test('sniffed media appears in the tab list with forwarded cookie/referer/UA but without Range', async () => {
  const { api } = await startApp();
  const bg = await loadBackground({ port: api.port, tabs: TAB });
  await sniff(bg, {
    url: 'https://cdn.example/v/movie.mp4?tok=1', resp: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-99/7340032' }, status: 206,
    req: { cookie: 'sid=abc', referer: 'https://site.example/watch/42', 'user-agent': 'Firefox/132', range: 'bytes=0-99', 'x-other': 'no' },
  });
  const list = await bg.send({ type: 'getMedia' }, { tab: { id: 5 } });
  assert.equal(list.length, 1);
  assert.equal(list[0].size, 7340032);
  assert.equal(list[0].kind, 'file');
  assert.ok(!('headers' in list[0]), 'cookies must never be exposed to page-level code');
  assert.deepEqual(plain(bg.calls.badge.at(-1)), { tabId: 5, text: '1' });
  await api.close();
});

test('fragments, ads, incognito tabs and unknown tabs are ignored; seeking does not duplicate', async () => {
  const { api } = await startApp();
  const bg = await loadBackground({ port: api.port, tabs: TAB });
  await sniff(bg, { url: 'https://cdn.example/s/seg-1.ts', resp: { 'content-type': 'video/mp2t', 'content-length': String(2 * MB) } });
  await sniff(bg, { url: 'https://pubads.g.doubleclick.net/ad.mp4', resp: { 'content-type': 'video/mp4', 'content-length': String(5 * MB) } });
  await sniff(bg, { tabId: 6, url: 'https://cdn.example/secret.mp4', resp: { 'content-type': 'video/mp4', 'content-length': String(5 * MB) } });
  await sniff(bg, { tabId: -1, url: 'https://cdn.example/bg.mp4', resp: { 'content-type': 'video/mp4', 'content-length': String(5 * MB) } });
  assert.equal((await bg.send({ type: 'getMedia' }, { tab: { id: 5 } })).length, 0);
  assert.equal((await bg.send({ type: 'getMedia' }, { tab: { id: 6 } })).length, 0);
  await sniff(bg, { url: 'https://cdn.example/m.mp4?t=A&bytestart=0', resp: { 'content-type': 'video/mp4', 'content-length': String(9 * MB) } });
  await sniff(bg, { url: 'https://cdn.example/m.mp4?t=B&bytestart=500', resp: { 'content-type': 'video/mp4', 'content-length': String(9 * MB) } });
  const list = await bg.send({ type: 'getMedia' }, { tab: { id: 5 } });
  assert.equal(list.length, 1);
  assert.match(list[0].url, /t=B/, 'newest URL (freshest token) wins');
  await api.close();
});

test('navigating to a new page clears the list', async () => {
  const { api } = await startApp();
  const bg = await loadBackground({ port: api.port, tabs: TAB });
  await sniff(bg, { url: 'https://cdn.example/x.mp4', resp: { 'content-type': 'video/mp4', 'content-length': String(9 * MB) } });
  bg.L.nav({ tabId: 5, frameId: 1, transitionType: 'auto_subframe' });
  assert.equal((await bg.send({ type: 'getMedia' }, { tab: { id: 5 } })).length, 1, 'iframe navigation keeps it');
  bg.L.nav({ tabId: 5, frameId: 0, transitionType: 'link' });
  assert.equal((await bg.send({ type: 'getMedia' }, { tab: { id: 5 } })).length, 0);
  await api.close();
});

test('send: HLS item reaches the app with headers, page title as file name', async () => {
  const { api, manager } = await startApp();
  const bg = await loadBackground({ port: api.port, tabs: TAB });
  await sniff(bg, {
    url: 'https://cdn.example/p/master.m3u8', resp: { 'content-type': 'application/vnd.apple.mpegurl' },
    req: { cookie: 'sid=abc', referer: 'https://site.example/watch/42' },
  });
  const [m] = await bg.send({ type: 'getMedia' }, { tab: { id: 5 } });
  const r = await bg.send({ type: 'send', id: m.id }, { tab: { id: 5 } });
  assert.deepEqual(plain(r), { ok: true });
  assert.equal(manager.added.length, 1);
  const a = manager.added[0];
  assert.equal(a.url, 'https://cdn.example/p/master.m3u8');
  assert.equal(a.kind, 'hls');
  assert.equal(a.filename, 'Phim hay tập 1.mp4');
  assert.equal(a.headers.cookie, 'sid=abc');
  assert.equal(a.headers.referer, 'https://site.example/watch/42');
  await api.close();
});

test('send reports failure when the app is not running', async () => {
  const { api } = await startApp();
  const port = api.port;
  await api.close();
  const bg = await loadBackground({ port, tabs: TAB });
  await sniff(bg, { url: 'https://cdn.example/x.mp4', resp: { 'content-type': 'video/mp4', 'content-length': String(9 * MB) } });
  const [m] = await bg.send({ type: 'getMedia' }, { tab: { id: 5 } });
  const r = await bg.send({ type: 'send', id: m.id }, { tab: { id: 5 } });
  assert.equal(r.ok, false);
});

test('download takeover: paused, sent with cached cookie+referer, then removed from Firefox', async () => {
  const { api, manager } = await startApp();
  const bg = await loadBackground({ port: api.port, tabs: TAB });
  const url = 'https://files.example/dl/tool.zip?x=1';
  bg.L.beforeSend({ requestId: 'd1', url, requestHeaders: reqHeaders({ cookie: 'auth=zzz', referer: 'https://files.example/page', 'user-agent': 'FF' }) });
  await bg.L.dlCreated({ id: 41, url, finalUrl: url, filename: 'C:\\Users\\me\\Downloads\\tool.zip', referrer: 'https://files.example/page', incognito: false });
  assert.deepEqual(plain(bg.calls.pause), [41]);
  assert.deepEqual(plain(bg.calls.cancel), [41]);
  assert.deepEqual(plain(bg.calls.erase), [41]);
  assert.deepEqual(plain(bg.calls.resume), []);
  assert.equal(manager.added.length, 1);
  assert.equal(manager.added[0].url, url);
  assert.equal(manager.added[0].filename, 'tool.zip');
  assert.equal(manager.added[0].headers.cookie, 'auth=zzz');
  await api.close();
});

test('takeover falls back to the cookie jar when no request headers were captured', async () => {
  const { api, manager } = await startApp();
  const bg = await loadBackground({ port: api.port, tabs: TAB, cookies: [{ name: 'sid', value: '9' }, { name: 'pref', value: 'a' }] });
  await bg.L.dlCreated({ id: 7, url: 'https://x.example/f.bin', filename: '', incognito: false });
  assert.equal(manager.added[0].headers.cookie, 'sid=9; pref=a');
  assert.deepEqual(plain(bg.calls.cancel), [7]);
  await api.close();
});

test('takeover: app not running -> Firefox keeps the download (resumed, never cancelled)', async () => {
  const { api } = await startApp();
  const port = api.port;
  await api.close();
  const bg = await loadBackground({ port, tabs: TAB });
  await bg.L.dlCreated({ id: 3, url: 'https://x.example/f.bin', incognito: false });
  assert.deepEqual(plain(bg.calls.pause), [3]);
  assert.deepEqual(plain(bg.calls.resume), [3]);
  assert.deepEqual(plain(bg.calls.cancel), []);
});

test('takeover: app rejects the request -> download is resumed in Firefox, nothing lost', async () => {
  const { api } = await startApp({ addImpl: () => { throw new Error('boom'); } });
  const bg = await loadBackground({ port: api.port, tabs: TAB });
  await bg.L.dlCreated({ id: 8, url: 'https://x.example/f.bin', incognito: false });
  assert.deepEqual(plain(bg.calls.cancel), []);
  assert.deepEqual(plain(bg.calls.resume), [8]);
  await api.close();
});

test('takeover ignores old downloads from the browser history (finished, or started long ago)', async () => {
  const { api, manager } = await startApp();
  const bg = await loadBackground({ port: api.port, tabs: TAB });
  await bg.L.dlCreated({ id: 61, url: 'https://x.example/old-installer.exe', state: 'complete', startTime: new Date(Date.now() - 3 * 3600e3).toISOString() });
  await bg.L.dlCreated({ id: 62, url: 'https://x.example/old2.exe', state: 'in_progress', startTime: new Date(Date.now() - 3 * 3600e3).toISOString() });
  assert.equal(manager.added.length, 0);
  assert.deepEqual(plain(bg.calls.pause), []);
  await bg.L.dlCreated({ id: 63, url: 'https://x.example/new.exe', state: 'in_progress', startTime: new Date().toISOString() });
  assert.equal(manager.added.length, 1);
  await api.close();
});

test('takeover is skipped for incognito, non-http, excluded domains, tiny files and when disabled', async () => {
  const { api, manager } = await startApp();
  const mk = (settings) => loadBackground({ port: api.port, tabs: TAB, settings });
  let bg = await mk({});
  await bg.L.dlCreated({ id: 1, url: 'https://x.example/a.bin', incognito: true });
  await bg.L.dlCreated({ id: 2, url: 'blob:https://x.example/uuid' });
  await bg.L.dlCreated({ id: 3, url: 'data:text/plain,hi' });
  bg = await mk({ excludeDomains: 'bank.example\nfoo.test' });
  await bg.L.dlCreated({ id: 4, url: 'https://secure.bank.example/statement.pdf' });
  bg = await mk({ minTakeoverKB: 500 });
  await bg.L.dlCreated({ id: 5, url: 'https://x.example/small.bin', totalBytes: 10 * 1024 });
  bg = await mk({ takeover: false });
  await bg.L.dlCreated({ id: 6, url: 'https://x.example/b.bin' });
  bg = await mk({ enabled: false });
  await bg.L.dlCreated({ id: 9, url: 'https://x.example/c.bin' });
  assert.equal(manager.added.length, 0);
  await api.close();
});

test('context menu: link and media are sent to the app', async () => {
  const { api, manager } = await startApp();
  const bg = await loadBackground({ port: api.port, tabs: TAB });
  assert.deepEqual(plain(bg.calls.menus).sort(), ['sg-link', 'sg-media']);
  await bg.L.menu({ menuItemId: 'sg-link', linkUrl: 'https://x.example/file.7z', pageUrl: 'https://x.example/' }, { id: 5, url: 'https://x.example/', title: 'T' });
  await bg.L.menu({ menuItemId: 'sg-media', srcUrl: 'javascript:alert(1)', pageUrl: 'https://x.example/' }, { id: 5 });
  assert.equal(manager.added.length, 1);
  assert.equal(manager.added[0].headers.referer, 'https://x.example/');
  await api.close();
});

test('sendUrl fallback rejects non-http URLs', async () => {
  const { api, manager } = await startApp();
  const bg = await loadBackground({ port: api.port, tabs: TAB });
  assert.equal((await bg.send({ type: 'sendUrl', url: 'blob:https://x/abc' }, { tab: { id: 5, url: 'https://x/' } })).ok, false);
  assert.equal((await bg.send({ type: 'sendUrl', url: 'https://x/v.mp4' }, { tab: { id: 5, url: 'https://x/', title: 'x' } })).ok, true);
  assert.equal(manager.added.length, 1);
  await api.close();
});

// ---------------------------------------------------------------- IDM-style listing of HLS streams

const http = require('http');
async function playlistServer(files) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    hits.push(p);
    if (files[p] === undefined) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    return res.end(files[p]);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  opened.push({ close: () => new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); }) });
  return { base: 'http://127.0.0.1:' + srv.address().port, hits };
}
const M3U8 = { 'content-type': 'application/vnd.apple.mpegurl' };
const vodList = (n, secs) => '#EXTM3U\n#EXT-X-TARGETDURATION:10\n' + Array.from({ length: n }, (_, i) => `#EXTINF:${secs},\nseg${i}.ts\n`).join('') + '#EXT-X-ENDLIST\n';
const MASTER = '#EXTM3U\n' +
  '#EXT-X-STREAM-INF:BANDWIDTH=1593000,RESOLUTION=1280x720\nindex-v1-a1.m3u8\n' +
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480\nindex-v2-a1.m3u8\n';
const TRAILER = { 5: { url: 'https://site.example/watch/trailer', title: 'Trailer - Phim hay', incognito: false } };

test('master + its variant playlists show up as ONE entry with title, duration, quality and bitrate', async () => {
  const { api } = await startApp();
  const pl = await playlistServer({ '/master.m3u8': MASTER, '/index-v1-a1.m3u8': vodList(48, 10), '/index-v2-a1.m3u8': vodList(48, 10) });
  const bg = await loadBackground({ port: api.port, tabs: TRAILER });
  await sniff(bg, { url: pl.base + '/master.m3u8', resp: M3U8 });
  await sniff(bg, { url: pl.base + '/index-v1-a1.m3u8', resp: M3U8 });
  await sniff(bg, { url: pl.base + '/index-v2-a1.m3u8', resp: M3U8 });
  await sleep(200);
  // the player re-polls a variant later: still no second entry
  await sniff(bg, { url: pl.base + '/index-v1-a1.m3u8?again=1', resp: M3U8 });
  const list = plain(await bg.send({ type: 'getMedia' }, { tab: { id: 5 } }));
  assert.equal(list.length, 1, JSON.stringify(list.map((x) => x.url)));
  assert.equal(list[0].kind, 'hls');
  assert.equal(list[0].name, 'Trailer - Phim hay');
  assert.equal(list[0].meta, 'HLS stream, 8 min 0 sec, quality 720p HD, 1593 kbps');
  assert.ok(list[0].url.endsWith('/master.m3u8'), 'the master is what gets downloaded (best quality + audio chosen by the app)');
  await api.close();
});

test('a variant that was sniffed BEFORE its master is removed once the master is understood', async () => {
  const { api } = await startApp();
  const pl = await playlistServer({ '/master.m3u8': MASTER, '/index-v1-a1.m3u8': vodList(6, 10), '/index-v2-a1.m3u8': vodList(6, 10) });
  const bg = await loadBackground({ port: api.port, tabs: TRAILER });
  await sniff(bg, { url: pl.base + '/index-v1-a1.m3u8', resp: M3U8 });
  assert.equal((await bg.send({ type: 'getMedia' }, { tab: { id: 5 } })).length, 1);
  await sniff(bg, { url: pl.base + '/master.m3u8', resp: M3U8 });
  await sleep(200);
  const list = plain(await bg.send({ type: 'getMedia' }, { tab: { id: 5 } }));
  assert.equal(list.length, 1);
  assert.ok(list[0].url.endsWith('/master.m3u8'));
  await api.close();
});

test('a lone media playlist shows its duration; live and DRM streams are flagged', async () => {
  const { api } = await startApp();
  const pl = await playlistServer({
    '/vod.m3u8': vodList(30, 10),
    '/live.m3u8': '#EXTM3U\n#EXTINF:6,\na.ts\n#EXTINF:6,\nb.ts\n',
    '/drm.m3u8': '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k"\n#EXTINF:10,\na.ts\n#EXT-X-ENDLIST\n',
  });
  const bg = await loadBackground({ port: api.port, tabs: TRAILER });
  for (const f of ['vod', 'live', 'drm']) { await sniff(bg, { url: `${pl.base}/${f}.m3u8`, resp: M3U8 }); }
  await sleep(250);
  const by = Object.fromEntries(plain(await bg.send({ type: 'getMedia' }, { tab: { id: 5 } })).map((x) => [x.url.split('/').pop().replace('.m3u8', ''), x.meta]));
  assert.equal(by.vod, 'HLS stream, 5 min 0 sec');
  assert.equal(by.live, 'HLS stream, live');
  assert.equal(by.drm, 'HLS stream, 0 min 10 sec, DRM protected');
  await api.close();
});

test('an unreachable playlist stays listed (by page title) instead of vanishing', async () => {
  const { api } = await startApp();
  const pl = await playlistServer({});
  const bg = await loadBackground({ port: api.port, tabs: TRAILER });
  await sniff(bg, { url: pl.base + '/gone.m3u8', resp: M3U8 });
  await sleep(150);
  const list = plain(await bg.send({ type: 'getMedia' }, { tab: { id: 5 } }));
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Trailer - Phim hay');
  assert.equal(list[0].meta, 'HLS stream');
  await api.close();
});

test('sending the master passes the page title as file name and keeps cookie/referer', async () => {
  const added = [];
  const { api } = await startApp({ addImpl: (o) => { added.push(o); return 'id1'; } });
  const pl = await playlistServer({ '/master.m3u8': MASTER, '/index-v1-a1.m3u8': vodList(6, 10), '/index-v2-a1.m3u8': vodList(6, 10) });
  const bg = await loadBackground({ port: api.port, tabs: TRAILER });
  await sniff(bg, { url: pl.base + '/master.m3u8', resp: M3U8, req: { cookie: 'sid=1', referer: 'https://site.example/watch/trailer' } });
  await sleep(150);
  const r = await bg.send({ type: 'send', id: (await bg.send({ type: 'getMedia' }, { tab: { id: 5 } }))[0].id }, { tab: { id: 5 } });
  assert.equal(r.ok, true, r.error);
  assert.equal(added.length, 1);
  assert.equal(added[0].filename, 'Trailer - Phim hay.mp4');
  assert.equal(added[0].headers.cookie, 'sid=1');
  assert.equal(added[0].headers.referer, 'https://site.example/watch/trailer');
  await api.close();
});

// ---------------------------------------------------------------- error reporting: "app not running" must mean exactly that

test('an error INSIDE the app is reported with its real reason, not as "app not running"', async () => {
  const { api } = await startApp({ addImpl: () => { throw new Error('Thư mục lưu không ghi được'); } });
  const pl = await playlistServer({ '/m.m3u8': vodList(3, 10) });
  const bg = await loadBackground({ port: api.port, tabs: TRAILER });
  await sniff(bg, { url: pl.base + '/m.m3u8', resp: M3U8 });
  const id = (await bg.send({ type: 'getMedia' }, { tab: { id: 5 } }))[0].id;
  const r = plain(await bg.send({ type: 'send', id }, { tab: { id: 5 } }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'app-error');
  assert.match(r.error, /Thư mục lưu không ghi được/, 'the browser must be able to read the app\'s error message (CORS headers on errors)');
  await api.close();
});

test('only a real connection failure is reported as app-down', async () => {
  const { api } = await startApp();
  const port = api.port;
  const pl = await playlistServer({ '/m.m3u8': vodList(3, 10) });
  const bg = await loadBackground({ port, tabs: TRAILER });
  await sniff(bg, { url: pl.base + '/m.m3u8', resp: M3U8 });
  const id = (await bg.send({ type: 'getMedia' }, { tab: { id: 5 } }))[0].id;
  await api.close();
  const r = plain(await bg.send({ type: 'send', id }, { tab: { id: 5 } }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'app-down');
});

test('a slow first answer from the app (busy opening a window) is retried instead of reported as down', async () => {
  // A server that ignores the first ping for 2s, then behaves.
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    const reply = () => { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': req.headers.origin || '*' }); res.end(JSON.stringify({ app: 'Vexlo', ok: true })); };
    if (hits === 1) { setTimeout(reply, 2000); } else { reply(); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  opened.push({ close: () => new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); }) });
  const bg = await loadBackground({ port: srv.address().port, tabs: TRAILER });
  const st = plain(await bg.send({ type: 'status' }));
  assert.equal(st.ok, true, 'second attempt should succeed');
  assert.ok(hits >= 2);
});

test('API error replies carry CORS headers for the extension origin (otherwise Firefox hides the real error)', async () => {
  const { api } = await startApp({ addImpl: () => { throw new Error('boom'); } });
  const res = await fetch(`http://127.0.0.1:${api.port}/api/add`, {
    method: 'POST', headers: { origin: 'moz-extension://test-uuid', 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://x.example/a.zip' }),
  });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('access-control-allow-origin'), 'moz-extension://test-uuid');
  assert.equal((await res.json()).error, 'boom');
  // a web page origin still gets nothing
  const bad = await fetch(`http://127.0.0.1:${api.port}/api/add`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
  await api.close();
});

test('wrong pairing code and a vanished entry get their own readable messages, never "app not running"', async () => {
  const { api } = await startApp();
  // Drive the same API with a token requirement by hitting it as a non-extension client would be refused; here the extension has a wrong token
  // configured and the app answers 401 -> must surface as a readable error, not as app-down.
  const http2 = require('http');
  const srv = http2.createServer((req, res) => { res.writeHead(401, { 'content-type': 'application/json', 'access-control-allow-origin': req.headers.origin || '*' }); res.end('{"error":"token"}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  opened.push({ close: () => new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); }) });
  const pl = await playlistServer({ '/m.m3u8': vodList(3, 10) });
  const bg = await loadBackground({ port: srv.address().port, tabs: TRAILER });
  await sniff(bg, { url: pl.base + '/m.m3u8', resp: M3U8 });
  const id = (await bg.send({ type: 'getMedia' }, { tab: { id: 5 } }))[0].id;
  const wrong = plain(await bg.send({ type: 'send', id }, { tab: { id: 5 } }));
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'app-error');
  assert.match(wrong.error, /mã ghép nối|pairing code/i);
  const gone = plain(await bg.send({ type: 'send', id: 'does-not-exist' }, { tab: { id: 5 } }));
  assert.equal(gone.code, 'app-error');
  assert.match(gone.error, /gộp|merged/i);
  await api.close();
});

// ---------------------------------------------------------------- auto-launch (IDM-style)

test('app not running: the extension asks the native host to launch it, then sends the item', async () => {
  const manager = fakeManager();
  const api = createApi(manager, { port: 0, token: 'tok' });
  opened.push(api);
  const asked = [];
  // The "host" starts the app (listen) when it receives {cmd:'launch'} and returns the config.
  const native = async (name, msg) => {
    asked.push(msg.cmd);
    if (msg.cmd === 'launch') { setTimeout(() => api.listen().catch(() => {}), 300); }
    return { ok: true, port: 0, token: 'tok' };
  };
  // Pick a free port first so the extension can find the app once it "starts".
  const probe = createApi(fakeManager(), { port: 0 });
  await probe.listen();
  const port = probe.port;
  await probe.close();
  const real = createApi(manager, { port, token: 'tok' });
  opened.push(real);
  const native2 = async (name, msg) => {
    asked.push(msg.cmd);
    if (msg.cmd === 'launch') { setTimeout(() => real.listen().catch(() => {}), 300); }
    return { ok: true, port, token: 'tok' };
  };
  const bg = await loadBackground({ port, settings: { token: 'tok' }, tabs: TAB, native: native2 });
  const st = await bg.send({ type: 'status' });
  assert.equal(st.ok, true);
  assert.ok(asked.includes('launch'));
  await real.close();
  void native;
});

test('app not running and no host: still reported as not running (no hang)', async () => {
  const bg = await loadBackground({ port: 1, tabs: TAB, native: async () => { throw new Error('no host'); } });
  const t0 = Date.now();
  const st = await bg.send({ type: 'status' });
  assert.equal(st.ok, false);
  assert.ok(Date.now() - t0 < 20000);
});
