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

const hex = (s) => Buffer.from(String(s), 'utf8').toString('hex');
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

const POOL = ['a', 'B', 'z', '0', '9', ' ', ' ', '.', '.', '-', '_', '/', '\\', ':', '*', '?', '"', '<', '>', '|', '\t', '\n', 'é', 'ü', 'ệ', 'Ă', '日', '本', '\u00a0', '\u3000', '\ufffd', '\ufeff', '%', '%20', '%C3%A9', '%zz', '%E6%97%A5', ';', '=', "'", 'file', 'CON', 'nul', 'com1', 'LPT9', '.mp4', '.exe', '.zip', 'x'.repeat(40)];
const randomString = (n) => { let s = ''; const k = 1 + Math.floor(rnd() * n); for (let i = 0; i < k; i++) { s += pick(POOL); } return s; };

const out = { sanitize: [], cd: [], url: [], mime: [], web: [], pick: [], cat: [], plan: [], retry: [], sched: [], meter: [], classify: [], probe: [], proxy: [], bypass: [] };

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

const dir = path.join(__dirname, '..', 'vexlo-core', 'tests', 'fixtures');
fs.mkdirSync(dir, { recursive: true });
for (const [name, rows] of Object.entries(out)) { fs.writeFileSync(path.join(dir, name + '.tsv'), rows.map((r) => r.join('\t')).join('\n') + '\n'); console.log(name, rows.length); }
