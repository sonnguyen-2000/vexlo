'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dueActions, toMinutes } = require('../src/core/schedule');

const at = (h, m, day = 3) => { const d = new Date(2026, 9, 21 + (day - 3), h, m); return d; }; // 2026-10-21 is a Wednesday (3)
const S = { enabled: true, start: '01:00', stop: '06:30', days: [0, 1, 2, 3, 4, 5, 6] };

test('toMinutes parses HH:MM and rejects junk', () => {
  assert.equal(toMinutes('01:30'), 90);
  assert.equal(toMinutes('7:05'), 425);
  assert.equal(toMinutes('24:00'), -1);
  assert.equal(toMinutes(''), -1);
});

test('start fires once at the start time, stop fires once at the stop time', () => {
  const st = {};
  assert.deepEqual(dueActions(at(0, 59), S, st), []);
  assert.deepEqual(dueActions(at(1, 0), S, st), ['start']);
  assert.deepEqual(dueActions(at(1, 1), S, st), []);
  assert.deepEqual(dueActions(at(6, 30), S, st), ['stop']);
  assert.deepEqual(dueActions(at(6, 31), S, st), []);
});

test('a slightly late check (sleep / lag) still fires, a very late one does not', () => {
  assert.deepEqual(dueActions(at(1, 8), S, {}), ['start']);
  assert.deepEqual(dueActions(at(1, 40), S, {}), []);
});

test('fires again the next day', () => {
  const st = {};
  dueActions(at(1, 0, 3), S, st);
  assert.deepEqual(dueActions(at(1, 0, 4), S, st), ['start']);
});

test('disabled, wrong weekday, or empty stop time', () => {
  assert.deepEqual(dueActions(at(1, 0), { ...S, enabled: false }, {}), []);
  assert.deepEqual(dueActions(at(1, 0, 3), { ...S, days: [1, 2] }, {}), []);
  assert.deepEqual(dueActions(at(6, 30), { ...S, stop: '' }, {}), []);
});

test('effectiveLimitKB: window limit applies inside the hours, also across midnight', () => {
  const { effectiveLimitKB } = require('../src/core/schedule');
  const o = { limit: 0, windowEnabled: true, windowFrom: '08:00', windowTo: '22:00', windowLimit: 500 };
  const at = (h, m) => new Date(2026, 9, 30, h, m);
  assert.equal(effectiveLimitKB(at(7, 59), o), 0);
  assert.equal(effectiveLimitKB(at(8, 0), o), 500);
  assert.equal(effectiveLimitKB(at(21, 59), o), 500);
  assert.equal(effectiveLimitKB(at(22, 0), o), 0);
  const night = { ...o, windowFrom: '22:00', windowTo: '06:00' };
  assert.equal(effectiveLimitKB(at(23, 30), night), 500);
  assert.equal(effectiveLimitKB(at(3, 0), night), 500);
  assert.equal(effectiveLimitKB(at(12, 0), night), 0);
  assert.equal(effectiveLimitKB(at(12, 0), { ...o, limit: 2000, windowEnabled: false }), 2000);
  assert.equal(effectiveLimitKB(at(12, 0), { ...o, windowFrom: '', limit: 100 }), 100);
});
