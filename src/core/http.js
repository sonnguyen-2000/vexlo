'use strict';
const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');
const { URL } = require('url');

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 128, keepAliveMsecs: 15000 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 128, keepAliveMsecs: 15000 }),
};

// ---- optional proxy: HTTP (plain HTTP via absolute URI, HTTPS via CONNECT tunnel) or SOCKS5 (socks5://host:port, names resolved by the proxy).
let proxy = null; // { host, port, auth }
let proxyText = ''; // the proxy as a full URL (for programs that take --proxy)
let bypassLocal = true;
const proxyAgents = new Map();

/** Accepts 'host:port', 'http://host:port' or 'http://user:pass@host:port'. Returns true when it is usable; '' turns the proxy off. */
function setProxy(str, { bypassLocal: bl = true } = {}) {
  const ok = setProxyInner(str, { bypassLocal: bl });
  const t = String(str || '').trim();
  proxyText = ok && proxy && t ? (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : 'http://' + t) : '';
  return ok;
}
/** The proxy now in use as a URL ('' when none). */
function getProxy() { return proxyText; }

function setProxyInner(str, { bypassLocal: bl = true } = {}) {
  proxyAgents.clear();
  bypassLocal = bl;
  const t = String(str || '').trim();
  if (!t) { proxy = null; return true; }
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : 'http://' + t);
    const socks = /^socks5h?:$|^socks:$/.test(u.protocol);
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && !socks) { proxy = null; return false; }
    const port = Number(u.port) || (socks ? 1080 : u.protocol === 'https:' ? 443 : 80);
    if (socks) {
      if (!u.hostname) { proxy = null; return false; }
      proxy = { type: 'socks', host: u.hostname.replace(/^\[|\]$/g, ''), port, user: decodeURIComponent(u.username || ''), pass: decodeURIComponent(u.password || '') };
      return true;
    }
    const auth = u.username ? 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64') : '';
    if (!u.hostname) { proxy = null; return false; }
    proxy = { host: u.hostname.replace(/^\[|\]$/g, ''), port, auth };
    return true;
  } catch { proxy = null; return false; }
}

const bypassProxy = (host) => (bypassLocal && /^(localhost|127\.|\[?::1\]?$)/i.test(host)) || /\.local$/i.test(host);

class TunnelAgent extends https.Agent {
  constructor(p) {
    super({ keepAlive: true, maxSockets: 128, keepAliveMsecs: 15000 });
    this.p = p;
  }

  createConnection(options, cb) {
    let done = false;
    const finish = (err, sock) => { if (!done) { done = true; cb(err, sock); } };
    const target = `${options.host || options.hostname}:${options.port || 443}`;
    const req = http.request({
      host: this.p.host, port: this.p.port, method: 'CONNECT', path: target, timeout: 25000,
      headers: { host: target, ...(this.p.auth ? { 'proxy-authorization': this.p.auth } : {}) },
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return finish(new Error(res.statusCode === 407 ? 'Proxy yêu cầu đăng nhập (407)' : `Proxy: HTTP ${res.statusCode}`)); }
      const t = tls.connect({ socket, servername: options.servername || options.host || options.hostname });
      t.once('secureConnect', () => finish(null, t));
      t.once('error', (e) => finish(e));
    });
    req.on('timeout', () => req.destroy(new Error('Proxy: timeout')));
    req.on('error', (e) => finish(e));
    req.end();
  }
}

/** SOCKS5 handshake (RFC 1928 / 1929) on a fresh socket to the proxy; calls back with the socket ready to talk to host:port. */
function socksConnect(p, host, port, cb) {
  let done = false;
  const sock = net.connect({ host: p.host, port: p.port });
  const fail = (err) => { if (!done) { done = true; sock.destroy(); cb(err); } };
  const ok = () => { if (!done) { done = true; sock.setTimeout(0); sock.removeAllListeners('data'); sock.removeAllListeners('timeout'); cb(null, sock); } };
  sock.setTimeout(25000, () => fail(new Error('Proxy SOCKS: timeout')));
  sock.once('error', fail);
  sock.once('close', () => fail(new Error('Proxy SOCKS: kết nối bị đóng')));
  let buf = Buffer.alloc(0);
  let step = 'method';
  const need = (n) => buf.length >= n;
  const take = (n) => { const b = buf.subarray(0, n); buf = buf.subarray(n); return b; };
  const sendConnect = () => {
    const h = Buffer.from(host, 'utf8');
    const ip = net.isIP(host);
    let addr;
    if (ip === 4) { addr = Buffer.concat([Buffer.from([1]), Buffer.from(host.split('.').map(Number))]); }
    else if (ip === 6) {
      const parts = host.split('::');
      const head = parts[0] ? parts[0].split(':') : [];
      const tail = parts[1] ? parts[1].split(':') : [];
      const all = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
      const b = Buffer.alloc(16); all.forEach((g, i) => b.writeUInt16BE(parseInt(g, 16) || 0, i * 2));
      addr = Buffer.concat([Buffer.from([4]), b]);
    } else { addr = Buffer.concat([Buffer.from([3, h.length]), h]); }
    const pt = Buffer.alloc(2); pt.writeUInt16BE(port);
    step = 'reply';
    sock.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, pt]));
  };
  const REPLY = ['', 'lỗi chung', 'bị cấm', 'mạng không tới được', 'máy đích không tới được', 'đích từ chối kết nối', 'TTL hết hạn', 'lệnh không hỗ trợ', 'kiểu địa chỉ không hỗ trợ'];
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (step === 'method') {
        if (!need(2)) { return; }
        const r = take(2);
        if (r[0] !== 5) { return fail(new Error('Proxy SOCKS: không phải SOCKS5')); }
        if (r[1] === 0) { sendConnect(); continue; }
        if (r[1] === 2 && p.user) {
          const u = Buffer.from(p.user); const w = Buffer.from(p.pass);
          step = 'auth';
          sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([w.length]), w]));
          continue;
        }
        return fail(new Error(r[1] === 2 ? 'Proxy SOCKS yêu cầu đăng nhập' : 'Proxy SOCKS: không có kiểu xác thực phù hợp'));
      }
      if (step === 'auth') {
        if (!need(2)) { return; }
        const r = take(2);
        if (r[1] !== 0) { return fail(new Error('Proxy SOCKS: sai tên hoặc mật khẩu')); }
        sendConnect();
        continue;
      }
      if (step === 'reply') {
        if (!need(5)) { return; }
        const atyp = buf[3];
        const len = 4 + (atyp === 1 ? 4 : atyp === 4 ? 16 : 1 + buf[4]) + 2;
        if (!need(len)) { return; }
        const r = take(len);
        if (r[1] !== 0) { return fail(new Error('Proxy SOCKS: ' + (REPLY[r[1]] || 'lỗi ' + r[1]))); }
        step = 'done';
        sock.removeListener('data', onData);
        if (buf.length) { sock.unshift(buf); }
        return ok();
      }
      return;
    }
  };
  sock.on('data', onData);
  sock.once('connect', () => { sock.write(p.user ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0])); });
}

function socksAgentFor(p, tlsWrap) {
  const Base = tlsWrap ? https.Agent : http.Agent;
  return new (class extends Base {
    createConnection(options, cb) {
      const host = options.host || options.hostname;
      socksConnect(p, host, Number(options.port) || (tlsWrap ? 443 : 80), (err, sock) => {
        if (err) { return cb(err); }
        if (!tlsWrap) { return cb(null, sock); }
        const t = tls.connect({ socket: sock, servername: options.servername || host });
        t.once('secureConnect', () => cb(null, t));
        t.once('error', (e) => cb(e));
        return undefined;
      });
    }
  })({ keepAlive: true, maxSockets: 128, keepAliveMsecs: 15000 });
}

function proxyAgentFor(protocol) {
  if (!proxyAgents.has(protocol)) {
    if (proxy.type === 'socks') { proxyAgents.set(protocol, socksAgentFor(proxy, protocol === 'https:')); return proxyAgents.get(protocol); }
    proxyAgents.set(protocol, protocol === 'https:' ? new TunnelAgent(proxy) : new http.Agent({ keepAlive: true, maxSockets: 128, keepAliveMsecs: 15000 }));
  }
  return proxyAgents.get(protocol);
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0';

class HttpError extends Error {
  constructor(message, { status, fatal = false, retryAfter } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.fatal = fatal;
    this.retryAfter = retryAfter;
  }
}

function lowerKeys(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') { out[k.toLowerCase()] = String(v); }
  }
  return out;
}

/**
 * Issue one HTTP request following redirects manually so we keep control of headers.
 * Cookie/Authorization are dropped when a redirect crosses to another host.
 * Resolves with { res, url } where res is a live IncomingMessage (caller must consume/destroy it).
 */
function request(url, { method = 'GET', headers = {}, signal, maxRedirects = 10, timeout = 25000, idleTimeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    let currentUrl = url;
    let currentHeaders = { 'user-agent': DEFAULT_UA, accept: '*/*', 'accept-encoding': 'identity', ...lowerKeys(headers) };
    let currentReq = null;

    const onAbort = () => {
      if (currentReq) { currentReq.destroy(Object.assign(new Error('aborted'), { code: 'ABORT_ERR', aborted: true })); }
      else { reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR', aborted: true })); }
    };
    if (signal) {
      if (signal.aborted) { return onAbort(); }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const cleanup = () => { if (signal) { signal.removeEventListener('abort', onAbort); } };

    const go = () => {
      let u;
      try { u = new URL(currentUrl); } catch (e) { cleanup(); return reject(new HttpError('URL không hợp lệ: ' + currentUrl, { fatal: true })); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        cleanup();
        return reject(new HttpError('Giao thức không hỗ trợ: ' + u.protocol, { fatal: true }));
      }
      const lib = u.protocol === 'https:' ? https : http;
      const viaProxy = proxy && !bypassProxy(u.hostname);
      let req;
      if (viaProxy && proxy.type !== 'socks' && u.protocol === 'http:') {
        // Plain HTTP through a proxy: the request line carries the full address.
        const h = { host: u.host, ...currentHeaders };
        if (proxy.auth) { h['proxy-authorization'] = proxy.auth; }
        if (u.username) { h.authorization = 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64'); }
        const full = new URL(u.href); full.username = ''; full.password = '';
        req = http.request({ host: proxy.host, port: proxy.port, method, path: full.href, headers: h, agent: proxyAgentFor('http:'), timeout });
      } else {
        req = lib.request(u, {
          method,
          headers: { host: u.host, ...currentHeaders },
          agent: viaProxy ? proxyAgentFor(u.protocol) : agents[u.protocol],
          timeout,
        });
      }
      currentReq = req;
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      req.on('error', (err) => { cleanup(); reject(err); });
      req.on('response', (res) => {
        const status = res.statusCode;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          if (++redirects > maxRedirects) { cleanup(); return reject(new HttpError('Quá nhiều chuyển hướng', { fatal: true })); }
          const next = new URL(res.headers.location, u);
          if (next.host !== u.host) {
            delete currentHeaders.cookie;
            delete currentHeaders.authorization;
          }
          currentUrl = next.toString();
          return go();
        }
        cleanup();
        // Idle-socket timeout for the body.
        res.setTimeout(idleTimeout || timeout, () => res.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
        resolve({ res, url: currentUrl });
      });
      req.end();
    };
    go();
  });
}

function classifyStatus(status, res) {
  const retryAfter = res?.headers?.['retry-after'] ? Number(res.headers['retry-after']) * 1000 : undefined;
  if (status === 429 || status === 503 || status === 502 || status === 504 || status === 408 || status >= 500) {
    return new HttpError(`HTTP ${status}`, { status, retryAfter });
  }
  return new HttpError(`HTTP ${status}`, { status, fatal: true });
}

/** Fetch a small text/binary resource fully into memory (playlists, keys). */
async function fetchBuffer(url, opts = {}) {
  const { res, url: finalUrl } = await request(url, opts);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.resume();
    throw classifyStatus(res.statusCode, res);
  }
  const chunks = [];
  for await (const c of res) { chunks.push(c); }
  return { body: Buffer.concat(chunks), url: finalUrl, headers: res.headers };
}

module.exports = { setProxy, getProxy, request, fetchBuffer, HttpError, classifyStatus, lowerKeys, DEFAULT_UA };
