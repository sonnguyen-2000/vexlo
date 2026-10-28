'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Download, probe } = require('./download');
const { SegmentedDownload } = require('./segmented');
const { SpeedLimiter } = require('./limiter');
const { uniquePath, atomicWriteJson, pickFilename, sanitizeFilename } = require('./util');

function detectKind(url, hint) {
  if (hint === 'hls' || hint === 'dash' || hint === 'file') { return hint; }
  let p = '';
  try { p = new URL(url).pathname.toLowerCase(); } catch { /* ignore */ }
  if (/\.m3u8?$/.test(p)) { return 'hls'; }
  if (/\.mpd$/.test(p)) { return 'dash'; }
  return 'file';
}

/**
 * Owns all downloads: queue, persistence, global speed limit.
 * Events: 'update' (snapshot of one task), 'added', 'removed', 'done', 'error'.
 */
class DownloadManager extends EventEmitter {
  constructor({
    dataDir, downloadDir, maxConcurrent = 3, connections = 8, speedLimit = 0, ffmpegPath, autoResume = false,
  }) {
    super();
    this.dataDir = dataDir;
    this.downloadDir = downloadDir;
    this.maxConcurrent = maxConcurrent;
    this.connections = connections;
    this.ffmpegPath = ffmpegPath;
    this.autoResume = autoResume;
    this.limiter = new SpeedLimiter(speedLimit);
    this.tasks = new Map(); // id -> { dl, state }
    this.file = path.join(dataDir, 'downloads.json');
    this._saveTimer = null;
  }

  // ----- persistence -----

  load() {
    let items = [];
    try { items = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }
    for (const state of items) {
      if (state.status === 'downloading' || state.status === 'queued') { state.status = 'paused'; }
      state.pending = false;
      for (const seg of state.segments || []) { delete seg.running; }
      this._register(state);
    }
    if (this.autoResume) {
      for (const { state } of this.tasks.values()) { if (state.status === 'paused') { this.resume(state.id); } }
    }
  }

  _serialize(state) {
    const copy = JSON.parse(JSON.stringify(state));
    for (const seg of copy.segments || []) { delete seg.running; }
    return copy;
  }

  _scheduleSave() {
    if (this._saveTimer) { return; }
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this.saveNow(); }, 1000);
  }

  saveNow() {
    try { atomicWriteJson(this.file, [...this.tasks.values()].map((t) => this._serialize(t.state))); }
    catch (e) { this.emit('warn', e); }
  }

  // ----- helpers -----

  _reservedPaths(exceptId) {
    const set = new Set();
    for (const { state } of this.tasks.values()) {
      if (state.id !== exceptId && state.path && state.status !== 'done') { set.add(state.path.toLowerCase()); }
    }
    return set;
  }

  _makeDl(state) {
    const resolvePath = (dir, name) => uniquePath(dir, name, this._reservedPaths(state.id));
    const deps = { limiter: this.limiter, ffmpegPath: this.ffmpegPath, resolvePath };
    return state.kind === 'hls' || state.kind === 'dash' ? new SegmentedDownload(state, deps) : new Download(state, deps);
  }

  _register(state) {
    const dl = this._makeDl(state);
    const task = { dl, state: dl.state };
    this.tasks.set(state.id, task);
    dl.on('progress', (p) => { this.emit('update', this.snapshot(task)); });
    dl.on('status', () => { this.emit('update', this.snapshot(task)); this._scheduleSave(); });
    dl.on('done', () => { this.emit('done', this.snapshot(task)); this.saveNow(); this._pump(); });
    dl.on('error', () => { this.emit('error', this.snapshot(task)); this.saveNow(); this._pump(); });
    return task;
  }

  snapshot(task) {
    const s = task.state;
    const p = task.dl.progress();
    return {
      id: s.id, url: s.url, kind: s.kind, filename: s.filename, path: s.path, dir: s.dir, status: s.status,
      size: s.size, downloaded: s.downloaded, speed: p.speed, eta: p.eta, connections: p.connections,
      error: s.error, createdAt: s.createdAt, completedAt: s.completedAt, resumable: s.resumable,
      segDone: s.segDone || 0, segTotal: s.segTotal || 0, phase: p.phase || '', meta: s.meta || {},
      pending: !!s.pending, mime: s.mime || '', quality: s.quality || 'best', connectionsMax: s.connections,
    };
  }

  list() {
    return [...this.tasks.values()].map((t) => this.snapshot(t)).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id) { return this.tasks.get(id); }

  // ----- operations -----

  /** @returns {string} new task id */
  add(opts) {
    if (!opts || !/^https?:\/\//i.test(opts.url || '')) { throw new Error('URL không hợp lệ'); }
    const kind = detectKind(opts.url, opts.kind);
    const base = {
      id: /^[0-9a-f-]{36}$/i.test(opts.id || '') ? opts.id : crypto.randomUUID(), url: opts.url, headers: opts.headers || {}, dir: opts.dir || this.downloadDir,
      // Names come from web pages and browser extensions: never let one carry a path ("..\\x", "C:\\...") into the folder logic.
      filename: opts.filename ? sanitizeFilename(opts.filename) : '', connections: opts.connections || this.connections, meta: opts.meta || {},
    };
    const state = kind === 'file' ? Download.create(base) : SegmentedDownload.create({ ...base, kind, quality: opts.quality });
    state.kind = kind;
    if (opts.pending) { state.pending = true; }
    this._register(state);
    this.emit('added', this.snapshot(this.tasks.get(state.id)));
    if (opts.start === false) { state.status = 'paused'; this.emit('update', this.snapshot(this.tasks.get(state.id))); }
    else { state.status = 'queued'; this._pump(); }
    this._scheduleSave();
    return state.id;
  }

  _runningCount() {
    let n = 0;
    for (const { state } of this.tasks.values()) { if (state.status === 'downloading') { n++; } }
    return n;
  }

  _pump() {
    for (const { dl, state } of this.tasks.values()) {
      if (this._runningCount() >= this.maxConcurrent) { break; }
      if (state.status === 'queued') {
        dl.start().catch((e) => this.emit('warn', e));
      }
    }
  }

  async pause(id) {
    const t = this.tasks.get(id);
    if (!t) { return; }
    if (t.state.status === 'queued') { t.state.status = 'paused'; this.emit('update', this.snapshot(t)); }
    else { await t.dl.pause(); }
    this._scheduleSave();
    this._pump();
  }

  resume(id) {
    const t = this.tasks.get(id);
    if (!t || !['paused', 'error'].includes(t.state.status)) { return; }
    // Rebuild the runner so stale abort flags / file handles are gone.
    const state = t.state;
    state.status = 'queued';
    state.error = '';
    t.dl.removeAllListeners();
    this.tasks.delete(id);
    const task = this._register(state);
    this.emit('update', this.snapshot(task));
    this._pump();
    this._scheduleSave();
  }

  async remove(id, { deleteFile = false } = {}) {
    const t = this.tasks.get(id);
    if (!t) { return; }
    const st = t.state;
    if (st.status === 'downloading' || st.status === 'queued') { await t.dl.cancel({ removeFile: true }); }
    else if (st.status !== 'done') {
      // paused / error: delete partial data
      await t.dl.cancel({ removeFile: true });
      if (st.kind !== 'file' && st.path) { try { fs.rmSync(st.path + '.parts', { recursive: true, force: true }); } catch { /* ignore */ } }
    }
    if (deleteFile && st.status === 'done' && st.path) { try { fs.unlinkSync(st.path); } catch { /* ignore */ } }
    this.tasks.delete(id);
    this.emit('removed', { id });
    this.saveNow();
    this._pump();
  }

  /**
   * Ask the server about a pending task (name, size, resumable) so a confirm dialog can show real values.
   * Never throws; returns the updated snapshot (or {error}).
   */
  async probeInfo(id) {
    const t = this.tasks.get(id);
    if (!t) { return null; }
    const st = t.state;
    if (st.kind !== 'file') { return { ...this.snapshot(t), filenameGuess: st.filename || '' }; }
    try {
      const info = await probe(st.url, st.headers);
      st.size = info.size;
      st.resumable = info.resumable;
      st.mime = info.mime;
      st.finalUrl = info.finalUrl;
      if (!st.userNamed) {
        st.filename = pickFilename({ contentDisposition: info.contentDisposition, url: info.finalUrl, mime: info.mime });
      }
    } catch (e) {
      const snap = this.snapshot(t);
      return { ...snap, probeError: e.message };
    }
    this.emit('update', this.snapshot(t));
    return this.snapshot(t);
  }

  /** Change name/folder/quality/connections of a task that has not started yet. */
  update(id, patch = {}) {
    const t = this.tasks.get(id);
    if (!t) { return; }
    const st = t.state;
    if (st.status === 'downloading' || st.status === 'done' || (st.downloaded > 0 && st.status !== 'paused')) { return; }
    if (typeof patch.filename === 'string' && patch.filename.trim() && patch.filename !== st.filename) {
      if (st.downloaded === 0) { st.filename = sanitizeFilename(patch.filename); st.userNamed = true; st.path = ''; }
    }
    if (typeof patch.dir === 'string' && patch.dir && st.downloaded === 0) { st.dir = patch.dir; st.path = ''; }
    if (patch.quality && st.kind !== 'file') { st.quality = patch.quality; }
    if (patch.connections) { st.connections = Math.max(1, Math.min(32, Number(patch.connections) || st.connections)); }
    this.emit('update', this.snapshot(t));
    this._scheduleSave();
  }

  /** Leave pending state; optionally start right away. */
  confirm(id, { start = true } = {}) {
    const t = this.tasks.get(id);
    if (!t) { return; }
    t.state.pending = false;
    if (start) { this.resume(id); } else { this.emit('update', this.snapshot(t)); this._scheduleSave(); }
  }

  pauseAll() { return Promise.all([...this.tasks.keys()].map((id) => this.pause(id))); }
  resumeAll() { for (const id of this.tasks.keys()) { this.resume(id); } }

  setSpeedLimit(bytesPerSec) { this.limiter.setLimit(bytesPerSec); }
  setMaxConcurrent(n) { this.maxConcurrent = Math.max(1, Number(n) || 1); this._pump(); }

  async shutdown() {
    await this.pauseAll();
    this.saveNow();
  }
}

module.exports = { DownloadManager, detectKind };
