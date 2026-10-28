'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { SegmentedDownload } = require('../src/core/segmented');
const { SpeedLimiter } = require('../src/core/limiter');
const { parseM3u8, pickVariant } = require('../src/core/hls');
const { parseMpd } = require('../src/core/dash');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const skip = hasFfmpeg ? false : 'ffmpeg không có trong PATH';

let root; let out; let server; let base;

function ff(args) {
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}
function probeFile(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  return { duration: Number(j.format.duration), types: j.streams.map((s) => s.codec_type).sort() };
}
const SRC = ['-f', 'lavfi', '-i', 'testsrc=d=8:s=320x240:r=25', '-f', 'lavfi', '-i', 'sine=d=8'];
const ENC = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '50', '-c:a', 'aac'];

test.before(async () => {
  if (!hasFfmpeg) { return; }
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlo-media-'));
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlo-out-'));
  // plain TS HLS
  fs.mkdirSync(path.join(root, 'ts'));
  ff([...SRC, ...ENC, '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', 'ts/s%d.ts', 'ts/index.m3u8']);
  // AES-128 HLS
  fs.mkdirSync(path.join(root, 'enc'));
  fs.writeFileSync(path.join(root, 'enc/enc.key'), Buffer.from('0123456789abcdef'));
  fs.writeFileSync(path.join(root, 'enc/keyinfo'), 'enc.key\n' + path.join(root, 'enc/enc.key') + '\n');
  ff([...SRC, ...ENC, '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_key_info_file', 'enc/keyinfo', '-hls_segment_filename', 'enc/s%d.ts', 'enc/index.m3u8']);
  // fMP4 HLS
  fs.mkdirSync(path.join(root, 'fmp4'));
  ff([...SRC, ...ENC, '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', 'fmp4/s%d.m4s', 'fmp4/index.m3u8']);
  // low quality variant + master
  fs.mkdirSync(path.join(root, 'low'));
  ff(['-f', 'lavfi', '-i', 'testsrc=d=8:s=160x120:r=25', '-f', 'lavfi', '-i', 'sine=d=8', ...ENC, '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', 'low/s%d.ts', 'low/index.m3u8']);
  fs.writeFileSync(path.join(root, 'master.m3u8'),
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=160x120\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=320x240\nts/index.m3u8\n');
  // DASH with template/timeline (separate audio+video adaptation sets)
  fs.mkdirSync(path.join(root, 'dash'));
  ff([...SRC, ...ENC, '-f', 'dash', '-seg_duration', '2', '-use_template', '1', '-use_timeline', '1', 'dash/manifest.mpd']);
  // DASH single file (SegmentBase)
  fs.mkdirSync(path.join(root, 'dash1'));
  ff([...SRC, ...ENC, '-f', 'dash', '-seg_duration', '2', '-single_file', '1', '-use_template', '0', '-use_timeline', '0', 'dash1/manifest.mpd']);

  const types = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.mp4': 'video/mp4', '.m4s': 'video/iso.segment', '.mpd': 'application/dash+xml' };
  server = http.createServer((req, res) => {
    const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    const buf = fs.readFileSync(p);
    const h = { 'content-type': types[path.extname(p)] || 'application/octet-stream', 'accept-ranges': 'bytes' };
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const a = Number(m[1]); const b = m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
      res.writeHead(206, { ...h, 'content-range': `bytes ${a}-${b}/${buf.length}`, 'content-length': b - a + 1 });
      return res.end(buf.subarray(a, b + 1));
    }
    res.writeHead(200, { ...h, 'content-length': buf.length });
    res.end(buf);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => {
  if (server) { server.close(); server.closeAllConnections?.(); }
  for (const d of [root, out]) { if (d) { fs.rmSync(d, { recursive: true, force: true }); } }
});

async function run(kind, urlPath, extra = {}) {
  const st = SegmentedDownload.create({ id: 'x' + Math.random(), url: base + urlPath, dir: out, kind, filename: extra.filename, quality: extra.quality });
  const d = new SegmentedDownload(st, {});
  d.on('error', () => {});
  await d.start();
  assert.equal(st.status, 'done', st.error);
  return st;
}

test('m3u8 parser: master picks highest quality, media parses keys and ranges', () => {
  const master = parseM3u8('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=640x360\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=500,RESOLUTION=1280x720\nb.m3u8\n', 'http://h/p/m.m3u8');
  assert.equal(master.type, 'master');
  assert.equal(pickVariant(master.variants).url, 'http://h/p/b.m3u8');
  assert.equal(pickVariant(master.variants, 'worst').url, 'http://h/p/a.m3u8');
  assert.equal(pickVariant(master.variants, 400).url, 'http://h/p/a.m3u8');
  const media = parseM3u8('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"\n#EXTINF:2,\ns.ts\n#EXT-X-ENDLIST\n', 'http://h/');
  assert.match(media.unsupported, /DRM/);
});

test('mpd parser handles SegmentTimeline templates', () => {
  const mpd = parseMpd(`<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT6S"><Period><AdaptationSet contentType="video" mimeType="video/mp4">
    <SegmentTemplate timescale="1000" initialization="i-$RepresentationID$.mp4" media="s-$RepresentationID$-$Number%05d$.m4s" startNumber="1">
    <SegmentTimeline><S t="0" d="2000" r="2"/></SegmentTimeline></SegmentTemplate>
    <Representation id="v1" bandwidth="1000" width="640" height="360"/></AdaptationSet></Period></MPD>`, 'http://h/d/m.mpd');
  assert.equal(mpd.video[0].segments.length, 3);
  assert.equal(mpd.video[0].segments[2].url, 'http://h/d/s-v1-00003.m4s');
  assert.equal(mpd.video[0].init.url, 'http://h/d/i-v1.mp4');
});

test('HLS (TS) downloads, merges and remuxes to a playable MP4', { skip }, async () => {
  const st = await run('hls', '/ts/index.m3u8', { filename: 'plain.mp4' });
  const info = probeFile(st.path);
  assert.ok(Math.abs(info.duration - 8) < 0.6, 'duration ' + info.duration);
  assert.deepEqual(info.types, ['audio', 'video']);
  assert.equal(fs.existsSync(st.path + '.parts'), false);
});

test('HLS AES-128 encrypted stream is decrypted', { skip }, async () => {
  const st = await run('hls', '/enc/index.m3u8', { filename: 'enc.mp4' });
  const info = probeFile(st.path);
  assert.ok(Math.abs(info.duration - 8) < 0.6, 'duration ' + info.duration);
  assert.deepEqual(info.types, ['audio', 'video']);
});

test('HLS fMP4 (init + m4s) works', { skip }, async () => {
  const st = await run('hls', '/fmp4/index.m3u8', { filename: 'fmp4.mp4' });
  const info = probeFile(st.path);
  assert.ok(Math.abs(info.duration - 8) < 0.6, 'duration ' + info.duration);
  assert.deepEqual(info.types, ['audio', 'video']);
});

test('HLS master playlist: best quality chosen by default, worst on request', { skip }, async () => {
  const hi = await run('hls', '/master.m3u8', { filename: 'hi.mp4' });
  const lo = await run('hls', '/master.m3u8', { filename: 'lo.mp4', quality: 'worst' });
  const h = (f) => Number(spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout);
  assert.equal(h(hi.path), 240);
  assert.equal(h(lo.path), 120);
});

test('DASH with templates: video+audio tracks are muxed', { skip }, async () => {
  const st = await run('dash', '/dash/manifest.mpd', { filename: 'dash.mp4' });
  const info = probeFile(st.path);
  assert.ok(Math.abs(info.duration - 8) < 0.6, 'duration ' + info.duration);
  assert.deepEqual(info.types, ['audio', 'video']);
});

test('DASH single-file representations use the multi-connection engine', { skip }, async () => {
  const st = await run('dash', '/dash1/manifest.mpd', { filename: 'dash1.mp4' });
  const info = probeFile(st.path);
  assert.ok(Math.abs(info.duration - 8) < 0.6, 'duration ' + info.duration);
  assert.deepEqual(info.types, ['audio', 'video']);
});

test('pause and resume an HLS download', { skip }, async () => {
  const st = SegmentedDownload.create({ id: 'p1', url: base + '/ts/index.m3u8', dir: out, kind: 'hls', filename: 'paused.mp4', connections: 1 });
  const d = new SegmentedDownload(st, { limiter: new SpeedLimiter(40 * 1024) });
  d.on('error', () => {});
  const running = d.start();
  for (let i = 0; i < 600 && st.segDone < 1; i++) { await new Promise((r) => setTimeout(r, 10)); }
  assert.ok(st.segDone >= 1 && st.segDone < st.segTotal, `segDone=${st.segDone}/${st.segTotal}`);
  await d.pause();
  await running;
  assert.equal(st.status, 'paused');
  assert.ok(fs.existsSync(st.path + '.parts'), 'parts kept for resume');
  const d2 = new SegmentedDownload(JSON.parse(JSON.stringify(st)), {});
  d2.state.status = 'paused';
  await d2.start();
  assert.equal(d2.state.status, 'done', d2.state.error);
  assert.ok(Math.abs(probeFile(d2.state.path).duration - 8) < 0.6);
});

test('cancel (remove) of a running HLS download returns quickly and cleans up', { skip }, async () => {
  const st = SegmentedDownload.create({ id: 'c1', url: base + '/ts/index.m3u8', dir: out, kind: 'hls', filename: 'cancelled.mp4', connections: 2 });
  const d = new SegmentedDownload(st, { limiter: new SpeedLimiter(50 * 1024), ffmpegPath: 'ffmpeg' });
  d.on('error', () => {});
  const run = d.start();
  await new Promise((r) => setTimeout(r, 600));
  const t0 = Date.now();
  await d.cancel({ removeFile: true });
  await run;
  assert.ok(Date.now() - t0 < 4000, 'cancel took ' + (Date.now() - t0));
  assert.equal(fs.existsSync(d.partsDir), false);
});
