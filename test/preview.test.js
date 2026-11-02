'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DownloadManager } = require('../src/core/manager');
const { SegmentedDownload } = require('../src/core/segmented');
const { MediaDownload } = require('../src/core/ytdlp');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
async function until(fn, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) { return v; } await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timeout waiting');
}

const DATA = crypto.randomBytes(6 * 1024 * 1024);
function rangeServer() {
  return http.createServer((req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : DATA.length - 1;
    res.writeHead(m ? 206 : 200, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': end - start + 1, ...(m ? { 'content-range': `bytes ${start}-${end}/${DATA.length}` } : {}) });
    res.end(DATA.subarray(start, end + 1));
  });
}

for (const conns of [1, 4]) {
  test(`preview of a file still downloading (${conns} connection${conns > 1 ? 's' : ''}): a playable copy of the bytes already in place`, async () => {
    const srv = rangeServer();
    const port = await listen(srv);
    const work = tmp('vx-pv-');
    const m = new DownloadManager({ dataDir: work, downloadDir: work, connections: conns, speedLimit: 1.5 * 1024 * 1024 });
    m.on('error', () => {});
    try {
      const id = m.add({ url: `http://127.0.0.1:${port}/clip.mp4`, dir: work, filename: 'clip.mp4', connections: conns });
      await until(() => m.get(id).state.downloaded > 1024 * 1024);
      await m.pause(id);
      const r = await m.preview(id);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(path.basename(r.path), 'clip.mp4');
      assert.notEqual(path.dirname(r.path), work); // a copy in the temp folder, the download itself is untouched
      const got = fs.readFileSync(r.path);
      assert.ok(got.length >= 256 * 1024 && got.length <= m.get(id).state.downloaded);
      assert.ok(got.equals(DATA.subarray(0, got.length)), 'the copy is exactly the start of the file');
      m.setMaxConcurrent(1);
      m.limiter.setLimit(0);
      m.resume(id);
      await until(() => m.get(id).state.status === 'done');
      assert.ok(fs.readFileSync(m.get(id).state.path).equals(DATA)); // and the download still finishes correctly
      const done = await m.preview(id);
      assert.deepEqual([done.ok, done.done, done.path], [true, true, m.get(id).state.path]);
    } finally { srv.close(); srv.closeAllConnections?.(); fs.rmSync(work, { recursive: true, force: true }); }
  });
}

test('preview with almost nothing downloaded, or an unknown task, says why', async () => {
  const work = tmp('vx-pv-');
  const m = new DownloadManager({ dataDir: work, downloadDir: work });
  try {
    assert.deepEqual(await m.preview('nope'), { ok: false, reason: 'none' });
    const id = m.add({ url: 'http://127.0.0.1:9/x.mp4', dir: work, start: false });
    assert.equal((await m.preview(id)).ok, false);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test('preview of an HLS download: the segments already in place are joined (init first, stops at the first gap)', async () => {
  const work = tmp('vx-pv-');
  try {
    const state = SegmentedDownload.create({ id: 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12), url: 'http://x/a.m3u8', dir: work, kind: 'hls', filename: 'Show.mp4' });
    state.path = path.join(work, 'Show.mp4');
    const dl = new SegmentedDownload(state, {});
    fs.mkdirSync(dl.partsDir);
    const seg = (i, body) => fs.writeFileSync(path.join(dl.partsDir, `t0-${String(i + 1).padStart(6, '0')}.seg`), body);
    seg(-1, 'INIT'); seg(0, 'AAAA'); seg(1, 'BBBB'); seg(3, 'DDDD'); // segment 2 is missing: the copy stops before it
    const out = tmp('vx-out-');
    const r = await dl.previewFile(out);
    assert.equal(r.ok, true);
    assert.equal(path.basename(r.path), 'Show.mp4');
    assert.equal(fs.readFileSync(r.path, 'utf8'), 'INITAAAABBBB');
    // transport stream segments (first byte 0x47) get a .ts name
    for (const f of fs.readdirSync(dl.partsDir)) { fs.rmSync(path.join(dl.partsDir, f)); }
    fs.writeFileSync(path.join(dl.partsDir, 't0-000001.seg'), Buffer.from([0x47, 1, 2]));
    fs.writeFileSync(path.join(dl.partsDir, 't0-000002.seg'), Buffer.from([0x47, 3, 4]));
    const t = await dl.previewFile(out);
    assert.equal(path.basename(t.path), 'Show.ts');
    assert.deepEqual([...fs.readFileSync(t.path)], [0x47, 1, 2, 0x47, 3, 4]);
    // nothing yet
    for (const f of fs.readdirSync(dl.partsDir)) { fs.rmSync(path.join(dl.partsDir, f)); }
    assert.equal((await dl.previewFile(out)).ok, false);
    fs.rmSync(out, { recursive: true, force: true });
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test('preview of a yt-dlp download: the biggest piece so far, without the .part ending', async () => {
  const work = tmp('vx-pv-');
  try {
    const state = MediaDownload.create({ id: 'b'.repeat(8) + '-bbbb-bbbb-bbbb-' + 'b'.repeat(12), url: 'https://youtu.be/abc', dir: work });
    state.base = 'My video';
    const dl = new MediaDownload(state, {});
    fs.writeFileSync(path.join(work, 'My video.f251.webm.part'), Buffer.alloc(300 * 1024, 1)); // sound
    fs.writeFileSync(path.join(work, 'My video.f137.mp4.part'), Buffer.alloc(900 * 1024, 2)); // picture
    fs.writeFileSync(path.join(work, 'Other.f137.mp4.part'), Buffer.alloc(2000 * 1024, 3));
    const out = tmp('vx-out-');
    const r = await dl.previewFile(out);
    assert.equal(r.ok, true);
    assert.equal(path.basename(r.path), 'My video.f137.mp4');
    assert.equal(fs.statSync(r.path).size, 900 * 1024);
    fs.rmSync(path.join(work, 'My video.f137.mp4.part'));
    fs.rmSync(path.join(work, 'My video.f251.webm.part'));
    assert.equal((await dl.previewFile(out)).ok, false);
    fs.rmSync(out, { recursive: true, force: true });
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});
