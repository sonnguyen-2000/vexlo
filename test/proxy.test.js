'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { setProxy, fetchBuffer } = require('../src/core/http');

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const close = (srv) => new Promise((r) => { srv.close(() => r()); if (srv.closeAllConnections) { srv.closeAllConnections(); } });
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

/** A tiny forward proxy: absolute-URI GET for http, CONNECT for https. Optional Basic auth. */
function makeProxy(auth) {
  const seen = { http: 0, connect: 0, targets: [] };
  const ok = (req) => !auth || req.headers['proxy-authorization'] === auth;
  const srv = http.createServer((req, res) => {
    if (!ok(req)) { res.writeHead(407, { 'proxy-authenticate': 'Basic realm="x"' }); return res.end(); }
    seen.http++;
    const u = new URL(req.url);
    seen.targets.push(req.url);
    const up = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers: { host: u.host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); });
    up.end();
  });
  srv.on('connect', (req, sock, head) => {
    if (!ok(req)) { sock.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="x"\r\n\r\n'); return; }
    seen.connect++;
    seen.targets.push(req.url);
    const [h, p] = req.url.split(':');
    const up = net.connect(Number(p), h, () => { sock.write('HTTP/1.1 200 Connection established\r\n\r\n'); if (head.length) { up.write(head); } up.pipe(sock); sock.pipe(up); });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });
  return { srv, seen };
}

test('setProxy: accepts host:port, URLs with credentials, and rejects junk', () => {
  assert.equal(setProxy('127.0.0.1:8080'), true);
  assert.equal(setProxy('http://user:p%40ss@proxy.example:3128'), true);
  assert.equal(setProxy('socks5://127.0.0.1:1080'), false);
  assert.equal(setProxy('http://'), false);
  assert.equal(setProxy(''), true);
});

test('proxy: plain HTTP goes through the proxy with the full address and the proxy credentials', async () => {
  const target = http.createServer((req, res) => { res.end('hello ' + req.url); });
  const tp = await listen(target);
  const { srv, seen } = makeProxy(basic('bob', 's3cret'));
  const pp = await listen(srv);
  try {
    setProxy(`http://bob:s3cret@127.0.0.1:${pp}`, { bypassLocal: false });
    const r = await fetchBuffer(`http://127.0.0.1:${tp}/a/b?x=1`);
    assert.equal(r.body.toString(), 'hello /a/b?x=1');
    assert.equal(seen.http, 1);
    assert.equal(seen.targets[0], `http://127.0.0.1:${tp}/a/b?x=1`);
    // wrong password: the proxy answers 407 and the download fails clearly
    setProxy(`http://bob:wrong@127.0.0.1:${pp}`, { bypassLocal: false });
    await assert.rejects(fetchBuffer(`http://127.0.0.1:${tp}/a`), /407/);
    // loopback addresses skip the proxy by default
    setProxy(`http://127.0.0.1:${pp}`);
    const before = seen.http;
    const r2 = await fetchBuffer(`http://127.0.0.1:${tp}/direct`);
    assert.equal(r2.body.toString(), 'hello /direct');
    assert.equal(seen.http, before, 'loopback must not use the proxy');
  } finally { setProxy(''); await close(srv); await close(target); }
});

test('proxy: HTTPS goes through a CONNECT tunnel', { skip: (() => { try { execFileSync('openssl', ['version']); return false; } catch { return 'openssl not available'; } })() }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlo-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const target = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => { res.end('secure ' + req.url); });
  const tp = await listen(target);
  const { srv, seen } = makeProxy(basic('bob', 's3cret'));
  const pp = await listen(srv);
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the test certificate is self-signed
  try {
    setProxy(`bob:s3cret@127.0.0.1:${pp}`, { bypassLocal: false });
    const r = await fetchBuffer(`https://127.0.0.1:${tp}/file.bin`);
    assert.equal(r.body.toString(), 'secure /file.bin');
    assert.equal(seen.connect, 1);
    assert.equal(seen.targets[0], `127.0.0.1:${tp}`);
    setProxy(`127.0.0.1:${pp}`, { bypassLocal: false }); // no credentials
    await assert.rejects(fetchBuffer(`https://127.0.0.1:${tp}/file.bin`), /407/);
  } finally {
    if (prev === undefined) { delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; } else { process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev; }
    setProxy(''); await close(srv); await close(target); fs.rmSync(dir, { recursive: true, force: true });
  }
});
