'use strict';
const http = require('http');
const crypto = require('crypto');

/** Deterministic content: byte i of a file with a given seed. */
function makeBuffer(size, seed = 7) {
  const b = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) { b[i] = (i * 31 + (i >> 8) + seed) & 255; }
  return b;
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Test server.
 *  /big.bin        8 MiB, Range supported
 *  /norange.bin    3 MiB, Range ignored
 *  /flaky.bin      4 MiB, first connection of each range is cut after ~600KB
 *  /attach         Content-Disposition attachment, UTF-8 name
 *  /redirect       302 -> /big.bin
 *  /limit.bin      refuses > 2 simultaneous connections with 429
 *  /missing        404
 */
function createServer() {
  const files = {
    '/big.bin': makeBuffer(8 * 1024 * 1024, 1),
    '/norange.bin': makeBuffer(3 * 1024 * 1024, 2),
    '/flaky.bin': makeBuffer(4 * 1024 * 1024, 3),
    '/limit.bin': makeBuffer(6 * 1024 * 1024, 4),
    '/attach': makeBuffer(1024 * 1024 + 123, 5),
  };
  const stats = { connections: 0, maxConcurrent: 0, concurrent: 0, flakyCuts: 0, rangeRequests: [] };
  const cut = new Set();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    stats.connections++;
    stats.concurrent++;
    stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.concurrent);
    res.on('close', () => { stats.concurrent--; });

    if (p === '/redirect') { res.writeHead(302, { location: '/big.bin' }); return res.end(); }
    if (p === '/missing') { res.writeHead(404); return res.end('nope'); }
    const body = files[p];
    if (!body) { res.writeHead(404); return res.end(); }

    if (p === '/limit.bin' && stats.concurrent > 2) { res.writeHead(429, { 'retry-after': '0' }); return res.end(); }

    const headers = { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes', etag: '"v1-' + p + '"' };
    if (p === '/attach') {
      headers['content-disposition'] = "attachment; filename*=UTF-8''B%C3%A1o%20c%C3%A1o%20t%E1%BB%95ng%20k%E1%BA%BFt.bin";
    }
    const range = req.headers.range;
    if (p === '/norange.bin' || !range) {
      res.writeHead(200, { ...headers, 'content-length': body.length });
      if (p === '/norange.bin') { delete headers['accept-ranges']; }
      return res.end(body);
    }
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = Number(m[1]);
    const end = m[2] === '' ? body.length - 1 : Math.min(Number(m[2]), body.length - 1);
    stats.rangeRequests.push([start, end]);
    let slice = body.subarray(start, end + 1);
    res.writeHead(206, {
      ...headers, 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': slice.length,
    });
    if (p === '/flaky.bin' && slice.length > 700 * 1024 && !cut.has(start)) {
      cut.add(start);
      stats.flakyCuts++;
      res.write(slice.subarray(0, 600 * 1024));
      setTimeout(() => res.destroy(), 20);
      return;
    }
    // Stream in 64 KiB pieces so progress/pause tests can observe partial state.
    let off = 0;
    const pump = () => {
      while (off < slice.length) {
        const piece = slice.subarray(off, off + 65536);
        off += piece.length;
        if (!res.write(piece)) { return res.once('drain', pump); }
        if (req.headers['x-slow']) { return setTimeout(pump, 5); }
      }
      res.end();
    };
    pump();
  });
  return { server, files, stats };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

module.exports = { createServer, listen, makeBuffer, sha };
