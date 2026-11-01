'use strict';
const fs = require('fs');
const { atomicWriteJson } = require('./util');

const KEEP_DAYS = 400;
const MAX_HOSTS = 300;
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Totals of what has been downloaded: per day, per web site and per type. Kept in one small JSON file. */
class Stats {
  constructor(file) {
    this.file = file;
    this.data = { days: {}, hosts: {}, types: {}, total: { bytes: 0, count: 0 }, since: Date.now() };
    this._timer = null;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && typeof j === 'object') { this.data = { ...this.data, ...j }; }
    } catch { /* first run */ }
  }

  record({ bytes = 0, host = '', type = 'other', at = Date.now() } = {}) {
    const b = Math.max(0, Math.floor(Number(bytes) || 0));
    const d = this.data;
    const k = dayKey(new Date(at));
    const bump = (obj, key) => { const e = obj[key] || (obj[key] = { bytes: 0, count: 0 }); e.bytes += b; e.count += 1; };
    bump(d.days, k);
    if (host) { bump(d.hosts, String(host).slice(0, 100)); }
    bump(d.types, String(type).slice(0, 20));
    d.total.bytes += b; d.total.count += 1;
    this._prune(at);
    this._schedule();
  }

  _prune(now) {
    const d = this.data;
    const limit = dayKey(new Date(now - KEEP_DAYS * 86400000));
    for (const k of Object.keys(d.days)) { if (k < limit) { delete d.days[k]; } }
    const hosts = Object.entries(d.hosts);
    if (hosts.length > MAX_HOSTS) {
      hosts.sort((a, b) => b[1].bytes - a[1].bytes);
      d.hosts = Object.fromEntries(hosts.slice(0, MAX_HOSTS));
    }
  }

  /** Numbers for the statistics window. */
  summary(now = Date.now(), nDays = 14) {
    const d = this.data;
    const sumDays = (n) => {
      let bytes = 0; let count = 0;
      for (let i = 0; i < n; i++) { const e = d.days[dayKey(new Date(now - i * 86400000))]; if (e) { bytes += e.bytes; count += e.count; } }
      return { bytes, count };
    };
    const days = [];
    for (let i = nDays - 1; i >= 0; i--) {
      const day = new Date(now - i * 86400000);
      const e = d.days[dayKey(day)];
      days.push({ date: dayKey(day), bytes: e ? e.bytes : 0, count: e ? e.count : 0 });
    }
    const top = (obj, n) => Object.entries(obj).map(([name, v]) => ({ name, bytes: v.bytes, count: v.count })).sort((a, b) => b.bytes - a.bytes).slice(0, n);
    return {
      today: sumDays(1), week: sumDays(7), month: sumDays(30), total: { ...d.total }, since: d.since,
      days, hosts: top(d.hosts, 8), types: top(d.types, 8),
    };
  }

  reset() {
    this.data = { days: {}, hosts: {}, types: {}, total: { bytes: 0, count: 0 }, since: Date.now() };
    this.saveNow();
  }

  _schedule() {
    if (this._timer) { return; }
    this._timer = setTimeout(() => { this._timer = null; this.saveNow(); }, 3000);
    if (this._timer.unref) { this._timer.unref(); }
  }

  saveNow() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    try { atomicWriteJson(this.file, this.data); } catch { /* statistics are not worth an error */ }
  }
}

module.exports = { Stats, dayKey };
