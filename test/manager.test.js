'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer, listen, sha } = require('./server');
const { DownloadManager } = require('../src/core/manager');
const { createApi } = require('../src/core/api');
const { categoryOf, folderFor } = require('../src/core/category');
const { sleep } = require('../src/core/util');

let src; let base; let tmp;
test.before(async () => {
  src = createServer();
  base = 'http://127.0.0.1:' + await listen(src.server);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlo-mgr-'));
});
test.after(() => { src.server.close(); src.server.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); });

const mkMgr = (name, extra = {}) => new DownloadManager({ dataDir: path.join(tmp, name, 'data'), downloadDir: path.join(tmp, name, 'dl'), ...extra });
async function waitStatus(m, id, status, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (m.list().find((x) => x.id === id)?.status === status) { return; }
    await sleep(30);
  }
  throw new Error('timeout waiting for ' + status + ', got ' + JSON.stringify(m.list().find((x) => x.id === id)));
}

test('categoryOf / folderFor classify files like IDM does', () => {
  assert.equal(categoryOf('movie.MKV'), 'video');
  assert.equal(categoryOf('https://h/a/b/song.mp3?x=1'), 'music');
  assert.equal(categoryOf('https://h/setup.exe'), 'program');
  assert.equal(categoryOf('pack.7z'), 'archive');
  assert.equal(categoryOf('bao-cao.PDF'), 'document');
  assert.equal(categoryOf('mystery.bin'), 'other');
  assert.equal(categoryOf('index', 'hls'), 'video');
  assert.equal(folderFor('/d', 'a.mp3'), path.join('/d', 'Music'));
});

test('pending task: probe fills name/size, rename + confirm starts the download', async () => {
  const m = mkMgr('pending');
  const id = m.add({ url: base + '/attach', start: false, pending: true });
  assert.equal(m.list()[0].pending, true);
  assert.equal(m.list()[0].status, 'paused');
  const info = await m.probeInfo(id);
  assert.equal(info.filename, 'Báo cáo tổng kết.bin');
  assert.equal(info.size, 1024 * 1024 + 123);
  assert.equal(info.resumable, true);
  m.update(id, { filename: 'Tên khác?.bin', connections: 4, dir: path.join(tmp, 'pending', 'custom') });
  m.confirm(id, { start: true });
  assert.equal(m.list()[0].pending, false);
  await waitStatus(m, id, 'done');
  const t = m.list()[0];
  assert.equal(path.basename(t.path), 'Tên khác_.bin', 'illegal characters are replaced');
  assert.equal(path.dirname(t.path), path.join(tmp, 'pending', 'custom'));
  assert.equal(sha(fs.readFileSync(t.path)), sha(src.files['/attach']));
});

test('"download later": confirm without starting keeps the task paused and resumable', async () => {
  const m = mkMgr('later');
  const id = m.add({ url: base + '/big.bin', start: false, pending: true, filename: 'later.bin' });
  m.confirm(id, { start: false });
  assert.equal(m.list()[0].status, 'paused');
  assert.equal(m.list()[0].pending, false);
  m.resume(id);
  await waitStatus(m, id, 'done');
  assert.equal(sha(fs.readFileSync(m.list()[0].path)), sha(src.files['/big.bin']));
});

test('probe reports errors without throwing', async () => {
  const m = mkMgr('probeerr');
  const id = m.add({ url: base + '/missing', start: false, pending: true });
  const info = await m.probeInfo(id);
  assert.match(info.probeError, /404/);
});

test('cancelling a pending task removes it and leaves no files', async () => {
  const m = mkMgr('cancel');
  const id = m.add({ url: base + '/big.bin', start: false, pending: true, filename: 'x.bin' });
  await m.remove(id);
  assert.equal(m.list().length, 0);
  assert.equal(fs.existsSync(path.join(tmp, 'cancel', 'dl', 'x.bin.part')), false);
});

test('pending flag does not survive a restart and the task stays resumable', async () => {
  const m = mkMgr('restart');
  m.add({ url: base + '/big.bin', start: false, pending: true, filename: 'r.bin' });
  m.saveNow();
  const m2 = mkMgr('restart');
  m2.load();
  assert.equal(m2.list().length, 1);
  assert.equal(m2.list()[0].pending, false);
  assert.equal(m2.list()[0].status, 'paused');
});

test('queue honours maxConcurrent', async () => {
  const m = mkMgr('queue', { maxConcurrent: 1, speedLimit: 4 * 1024 * 1024 });
  const a = m.add({ url: base + '/big.bin', filename: 'q1.bin' });
  const b = m.add({ url: base + '/big.bin', filename: 'q2.bin' });
  await sleep(150);
  const st = Object.fromEntries(m.list().map((x) => [x.id, x.status]));
  assert.equal(st[a], 'downloading');
  assert.equal(st[b], 'queued');
  await waitStatus(m, b, 'done', 20000);
  assert.equal(m.list().find((x) => x.id === a).status, 'done');
});

test('API: browser-supplied "dir" is ignored and onAdd hook receives sanitised items', async () => {
  const m = mkMgr('api');
  const seen = [];
  const api = createApi(m, { port: 0, onAdd: (items) => { seen.push(...items); return items.map(() => 'x'); } });
  await api.listen();
  const http = require('http');
  const post = (body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: api.port, path: '/api/add', method: 'POST', headers: { origin: 'moz-extension://u', 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end(data);
  });
  assert.equal(await post({ items: [{ url: base + '/big.bin', dir: 'C:\\Windows\\System32', headers: { cookie: 'a=b', evil: 'x' }, filename: '..\\..\\boot.ini' }] }), 200);
  assert.equal(seen.length, 1);
  assert.equal('dir' in seen[0], false);
  assert.deepEqual(Object.keys(seen[0].headers), ['cookie']);
  await api.close();
  // And the file name is neutralised by the engine before touching disk:
  const { sanitizeFilename } = require('../src/core/util');
  for (const evil of ['..\\..\\boot.ini', '../../etc/passwd', '..', '.', 'a/../../b', 'C:\\Windows\\x.dll']) {
    const clean = sanitizeFilename(evil);
    assert.ok(!/[\\/:]/.test(clean) && !clean.startsWith('.') && clean.length > 0, `unsafe: ${JSON.stringify(clean)} from ${evil}`);
  }
  assert.equal(sanitizeFilename('CON.txt'), '_CON.txt');
});

test('file names from outside are stripped of path parts on add and on confirm-dialog edits', () => {
  const m = new DownloadManager({ dataDir: require('os').tmpdir() + '/sg-san-' + Date.now(), downloadDir: require('os').tmpdir() });
  const id = m.add({ url: 'https://x.example/a.bin', filename: '..\\..\\Windows\\evil.exe', start: false });
  assert.ok(!/[\\/]/.test(m.get(id).state.filename), m.get(id).state.filename);
  assert.match(m.get(id).state.filename, /evil\.exe$/);
  m.update(id, { filename: 'C:\\Windows\\System32\\boot.ini' });
  assert.ok(!/[\\/:]/.test(m.get(id).state.filename), m.get(id).state.filename);
  const ok = m.add({ url: 'https://x.example/b.bin', filename: 'Báo cáo tháng 10.pdf', start: false });
  assert.equal(m.get(ok).state.filename, 'Báo cáo tháng 10.pdf', 'normal names are untouched');
});

// ---------------------------------------------------------------- queue under load

async function runQueueScenario(name, { count, max, viaConfirm }) {
  const m = mkMgr(name, { maxConcurrent: max, speedLimit: 3 * 1024 * 1024 });
  const order = [];
  const seen = new Set();
  let peak = 0;
  m.on('update', (s) => { if (s.status === 'downloading' && !seen.has(s.id)) { seen.add(s.id); order.push(s.id); } });
  const sampler = setInterval(() => { peak = Math.max(peak, m.list().filter((x) => x.status === 'downloading').length); }, 10);
  const ids = [];
  for (let i = 0; i < count; i++) {
    ids.push(m.add({ url: base + '/attach', filename: `${name}-${i}.bin`, start: !viaConfirm, pending: viaConfirm }));
  }
  if (viaConfirm) { for (const id of ids) { m.confirm(id, { start: true }); } } // user accepts N confirm dialogs in a row
  await sleep(120);
  const snap = m.list();
  const early = snap.filter((x) => x.status === 'downloading').length;
  const finishedAlready = snap.filter((x) => x.status === 'done').length;
  // everything that is neither running nor finished is waiting in the queue
  const waiting = snap.filter((x) => x.status === 'queued').length;
  assert.equal(early + finishedAlready + waiting, count, 'every task is running, done or waiting');
  for (const id of ids) { await waitStatus(m, id, 'done', 30000); }
  clearInterval(sampler);
  return { m, ids, order, peak, early, waiting };
}

test('queue: 12 downloads added at once never run more than maxConcurrent, the rest wait and start in order', async () => {
  const r = await runQueueScenario('qload', { count: 12, max: 2, viaConfirm: false });
  assert.ok(r.peak <= 2, 'peak concurrency was ' + r.peak);
  assert.equal(r.early, 2, 'only 2 should be running right after adding');
  assert.ok(r.waiting >= 6, 'most of the others should still be waiting in the queue, got ' + r.waiting);
  assert.deepEqual(r.order, r.ids, 'FIFO start order');
});

test('queue: accepting many confirm dialogs in a row still respects maxConcurrent', async () => {
  const r = await runQueueScenario('qconfirm', { count: 8, max: 3, viaConfirm: true });
  assert.ok(r.peak <= 3, 'peak concurrency was ' + r.peak);
  assert.equal(r.early, 3);
  assert.deepEqual(r.order, r.ids);
});

test('queue: lowering maxConcurrent while running does not start more, raising it starts waiting ones', async () => {
  const m = mkMgr('qchange', { maxConcurrent: 1, speedLimit: 1024 * 1024 });
  const ids = [0, 1, 2, 3].map((i) => m.add({ url: base + '/attach', filename: `c${i}.bin` }));
  await sleep(100);
  assert.equal(m.list().filter((x) => x.status === 'downloading').length, 1);
  m.setMaxConcurrent(3);
  await sleep(100);
  assert.equal(m.list().filter((x) => x.status === 'downloading').length, 3);
  for (const id of ids) { await waitStatus(m, id, 'done', 30000); }
});

// ---------------------------------------------------------------- removing: list entry vs. file on disk

async function finished(name) {
  const m = mkMgr(name);
  const id = m.add({ url: base + '/attach', filename: `${name}.bin` });
  await waitStatus(m, id, 'done');
  return { m, id, file: m.get(id).state.path };
}

test('remove: by default a finished download leaves the saved file alone', async () => {
  const { m, id, file } = await finished('keep');
  assert.ok(fs.existsSync(file));
  await m.remove(id);
  assert.equal(m.list().length, 0);
  assert.ok(fs.existsSync(file), 'the file the user downloaded must survive removing the list entry');
});

test('remove: deleteFile=true removes the saved file too', async () => {
  const { m, id, file } = await finished('wipe');
  await m.remove(id, { deleteFile: true });
  assert.equal(fs.existsSync(file), false);
});

test('remove: an unfinished download only loses its own partial data, never another file', async () => {
  const m = mkMgr('partial', { speedLimit: 256 * 1024 });
  const bystander = path.join(tmp, 'partial', 'dl', 'unrelated.bin');
  fs.mkdirSync(path.dirname(bystander), { recursive: true });
  fs.writeFileSync(bystander, 'mine');
  const id = m.add({ url: base + '/big.bin', filename: 'partial.bin' });
  await sleep(300);
  const target = m.get(id).state.path;
  await m.remove(id);
  assert.equal(fs.existsSync(target + '.part'), false, 'partial data cleaned up');
  assert.equal(fs.existsSync(bystander), true);
});

test('clearDone-style removal of finished items never touches the files', async () => {
  const { m, id, file } = await finished('cleardone');
  for (const t of m.list()) { if (t.status === 'done') { await m.remove(t.id); } }
  assert.ok(fs.existsSync(file));
});

test('queue: "download first" jumps a waiting item ahead, "move to end" sends it back', async () => {
  const m = mkMgr('qprio', { maxConcurrent: 1, speedLimit: 64 * 1024 });
  const ids = [0, 1, 2, 3, 4].map((i) => m.add({ url: base + '/attach', filename: `p${i}.bin` }));
  const running = m.list().find((x) => x.status === 'downloading');
  const waiting = ids.filter((id) => id !== running.id); // in the order they were added
  assert.equal(waiting.length, 4);
  assert.equal(m.prioritize([waiting[3]], 'top'), 1);
  assert.equal(m.prioritize([waiting[0]], 'bottom'), 1);
  assert.equal(m.prioritize([running.id], 'top'), 0, 'a running item is not queued, nothing to move');
  const order = [];
  m.on('update', (s) => { if (s.status === 'downloading' && s.id !== running.id && !order.includes(s.id)) { order.push(s.id); } });
  for (const id of ids) { await waitStatus(m, id, 'done', 120000); }
  assert.deepEqual(order, [waiting[3], waiting[1], waiting[2], waiting[0]]);
});
