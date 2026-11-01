'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Stats, dayKey } = require('../src/core/stats');
const { parseListedEntries, entriesCommand, extractDirIn } = require('../src/core/util');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vx-st-')), 'stats.json');

test('Stats: totals per day, week, month, site and type', () => {
  const f = tmp();
  const st = new Stats(f);
  const now = new Date(2026, 10, 15, 12).getTime();
  const day = 86400000;
  st.record({ bytes: 1000, host: 'a.com', type: 'video', at: now });
  st.record({ bytes: 500, host: 'a.com', type: 'archive', at: now });
  st.record({ bytes: 200, host: 'b.com', type: 'video', at: now - 3 * day });
  st.record({ bytes: 50, host: 'c.com', type: 'other', at: now - 20 * day });
  st.record({ bytes: 7, host: 'c.com', type: 'other', at: now - 60 * day });
  const s = st.summary(now);
  assert.deepEqual(s.today, { bytes: 1500, count: 2 });
  assert.deepEqual(s.week, { bytes: 1700, count: 3 });
  assert.deepEqual(s.month, { bytes: 1750, count: 4 });
  assert.deepEqual(s.total, { bytes: 1757, count: 5 });
  assert.equal(s.days.length, 14);
  assert.equal(s.days[13].bytes, 1500);
  assert.equal(s.days[10].bytes, 200);
  assert.equal(s.hosts[0].name, 'a.com');
  assert.equal(s.hosts[0].bytes, 1500);
  assert.equal(s.types[0].name, 'video');
  st.saveNow();
  assert.equal(new Stats(f).summary(now).total.bytes, 1757); // survives a restart
  st.reset();
  assert.equal(st.summary(now).total.count, 0);
  assert.equal(new Stats(f).summary(now).total.count, 0);
});

test('Stats: ignores bad numbers, drops very old days, caps the site list', () => {
  const st = new Stats(tmp());
  const now = Date.now();
  st.record({ bytes: -5, host: 'x', at: now });
  st.record({ bytes: NaN, host: 'x', at: now });
  assert.equal(st.summary(now).total.bytes, 0);
  st.record({ bytes: 9, host: 'old', at: now - 500 * 86400000 });
  st.record({ bytes: 1, host: 'new', at: now });
  assert.ok(!st.data.days[dayKey(new Date(now - 500 * 86400000))]);
  for (let i = 0; i < 400; i++) { st.record({ bytes: i + 1, host: 'h' + i, at: now }); }
  assert.ok(Object.keys(st.data.hosts).length <= 300);
});

test('archive listing: 7-Zip, UnRAR and tar output', () => {
  const seven = parseListedEntries('7zip', 'Listing archive: a.7z\n\n--\nPath = a.7z\nType = 7z\n\n----------\nPath = d\nFolder = +\nSize = 0\nEncrypted = -\n\nPath = d/x.txt\nFolder = -\nSize = 12\nEncrypted = +\n');
  assert.deepEqual(seven.map((e) => [e.name, e.size, e.dir, e.encrypted]), [['d', 0, true, false], ['d/x.txt', 12, false, true]]);
  const rar = parseListedEntries('unrar', 'Archive: a.rar\n\nName: d/x.txt\nType: File\nSize: 5\nFlags: encrypted\n\nName: d\nType: Directory\nSize: 0\n');
  assert.deepEqual(rar.map((e) => [e.name, e.size, e.dir, e.encrypted]), [['d/x.txt', 5, false, true], ['d', 0, true, false]]);
  assert.deepEqual(parseListedEntries('tar', 'a/\na/b.txt\n').map((e) => [e.name, e.dir]), [['a', true], ['a/b.txt', false]]);
  assert.deepEqual(parseListedEntries('7zip', 'nothing here'), []);
});

test('entriesCommand falls back to tar (but not for passwords); extractDirIn uses the chosen folder', () => {
  assert.equal(entriesCommand('/x/a.zip', { platform: 'linux' }).name, 'tar');
  assert.equal(entriesCommand('/x/a.zip', { platform: 'linux', password: 'pw' }), null);
  const have = new Set(['C:\\Program Files\\7-Zip\\7z.exe']);
  const c = entriesCommand('C:\\a.zip', { platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, exists: (f) => have.has(f) });
  assert.equal(c.name, '7zip');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-d-'));
  assert.equal(extractDirIn('/anywhere/Pack.tar.gz', d), path.join(d, 'Pack'));
  fs.mkdirSync(path.join(d, 'Pack'));
  assert.notEqual(extractDirIn('/anywhere/Pack.zip', d), path.join(d, 'Pack'));
});
