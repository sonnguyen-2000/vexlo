'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createServer, listen, sha } = require('./server');
const { DownloadManager } = require('../src/core/manager');
const { createApi } = require('../src/core/api');
const { sleep } = require('../src/core/util');

let src; let base; let tmp; let mgr; let api; let apiBase;
const TOKEN = 'secret-token';

function call(method, p, { body, headers = {}, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: api.port, path: p, method,
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...(host ? { host } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('error', reject);
    if (data) { req.write(data); }
    req.end();
  });
}
const EXT = { origin: 'moz-extension://abc-123' };

test.before(async () => {
  src = createServer();
  base = 'http://127.0.0.1:' + await listen(src.server);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlo-api-'));
  mgr = new DownloadManager({ dataDir: path.join(tmp, 'data'), downloadDir: path.join(tmp, 'dl'), maxConcurrent: 2 });
  api = createApi(mgr, { port: 0, token: TOKEN });
  await api.listen();
  apiBase = 'http://127.0.0.1:' + api.port;
});
test.after(async () => {
  await mgr.shutdown();
  await api.close();
  src.server.close(); src.server.closeAllConnections?.();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('web pages (foreign Origin) and bad Host headers are rejected', async () => {
  assert.equal((await call('GET', '/api/ping', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('GET', '/api/ping', { headers: EXT, host: 'evil.example' })).status, 403);
  assert.equal((await call('GET', '/api/ping', { headers: EXT, host: 'evil.example:' + api.port })).status, 403);
});

test('requests without Origin need the token', async () => {
  assert.equal((await call('GET', '/api/ping')).status, 401);
  assert.equal((await call('GET', '/api/ping', { headers: { 'x-vexlo-token': 'wrong' } })).status, 401);
  assert.equal((await call('GET', '/api/ping', { headers: { 'x-vexlo-token': TOKEN } })).status, 200);
});

test('extension origin gets CORS headers and preflight works', async () => {
  const r = await call('GET', '/api/ping', { headers: EXT });
  assert.equal(r.status, 200);
  assert.equal(r.headers['access-control-allow-origin'], EXT.origin);
  assert.equal(r.json.app, 'Vexlo');
  const pre = await call('OPTIONS', '/api/add', { headers: EXT });
  assert.equal(pre.status, 204);
  assert.match(pre.headers['access-control-allow-headers'], /content-type/);
});

test('add via API downloads the file and forwards only safe headers', async () => {
  const r = await call('POST', '/api/add', {
    headers: EXT,
    body: { url: base + '/big.bin', filename: 'api-big.bin', headers: { referer: 'https://site.example/', cookie: 'a=b', 'x-evil': '1', 'user-agent': 'UA\r\nInjected: 1' } },
  });
  assert.equal(r.status, 200);
  const id = r.json.ids[0];
  for (let i = 0; i < 200; i++) {
    const it = mgr.list().find((x) => x.id === id);
    if (it.status === 'done') { break; }
    await sleep(50);
  }
  const it = mgr.list().find((x) => x.id === id);
  assert.equal(it.status, 'done', it.error);
  assert.equal(sha(fs.readFileSync(it.path)), sha(src.files['/big.bin']));
  const st = mgr.get(id).state;
  assert.deepEqual(Object.keys(st.headers).sort(), ['cookie', 'referer']);
});

test('invalid urls and unknown task ids are handled', async () => {
  assert.equal((await call('POST', '/api/add', { headers: EXT, body: { url: 'file:///etc/passwd' } })).status, 400);
  assert.equal((await call('POST', '/api/add', { headers: EXT, body: { url: 'javascript:alert(1)' } })).status, 400);
  assert.equal((await call('POST', '/api/tasks/nope/pause', { headers: EXT, body: {} })).status, 404);
});

test('state survives restart: finished list is reloaded from disk', async () => {
  mgr.saveNow();
  const m2 = new DownloadManager({ dataDir: path.join(tmp, 'data'), downloadDir: path.join(tmp, 'dl') });
  m2.load();
  assert.ok(m2.list().some((x) => x.filename === 'api-big.bin' && x.status === 'done'));
});

test('SSE stream delivers update events', async () => {
  const events = [];
  await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: api.port, path: '/api/events', headers: EXT }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (d) => {
        events.push(d);
        if (/event: added/.test(events.join(''))) { req.destroy(); resolve(); }
      });
    });
    req.on('error', (e) => (e.code === 'ECONNRESET' ? resolve() : reject(e)));
    req.end();
    setTimeout(() => { mgr.add({ url: base + '/attach', start: false }); }, 100);
    setTimeout(() => { req.destroy(); resolve(); }, 3000);
  });
  assert.match(events.join(''), /event: added/);
});
