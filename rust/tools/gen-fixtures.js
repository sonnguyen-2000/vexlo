'use strict';
// Runs the original JavaScript helpers over many inputs and writes the results to
// vexlo-core/tests/fixtures/*.tsv. The Rust tests (tests/differential.rs) must give the same answers.
// Fields are hex-encoded UTF-8 so tabs and newlines in inputs are safe.
const fs = require('fs');
const path = require('path');
const util = require('../../src/core/util');
const category = require('../../src/core/category');
const { Download, planSegments, retryDelay, interpretProbe } = require('../../src/core/download');
const { classifyStatus, setProxy, getProxy, bypassProxy } = require('../../src/core/http');
const { SpeedMeter } = require('../../src/core/limiter');
const hls = require('../../src/core/hls');
const dash = require('../../src/core/dash');
const ytdlp = require('../../src/core/ytdlp');
const schedule = require('../../src/core/schedule');
const { findDuplicate } = require('../../src/core/dupes');

const hex = (s) => Buffer.from(String(s), 'utf8').toString('hex');
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

const POOL = ['a', 'B', 'z', '0', '9', ' ', ' ', '.', '.', '-', '_', '/', '\\', ':', '*', '?', '"', '<', '>', '|', '\t', '\n', 'é', 'ü', 'ệ', 'Ă', '日', '本', '\u00a0', '\u3000', '\ufffd', '\ufeff', '%', '%20', '%C3%A9', '%zz', '%E6%97%A5', ';', '=', "'", 'file', 'CON', 'nul', 'com1', 'LPT9', '.mp4', '.exe', '.zip', 'x'.repeat(40)];
const randomString = (n) => { let s = ''; const k = 1 + Math.floor(rnd() * n); for (let i = 0; i < k; i++) { s += pick(POOL); } return s; };

const out = { sanitize: [], cd: [], url: [], mime: [], web: [], pick: [], cat: [], plan: [], retry: [], sched: [], meter: [], classify: [], probe: [], proxy: [], bypass: [], urljoin: [], hls: [], variant: [], dash: [], dur: [], ytmedia: [], ytfmt: [], ytprog: [], yterr: [], tomin: [], dsched: [], limit: [], dupes: [], ytinfo: [] };

const sanitizeCases = ['', ' ', '...', 'a.b.c', 'CON', 'con.txt', 'com1', 'LPT1.log', 'COM0', 'a'.repeat(300) + '.mp4', '日本語'.repeat(80) + '.zip', 'x'.repeat(179) + '.verylongextension1234567890', 'file name . ', '  .hidden', 'a\u00a0\u00a0b', 'a:b*c?d"e<f>g|h', 'tab\there', '\ufffdabc\ufffd', '😀'.repeat(100) + '.mp4', '..a..', 'name.'];
for (let i = 0; i < 400; i++) { sanitizeCases.push(randomString(12)); }
for (const c of sanitizeCases) { out.sanitize.push([hex(c), hex(util.sanitizeFilename(c))]); }

const cdCases = [
  '', 'attachment', 'attachment; filename="a.zip"', 'attachment; filename=a.zip', 'attachment; filename = "a b.zip"', "attachment; filename*=UTF-8''%E6%97%A5%E6%9C%AC.zip",
  "attachment; filename*=utf-8'en'na%C3%AFve.pdf; filename=\"fallback.pdf\"", 'attachment; filename="a\\"b.zip"', 'attachment; filename="Ã©tÃ©.mp4"', 'attachment; filename="caf\u00c3\u00a9.mp4"',
  'attachment; filename=%E6%97%A5.zip', 'attachment; filename=bad%zz.zip', "attachment; filename*=ISO-8859-1''na%EFve.txt", 'inline; FILENAME="UP.TXT"', 'attachment; filename="unterminated', 'attachment; filename=;', 'attachment; filename= ;x=1',
  'attachment; filename="a\\\nb"', "attachment; filename*=UTF-8''", "attachment; filename*=UTF-8''\"quoted.txt\"", 'attachment;filename="x;y.zip"', 'form-data; name="f"; filename="photo 1.jpg"',
];
for (let i = 0; i < 300; i++) {
  const parts = ['attachment', 'inline', 'filename', 'filename*', '=', ' = ', '"', "'", ';', ' ', 'UTF-8', "UTF-8''", '%E6%97%A5', '%C3%A9', 'a.zip', 'é', 'Ã©', '\\', 'x', '\n'];
  let s = ''; const k = 2 + Math.floor(rnd() * 8); for (let j = 0; j < k; j++) { s += pick(parts); } cdCases.push(s);
}
for (const c of cdCases) { out.cd.push([hex(c), hex(util.filenameFromContentDisposition(c))]); }

const urlCases = [
  'https://example.com/a/b/file.zip', 'https://example.com/a/b/file.zip?x=1#y', 'https://example.com/', 'https://example.com', 'https://example.com/a%20b.mp4', 'https://example.com/%E6%97%A5%E6%9C%AC.zip',
  'https://example.com/a/../b/c.exe', 'https://example.com/a/./b.txt', 'https://example.com//a//b.txt', 'https://example.com/bad%zz.txt', 'http://host:8080/dl/f.iso', 'ftp://h/pub/x.tar.gz',
  'not a url', '', '//example.com/a.zip', 'https:///a.zip', 'blob:https://claude.ai/abc-123', 'data:text/plain,hi', 'file:///C:/a/b.txt', 'https://example.com/a\\b\\c.zip', 'HTTPS://EXAMPLE.com/Dir/F.ZIP',
  'https://example.com/a/b/', 'https://example.com/?q=file.zip', 'https://example.com/path/with space/file name.zip',
];
for (const c of urlCases) { out.url.push([hex(c), hex(util.filenameFromUrl(c))]); }

const mimeCases = ['video/mp4', 'VIDEO/MP4; codecs="x"', 'application/octet-stream', '', 'application/x-msdownload', 'image/webp ; q=1', 'audio/flac', 'application/vnd.apple.mpegurl', 'text/html'];
for (const c of mimeCases) { out.mime.push([hex(c), hex(util.extFromMime(c))]); }

const webCases = [];
const heads = ['<!DOCTYPE html><html>', '  \n<html lang="en">', '<HTML>', '<head><title>', '<body>', '<html', '<htmlx>', '<!doctype  html>', '<!doctypehtml>', '\ufeff<html>', 'PK\u0003\u0004zip', '', 'MZ\u0090', '<?xml version', '<body\n', '<head>'];
const names = ['a.zip', 'a.html', 'a.TXT', 'a', 'a.', 'a.svg', 'a.md', 'a.tar.gz', 'noext', 'a.JSON'];
for (const h of heads) { for (const n of names) { for (const size of [100, 6 * 1024 * 1024]) { webCases.push([n, size, h]); } } }
for (const [n, size, h] of webCases) { out.web.push([hex(n), String(size), hex(h), util.looksLikeWebPage({ mime: '', filename: n, size, head: Buffer.from(h, 'utf8') }) ? '1' : '0']); }

const pickCases = [
  ['', 'https://e.com/a.zip', 'application/zip', ''], ['attachment; filename="b.pdf"', 'https://e.com/a.zip', '', ''], ['', 'https://e.com/', 'video/mp4', ''], ['', 'https://e.com/dl', 'application/pdf', ''],
  ['', 'https://e.com/a.zip', '', 'Hint Name'], ['', 'https://e.com/a.zip', '', 'Clip: part 1?'], ['', '', '', ''], ['', 'https://e.com/%E6%97%A5', 'image/png', ''],
];
for (const [cd, url, mime, hint] of pickCases) { out.pick.push([hex(cd), hex(url), hex(mime), hex(hint), hex(util.pickFilename({ contentDisposition: cd, url, mime, hint }))]); }

const catCases = [['movie.MP4', 'file'], ['song.flac', 'file'], ['setup.exe', 'file'], ['x.zip', 'file'], ['doc.pdf', 'file'], ['noext', 'file'], ['x.unknown', 'file'], ['a.zip', 'hls'], ['a', 'media'], ['a.mp3', 'dash'],
  ['https://e.com/a/b/Setup.EXE?x=1', 'file'], ['https://e.com/a%20b.mkv', 'file'], ['https://e.com/dl', 'file'], ['https://e.com/a.b/c', 'file'], ['.hidden', 'file'], ['a.tar.gz', 'file'], ['dir/file.iso', 'file'], ['HTTP://E.com/X.JAR', 'file']];
for (const [n, k] of catCases) { out.cat.push([hex(n), hex(k), category.categoryOf(n, k), hex(category.extOf(n))]); }


// ---- segment planning, retry delays
for (const size of [1, 1000, 1048575, 1048576, 1048577, 2097152, 5000000, 123456789, 10 * 2 ** 30 + 7]) {
  for (const conn of [1, 2, 4, 8, 16, 32]) {
    const segs = planSegments(size, conn);
    out.plan.push([`${size},${conn}`, segs.map((x) => `${x.start}-${x.end}`).join(';')]);
  }
}
for (let attempt = 1; attempt <= 12; attempt++) { for (const ra of [0, 1234]) { out.retry.push([`${attempt},${ra}`, String(retryDelay(attempt, ra))]); } }

// ---- the scheduler: which ranges start, how a running range is split
const fmtSegs = (segs) => segs.map((x) => `${x.start},${x.end},${x.pos},${x.done ? 1 : 0},${x.running ? 1 : 0}`).join(';');
for (let i = 0; i < 400; i++) {
  const total = Math.floor(rnd() * 40 * 1024 * 1024) + 1;
  const n = 1 + Math.floor(rnd() * 8);
  const part = Math.floor(total / n);
  const segs = [];
  let running = 0;
  for (let k = 0; k < n; k++) {
    const start = k * part;
    const end = k === n - 1 ? total - 1 : start + part - 1;
    const kind = rnd();
    let pos = start;
    let done = false;
    let run = false;
    if (kind < 0.2) { pos = end + 1; done = true; } else if (kind < 0.35) { pos = start + Math.floor(rnd() * (end - start + 1)); } else if (kind < 0.8) { pos = start + Math.floor(rnd() * (end - start + 1)); run = true; }
    if (run) { running++; }
    segs.push({ start, end, pos, done, running: run });
  }
  const maxConn = 1 + Math.floor(rnd() * 10);
  const input = `${maxConn}|${fmtSegs(segs)}`;
  const dl = new Download(Download.create({ id: 1, url: 'http://x/', dir: '.', connections: maxConn }));
  dl.state.segments = segs.map((x) => ({ ...x }));
  dl._maxConn = maxConn;
  dl._running = running;
  const launched = [];
  let resolved = false;
  dl._launch = (seg) => { seg.running = true; dl._running++; launched.push(dl.state.segments.indexOf(seg)); };
  dl._segResolve = () => { resolved = true; };
  dl._schedule();
  out.sched.push([input, `${launched.join(',')}|${resolved ? 1 : 0}|${fmtSegs(dl.state.segments)}|${dl.state.downloaded}|${dl._running}`]);
}

// ---- speed meter with a controlled clock
const realNow = Date.now;
for (let i = 0; i < 300; i++) {
  const windowMs = pick([3000, 1000, 500, 10000]);
  const ops = [];
  const k = 3 + Math.floor(rnd() * 25);
  for (let j = 0; j < k; j++) {
    const r = rnd();
    if (r < 0.55) { ops.push(`a:${Math.floor(rnd() * 900)}:${Math.floor(rnd() * 5_000_000)}`); } else if (r < 0.95) { ops.push(`s:${Math.floor(rnd() * 2500)}`); } else { ops.push('r'); }
  }
  let t = 1_700_000_000_000;
  Date.now = () => t;
  const m = new SpeedMeter(windowMs);
  const res = [];
  const buf = new DataView(new ArrayBuffer(8));
  for (const op of ops) {
    const f = op.split(':');
    if (f[0] === 'a') { t += Number(f[1]); m.add(Number(f[2])); } else if (f[0] === 's') { t += Number(f[1]); buf.setFloat64(0, m.speed); res.push(buf.getBigUint64(0).toString(16)); } else { m.reset(); }
  }
  Date.now = realNow;
  out.meter.push([`${windowMs}|${ops.join(',')}`, res.join(',')]);
}

// ---- HTTP status handling
for (const status of [400, 401, 403, 404, 408, 410, 416, 429, 500, 502, 503, 504, 599]) {
  for (const ra of ['', '5', '120', 'abc', '0', 'Wed, 21 Oct 2026 07:28:00 GMT']) {
    const e = classifyStatus(status, { headers: ra ? { 'retry-after': ra } : {} });
    const after = Number.isFinite(e.retryAfter) && e.retryAfter > 0 ? e.retryAfter : 0;
    out.classify.push([`${status}|${ra}`, `${e.message}|${e.fatal ? 1 : 0}|${after}`]);
  }
}
for (const status of [200, 206, 416, 301, 404, 429, 500, 503]) {
  for (const cr of ['', 'bytes 0-0/12345', 'bytes 0-0/*', 'bytes 0-0/0', 'bytes 0-0/99 ', 'garbage/12', 'bytes 0-0/12abc']) {
    for (const cl of ['', '777', 'abc', '0']) {
      const h = {};
      if (cr) { h['content-range'] = cr; }
      if (cl) { h['content-length'] = cl; }
      let res;
      try { const r = interpretProbe(status, h); res = `ok|${r.size}|${r.resumable ? 1 : 0}`; } catch (e) { res = `err|${e.fatal ? 1 : 0}|${e.status}`; }
      out.probe.push([`${status}|${cr}|${cl}`, res]);
    }
  }
}

// ---- proxy text
const proxyCases = ['', ' ', '127.0.0.1:8080', 'proxy.local:3128', 'http://u:p@host:8080', 'http://u:p%40x@host:8080', 'http://u%zz:p@host', 'socks5://h:1080', 'socks5h://h', 'socks://h:1', 'socks5://u:p@h', 'socks5://:p@h:9', 'ftp://h:21', 'https://h', 'https://h:444', 'http://', 'host:abc', 'host:99999', 'host:0', '[::1]:8080', 'http://[::1]:8080', 'user:pass@h:1', 'HTTP://UP.com:81', 'socks4://h', ':8080', 'h:80:90', 'http://h/path?x=1', '  http://h:3128  ', 'http://h:80', 'https://h:443', 'a b:80', 'http://:p@h'];
for (const c of proxyCases) { const ok = setProxy(c); out.proxy.push([hex(c), `${ok ? 1 : 0}|${hex(getProxy())}`]); }
setProxy('');
for (const host of ['localhost', 'LOCALHOST', 'localhost.example.com', '127.0.0.1', '127.5.5.5', '127.example.com', '::1', '[::1]', '[::1]x', '1270.0.0.1', 'foo.local', 'FOO.LOCAL', 'example.com', 'my.localhost', 'a.local.b', 'local']) {
  for (const bl of [true, false]) { setProxy('h:1', { bypassLocal: bl }); out.bypass.push([`${host}|${bl ? 1 : 0}`, bypassProxy(host) ? '1' : '0']); }
}

// ---- URL joining (playlist links)
const bases = ['https://cdn.example.com/video/hls/index.m3u8', 'http://h.com:8080/a/b/c.m3u8?token=1&x=y#top', 'https://H.Example.COM:443/', 'https://example.com/a/b/', 'http://example.com:80/dir/play list.m3u8', 'https://example.com', 'https://user:pw@example.com/p/q.m3u8'];
const rels = ['seg1.ts', './seg1.ts', '../seg1.ts', '../../x/seg.ts', '../../../../up.ts', '/abs/seg.ts', '//other.cdn.com/p/s.ts', 'https://abs.example.org/z/s.ts?a=b', 'HTTP://UP.Example.COM:80/Case/Seg.TS', 'seg 1.ts', 'seg.ts?token=a b&c=d', 'seg.ts?x=\'q\'', 'seg.ts#frag ment', '?only=query', '#only', '', 'a/b/../c/./d.ts', 'a/./b/.', 'a/b/..', 'a/%2e%2e/b.ts', 'dir/', 'ü/é.ts', 'seg.ts?q=ü', 'a\\b\\c.ts', 'https://example.com:8443/x', 'http://example.com:0080/x', '  spaced.ts  ', 'seg\n1.ts', 'a%20b.ts', 'a{b}.ts', 'https://example.com', 'https://example.com?x=1', '/', '//x.com', 'data:text/plain,hi', 'blob:https://a/b'];
for (const b of bases) { for (const r of rels) { let v; try { v = new URL(r, b).toString(); } catch { v = 'ERR'; } out.urljoin.push([hex(r), hex(b), hex(v)]); } }

// ---- HLS playlists
const f64hex = (x) => { const bf = new DataView(new ArrayBuffer(8)); bf.setFloat64(0, x); return bf.getBigUint64(0).toString(16).padStart(16, '0'); };
const rg = (r) => (r ? `${r.start}-${r.end}` : '-');
function dumpHls(r) {
  if (r.type === 'master') {
    return 'master;' + r.variants.map((v) => ['V', hex(v.url), f64hex(v.bandwidth), f64hex(v.peak), f64hex(v.width), f64hex(v.height), hex(v.codecs), hex(v.audio)].join('|')).join(';') + ';' +
      r.audios.map((a) => ['A', hex(a.group || ''), hex(a.name), hex(a.lang), a.def ? 1 : 0, hex(a.url)].join('|')).join(';');
  }
  const key = (k) => (k ? `${hex(k.uri)}@${k.iv ? k.iv.toString('hex') : '~'}` : '-');
  return ['media', r.mediaSequence, r.endlist ? 1 : 0, f64hex(r.targetDuration), hex(r.unsupported), f64hex(r.totalDuration), r.map ? `${hex(r.map.url)}@${rg(r.map.range)}` : '-'].join('|') + ';' +
    r.segments.map((s) => ['S', hex(s.url), f64hex(s.duration), rg(s.range), key(s.key), s.seq, s.discontinuity ? 1 : 0].join('|')).join(';');
}
const hlsBase = 'https://cdn.example.com/v/hls/index.m3u8?sig=1';
const hlsTexts = [
  '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:9.009,\nseg7.ts\n#EXTINF:9.009,title\nseg8.ts\n#EXTINF:3.5\n/abs/seg9.ts\n#EXT-X-ENDLIST\n',
  '#EXTM3U\r\n#EXT-X-TARGETDURATION:6\r\n#EXT-X-DISCONTINUITY\r\n#EXTINF:6,\r\na.ts\r\n#EXTINF:6,\r\nb.ts\r\n',
  '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000001\n#EXTINF:4,\ns1.ts\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,\ns2.ts\n#EXT-X-KEY:METHOD=AES-128,URI="https://k.example.com/k?id=5"\n#EXTINF:4,\ns3.ts\n#EXT-X-ENDLIST',
  '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:4,\ns1.ts',
  '#EXTM3U\n#EXT-X-KEY:METHOD=AES-256,URI="k"\n#EXTINF:4,\ns1.ts',
  '#EXTM3U\n#EXT-X-KEY:METHOD=ISO-23001-7,KEYFORMAT="urn:uuid:EDEF8BA9-79D6-4ACE-A3C8-27DCD51D21ED"\n#EXTINF:4,\ns1.ts',
  '#EXTM3U\n#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"\n#EXT-X-BYTERANGE:1000@720\n#EXTINF:4,\nmedia.mp4\n#EXT-X-BYTERANGE:500\n#EXTINF:4,\nmedia.mp4\n#EXT-X-BYTERANGE:bad\n#EXTINF:2,\nmedia.mp4',
  '#EXTM3U\n#EXT-X-MAP:BYTERANGE="5@1"\n#EXTINF:4,\nx.m4s',
  '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:abc\n#EXT-X-TARGETDURATION: 8 \n#EXTINF:,\nx.ts\n#EXTINF:abc\ny.ts\n#EXTINF:5.5e0,z\nz.ts\n#EXTINF:-3,\nw.ts',
  '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,AVERAGE-BANDWIDTH=700000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aud"\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720\n#EXT-X-FOO\nmid/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,FRAME-RATE=30\nhttps://other.example.com/hi.m3u8\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/en.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Fr",DEFAULT=NO,URI="audio/fr.m3u8"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",URI="sub.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="x"',
  '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n',
  '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920X1080,BANDWIDTH=\nlast.m3u8\n#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=,BANDWIDTH=77\nb.m3u8',
  '#EXTM3U', '', 'hello', '\n#EXTM3U\n', '#EXTM3U8\n#EXTINF:1,\nq.ts', '#EXTM3U\n#EXT-X-ENDLIST',
  '#EXTM3U\n#EXTINF:1,\nhttp://\n', '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="http://"\n#EXTINF:1,\nq.ts',
  '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k",IV=0XABC\n#EXTINF:1,\nq.ts\n#EXT-X-KEY:METHOD=AES-128,IV=zz\n#EXTINF:1,\nr.ts',
  '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128\n#EXTINF:1,\nq.ts',
];
const hlsPool = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10', '#EXT-X-MEDIA-SEQUENCE:3', '#EXTINF:4.2,', '#EXTINF:2', '#EXT-X-ENDLIST', '#EXT-X-DISCONTINUITY', 'a.ts', 'b/c.ts', '../d.ts', '#EXT-X-BYTERANGE:100@0', '#EXT-X-BYTERANGE:50', '#EXT-X-KEY:METHOD=AES-128,URI="k.bin"', '#EXT-X-KEY:METHOD=NONE', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="x"', '#EXT-X-MAP:URI="i.mp4"', '#COMMENT', '', '  ', '#EXT-X-MEDIA-SEQUENCE:x'];
for (let i = 0; i < 250; i++) {
  const n = 1 + Math.floor(rnd() * 12); const lines = ['#EXTM3U'];
  for (let j = 0; j < n; j++) { lines.push(pick(hlsPool)); }
  hlsTexts.push(lines.join(rnd() < 0.3 ? '\r\n' : '\n'));
}
for (const t of hlsTexts) { let v; try { v = dumpHls(hls.parseM3u8(t, hlsBase)); } catch { v = 'ERR'; } out.hls.push([hex(t), v]); }

// ---- variant choice
const vs = [
  [{ url: 'a', bandwidth: 100, height: 360 }, { url: 'b', bandwidth: 300, height: 720 }, { url: 'c', bandwidth: 200, height: 720 }, { url: 'd', bandwidth: 50, height: 0 }, { url: 'e', bandwidth: 900, height: 1080 }],
  [{ url: 'a', bandwidth: 5, height: 0 }, { url: 'b', bandwidth: 9, height: 0 }],
  [{ url: 'a', bandwidth: 5, height: 480 }],
  [{ url: 'a', bandwidth: 5, height: 480 }, { url: 'b', bandwidth: 5, height: 480 }, { url: 'c', bandwidth: 5, height: 240 }],
];
for (let vi = 0; vi < vs.length; vi++) {
  for (const q of ['best', 'worst', '720', '1000', '100', '0', '-5', 'x', '1080', '480', '360']) {
    const pickd = hls.pickVariant(vs[vi], q);
    out.variant.push([`${vi}|${q}`, String(vs[vi].indexOf(pickd))]);
  }
}
out.variant.push(['empty|best', String(hls.pickVariant([], 'best') === null ? -1 : 0)]);

// ---- DASH manifests
const dRg = (r) => (r ? `${r.start}-${r.end}` : '-');
function dumpMpd(m) {
  const rep = (r) => ['R', hex(r.id || ''), f64hex(r.bandwidth), f64hex(r.width), f64hex(r.height), hex(r.codecs), hex(r.mime), r.type, hex(r.lang),
    r.single ? hex(r.single) : '-', r.init ? `${hex(r.init.url)}@${dRg(r.init.range)}` : '-',
    r.segments ? r.segments.map((s) => `${hex(s.url)}:${f64hex(s.duration)}:${dRg(s.range)}`).join(',') : '-'].join('|');
  return [f64hex(m.duration), m.protection ? 1 : 0, 'V', ...m.video.map(rep), 'A', ...m.audio.map(rep)].join(';');
}
const mpdUrl = 'https://cdn.example.com/dash/v/manifest.mpd?t=1';
const mpdTexts = [
  `<?xml version="1.0"?><!-- c --><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT1M30.5S"><Period><AdaptationSet mimeType="video/mp4" codecs="avc1.64001f" width="1280" height="720"><SegmentTemplate timescale="90000" duration="360000" initialization="init-$RepresentationID$.mp4" media="seg-$RepresentationID$-$Number%05d$.m4s" startNumber="1"/><Representation id="v720" bandwidth="2500000"/><Representation id="v360" bandwidth="800000" height="360" width="640"/></AdaptationSet><AdaptationSet mimeType="audio/mp4" lang="en"><Representation id="a1" bandwidth="128000" codecs="mp4a.40.2"><SegmentTemplate timescale="48000" duration="192000" initialization="a-init.mp4" media="a-$Number$.m4s"/></Representation></AdaptationSet></Period></MPD>`,
  `<MPD type="static" mediaPresentationDuration="PT20S"><BaseURL>https://media.example.org/root/</BaseURL><Period duration="PT20S"><BaseURL>p1/</BaseURL><AdaptationSet contentType="video"><SegmentTemplate timescale="1000" media="$RepresentationID$/$Time$.m4s" initialization="$RepresentationID$/i.mp4"><SegmentTimeline><S t="0" d="4000" r="2"/><S d="2000"/><S d="1000" r="1"/></SegmentTimeline></SegmentTemplate><Representation id="x1" bandwidth="1000" width="640" height="360"/></AdaptationSet></Period></MPD>`,
  `<mpd:MPD xmlns:mpd="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT1H2M3S"><mpd:Period><mpd:AdaptationSet mimeType="video/mp4"><mpd:Representation id="1" bandwidth="500" height="480"><mpd:BaseURL>video-480.mp4</mpd:BaseURL><mpd:SegmentBase indexRange="0-800"/></mpd:Representation></mpd:AdaptationSet></mpd:Period></mpd:MPD>`,
  `<MPD mediaPresentationDuration="PT10S"><Period><AdaptationSet mimeType="video/mp4"><Representation id="l" bandwidth="9" height="240"><SegmentList><Initialization sourceURL="init.mp4" range="0-99"/><SegmentURL media="s1.m4s" mediaRange="100-999"/><SegmentURL media="s2.m4s"/></SegmentList></Representation></AdaptationSet></Period></MPD>`,
  `<MPD type="dynamic"><Period/></MPD>`, `<MPD><Foo/></MPD>`, `<Other/>`, '', 'garbage', `<MPD mediaPresentationDuration="PT5S"><Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate media="x$Number$.m4s"/><Representation id="a" bandwidth="1"/></AdaptationSet></Period></MPD>`,
  `<MPD mediaPresentationDuration="PT8S"><Period><AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:uuid:EDEF8BA9-79D6-4ACE-A3C8-27DCD51D21ED"/><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/><SegmentTemplate duration="4" media="s$Number$.m4s" startNumber="0"/><Representation id="r&amp;1" bandwidth="1"/></AdaptationSet></Period></MPD>`,
  `<MPD mediaPresentationDuration="PT8S"><Period><AdaptationSet mimeType="text/vtt"><Representation id="t"><BaseURL>sub.vtt</BaseURL></Representation></AdaptationSet><AdaptationSet><Representation id="u" mimeType="audio/mp4" bandwidth="5"><BaseURL>a.m4a</BaseURL></Representation><Representation id="n" mimeType="audio/mp4"/></AdaptationSet></Period></MPD>`,
  `<MPD mediaPresentationDuration="PT8S"><Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate duration="3" timescale="1" media="$$a$Number$$$RepresentationID$.m4s"/><Representation id="r" bandwidth="1"/></AdaptationSet></Period></MPD>`,
  `<MPD mediaPresentationDuration="PT8S"><Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate duration="3" timescale="1" media="s$Bandwidth%03d$-$Number%02d$-$Time$-$Unknown$.m4s" initialization="i-$Number$-$Time$.mp4"/><Representation id="r" bandwidth="7"/></AdaptationSet></Period></MPD>`,
  `<MPD><Period><AdaptationSet mimeType='video/mp4'><Representation id='q' bandwidth='1'><BaseURL>  a b.mp4  </BaseURL></Representation></AdaptationSet></Period></MPD>`,
];
for (const t of mpdTexts) { let v; try { v = dumpMpd(dash.parseMpd(t, mpdUrl)); } catch { v = 'ERR'; } out.dash.push([hex(t), v]); }
for (const s of ['PT1M30.5S', 'PT10S', 'P1DT2H', 'P1D', 'PT0S', 'PT', 'P', '', 'abc', 'PT1H', 'PT5M', 'P2DT3H4M5.5S', 'PT1.5S', 'P1DT', 'PT10', '1H', 'pt5s', 'PT1H1H', 'P1M']) { out.dur.push([hex(s), f64hex(dash.parseDuration(s))]); }

// ---- yt-dlp helpers
const ytUrls = ['https://www.youtube.com/watch?v=abc', 'https://youtube.com/watch', 'https://m.youtube.com/shorts/xyz', 'https://youtube.com/live/abc', 'https://www.youtube.com/embed/abc', 'https://www.youtube.com/', 'https://www.youtube.com/@chan', 'https://youtube.com/watchlist', 'https://www.youtube-nocookie.com/embed/q', 'https://notyoutube.com/watch?v=1', 'https://youtube.com.evil.com/watch', 'https://youtu.be/abc', 'https://youtu.be/', 'https://youtu.be',
  'https://www.tiktok.com/@u/video/123', 'https://www.tiktok.com/@u/video/abc', 'https://vm.tiktok.com/xyz/', 'https://vt.tiktok.com/abc', 'https://www.tiktok.com/t/ZT123/', 'https://www.tiktok.com/@u/photo/55', 'https://www.tiktok.com/', 'https://tiktok.com/v/1',
  'https://www.facebook.com/watch?v=1', 'https://www.facebook.com/reel/123', 'https://www.facebook.com/reels/123', 'https://www.facebook.com/share/v/abc/', 'https://www.facebook.com/share/r/abc', 'https://www.facebook.com/user/videos/123', 'https://www.facebook.com/user/videos/abc', 'https://www.facebook.com/video.php?v=1', 'https://www.facebook.com/videoXphp', 'https://www.facebook.com/user/posts/123?v=5', 'https://www.facebook.com/user/posts/123', 'https://www.facebook.com/user/permalink/1?x=1&v=2', 'https://fb.watch/abc/', 'https://fb.watch/', 'https://www.facebook.com/',
  'https://www.instagram.com/reel/abc/', 'https://www.instagram.com/p/abc', 'https://www.instagram.com/tv/abc', 'https://www.instagram.com/reels/abc', 'https://www.instagram.com/user/', 'https://instagram.com/p/',
  'https://example.com/video.mp4', 'ftp://youtube.com/watch', 'not a url', '', 'HTTPS://WWW.YOUTUBE.COM/watch?v=1', 'https://www.youtube.com:443/watch', 'javascript:alert(1)', 'https://www.youtube.com/%77atch', 'https://www.youtube.com/a/../watch'];
for (const u of ytUrls) { out.ytmedia.push([hex(u), ytdlp.isMediaUrl(u) ? '1' : '0']); }
for (const q of ['best', 'audio', 'worst', '720', '1080', '0', '-1', 'x', '', '144', '4320', '720.5', ' 480 ']) { const r = ytdlp.formatSelector(q); out.ytfmt.push([hex(q), `${hex(r.fmt)}|${r.audio ? 1 : 0}`]); }
const progCases = ['VXP|100|1000|2000|50.5|12', 'VXP|100|NA|2000|50.5|12', 'VXP|100|0|2000|NA|NA', 'VXP|||||', 'VXP|1|2|3|4', 'VXP|1|2|3', 'VXP|1|2|3|4|5|6', '  VXP|1|2|3|4|5  \n', 'xVXP|1|2|3|4|5', 'vxp|1|2|3|4|5', 'VXP| 7 | 8 | 9 | 10 | 11 ', 'VXP|-5|-6|-7|-8|-9', 'VXP|1e3|2.5e2|0|1|1', 'VXP|abc|def|ghi|jkl|mno', 'VXP|Infinity|1|1|1|1', 'VXP|0|0|500|1|1', '', 'something else'];
for (const c of progCases) { const r = ytdlp.parseProgress(c); out.ytprog.push([hex(c), r ? [r.done, r.total, r.speed, r.eta].map(f64hex).join('|') : '-']); }
const errFrags = ['ERROR: [youtube] abc123: Sign in to confirm you’re not a bot', 'ERROR: [youtube] abc: Sign in to confirm youre not a bot', 'Use --cookies-from-browser', 'cookies are required for this', 'cookies\nrequired', 'Private video. Sign in', 'This video is private', 'Video unavailable', 'ERROR: [TikTok] 77: Unsupported URL: https://x', 'HTTP Error 429: Too Many Requests', 'rate-limited', 'rate limit', 'ffmpeg not found', 'ffprobe and ffmpeg are fine', 'No space left on device', 'Unable to extract nsig', 'HTTP Error 403: Forbidden', 'getaddrinfo failed', 'Connection reset by peer', 'connection refused', 'The account associated with this video has been terminated', 'account x terminated', 'Requested format is not available', 'ERROR: [generic] Something odd: details here', 'plain text line', '  ', '', 'Log in to continue', 'you must be 18', 'Members-only content', 'ERROR: first\nERROR: [x] y: second', 'WARNING: x\nlast line', 'error: lower case', 'x'.repeat(300), 'ERROR: [a:b] id-1_x:   spaced', 'ERROR: [] not tag: x', 'ERROR: é [bad tag'];
for (const f of errFrags) { const r = ytdlp.friendlyError(f); out.yterr.push([hex(f), `${r.code}|${hex(r.message)}`]); }
for (let i = 0; i < 300; i++) { const n = 1 + Math.floor(rnd() * 4); let t = ''; for (let j = 0; j < n; j++) { t += pick(errFrags) + pick(['\n', ' ', '', '\r\n']); } const r = ytdlp.friendlyError(t); out.yterr.push([hex(t), `${r.code}|${hex(r.message)}`]); }

// ---- yt-dlp -J output -> title / extension / size
const infoCases = [
  { id: 'abc', title: 'Bài hát: thử/nghiệm?', extractor_key: 'Youtube', ext: 'webm', duration: 30, uploader: 'Kênh A', requested_formats: [{ filesize: 4000 }, { filesize: 1000 }] },
  { id: 'x1', title: 'Single', ext: 'mp4', filesize: 5000 },
  { id: 'x2', fulltitle: 'Only full', extractor: 'generic', channel: 'Chan', duration: '12.5', filesize_approx: 777.5 },
  { id: 12345 },
  { title: '', id: '', ext: '' },
  { title: 'T', requested_formats: [], ext: 'mkv', filesize: 9 },
  { title: 'T', requested_formats: [{ filesize: null, filesize_approx: 30 }, { filesize: 0, filesize_approx: 12 }, {}] },
  { title: 'Playlist', entries: [{ title: 'First', id: 'f1', ext: 'flv', filesize: 10 }, { title: 'Second' }] },
  { title: 'Empty entries', entries: [], ext: 'mov' },
  { title: 'Null entry', entries: [null], ext: 'ogg' },
  { title: 'Zero dur', duration: 0, uploader: '', channel: 'Ch' },
  { title: 'Str size', filesize: '1234', duration: 'abc' },
  { title: 'Neg', filesize: -5, duration: -3 },
  { title: 'Unicode 日本語 😀', id: 'u', extractor_key: 'Niconico' },
  { title: 'Fmt one', requested_formats: [{ filesize: 100 }], ext: 'webm' },
];
const infoTexts = infoCases.map((c) => JSON.stringify(c)).concat(['[]', '"text"', '42', 'null', '{', '', '{"title":"X"}', '{"title":null,"id":0}']);
for (const t of infoTexts) {
  for (const audio of [false, true]) {
    const r = ytdlp.parseInfo(t, audio);
    out.ytinfo.push([hex(t), audio ? '1' : '0', r ? [hex(r.title), hex(r.id), hex(r.site), hex(r.uploader), f64hex(r.duration), f64hex(r.total), hex(r.ext)].join('|') : '-']);
  }
}

// ---- schedule
for (const t of ['08:00', '8:00', '23:59', '24:00', '7:5', '', 'x', '00:00', '0:00', '12:30', ' 09:15 ', '19:60', '20:00', '1:00', '01:00', '001:00', '9:5a', ':30', '10:', '10:30:00', '\t7:07\n', '-1:00', '٣:٠٠']) { out.tomin.push([hex(t), String(schedule.toMinutes(t))]); }
const fields = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getDay(), d.getHours(), d.getMinutes()];
const times = ['08:00', '8:00', '23:55', '00:05', '12:30', '', 'bad', '07:07', '22:00'];
for (let i = 0; i < 300; i++) {
  const sched = { enabled: rnd() < 0.85, start: pick(times), stop: pick(times), days: pick([[], [], [1, 2, 3, 4, 5], [0, 6], [3], [0, 1, 2, 3, 4, 5, 6]]) };
  const grace = pick([10, 10, 0, 1, 30]);
  const todayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const base = new Date(2026, 10 + Math.floor(rnd() * 3), 1 + Math.floor(rnd() * 28), 0, 0);
  const state = {};
  if (rnd() < 0.3) { state.start = todayKey(base); }
  if (rnd() < 0.2) { state.stop = '2020-1-1'; }
  const init = [state.start === undefined ? '~' : hex(state.start), state.stop === undefined ? '~' : hex(state.stop)].join(',');
  const nowsList = []; const results = [];
  let minute = Math.floor(rnd() * 600);
  for (let j = 0; j < 14; j++) {
    minute += Math.floor(rnd() * 120);
    const d = new Date(base.getTime() + minute * 60000);
    nowsList.push(fields(d).join(','));
    const a = schedule.dueActions(d, sched.enabled || rnd() < 0 ? sched : sched, state, grace);
    results.push(a.length ? a.join('+') : '-');
  }
  const desc = [sched.enabled ? 1 : 0, hex(sched.start), hex(sched.stop), sched.days.join('.') || '~', grace, init, nowsList.join(';')].join('|');
  out.dsched.push([hex(desc), results.join(',')]);
}
for (let i = 0; i < 300; i++) {
  const o = { limit: pick([0, 0, 100, 500, 2048]), windowEnabled: rnd() < 0.8, windowFrom: pick(times), windowTo: pick(times), windowLimit: pick([0, 50, 1000]) };
  const d = new Date(2026, 10, 3, Math.floor(rnd() * 24), Math.floor(rnd() * 60));
  const desc = [o.limit, o.windowEnabled ? 1 : 0, hex(o.windowFrom), hex(o.windowTo), o.windowLimit, fields(d).join(',')].join('|');
  out.limit.push([hex(desc), f64hex(schedule.effectiveLimitKB(d, o))]);
}

// ---- duplicate detection
const dvocab = { url: ['https://a.com/x.zip', 'https://a.com/x.zip#frag', 'https://a.com/y.zip', 'https://b.com/v?id=1', 'https://b.com/v?id=2'], name: ['x.zip', 'X.ZIP', 'y.zip', 'video.mp4', ''], status: ['downloading', 'queued', 'paused', 'error', 'done', 'pending'], kind: [undefined, 'file', 'hls', 'media'], page: ['', 'https://p.com/1', 'https://p.com/1#top', 'https://p.com/2'], title: ['', 'My Video', 'my video', 'Other'] };
const dlDir = 'D:/dl';
for (let i = 0; i < 400; i++) {
  const tasks = []; const n = Math.floor(rnd() * 5);
  for (let j = 0; j < n; j++) {
    const name = pick(dvocab.name);
    tasks.push({ id: 't' + j, url: pick(dvocab.url), filename: name, path: rnd() < 0.5 ? path.posix.join(dlDir, name) : '', status: pick(dvocab.status), pending: rnd() < 0.2, kind: pick(dvocab.kind), meta: { page: pick(dvocab.page), title: pick(dvocab.title) } });
  }
  const q = { url: pick(dvocab.url), filename: pick(dvocab.name), dir: pick([dlDir, dlDir, '']), page: pick(dvocab.page), title: pick(dvocab.title), kind: pick(dvocab.kind) };
  const existing = new Set(); for (const nm of dvocab.name) { if (nm && rnd() < 0.4) { existing.add(path.posix.join(dlDir, nm)); } }
  const ignoreId = rnd() < 0.2 ? 't0' : '';
  const r = findDuplicate(tasks, q, { exists: (p) => existing.has(p), ignoreId });
  const enc = (t) => [t.id, hex(t.url), hex(t.filename), hex(t.path), t.status, t.pending ? 1 : 0, t.kind === undefined ? '~' : t.kind, hex(t.meta.page), hex(t.meta.title)].join(',');
  const desc = [tasks.map(enc).join(';'), [hex(q.url), hex(q.filename), hex(q.dir), hex(q.page), hex(q.title), q.kind === undefined ? '~' : q.kind].join(','), [...existing].map(hex).join(','), ignoreId].join('|');
  const res = !r ? '-' : r.type === 'done' ? `done:${hex(r.path)}:${r.task ? r.task.id : '-'}` : `${r.type}:${r.task.id}`;
  out.dupes.push([hex(desc), res]);
}

const dir = path.join(__dirname, '..', 'vexlo-core', 'tests', 'fixtures');
fs.mkdirSync(dir, { recursive: true });
for (const [name, rows] of Object.entries(out)) { fs.writeFileSync(path.join(dir, name + '.tsv'), rows.map((r) => r.join('\t')).join('\n') + '\n'); console.log(name, rows.length); }
