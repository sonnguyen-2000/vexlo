'use strict';
/* Same surface as DownloadManager (what main.js and api.js use), but the work happens in worker.js in another process.
 * Reads (list/get/snapshot) are answered from a local cache that the worker keeps up to date with events. */
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { detectKind } = require('./manager');

const WORKER = path.join(__dirname, 'worker.js');

function spawnWorker() {
  if (process.versions && process.versions.electron) {
    try {
      const { utilityProcess } = require('electron');
      if (utilityProcess) {
        const child = utilityProcess.fork(WORKER, [], { serviceName: 'Vexlo engine' });
        return {
          post: (m) => child.postMessage(m),
          onMessage: (fn) => child.on('message', fn),
          onExit: (fn) => child.on('exit', fn),
          kill: () => child.kill(),
        };
      }
    } catch { /* fall through to fork */ }
  }
  const child = require('child_process').fork(WORKER, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  return {
    post: (m) => { if (child.connected) { child.send(m); } },
    onMessage: (fn) => child.on('message', fn),
    onExit: (fn) => child.on('exit', fn),
    kill: () => child.kill(),
  };
}

class EngineClient extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = { ...opts };
    this._dir = opts.downloadDir;
    this._conns = opts.connections;
    this.cache = new Map();
    this._rid = 0;
    this._pending = new Map();
    this._closing = false;
    this.restarts = 0;
    this.ready = new Promise((resolve) => { this._resolveReady = resolve; });
    this._start();
  }

  _start() {
    this._w = spawnWorker();
    const me = this._w;
    me.onMessage((msg) => { if (this._w === me) { this._onMessage(msg); } });
    me.onExit(() => {
      if (this._w !== me) { return; }
      for (const [, p] of this._pending) { p.reject(new Error('engine stopped')); }
      this._pending.clear();
      if (this._closing) { return; }
      this.emit('warn', 'engine process exited, restarting');
      this.restarts++;
      setTimeout(() => { if (!this._closing) { this._start(); } }, 500);
    });
    me.post({ t: 'init', opts: { ...this.opts, downloadDir: this._dir, connections: this._conns } });
  }

  _onMessage(msg) {
    if (!msg) { return; }
    if (msg.t === 'ready') {
      this.cache = new Map((msg.list || []).map((s) => [s.id, s]));
      if (this._resolveReady) { this._resolveReady(); this._resolveReady = null; }
      else { for (const s of this.cache.values()) { this.emit('update', s); } }
    } else if (msg.t === 'reply') {
      const p = this._pending.get(msg.rid);
      if (!p) { return; }
      this._pending.delete(msg.rid);
      if (msg.ok) { p.resolve(msg.v); } else { p.reject(new Error(msg.err || 'engine error')); }
    } else if (msg.t === 'ev') {
      const { name, data } = msg;
      if (name === 'removed') { this.cache.delete(data.id); }
      else if (name === 'warn') { this.emit('warn', new Error(String(data))); return; }
      else if (data && data.id) { this.cache.set(data.id, data); }
      if (name === 'error' && this.listenerCount('error') === 0) { return; }
      this.emit(name, data);
    }
  }

  _call(m, ...a) {
    return new Promise((resolve, reject) => {
      const rid = ++this._rid;
      this._pending.set(rid, { resolve, reject });
      this._w.post({ t: 'call', rid, m, a });
    });
  }

  // ----- reads (synchronous, from cache) -----
  list() { return [...this.cache.values()].sort((a, b) => b.createdAt - a.createdAt); }
  get(id) { const s = this.cache.get(id); return s ? { state: s } : undefined; }
  snapshot(t) { return t.state; }

  // ----- config -----
  get downloadDir() { return this._dir; }
  set downloadDir(v) { this._dir = v; this._w.post({ t: 'config', downloadDir: v }); }
  get connections() { return this._conns; }
  set connections(v) { this._conns = v; this._w.post({ t: 'config', connections: v }); }
  setSpeedLimit(bps) { this.opts.speedLimit = bps; this._call('setSpeedLimit', bps).catch(() => {}); }
  setMaxConcurrent(n) { this.opts.maxConcurrent = n; this._call('setMaxConcurrent', n).catch(() => {}); }

  // ----- operations -----
  /** @returns {string} new task id (known immediately; the worker creates the task with this id) */
  add(o) {
    if (!o || !/^https?:\/\//i.test(o.url || '')) { throw new Error('URL không hợp lệ'); }
    const id = crypto.randomUUID();
    const kind = detectKind(o.url, o.kind);
    const stub = {
      id, url: o.url, kind, filename: o.filename || '', path: '', dir: o.dir || this._dir, status: o.start === false || o.pending ? 'paused' : 'queued',
      size: 0, downloaded: 0, speed: 0, eta: 0, connections: 0, error: '', createdAt: Date.now(), completedAt: 0, resumable: false,
      segDone: 0, segTotal: 0, phase: '', meta: o.meta || {}, pending: !!o.pending, mime: '', quality: o.quality || 'best', connectionsMax: o.connections || this._conns,
    };
    if (!this.cache.has(id)) { this.cache.set(id, stub); }
    this._call('add', { ...o, id }).catch((e) => { this.cache.delete(id); this.emit('warn', e); });
    return id;
  }
  pause(id) { return this._call('pause', id); }
  resume(id) { this._call('resume', id).catch(() => {}); }
  remove(id, opts) { return this._call('remove', id, opts); }
  probeInfo(id) { return this._call('probeInfo', id); }
  update(id, patch) { this._call('update', id, patch).catch(() => {}); }
  confirm(id, opts) { this._call('confirm', id, opts).catch(() => {}); }
  pauseAll() { return this._call('pauseAll'); }
  resumeAll() { this._call('resumeAll').catch(() => {}); }

  async shutdown() {
    this._closing = true;
    try { await Promise.race([this._call('shutdown'), new Promise((r) => setTimeout(r, 4000))]); } catch { /* engine already gone */ }
    try { this._w.kill(); } catch { /* ignore */ }
  }
}

module.exports = { EngineClient };
