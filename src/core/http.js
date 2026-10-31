'use strict';
const http = require('http');
const https = require('https');
const tls = require('tls');
const { URL } = require('url');

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 128, keepAliveMsecs: 15000 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 128, keepAliveMsecs: 15000 }),
};

// ---- optional HTTP proxy (plain HTTP via absolute URI, HTTPS via CONNECT tunnel). SOCKS is not supported.
let proxy = null; // { host, port, auth }
let bypassLocal = true;
const proxyAgents = new Map();

/** Accepts 'host:port', 'http://host:port' or 'http://user:pass@host:port'. Returns true when it is usable; '' turns the proxy off. */
function setProxy(str, { bypassLocal: bl = true } = {}) {
  proxyAgents.clear();
  bypassLocal = bl;
  const t = String(str || '').trim();
  if (!t) { proxy = null; return true; }
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : 'http://' + t);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { proxy = null; return false; }
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
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

function proxyAgentFor(protocol) {
  if (!proxyAgents.has(protocol)) {
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
function request(url, { method = 'GET', headers = {}, signal, maxRedirects = 10, timeout = 25000 } = {}) {
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
      if (viaProxy && u.protocol === 'http:') {
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
          agent: viaProxy ? proxyAgentFor('https:') : agents[u.protocol],
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
        res.setTimeout(timeout, () => res.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
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

module.exports = { setProxy, request, fetchBuffer, HttpError, classifyStatus, lowerKeys, DEFAULT_UA };
