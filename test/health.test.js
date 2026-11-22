'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('../src/main/health');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vx-health-'));

test('an unfinished start is noticed on the next start', () => {
  const d = tmp();
  assert.strictEqual(H.previousStartFailed(d), false);
  H.markStarting(d, 1);
  assert.strictEqual(H.previousStartFailed(d), true);
  H.markStarted(d);
  assert.strictEqual(H.previousStartFailed(d), false);
});

test('a damaged settings file is moved aside, not deleted, and reported as fixed', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'settings.json'), '{ broken');
  fs.writeFileSync(path.join(d, 'downloads.json'), '[]');
  const r = await H.healthCheck({ dir: d });
  const s = r.find((x) => x.id === 'settings.json');
  assert.deepStrictEqual([s.ok, s.fixed], [false, true]);
  assert.ok(!fs.existsSync(path.join(d, 'settings.json')));
  assert.ok(fs.readdirSync(d).some((f) => f.startsWith('settings.json.bad-')), 'the damaged copy is kept');
  assert.strictEqual(r.find((x) => x.id === 'downloads.json').ok, true);
});

test('a download folder that cannot be created is reported, and the check never waits longer than its limit', async () => {
  const d = tmp();
  const blocker = path.join(d, 'file.txt');
  fs.writeFileSync(blocker, 'x');
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ downloadDir: path.join(blocker, 'sub') })); // a folder inside a file
  const t0 = Date.now();
  const r = await H.healthCheck({ dir: d, folderMs: 1500 });
  assert.strictEqual(r.find((x) => x.id === 'download-folder').ok, false);
  assert.ok(Date.now() - t0 < 2500);
});

test('healthy data gives no problems', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ downloadDir: path.join(d, 'dl') }));
  const r = await H.healthCheck({ dir: d });
  assert.ok(r.every((x) => x.ok));
});
