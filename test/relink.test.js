'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { DownloadManager } = require('../src/core/manager');

test('relink keeps the downloaded data of a plain file and switches to the new address', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-relink-'));
  const m = new DownloadManager({ dataDir: dir, downloadDir: dir, maxConcurrent: 0 });
  const id = m.add({ url: 'http://127.0.0.1:1/a.bin', start: false });
  const st = m.get(id).state;
  st.status = 'error'; st.downloaded = 500; st.size = 1000; st.finalUrl = 'http://old/';
  assert.strictEqual(m.relink(id, { url: 'http://127.0.0.1:1/new.bin', size: 999 }), false, 'a different size is a different file');
  assert.strictEqual(m.relink(id, { url: 'ftp://x' }), false);
  assert.strictEqual(m.relink(id, { url: 'http://127.0.0.1:1/new.bin', headers: { referer: 'r' }, size: 1000 }), true);
  const now = m.get(id).state;
  assert.strictEqual(now.url, 'http://127.0.0.1:1/new.bin');
  assert.strictEqual(now.finalUrl, '');
  assert.strictEqual(now.downloaded, 500);
  assert.strictEqual(now.headers.referer, 'r');
  m.shutdown && m.shutdown();
});

test('relink refuses a download that has no data yet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-relink-'));
  const m = new DownloadManager({ dataDir: dir, downloadDir: dir, maxConcurrent: 0 });
  const id = m.add({ url: 'http://127.0.0.1:1/a.bin', start: false });
  m.get(id).state.status = 'error';
  assert.strictEqual(m.relink(id, { url: 'http://127.0.0.1:1/b.bin' }), false);
});
