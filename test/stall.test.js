'use strict';
// A connection that stops sending data must be dropped and asked again, not waited on for 25 s.
process.env.VEXLO_IDLE_MS = '700';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DownloadManager } = require('../src/core/manager');
const { sleep } = require('../src/core/util');

test('a download whose connection freezes mid-body finishes quickly on a new connection', async () => {
  const body = crypto.randomBytes(2 * 1024 * 1024);
  let hung = 0;
  const server = http.createServer((req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
    const chunk = body.subarray(start, end + 1);
    res.writeHead(m ? 206 : 200, {
      'content-type': 'application/octet-stream', 'accept-ranges': 'bytes', 'content-length': chunk.length,
      ...(m ? { 'content-range': `bytes ${start}-${end}/${body.length}` } : {}),
    });
    if (chunk.length > 1000 && hung < 2) { // the first two real requests freeze after 64 KB and never finish
      hung++;
      res.write(chunk.subarray(0, 64 * 1024));
      return; // socket stays open, no more data
    }
    res.end(chunk);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlo-stall-'));
  const m = new DownloadManager({ dataDir: path.join(tmp, 'data'), downloadDir: path.join(tmp, 'dl'), maxConcurrent: 1 });
  try {
    const t0 = Date.now();
    const id = m.add({ url: `http://127.0.0.1:${server.address().port}/f.bin`, filename: 'f.bin', connections: 2 });
    for (let i = 0; i < 200 && m.list().find((x) => x.id === id).status !== 'done'; i++) { await sleep(50); }
    const t = m.list().find((x) => x.id === id);
    assert.equal(t.status, 'done', 'status ' + t.status + ' ' + t.error);
    assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0} ms`);
    assert.ok(hung >= 1, 'the freeze must have happened');
    const got = fs.readFileSync(t.path);
    assert.equal(crypto.createHash('sha256').update(got).digest('hex'), crypto.createHash('sha256').update(body).digest('hex'));
  } finally { server.close(); server.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
