'use strict';
// Runs the original JavaScript helpers over many inputs and writes the results to
// vexlo-core/tests/fixtures/*.tsv. The Rust tests (tests/differential.rs) must give the same answers.
// Fields are hex-encoded UTF-8 so tabs and newlines in inputs are safe.
const fs = require('fs');
const path = require('path');
const util = require('../../src/core/util');
const category = require('../../src/core/category');

const hex = (s) => Buffer.from(String(s), 'utf8').toString('hex');
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

const POOL = ['a', 'B', 'z', '0', '9', ' ', ' ', '.', '.', '-', '_', '/', '\\', ':', '*', '?', '"', '<', '>', '|', '\t', '\n', 'é', 'ü', 'ệ', 'Ă', '日', '本', '\u00a0', '\u3000', '\ufffd', '\ufeff', '%', '%20', '%C3%A9', '%zz', '%E6%97%A5', ';', '=', "'", 'file', 'CON', 'nul', 'com1', 'LPT9', '.mp4', '.exe', '.zip', 'x'.repeat(40)];
const randomString = (n) => { let s = ''; const k = 1 + Math.floor(rnd() * n); for (let i = 0; i < k; i++) { s += pick(POOL); } return s; };

const out = { sanitize: [], cd: [], url: [], mime: [], web: [], pick: [], cat: [] };

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

const dir = path.join(__dirname, '..', 'vexlo-core', 'tests', 'fixtures');
fs.mkdirSync(dir, { recursive: true });
for (const [name, rows] of Object.entries(out)) { fs.writeFileSync(path.join(dir, name + '.tsv'), rows.map((r) => r.join('\t')).join('\n') + '\n'); console.log(name, rows.length); }
