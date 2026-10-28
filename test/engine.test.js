'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer, listen, sha } = require('./server');
const { Download } = require('../src/core/download');
const { SpeedLimiter } = require('../src/core/limiter');
const { sleep } = require('../src/core/util');

let ctx;
let base;
let tmp;

test.before(async () => {
  ctx = createServer();
  const port = await listen(ctx.server);
  base = `http://127.0.0.1:${port}`;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlo-'));
});
test.after(() => { ctx.server.close(); ctx.server.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); });

function mk(urlPath, extra = {}) {
  const state = Download.create({ id: 't' + Math.random().toString(36).slice(2), url: base + urlPath, dir: tmp, connections: 8, ...extra });
  return new Download(state, { limiter: extra.limiter });
}
const once = (d, ev) => new Promise((r) => d.once(ev, r));

test('multi-connection download is byte-exact and uses several connections', async () => {
  ctx.stats.rangeRequests.length = 0;
  const d = mk('/big.bin', { filename: 'big1.bin' });
  const done = once(d, 'done');
  await d.start();
  await done;
  const out = fs.readFileSync(d.state.path);
  assert.equal(sha(out), sha(ctx.files['/big.bin']));
  assert.equal(d.state.status, 'done');
  assert.ok(ctx.stats.rangeRequests.length >= 8, 'expected >= 8 range requests, got ' + ctx.stats.rangeRequests.length);
  assert.equal(fs.existsSync(d.state.path + '.part'), false);
});

test('follows redirects and takes name from URL', async () => {
  const d = mk('/redirect');
  await d.start();
  assert.equal(d.state.status, 'done');
  assert.equal(d.state.filename, 'big.bin');
  assert.equal(sha(fs.readFileSync(d.state.path)), sha(ctx.files['/big.bin']));
});

test('falls back to a single stream when Range is not supported', async () => {
  const d = mk('/norange.bin', { filename: 'norange.bin' });
  await d.start();
  assert.equal(d.state.status, 'done');
  assert.equal(d.state.resumable, false);
  assert.equal(sha(fs.readFileSync(d.state.path)), sha(ctx.files['/norange.bin']));
});

test('recovers from connections dropped mid-transfer', async () => {
  ctx.stats.flakyCuts = 0;
  const d = mk('/flaky.bin', { filename: 'flaky.bin' });
  await d.start();
  assert.equal(d.state.status, 'done', d.state.error);
  assert.ok(ctx.stats.flakyCuts > 0, 'server should have cut some connections');
  assert.equal(sha(fs.readFileSync(d.state.path)), sha(ctx.files['/flaky.bin']));
});

test('reads UTF-8 filename from Content-Disposition', async () => {
  const d = mk('/attach');
  await d.start();
  assert.equal(d.state.status, 'done');
  assert.equal(d.state.filename, 'Báo cáo tổng kết.bin');
  assert.equal(sha(fs.readFileSync(d.state.path)), sha(ctx.files['/attach']));
});

test('404 ends in error state without retry storm', async () => {
  const d = mk('/missing', { filename: 'missing.bin' });
  d.on('error', () => {});
  await d.start();
  assert.equal(d.state.status, 'error');
  assert.match(d.state.error, /404/);
});

test('adapts when the server answers 429 to extra connections', async () => {
  const d = mk('/limit.bin', { filename: 'limit.bin' });
  d.on('error', () => {});
  await d.start();
  assert.equal(d.state.status, 'done', d.state.error);
  assert.equal(sha(fs.readFileSync(d.state.path)), sha(ctx.files['/limit.bin']));
});

test('pause then resume continues and yields identical file', async () => {
  // Throttled on purpose: unthrottled, the local server can deliver all 8 MiB before the test gets a chance to pause.
  const d = mk('/big.bin', { filename: 'resume.bin', limiter: new SpeedLimiter(1024 * 1024) });
  d.on('error', () => {});
  const running = d.start();
  // wait for ~1.5MB (about a second at 1 MiB/s plus the one-second burst allowance)
  for (let i = 0; i < 400 && d.state.downloaded < 1.5 * 1024 * 1024; i++) { await sleep(25); }
  await d.pause();
  await running;
  assert.equal(d.state.status, 'paused');
  const mid = d.state.downloaded;
  assert.ok(mid > 0 && mid < d.state.size, 'paused mid-way: ' + mid);
  assert.ok(fs.existsSync(d.partPath));

  // Simulate an app restart: rebuild from the serialized state.
  const saved = JSON.parse(JSON.stringify(d.state));
  saved.segments.forEach((s) => { delete s.running; });
  saved.status = 'paused';
  const d2 = new Download(saved, {});
  d2.state.headers = {};
  await d2.start();
  assert.equal(d2.state.status, 'done', d2.state.error);
  assert.equal(sha(fs.readFileSync(d2.state.path)), sha(ctx.files['/big.bin']));
});

test('speed limiter caps throughput', async () => {
  const limiter = new SpeedLimiter(2 * 1024 * 1024); // 2 MiB/s
  const d = mk('/big.bin', { filename: 'limited.bin', limiter });
  const t0 = Date.now();
  await d.start();
  const secs = (Date.now() - t0) / 1000;
  assert.equal(d.state.status, 'done');
  // 8 MiB at 2 MiB/s with a 1s burst allowance => at least ~2.5s
  assert.ok(secs >= 2.5, `took only ${secs.toFixed(2)}s`);
  assert.ok(secs < 12, `took too long ${secs.toFixed(2)}s`);
});

test('unique name is chosen when file exists', async () => {
  fs.writeFileSync(path.join(tmp, 'exists.bin'), 'x');
  const { uniquePath } = require('../src/core/util');
  assert.equal(path.basename(uniquePath(tmp, 'exists.bin')), 'exists (1).bin');
});
