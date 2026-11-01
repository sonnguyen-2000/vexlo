'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DownloadManager, detectKind } = require('../src/core/manager');
const { isMediaUrl, formatSelector, parseProgress, parseInfo, friendlyError } = require('../src/core/ytdlp');

process.env.VEXLO_TEST_NODE_SCRIPTS = '1'; // the stand-in for yt-dlp is a Node script

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// A stand-in for yt-dlp: answers --version and -J, then "downloads" a video and a sound stream and writes the file.
function fakeYtdlp(dir) {
  const f = path.join(dir, 'fake-ytdlp.js');
  fs.writeFileSync(f, `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(a) + '\\n');
const mode = process.env.FAKE_MODE || 'ok';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  if (a.includes('--version')) { console.log('2099.01.01'); return; }
  if (a.includes('-J')) {
    if (mode === 'login') { console.error("ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser"); process.exitCode = 1; return; }
    console.log(JSON.stringify({ id: 'abc', title: 'Bài hát: thử/nghiệm?', extractor_key: 'Youtube', ext: 'webm', duration: 30, uploader: 'Kênh A', thumbnail: 'https://i.ytimg.com/vi/abc/hq.jpg', formats: [{ height: 360 }, { height: 1080 }, { height: null }],
      requested_formats: [{ filesize: 4000 }, { filesize: 1000 }] }));
    return;
  }
  const o = a[a.indexOf('-o') + 1];
  const out = o.replace('%(ext)s', a.includes('-x') ? 'mp3' : 'mp4');
  const line = (d, t, s) => console.log('VXP|' + d + '|' + t + '|NA|' + s + '|1');
  const slow = mode === 'slow' ? 150 : 5;
  for (const [t, n] of [[4000, 4], [1000, 2]]) {
    for (let i = 1; i <= n; i++) { line(Math.round((t * i) / n), t, 1000); await sleep(slow); }
  }
  if (mode === 'slow') { for (let i = 0; i < 20; i++) { await sleep(100); } }
  console.log('[Merger] Merging formats into "' + out + '"');
  fs.writeFileSync(out, 'FAKEVIDEO' + a.join(' ').length);
})();
`);
  fs.chmodSync(f, 0o755);
  return f;
}

async function until(fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) { return v; } await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timeout waiting');
}

function setup(mode = 'ok') {
  const work = tmp('vx-yt-');
  const fake = fakeYtdlp(work);
  process.env.VEXLO_YTDLP = fake;
  process.env.FAKE_LOG = path.join(work, 'calls.log');
  process.env.FAKE_MODE = mode;
  const dl = path.join(work, 'dl');
  fs.mkdirSync(dl);
  const m = new DownloadManager({ dataDir: path.join(work, 'data'), downloadDir: dl, binDir: path.join(work, 'bin'), media: { cookies: 'firefox' } });
  fs.mkdirSync(path.join(work, 'data'), { recursive: true });
  m.on('error', () => {});
  const calls = () => (fs.existsSync(process.env.FAKE_LOG) ? fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { m, dl, work, calls, done: () => { delete process.env.VEXLO_YTDLP; fs.rmSync(work, { recursive: true, force: true }); } };
}

test('isMediaUrl: video pages of YouTube, TikTok, Facebook, Instagram; not plain files or other pages', () => {
  const yes = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ', 'https://m.youtube.com/shorts/abc123', 'https://www.youtube.com/live/xyz',
    'https://www.tiktok.com/@user/video/7234567890123456789', 'https://vm.tiktok.com/ZMabc123/', 'https://www.tiktok.com/t/ZTabc/',
    'https://www.facebook.com/watch/?v=123456', 'https://www.facebook.com/reel/1234567890', 'https://www.facebook.com/user/videos/1234567890', 'https://fb.watch/abc123/', 'https://www.facebook.com/share/v/1AbCd/',
    'https://www.instagram.com/reel/Cabc123/',
  ];
  const no = [
    'https://www.youtube.com/', 'https://www.youtube.com/@channel', 'https://www.youtube.com/results?search_query=x', 'https://www.tiktok.com/@user', 'https://www.facebook.com/',
    'https://www.facebook.com/somepage', 'https://video.fbcdn.net/v/clip.mp4', 'https://example.com/watch?v=1', 'https://files.example.com/a.zip', 'ftp://youtu.be/abc', 'not a url',
    'https://notyoutube.com/watch?v=1', 'https://youtube.com.evil.test/watch?v=1',
  ];
  for (const u of yes) { assert.equal(isMediaUrl(u), true, u); assert.equal(detectKind(u), 'media', u); }
  for (const u of no) { assert.equal(isMediaUrl(u), false, u); }
  assert.equal(detectKind('https://example.com/a.m3u8'), 'hls');
});

test('formatSelector, parseProgress, parseInfo', () => {
  assert.deepEqual(formatSelector('audio'), { fmt: 'ba/b', audio: true });
  assert.match(formatSelector('720').fmt, /height<=720/);
  assert.equal(formatSelector('best').audio, false);
  assert.deepEqual(parseProgress('VXP|1000|4000|NA|250.5|12'), { done: 1000, total: 4000, speed: 250.5, eta: 12 });
  assert.deepEqual(parseProgress('VXP|1000|NA|5000|NA|NA'), { done: 1000, total: 5000, speed: 0, eta: 0 });
  assert.equal(parseProgress('[download] 50%'), null);
  const i = parseInfo({ id: 'x', title: 'T', ext: 'webm', requested_formats: [{ filesize: 10 }, { filesize_approx: 5 }] }, false);
  assert.equal(i.total, 15); assert.equal(i.ext, 'mp4'); assert.equal(i.title, 'T');
  assert.equal(parseInfo({ title: 'S', ext: 'm4a' }, true).ext, 'mp3');
  assert.equal(parseInfo({ entries: [{ title: 'First', ext: 'mp4' }] }, false).title, 'First');
  assert.equal(parseInfo('not json', false), null);
});

test('friendlyError names the cause in plain words', () => {
  assert.equal(friendlyError("ERROR: [youtube] x: Sign in to confirm you're not a bot").code, 'login');
  assert.equal(friendlyError('ERROR: This video is private').code, 'private');
  assert.equal(friendlyError('ERROR: Unsupported URL: https://x').code, 'unsupported');
  assert.equal(friendlyError('ERROR: Video unavailable').code, 'unavailable');
  assert.equal(friendlyError('ERROR: HTTP Error 429: Too Many Requests').code, 'rate');
  assert.equal(friendlyError('ERROR: unable to extract nsig function').code, 'extract');
  assert.equal(friendlyError('ERROR: Unable to download: getaddrinfo failed').code, 'network');
  assert.equal(friendlyError('ERROR: something odd happened').message, 'something odd happened');
});

test('a YouTube link is downloaded through yt-dlp: title as file name, two streams counted as one progress, quality and cookies passed on', async () => {
  const s = setup();
  try {
    const seen = [];
    s.m.on('update', (x) => { if (x.kind === 'media') { seen.push(x); } });
    const id = s.m.add({ url: 'https://www.youtube.com/watch?v=abc', dir: s.dl, quality: '720' });
    assert.equal(s.m.get(id).state.kind, 'media');
    await until(() => s.m.get(id).state.status === 'done');
    const st = s.m.get(id).state;
    assert.equal(st.filename, 'Bài hát_ thử_nghiệm_.mp4');
    assert.equal(path.dirname(st.path), s.dl);
    assert.ok(fs.existsSync(st.path));
    assert.equal(st.size, fs.statSync(st.path).size);
    // progress never went backwards when the second stream started, and the total was known from the start
    let last = 0;
    for (const x of seen.filter((v) => v.status === 'downloading' && v.downloaded)) { assert.ok(x.downloaded >= last, 'progress went back'); last = x.downloaded; }
    assert.ok(seen.some((x) => x.size === 5000));
    const dlArgs = s.calls().find((a) => a.includes('--newline'));
    assert.ok(dlArgs.includes('--no-playlist'));
    assert.ok(dlArgs.join(' ').includes('height<=720'));
    assert.deepEqual(dlArgs.slice(dlArgs.indexOf('--cookies-from-browser'), dlArgs.indexOf('--cookies-from-browser') + 2), ['--cookies-from-browser', 'firefox']);
    assert.ok(dlArgs.includes('--merge-output-format'));
  } finally { s.done(); }
});

test('audio only asks yt-dlp for MP3', async () => {
  const s = setup();
  try {
    const id = s.m.add({ url: 'https://youtu.be/abc', dir: s.dl, quality: 'audio' });
    await until(() => s.m.get(id).state.status === 'done');
    assert.match(s.m.get(id).state.filename, /\.mp3$/);
    assert.ok(s.calls().find((a) => a.includes('--newline')).includes('-x'));
  } finally { s.done(); }
});

test('a second video with the same title gets a numbered name', async () => {
  const s = setup();
  try {
    const a = s.m.add({ url: 'https://www.youtube.com/watch?v=abc', dir: s.dl });
    await until(() => s.m.get(a).state.status === 'done');
    const b = s.m.add({ url: 'https://www.youtube.com/watch?v=def', dir: s.dl });
    await until(() => s.m.get(b).state.status === 'done');
    assert.notEqual(s.m.get(a).state.filename, s.m.get(b).state.filename);
    assert.match(s.m.get(b).state.filename, /\(2\)\.mp4$/);
  } finally { s.done(); }
});

test('a login wall is reported with what to do, as an error', async () => {
  const s = setup('login');
  try {
    const id = s.m.add({ url: 'https://www.youtube.com/watch?v=abc', dir: s.dl });
    await until(() => s.m.get(id).state.status === 'error');
    assert.match(s.m.get(id).state.error, /đăng nhập|xác minh/);
    assert.match(s.m.get(id).state.error, /Cookie|trình duyệt/);
  } finally { s.done(); }
});

test('pause stops yt-dlp, resume finishes the download; remove cleans up', async () => {
  const s = setup('slow');
  try {
    const id = s.m.add({ url: 'https://www.tiktok.com/@u/video/7234567890123456789', dir: s.dl });
    await until(() => s.m.get(id).state.downloaded > 0);
    await s.m.pause(id);
    assert.equal(s.m.get(id).state.status, 'paused');
    const before = s.m.get(id).state.downloaded;
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(s.m.get(id).state.downloaded, before); // really stopped
    s.m.resume(id);
    await until(() => s.m.get(id).state.status === 'done', 12000);
    assert.ok(fs.existsSync(s.m.get(id).state.path));
    await s.m.remove(id, { deleteFile: true });
    assert.deepEqual(fs.readdirSync(s.dl), []);
  } finally { s.done(); }
});

test('the speed limit is handed to yt-dlp', async () => {
  const s = setup();
  try {
    s.m.limiter.setLimit(300 * 1024);
    const id = s.m.add({ url: 'https://youtu.be/abc', dir: s.dl });
    await until(() => s.m.get(id).state.status === 'done');
    const a = s.calls().find((x) => x.includes('--newline'));
    assert.equal(a[a.indexOf('--limit-rate') + 1], '300K');
  } finally { s.done(); }
});

test('ensureYtdlp downloads the program once, checks that it runs, and updates on request', async () => {
  const http = require('http');
  const { ensureYtdlp, ytdlpVersion, binaryName } = require('../src/core/ytdlp');
  let version = '2099.01.01'; let hits = 0;
  const srv = http.createServer((req, res) => {
    if (req.url === '/redir/' + binaryName()) { res.writeHead(302, { location: '/real/' + binaryName() }); return res.end(); }
    hits++;
    const body = `#!/usr/bin/env node\nif (process.argv.includes('--version')) console.log('${version}');\n`;
    res.writeHead(200, { 'content-length': Buffer.byteLength(body) }); res.end(body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const dir = tmp('vx-bin-');
  const keep = { u: process.env.VEXLO_YTDLP, l: process.env.VEXLO_YTDLP_URL };
  delete process.env.VEXLO_YTDLP;
  process.env.VEXLO_YTDLP_URL = `http://127.0.0.1:${srv.address().port}/redir/`;
  try {
    assert.equal(await ytdlpVersion(dir), '');
    const f = await ensureYtdlp(dir);
    assert.equal(await ytdlpVersion(dir), '2099.01.01');
    await ensureYtdlp(dir); assert.equal(hits, 1); // already there: not fetched again
    version = '2100.02.02';
    await ensureYtdlp(dir, { force: true });
    assert.equal(await ytdlpVersion(dir), '2100.02.02');
    assert.ok(f.startsWith(dir));
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.new')), []);
  } finally {
    srv.close(); srv.closeAllConnections?.(); fs.rmSync(dir, { recursive: true, force: true });
    if (keep.u) { process.env.VEXLO_YTDLP = keep.u; }
    if (keep.l) { process.env.VEXLO_YTDLP_URL = keep.l; } else { delete process.env.VEXLO_YTDLP_URL; }
  }
});

test('probeInfo of a video link returns title, picture address, length, uploader and best height, and names the task after the title', async () => {
  const s = setup();
  try {
    const id = s.m.add({ url: 'https://www.youtube.com/watch?v=abc', dir: s.dl, pending: true, start: false });
    const info = await s.m.probeInfo(id);
    assert.equal(info.media.ok, true);
    assert.equal(info.media.title, 'Bài hát: thử/nghiệm?');
    assert.equal(info.media.thumbnail, 'https://i.ytimg.com/vi/abc/hq.jpg');
    assert.equal(info.media.duration, 30);
    assert.equal(info.media.uploader, 'Kênh A');
    assert.equal(info.media.maxHeight, 1080);
    assert.equal(info.filename, 'Bài hát_ thử_nghiệm_.mp4');
    assert.equal(s.m.get(id).state.status, 'paused'); // only looking: nothing was downloaded
    assert.ok(s.calls().some((a) => a.includes('--skip-download')));
  } finally { s.done(); }
});

test('probeInfo of a video link that needs a login reports why, without throwing', async () => {
  const s = setup('login');
  try {
    const id = s.m.add({ url: 'https://www.youtube.com/watch?v=abc', dir: s.dl, pending: true, start: false });
    const info = await s.m.probeInfo(id);
    assert.equal(info.media.ok, false);
    assert.match(info.probeError, /đăng nhập|xác minh/);
  } finally { s.done(); }
});
