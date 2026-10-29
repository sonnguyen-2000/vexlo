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
