'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { setProxy, fetchBuffer } = require('../src/core/http');
const { extractCommands, listCommand } = require('../src/core/util');
const { Download } = require('../src/core/download');

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const close = (srv) => new Promise((r) => { srv.close(() => r()); if (srv.closeAllConnections) { srv.closeAllConnections(); } });

/** Minimal SOCKS5 server. `map` turns a requested name into a real local port (so names are proven to be sent to the proxy). */
function makeSocks({ user, pass, map = {} } = {}) {
  const seen = { targets: [], auth: 0 };
  const srv = net.createServer((c) => {
    let buf = Buffer.alloc(0); let step = 'greet';
    c.on('error', () => {});
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (step === 'greet' && buf.length >= 2 && buf.length >= 2 + buf[1]) {
        buf = buf.subarray(2 + buf[1]);
        if (user) { c.write(Buffer.from([5, 2])); step = 'auth'; } else { c.write(Buffer.from([5, 0])); step = 'req'; }
      }
      if (step === 'auth' && buf.length >= 2) {
        const ul = buf[1];
        if (buf.length < 2 + ul + 1) { return; }
        const u = buf.subarray(2, 2 + ul).toString(); const pl = buf[2 + ul];
        if (buf.length < 3 + ul + pl) { return; }
        const p = buf.subarray(3 + ul, 3 + ul + pl).toString();
        buf = buf.subarray(3 + ul + pl);
        if (u === user && p === pass) { seen.auth++; c.write(Buffer.from([1, 0])); step = 'req'; } else { c.end(Buffer.from([1, 1])); return; }
      }
      if (step === 'req' && buf.length >= 5) {
        const atyp = buf[3];
        const hl = atyp === 3 ? buf[4] : atyp === 1 ? 4 : 16;
        const total = 4 + (atyp === 3 ? 1 : 0) + hl + 2;
        if (buf.length < total) { return; }
        const host = atyp === 3 ? buf.subarray(5, 5 + hl).toString() : atyp === 1 ? [...buf.subarray(4, 8)].join('.') : '::1';
        let port = buf.readUInt16BE(total - 2);
        buf = buf.subarray(total); step = 'pipe';
        seen.targets.push(`${host}:${port}`);
        let realHost = host;
        if (map[host]) { realHost = '127.0.0.1'; port = map[host]; }
        const up = net.connect(port, realHost, () => {
          c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (buf.length) { up.write(buf); }
          up.pipe(c); c.pipe(up);
        });
        up.on('error', () => { c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])); });
      }
    });
  });
  return { srv, seen };
}

test('SOCKS5: plain HTTP through the proxy, name resolved by the proxy', async () => {
  const web = http.createServer((req, res) => res.end('hello ' + req.headers.host));
  const wp = await listen(web);
  const { srv, seen } = makeSocks({ map: { 'files.example': wp } });
  const sp = await listen(srv);
  try {
    assert.equal(setProxy(`socks5://127.0.0.1:${sp}`, { bypassLocal: false }), true);
    const r = await fetchBuffer(`http://files.example:${wp}/x`);
    assert.equal(r.body.toString(), `hello files.example:${wp}`);
    assert.deepEqual(seen.targets, [`files.example:${wp}`]);
  } finally { setProxy(''); await close(web); await close(srv); }
});

test('SOCKS5: user and password', async () => {
  const web = http.createServer((req, res) => res.end('ok'));
  const wp = await listen(web);
  const { srv, seen } = makeSocks({ user: 'bob', pass: 's3', map: { 'a.test': wp } });
  const sp = await listen(srv);
  try {
    setProxy(`socks5://bob:s3@127.0.0.1:${sp}`, { bypassLocal: false });
    assert.equal((await fetchBuffer(`http://a.test:${wp}/`)).body.toString(), 'ok');
    assert.equal(seen.auth, 1);
    setProxy(`socks5://bob:wrong@127.0.0.1:${sp}`, { bypassLocal: false });
    await assert.rejects(fetchBuffer(`http://a.test:${wp}/`), /sai tên hoặc mật khẩu/);
  } finally { setProxy(''); await close(web); await close(srv); }
});

test('SOCKS5: a refused target is reported', async () => {
  const { srv } = makeSocks();
  const sp = await listen(srv);
  try {
    setProxy(`socks5://127.0.0.1:${sp}`, { bypassLocal: false });
    await assert.rejects(fetchBuffer('http://127.0.0.1:1/'), /SOCKS/);
  } finally { setProxy(''); await close(srv); }
});

test('setProxy accepts socks5 and rejects other schemes', () => {
  assert.equal(setProxy('socks5://h:1080'), true);
  assert.equal(setProxy('socks5h://h'), true);
  assert.equal(setProxy('ftp://h:21'), false);
  setProxy('');
});

test('extractCommands / listCommand use a folder chosen by the user', () => {
  const have = new Set(['D:\\Tools\\Rar\\UnRAR.exe', 'D:\\Tools\\Rar\\7z.exe']);
  const opts = { platform: 'win32', env: {}, exists: (f) => have.has(f), toolDir: 'D:\\Tools\\Rar' };
  const cmds = extractCommands('C:\\a.rar', 'C:\\a', opts);
  assert.equal(cmds[0].exe, 'D:\\Tools\\Rar\\UnRAR.exe');
  assert.ok(cmds.some((c) => c.exe === 'D:\\Tools\\Rar\\7z.exe'));
  assert.equal(listCommand('C:\\a.rar', opts).exe, 'D:\\Tools\\Rar\\UnRAR.exe');
  const none = extractCommands('C:\\a.rar', 'C:\\a', { platform: 'win32', env: {}, exists: () => false });
  assert.deepEqual(none.map((c) => c.name), ['tar']);
});

test('a file whose type is only known after the server answers goes to the matching folder', async () => {
  const web = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': 5, 'content-disposition': 'attachment; filename="pack.rar"' });
    res.end('12345');
  });
  const wp = await listen(web);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-'));
  try {
    const state = Download.create({ id: 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12), url: `http://127.0.0.1:${wp}/get?id=1`, dir: path.join(base, 'Other') });
    state.autoBase = base;
    const dl = new Download(state, {});
    await dl.start();
    assert.equal(state.status, 'done', state.error);
    assert.equal(path.dirname(state.path), path.join(base, 'Compressed'));
    assert.ok(fs.existsSync(path.join(base, 'Compressed', 'pack.rar')));
  } finally { await close(web); fs.rmSync(base, { recursive: true, force: true }); }
});

test('looksLikeWebPage: an HTML answer saved under a binary name is caught, real files and html names are not', () => {
  const { looksLikeWebPage } = require('../src/core/util');
  const html = Buffer.from('<!DOCTYPE html><html><body>Link expired</body></html>');
  assert.equal(looksLikeWebPage({ filename: 'a.zip', size: 60, head: html }), true);
  assert.equal(looksLikeWebPage({ filename: 'a.rar', size: 60, head: Buffer.from('\n  <html lang="vi">') }), true);
  assert.equal(looksLikeWebPage({ filename: 'page.html', size: 60, head: html }), false);
  assert.equal(looksLikeWebPage({ filename: 'a.zip', size: 60, head: Buffer.from('PK\x03\x04rest') }), false);
  assert.equal(looksLikeWebPage({ filename: 'a.zip', size: 50 * 1024 * 1024, head: html }), false);
});

test('a download that answers with a web page fails clearly and leaves no file', async () => {
  const web = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body>Hết hạn</body></html>'); });
  const wp = await listen(web);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-'));
  try {
    const state = Download.create({ id: 'b'.repeat(8) + '-bbbb-bbbb-bbbb-' + 'b'.repeat(12), url: `http://127.0.0.1:${wp}/f.zip`, dir: base, filename: 'f.zip' });
    const dl = new Download(state, {});
    dl.on('error', () => {});
    await dl.start();
    assert.equal(state.status, 'error');
    assert.match(state.error, /trang web/);
    assert.deepEqual(fs.readdirSync(base), []);
  } finally { await close(web); fs.rmSync(base, { recursive: true, force: true }); }
});
