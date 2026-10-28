'use strict';
const http = require('http');

const MAX_BODY = 2 * 1024 * 1024;
const EXT_ORIGIN = /^(moz-extension|chrome-extension|extension):\/\//i;

/**
 * Local control API used by the browser extension.
 *
 * Security model (a web page must never be able to drive this):
 *  - binds to 127.0.0.1 only
 *  - Host header must be 127.0.0.1/localhost:port (blocks DNS rebinding)
 *  - browser requests must carry an extension Origin (pages cannot forge Origin)
 *  - non-browser clients (no Origin) must send the X-Vexlo-Token header
 */
function createApi(manager, { port = 6877, token = '', onAdd, onShowWindow, getSettings, version = '0.1.0' } = {}) {
  const clients = new Set();

  const send = (res, status, obj, extra = {}) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), ...extra });
    res.end(body);
  };

  const readJson = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Body quá lớn'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) { return resolve({}); }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('JSON không hợp lệ'), { status: 400 })); }
    });
    req.on('error', reject);
  });

  const hostOk = (req) => {
    const h = String(req.headers.host || '').toLowerCase();
    return h === `127.0.0.1:${actualPort}` || h === `localhost:${actualPort}` || h === `[::1]:${actualPort}`;
  };

  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) { try { res.write(msg); } catch { clients.delete(res); } }
  };
  manager.on('update', (s) => broadcast('update', s));
  manager.on('added', (s) => broadcast('added', s));
  manager.on('removed', (s) => broadcast('removed', s));

  let actualPort = port;

  const server = http.createServer(async (req, res) => {
    const corsHeaders = {}; // filled once the Origin is accepted; also used for error replies so the extension can read them
    try {
      if (!hostOk(req)) { return send(res, 403, { error: 'host' }); }
      const origin = req.headers.origin;
      if (origin) {
        if (!EXT_ORIGIN.test(origin)) { return send(res, 403, { error: 'origin' }); }
        corsHeaders['access-control-allow-origin'] = origin;
        corsHeaders.vary = 'Origin';
        corsHeaders['access-control-allow-headers'] = 'content-type, x-vexlo-token';
        corsHeaders['access-control-allow-methods'] = 'GET, POST, OPTIONS';
        corsHeaders['access-control-max-age'] = '600';
      } else if (!token || req.headers['x-vexlo-token'] !== token) {
        return send(res, 401, { error: 'token' });
      }
      if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders); return res.end(); }

      const url = new URL(req.url, 'http://x');
      const p = url.pathname;

      if (req.method === 'GET' && p === '/api/ping') {
        return send(res, 200, { app: 'Vexlo', version, ok: true }, corsHeaders);
      }
      if (req.method === 'GET' && p === '/api/list') {
        return send(res, 200, { items: manager.list() }, corsHeaders);
      }
      if (req.method === 'GET' && p === '/api/settings') {
        return send(res, 200, getSettings ? getSettings() : {}, corsHeaders);
      }
      if (req.method === 'GET' && p === '/api/events') {
        res.writeHead(200, { ...corsHeaders, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': hi\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return undefined;
      }
      if (req.method === 'POST' && p === '/api/add') {
        const body = await readJson(req);
        const items = Array.isArray(body.items) ? body.items : [body];
        // The browser may suggest a file name but never a folder: the app decides where files go.
        const clean = items.map((it) => ({
          url: it.url, headers: sanitizeHeaders(it.headers), filename: typeof it.filename === 'string' ? it.filename : undefined,
          kind: it.kind, quality: it.quality, start: it.start, meta: { referer: it.referer, page: it.page, title: it.title },
        }));
        const ids = onAdd ? onAdd(clean, { show: !!body.show }) : clean.map((it) => manager.add(it));
        if (body.show && onShowWindow) { onShowWindow(); }
        return send(res, 200, { ids }, corsHeaders);
      }
      const m = /^\/api\/tasks\/([\w-]+)\/(pause|resume|remove)$/.exec(p);
      if (req.method === 'POST' && m) {
        const [, id, action] = m;
        if (!manager.get(id)) { return send(res, 404, { error: 'not found' }, corsHeaders); }
        if (action === 'pause') { await manager.pause(id); }
        else if (action === 'resume') { manager.resume(id); }
        else { const body = await readJson(req); await manager.remove(id, { deleteFile: !!body.deleteFile }); }
        return send(res, 200, { ok: true }, corsHeaders);
      }
      return send(res, 404, { error: 'not found' }, corsHeaders);
    } catch (err) {
      return send(res, err.status || 400, { error: err.message || String(err) }, corsHeaders);
    }
  });

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { actualPort = server.address().port; resolve(actualPort); });
      });
    },
    close() {
      for (const c of clients) { try { c.end(); } catch { /* ignore */ } }
      clients.clear();
      return new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
    },
    get port() { return actualPort; },
  };
}

/** Keep only headers that matter for the download and that are safe to forward. */
function sanitizeHeaders(h) {
  const allowed = new Set(['cookie', 'referer', 'user-agent', 'authorization', 'origin', 'accept-language']);
  const out = {};
  if (h && typeof h === 'object') {
    for (const [k, v] of Object.entries(h)) {
      const key = k.toLowerCase();
      if (allowed.has(key) && typeof v === 'string' && v.length < 16000 && !/[\r\n]/.test(v)) { out[key] = v; }
    }
  }
  return out;
}

module.exports = { createApi, sanitizeHeaders };
