'use strict';
const http = require('http');
const https = require('https');
const { URL } = require('url');

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 128, keepAliveMsecs: 15000 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 128, keepAliveMsecs: 15000 }),
};

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
      const req = lib.request(u, {
        method,
        headers: { host: u.host, ...currentHeaders },
        agent: agents[u.protocol],
        timeout,
      });
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

module.exports = { request, fetchBuffer, HttpError, classifyStatus, lowerKeys, DEFAULT_UA };
