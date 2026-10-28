'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { EventEmitter } = require('events');
const { request, classifyStatus, HttpError } = require('./http');
const { SpeedMeter, SpeedLimiter } = require('./limiter');
const { pickFilename, sleep, uniquePath } = require('./util');

const MIN_SPLIT = 512 * 1024;      // never split a segment smaller than this
const MIN_SEGMENT = 1024 * 1024;   // initial segment size lower bound
const MAX_RETRIES = 8;

/**
 * Probe a URL: size, range support, name and validators.
 * Uses GET with "Range: bytes=0-0" because many servers mishandle HEAD.
 */
async function probe(url, headers = {}, signal) {
  const { res, url: finalUrl } = await request(url, { headers: { ...headers, range: 'bytes=0-0' }, signal });
  const status = res.statusCode;
  const h = res.headers;
  res.destroy();
  let size = 0;
  let resumable = false;
  if (status === 206) {
    const m = /\/(\d+)\s*$/.exec(h['content-range'] || '');
    if (m) { size = Number(m[1]); resumable = size > 0; }
    else if (h['content-length']) { size = 0; }
  } else if (status === 200) {
    size = Number(h['content-length']) || 0;
    resumable = false;
  } else if (status === 416) {
    // Empty file or range unsatisfiable: fall back to a plain GET to learn the size.
    size = 0;
  } else {
    throw classifyStatus(status, { headers: h });
  }
  const type = (h['content-type'] || '').split(';')[0].trim().toLowerCase();
  return {
    finalUrl,
    size,
    resumable,
    mime: type,
    etag: h.etag || '',
    lastModified: h['last-modified'] || '',
    contentDisposition: h['content-disposition'] || '',
  };
}

class Download extends EventEmitter {
  /**
   * @param {object} state persisted/initial state (see Download.create)
   * @param {{limiter?: SpeedLimiter}} deps
   */
  constructor(state, { limiter, resolvePath } = {}) {
    super();
    this.state = state;
    this.limiter = limiter || new SpeedLimiter(0);
    this.resolvePath = resolvePath || ((dir, name) => uniquePath(dir, name));
    this.meter = new SpeedMeter();
    this.fd = null;
    this.ac = null;
    this._running = 0;
    this._stopReason = null;
    this._lastEmit = 0;
    this._error = null;
  }

  static create(opts) {
    return {
      id: opts.id,
      url: opts.url,
      finalUrl: '',
      headers: opts.headers || {},
      dir: opts.dir,
      filename: opts.filename || '',
      userNamed: !!opts.filename,
      path: opts.path || '',
      size: 0,
      downloaded: 0,
      resumable: false,
      etag: '',
      lastModified: '',
      mime: '',
      connections: opts.connections || 8,
      segments: [],
      status: 'queued', // queued | downloading | paused | done | error
      error: '',
      createdAt: Date.now(),
      completedAt: 0,
      kind: 'file',
      meta: opts.meta || {},
    };
  }

  get status() { return this.state.status; }
  get partPath() { return this.state.path + '.part'; }

  progress() {
    const s = this.state;
    const speed = s.status === 'downloading' ? this.meter.speed : 0;
    const left = s.size > 0 && speed > 0 ? Math.max(0, (s.size - s.downloaded) / speed) : 0;
    return {
      id: s.id, status: s.status, size: s.size, downloaded: s.downloaded, speed, eta: left,
      connections: this._running, filename: s.filename, error: s.error,
    };
  }

  _emitProgress(force = false) {
    const now = Date.now();
    if (!force && now - this._lastEmit < 250) { return; }
    this._lastEmit = now;
    this.emit('progress', this.progress());
  }

  _recount() {
    let total = 0;
    for (const seg of this.state.segments) { total += Math.min(seg.pos, seg.end + 1) - seg.start; }
    this.state.downloaded = total;
  }

  async start() {
    const s = this.state;
    if (s.status === 'done' || s.status === 'downloading') { return; }
    this._stopReason = null;
    this._error = null;
    s.status = 'downloading';
    s.error = '';
    this.ac = new AbortController();
    this.meter.reset();
    this.emit('status', this.progress());
    try {
      await this._prepare();
      if (this._stopReason) { return; }
      if (s.resumable && s.size > 0) { await this._runSegmented(); }
      else { await this._runSingle(); }
      if (this._stopReason) { return; }
      await this._finalize();
    } catch (err) {
      if (this._stopReason) { return; }
      await this._closeFd();
      s.status = 'error';
      s.error = err.message || String(err);
      this.emit('status', this.progress());
      this.emit('error', err);
    }
  }

  /** Probe (or re-validate when resuming) and open the part file. */
  async _prepare() {
    const s = this.state;
    const info = await probe(s.finalUrl || s.url, s.headers, this.ac.signal);
    const hadProgress = !!s.path && s.segments.length > 0 && s.downloaded > 0;
    const changed = hadProgress && (
      (s.size && info.size && s.size !== info.size) ||
      (s.etag && info.etag && s.etag !== info.etag) ||
      (s.lastModified && info.lastModified && s.lastModified !== info.lastModified) ||
      (s.resumable && !info.resumable)
    );
    s.finalUrl = info.finalUrl;
    s.mime = info.mime;
    if (!s.path) {
      s.filename = pickFilename({
        contentDisposition: s.userNamed ? '' : info.contentDisposition, url: info.finalUrl, mime: info.mime, hint: s.userNamed ? s.filename : '',
      });
      s.path = this.resolvePath(s.dir, s.filename);
      s.filename = path.basename(s.path);
    }
    if (changed || !hadProgress) {
      s.segments = [];
      s.downloaded = 0;
      try { await fsp.unlink(this.partPath); } catch { /* none */ }
    }
    s.size = info.size;
    s.resumable = info.resumable;
    s.etag = info.etag;
    s.lastModified = info.lastModified;
    await fsp.mkdir(path.dirname(s.path), { recursive: true });

    if (!s.segments.length && s.resumable && s.size > 0) {
      const n = Math.max(1, Math.min(s.connections, Math.ceil(s.size / MIN_SEGMENT)));
      const part = Math.floor(s.size / n);
      for (let i = 0; i < n; i++) {
        const start = i * part;
        const end = i === n - 1 ? s.size - 1 : start + part - 1;
        s.segments.push({ start, end, pos: start, done: false });
      }
    }
    // Open for read/write without truncating (resume keeps existing bytes).
    this.fd = await fsp.open(this.partPath, fs.existsSync(this.partPath) ? 'r+' : 'w+');
    if (s.size > 0 && s.resumable) {
      const st = await this.fd.stat();
      if (st.size !== s.size) { await this.fd.truncate(s.size); }
    }
    this._recount();
    this.emit('status', this.progress());
  }

  // ---------- segmented (multi-connection) mode ----------

  _runSegmented() {
    return new Promise((resolve, reject) => {
      this._segResolve = resolve;
      this._segReject = reject;
      this._maxConn = this.state.connections;
      this._schedule();
    });
  }

  _schedule() {
    const s = this.state;
    if (this._stopReason || this._failed) { return; }
    for (;;) {
      if (this._running >= this._maxConn) { break; }
      const waiting = s.segments.find((x) => !x.done && !x.running && x.pos <= x.end);
      if (waiting) { this._launch(waiting); continue; }
      // Dynamic splitting: take the second half of the biggest running segment.
      let victim = null;
      for (const x of s.segments) {
        if (x.done || !x.running) { continue; }
        const remaining = x.end - x.pos + 1;
        if (remaining >= MIN_SPLIT * 2 && (!victim || remaining > victim.end - victim.pos + 1)) { victim = x; }
      }
      if (!victim) { break; }
      const remaining = victim.end - victim.pos + 1;
      const mid = victim.pos + Math.floor(remaining / 2);
      const fresh = { start: mid, end: victim.end, pos: mid, done: false };
      victim.end = mid - 1;
      s.segments.push(fresh);
      this._launch(fresh);
    }
    if (this._running === 0 && s.segments.every((x) => x.done || x.pos > x.end)) {
      this._recount();
      this._segResolve();
    }
  }

  _launch(seg) {
    seg.running = true;
    this._running++;
    this._runSegment(seg)
      .then(() => { seg.done = seg.pos > seg.end; })
      .catch((err) => {
        if (this._stopReason) { return; }
        if (err && err.softLimit && this._maxConn > 1) {
          // Server refused this many connections: lower the cap and retry the segment.
          this._maxConn = Math.max(1, this._running - 1);
          seg.running = false;
          this._running--;
          setTimeout(() => this._schedule(), 1000);
          throw Object.assign(new Error('retry-scheduled'), { swallow: true });
        }
        this._failed = true;
        this.ac.abort();
        this._segReject(err);
      })
      .catch((e) => { if (!e?.swallow) { /* already handled */ } })
      .finally(() => {
        if (seg.running) { seg.running = false; this._running--; }
        this._schedule();
      });
  }

  async _runSegment(seg) {
    let attempt = 0;
    while (!this._stopReason && !this._failed) {
      if (seg.pos > seg.end) { return; }
      const before = seg.pos;
      try {
        await this._fetchRange(seg);
        if (seg.pos > seg.end) { return; }
        throw new HttpError('Kết nối bị ngắt sớm');
      } catch (err) {
        if (this._stopReason || this._failed) { return; }
        if (err.fatal) { throw err; }
        if (seg.pos > before) { attempt = 0; }
        attempt++;
        if ((err.status === 429 || err.status === 503) && this._running > 1) {
          throw Object.assign(err, { softLimit: true });
        }
        if (attempt > MAX_RETRIES) { throw err; }
        const delay = err.retryAfter || Math.min(15000, 400 * 2 ** (attempt - 1));
        await sleep(delay);
      }
    }
  }

  async _fetchRange(seg) {
    const s = this.state;
    const { res } = await request(s.finalUrl || s.url, {
      headers: { ...s.headers, range: `bytes=${seg.pos}-${seg.end}` },
      signal: this.ac.signal,
    });
    if (res.statusCode !== 206) {
      res.destroy();
      if (res.statusCode === 200 && s.segments.length === 1 && seg.pos === 0) {
        throw new HttpError('Máy chủ bỏ qua Range', { fatal: true });
      }
      throw classifyStatus(res.statusCode, res);
    }
    const cr = /bytes\s+(\d+)-/.exec(res.headers['content-range'] || '');
    if (cr && Number(cr[1]) !== seg.pos) {
      res.destroy();
      throw new HttpError('Content-Range không khớp');
    }
    try {
      for await (let chunk of res) {
        if (this._stopReason) { break; }
        const room = seg.end - seg.pos + 1;
        if (room <= 0) { break; }
        if (chunk.length > room) { chunk = chunk.subarray(0, room); }
        await this.limiter.wait(chunk.length);
        if (this._stopReason) { break; }
        const writePos = seg.pos;
        await this.fd.write(chunk, 0, chunk.length, writePos);
        seg.pos = writePos + chunk.length;
        this.state.downloaded += chunk.length;
        this.meter.add(chunk.length);
        this._emitProgress();
        if (seg.pos > seg.end) { break; }
      }
    } finally {
      res.destroy();
    }
  }

  // ---------- single connection fallback ----------

  async _runSingle() {
    const s = this.state;
    s.segments = [];
    s.downloaded = 0;
    await this.fd.truncate(0);
    let attempt = 0;
    for (;;) {
      try {
        const { res } = await request(s.finalUrl || s.url, { headers: s.headers, signal: this.ac.signal });
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.destroy();
          throw classifyStatus(res.statusCode, res);
        }
        if (!s.size) { s.size = Number(res.headers['content-length']) || 0; }
        let pos = 0;
        s.downloaded = 0;
        try {
          for await (const chunk of res) {
            if (this._stopReason) { break; }
            await this.limiter.wait(chunk.length);
            await this.fd.write(chunk, 0, chunk.length, pos);
            pos += chunk.length;
            s.downloaded = pos;
            this.meter.add(chunk.length);
            this._emitProgress();
          }
        } finally { res.destroy(); }
        if (this._stopReason) { return; }
        if (s.size && pos < s.size) { throw new HttpError('Kết nối bị ngắt sớm'); }
        s.size = s.size || pos;
        return;
      } catch (err) {
        if (this._stopReason || err.fatal || ++attempt > MAX_RETRIES) { throw err; }
        await sleep(Math.min(15000, 400 * 2 ** (attempt - 1)));
      }
    }
  }

  // ---------- lifecycle ----------

  async _closeFd() {
    if (this.fd) {
      try { await this.fd.close(); } catch { /* ignore */ }
      this.fd = null;
    }
  }

  async _finalize() {
    const s = this.state;
    if (s.size && s.downloaded < s.size) { throw new HttpError('Tệp tải về chưa đủ dung lượng'); }
    try { await this.fd.sync(); } catch { /* not fatal */ }
    await this._closeFd();
    // Never overwrite a file that appeared meanwhile.
    let target = s.path;
    if (fs.existsSync(target)) {
      const { uniquePath } = require('./util');
      target = uniquePath(path.dirname(target), path.basename(target));
      s.path = target;
      s.filename = path.basename(target);
    }
    await fsp.rename(this.partPath, target);
    s.status = 'done';
    s.completedAt = Date.now();
    s.segments = [];
    this._emitProgress(true);
    this.emit('status', this.progress());
    this.emit('done', this.progress());
  }

  /** Stop without deleting data; state stays resumable. */
  async pause() {
    if (this.state.status !== 'downloading' && this.state.status !== 'queued') { return; }
    this._stopReason = 'pause';
    if (this.ac) { this.ac.abort(); }
    await this._waitIdle();
    if (this._segResolve) { this._segResolve(); }
    for (const seg of this.state.segments) { seg.running = false; }
    this._recount();
    await this._closeFd();
    this.state.status = 'paused';
    this.emit('status', this.progress());
  }

  /** Stop and delete partial data. */
  async cancel({ removeFile = true } = {}) {
    this._stopReason = 'cancel';
    if (this.ac) { this.ac.abort(); }
    await this._waitIdle();
    if (this._segResolve) { this._segResolve(); }
    await this._closeFd();
    if (removeFile) {
      try { await fsp.unlink(this.partPath); } catch { /* none */ }
    }
  }

  async _waitIdle() {
    const t0 = Date.now();
    while (this._running > 0 && Date.now() - t0 < 3000) { await sleep(20); }
    this._running = 0;
  }
}

module.exports = { Download, probe, MIN_SPLIT };
