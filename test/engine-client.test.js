'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer, listen, sha } = require('./server');
const { EngineClient } = require('../src/core/engine-client');
const { sleep } = require('../src/core/util');

let src; let base; let tmp; let client;
test.before(async () => {
  src = createServer();
  base = 'http://127.0.0.1:' + await listen(src.server);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlo-eng-'));
  client = new EngineClient({ dataDir: path.join(tmp, 'data'), downloadDir: path.join(tmp, 'dl'), maxConcurrent: 2, connections: 4 });
  await client.ready;
});
test.after(async () => { await client.shutdown(); src.server.close(); src.server.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); });

async function waitFor(fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) { return v; } await sleep(30); }
  throw new Error('timeout');
}

test('engine process downloads a file; add() returns an id at once and the cache follows', async () => {
  const id = client.add({ url: base + '/big.bin', filename: 'viaworker.bin' });
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.ok(client.get(id), 'known immediately');
  await waitFor(() => client.get(id)?.state.status === 'done');
  const st = client.get(id).state;
  assert.equal(sha(fs.readFileSync(st.path)), sha(src.files['/big.bin']));
  assert.equal(path.basename(st.path), 'viaworker.bin');
});

test('pending + update + confirm work through the process boundary, remove cleans up', async () => {
  const id = client.add({ url: base + '/big.bin', pending: true, start: false });
  const info = await client.probeInfo(id);
  assert.ok(info.size > 0);
  client.update(id, { filename: 'renamed.bin' });
  client.confirm(id, { start: true });
  await waitFor(() => client.get(id)?.state.status === 'done');
  assert.equal(path.basename(client.get(id).state.path), 'renamed.bin');
  await client.remove(id);
  assert.equal(client.get(id), undefined);
  assert.ok(!client.list().some((x) => x.id === id));
});

test('invalid url is rejected synchronously', () => {
  assert.throws(() => client.add({ url: 'ftp://x/y' }), /URL/);
});

test('replaceId: a failed attempt is replaced and the new download keeps the plain file name', async () => {
  const bad = client.add({ url: base + '/missing', filename: 'same-name.bin' });
  await waitFor(() => client.get(bad)?.state.status === 'error');
  const good = client.add({ url: base + '/big.bin', filename: 'same-name.bin', replaceId: bad });
  await waitFor(() => client.get(good)?.state.status === 'done');
  assert.equal(path.basename(client.get(good).state.path), 'same-name.bin');
  await waitFor(() => !client.get(bad));
});

test('a finished file with the same name gets a numbered name', async () => {
  const again = client.add({ url: base + '/big.bin', filename: 'same-name.bin' });
  await waitFor(() => client.get(again)?.state.status === 'done');
  assert.equal(path.basename(client.get(again).state.path), 'same-name (1).bin');
});
