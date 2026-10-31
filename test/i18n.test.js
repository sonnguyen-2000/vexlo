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
