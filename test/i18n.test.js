'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('i18n: English lookup, placeholders and "message: detail" errors', () => {
  const I = require('../src/renderer/i18n');
  I.setLang('en');
  assert.equal(I.tr('Xóa {n} mục', { n: 3 }), 'Delete 3 items');
  assert.equal(I.tr('URL không hợp lệ: x'), 'Invalid URL: x');
  assert.equal(I.tr('chuỗi không có trong từ điển'), 'chuỗi không có trong từ điển');
  I.setLang('vi');
  assert.equal(I.tr('Xóa {n} mục', { n: 3 }), 'Xóa 3 mục');
});

test('native host: config works, launch without an app path fails cleanly', async () => {
  const { spawn } = require('child_process');
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vx-')), 'settings.json');
  fs.writeFileSync(f, JSON.stringify({ port: 6999, token: 'abc' }));
  const ask = (cmd) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'native', 'host.js'), f, '']);
    const body = Buffer.from(JSON.stringify({ cmd })); const h = Buffer.alloc(4); h.writeUInt32LE(body.length);
    let out = Buffer.alloc(0);
    p.stdout.on('data', (c) => { out = Buffer.concat([out, c]); if (out.length >= 4 && out.length >= 4 + out.readUInt32LE(0)) { p.kill(); resolve(JSON.parse(out.subarray(4).toString())); } });
    p.stdin.write(Buffer.concat([h, body]));
  });
  assert.deepEqual(await ask('config'), { ok: true, app: 'Vexlo', port: 6999, token: 'abc' });
  const l = await ask('launch');
  assert.equal(l.ok, false);
});

test('clipboard: only a single http(s) link to a file is offered', () => {
  const { downloadLinkIn } = require('../src/core/util');
  assert.equal(downloadLinkIn('https://a.com/x/file.zip'), 'https://a.com/x/file.zip');
  assert.equal(downloadLinkIn('  http://a.com/v.MP4?token=1  '), 'http://a.com/v.MP4?token=1');
  assert.equal(downloadLinkIn('https://a.com/page'), '');
  assert.equal(downloadLinkIn('https://a.com/a.zip and more'), '');
  assert.equal(downloadLinkIn('ftp://a.com/a.zip'), '');
  assert.equal(downloadLinkIn('hello'), '');
  assert.equal(downloadLinkIn(''), '');
});

test('plainNotes: release Markdown becomes readable plain text', () => {
  const { plainNotes } = require('../src/core/util');
  const md = '## What\'s new\r\n\r\n- **Queue** priority\r\n* See [docs](https://x.y) and `code`\r\n\r\n\r\n\r\n<!-- hidden -->\r\n![img](a.png)\r\nEnd  ';
  assert.equal(plainNotes(md), "What's new\n\n\u2022 Queue priority\n\u2022 See docs and code\n\nEnd");
  assert.equal(plainNotes(''), '');
  assert.equal(plainNotes('x'.repeat(50), 10).length, 10);
});

test('parseImportList: Vexlo export, plain text lines, junk and repeats', () => {
  const { parseImportList } = require('../src/core/util');
  const json = JSON.stringify({ app: 'vexlo', items: [
    { url: 'https://a.com/x.zip', filename: '..\\evil/x.zip', kind: 'file', page: 'https://a.com/p' },
    { url: 'https://a.com/x.zip' }, { url: 'javascript:alert(1)' }, { url: 'ftp://a/b' }, { url: 'https://b.com/v.m3u8', kind: 'weird' }, 'https://c.com/y.mp4',
  ] });
  const r = parseImportList(json);
  assert.deepEqual(r.map((x) => x.url), ['https://a.com/x.zip', 'https://b.com/v.m3u8', 'https://c.com/y.mp4']);
  assert.ok(!/[\\/]/.test(r[0].filename), 'path parts stripped from names: ' + r[0].filename);
  assert.equal(r[0].page, 'https://a.com/p');
  assert.equal(r[1].kind, undefined);
  const txt = parseImportList('\uFEFFhttps://a.com/1.zip\r\n\r\nnot a link\r\nhttps://a.com/2.zip\r\nhttps://a.com/1.zip');
  assert.deepEqual(txt.map((x) => x.url), ['https://a.com/1.zip', 'https://a.com/2.zip']);
  assert.deepEqual(parseImportList(''), []);
});

test('archives: names are recognised and the extract folder is named after the file', () => {
  const { isArchive, extractDirFor } = require('../src/core/util');
  for (const n of ['a.zip', 'B.7Z', 'c.tar.gz', 'd.tgz', 'e.rar', 'f.tar']) { assert.equal(isArchive(n), true, n); }
  for (const n of ['a.exe', 'zip', 'a.zip.part', 'movie.mp4']) { assert.equal(isArchive(n), false, n); }
  const os = require('os'); const path = require('path'); const fs = require('fs');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-ex-'));
  assert.equal(extractDirFor(path.join(d, 'Pack.tar.gz')), path.join(d, 'Pack'));
  fs.mkdirSync(path.join(d, 'Pack'));
  assert.equal(extractDirFor(path.join(d, 'Pack.zip')), path.join(d, 'Pack (1)'));
  fs.rmSync(d, { recursive: true, force: true });
});

test('extractCommands: WinRAR and 7-Zip are used when installed, tar is always the last resort', () => {
  const { extractCommands } = require('../src/core/util');
  const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', SystemRoot: 'C:\\Windows' };
  const has = (...files) => (f) => files.includes(f);
  const names = (list) => list.map((c) => c.name);
  const opt = (file, ...inst) => extractCommands(file, 'D:\\out\\Pack', { platform: 'win32', env, exists: has(...inst) });
  const WR = 'C:\\Program Files\\WinRAR\\WinRAR.exe';
  const UR = 'C:\\Program Files\\WinRAR\\UnRAR.exe';
  const SZ = 'C:\\Program Files\\7-Zip\\7z.exe';
  assert.deepEqual(names(opt('D:\\a.rar')), ['tar']);
  assert.deepEqual(names(opt('D:\\a.rar', WR)), ['winrar', 'tar']);
  assert.deepEqual(names(opt('D:\\a.rar', WR, UR, SZ)), ['unrar', 'winrar', '7zip', 'tar']);
  assert.deepEqual(names(opt('D:\\a.7z', WR, SZ)), ['7zip', 'winrar', 'tar']);
  assert.deepEqual(names(opt('D:\\a.zip', WR, SZ)), ['tar', '7zip', 'winrar']);
  const rar = opt('D:\\a.rar', UR)[0];
  assert.equal(rar.exe, UR);
  assert.deepEqual(rar.args, ['x', '-y', '-p-', '-idq', 'D:\\a.rar', 'D:\\out\\Pack\\']);
  assert.deepEqual(opt('D:\\a.7z', SZ)[0].args, ['x', '-y', '-oD:\\out\\Pack', 'D:\\a.7z']);
  assert.equal(opt('D:\\a.zip')[0].exe, 'C:\\Windows\\System32\\tar.exe');
  assert.deepEqual(names(extractCommands('/x/a.rar', '/x/a', { platform: 'linux' })), ['tar']);
});

test('explainExtractFailure: turns what the programs said into a plain reason', () => {
  const { explainExtractFailure: why } = require('../src/core/util');
  assert.equal(why([{ name: 'unrar', code: 11, msg: 'Incorrect password' }, { name: 'tar', code: 1, msg: 'tar: Unrecognized archive format' }]), 'password');
  assert.equal(why([{ name: 'unrar', code: 3, msg: 'CRC failed in x.bin' }]), 'corrupt');
  assert.equal(why([{ name: '7zip', code: 2, msg: 'ERROR: Data Error in encrypted file. Wrong password?' }]), 'password');
  assert.equal(why([{ name: 'tar', code: 1, msg: 'tar.exe: Error opening archive: Unrecognized archive format' }]), 'format');
  assert.equal(why([{ name: 'unrar', code: 5, msg: 'Write error' }]), 'space');
  assert.equal(why([{ name: 'tar', code: 1, msg: 'something odd' }]), 'unknown');
  assert.equal(why([]), 'unknown');
});

test('extractCommands with a password: only WinRAR / 7-Zip get it, tar is left out, no password means -p-', () => {
  const { extractCommands } = require('../src/core/util');
  const env = { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' };
  const all = () => true;
  const withPw = extractCommands('D:\\a.rar', 'D:\\out', { platform: 'win32', env, exists: all, password: 'p@ss word' });
  assert.deepEqual(withPw.map((c) => c.name), ['unrar', 'winrar', '7zip']);
  assert.ok(withPw[0].args.includes('-pp@ss word'));
  assert.ok(withPw[2].args.includes('-pp@ss word'));
  assert.ok(extractCommands('D:\\a.rar', 'D:\\out', { platform: 'win32', env, exists: all })[0].args.includes('-p-'));
  assert.deepEqual(extractCommands('/a.rar', '/o', { platform: 'linux', password: 'x' }), []);
});

test('listing an archive: the command to use and the total size read from its output', () => {
  const { listCommand, parseListedTotal } = require('../src/core/util');
  const env = { ProgramFiles: 'C:\\Program Files' };
  const UR = 'C:\\Program Files\\WinRAR\\UnRAR.exe';
  const SZ = 'C:\\Program Files\\7-Zip\\7z.exe';
  const has = (...f) => (x) => f.includes(x);
  assert.equal(listCommand('D:\\a.rar', { platform: 'win32', env, exists: has(UR, SZ) }).name, 'unrar');
  assert.deepEqual(listCommand('D:\\a.rar', { platform: 'win32', env, exists: has(UR), password: 'pw' }).args, ['lt', '-y', '-ppw', 'D:\\a.rar']);
  assert.equal(listCommand('D:\\a.zip', { platform: 'win32', env, exists: has(UR, SZ) }).name, '7zip');
  assert.equal(listCommand('D:\\a.zip', { platform: 'win32', env, exists: has(UR) }), null);
  assert.equal(listCommand('/a.rar', { platform: 'linux' }), null);
  const rar = '        Name: a.txt\n        Type: File\n        Size: 1000\n Packed size: 400\n\n        Name: dir\n        Type: Directory\n        Size: 0\n\n        Name: b.bin\n        Size: 2500\n';
  assert.equal(parseListedTotal('unrar', rar), 3500);
  const sz = 'Path = a.7z\nType = 7z\nSize = 777\n\n----------\nPath = a.txt\nSize = 10\nPacked Size = 5\n\nPath = b.bin\nSize = 90\n';
  assert.equal(parseListedTotal('7zip', sz), 100);
  assert.equal(parseListedTotal('7zip', 'nothing'), 0);
});
