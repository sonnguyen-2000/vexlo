'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { request, fetchBuffer, classifyStatus, HttpError } = require('./http');
const { SpeedMeter, SpeedLimiter } = require('./limiter');
const { parseM3u8, pickVariant } = require('./hls');
const { parseMpd, pickRepresentation } = require('./dash');
const { Download } = require('./download');
const { sleep, uniquePath } = require('./util');

const SEG_RETRIES = 6;
const SEG_IDLE_MS = Number(process.env.VEXLO_IDLE_MS) || 8000; // a connection that sends nothing for this long is dropped and the segment is asked again on a fresh one

function resolveFfmpeg(explicit) {
  if (explicit) { return explicit; }
  if (process.env.VEXLO_FFMPEG) { return process.env.VEXLO_FFMPEG; }
  try {
    const p = require('ffmpeg-static');
    // Binaries cannot run from inside app.asar; electron-builder unpacks them next to it.
    return p ? p.replace('app.asar' + require('path').sep, 'app.asar.unpacked' + require('path').sep) : 'ffmpeg';
  } catch { return 'ffmpeg'; }
}

/** fs.rename that tries again for a moment when Windows says the file is busy (EPERM / EBUSY / EACCES). */
async function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { return await fsp.rename(from, to); }
    catch (e) {
      if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { throw e; }
      await sleep(80 * (i + 1));
    }
  }
}

/** HLS / DASH downloader: fetch playlist, download segments in parallel, merge, remux with ffmpeg. */
class SegmentedDownload extends EventEmitter {
  constructor(state, { limiter, ffmpegPath, resolvePath } = {}) {
    super();
    this.resolvePath = resolvePath || ((dir, name) => uniquePath(dir, name));
    this.state = state;
    this.limiter = limiter || new SpeedLimiter(0);
    this.ffmpegPath = resolveFfmpeg(ffmpegPath);
    this.meter = new SpeedMeter();
    this.ac = null;
    this._stopReason = null;
    this._active = 0;
    this._inner = [];
    this._lastEmit = 0;
    this._singleBytes = 0;
    this._doneSegs = 0;
    this._totalSegs = 0;
  }

  static create(opts) {
    const s = Download.create(opts);
    s.kind = opts.kind; // 'hls' | 'dash'
    s.quality = opts.quality || 'best';
    s.segDone = 0;
    s.segTotal = 0;
    s.output = '';
    return s;
  }

  get partsDir() { return this.state.path + '.parts'; }

  progress() {
    const s = this.state;
    const speed = s.status === 'downloading' ? this.meter.speed : 0;
    const left = s.size > 0 && speed > 0 ? Math.max(0, (s.size - s.downloaded) / speed) : 0;
    return {
      id: s.id, status: s.status, size: s.size, downloaded: s.downloaded, speed, eta: left,
      connections: this._active, filename: s.filename, error: s.error, segDone: s.segDone, segTotal: s.segTotal,
      phase: this._phase || '',
    };
  }

  _emitProgress(force = false) {
    const now = Date.now();
    if (!force && now - this._lastEmit < 250) { return; }
    this._lastEmit = now;
    this.emit('progress', this.progress());
  }

  async start() {
    const s = this.state;
    if (s.status === 'done' || s.status === 'downloading') { return; }
    this._stopReason = null;
    s.status = 'downloading';
    s.error = '';
    this.ac = new AbortController();
    this.meter.reset();
    this._phase = 'prepare';
    this.emit('status', this.progress());
    try {
      this._prepareNames();
      const plan = s.kind === 'dash' ? await this._planDash() : await this._planHls();
      if (this._stopReason) { return; }
      await fsp.mkdir(this.partsDir, { recursive: true });
      this._phase = 'download';
      await this._downloadAll(plan);
      if (this._stopReason) { return; }
      this._phase = 'merge';
      this._emitProgress(true);
      const merged = await this._merge(plan);
      this._phase = 'mux';
      await this._mux(plan, merged);
      await this._finish();
    } catch (err) {
      if (this._stopReason) { return; }
      s.status = 'error';
      s.error = err.message || String(err);
      this.emit('status', this.progress());
      this.emit('error', err);
    }
  }

  _prepareNames() {
    const s = this.state;
    if (!s.filename) {
      let n = '';
      try { n = decodeURIComponent(new URL(s.url).pathname.split('/').filter(Boolean).pop() || ''); } catch { /* ignore */ }
      s.filename = n || 'video';
    }
    s.filename = s.filename.replace(/\.(m3u8?|mpd)$/i, '');
    if (!/\.(mp4|mkv|webm|ts|mov)$/i.test(s.filename)) { s.filename += '.mp4'; }
    if (!s.path) { s.path = this.resolvePath(s.dir, s.filename); s.filename = path.basename(s.path); }
  }

  // ---------- planning ----------

  async _planHls() {
    const s = this.state;
    const opts = { headers: s.headers, signal: this.ac.signal };
    let { body, url } = await fetchBuffer(s.url, opts);
    let pl = parseM3u8(body.toString('utf8'), url);
    let audioUrl = '';
    if (pl.type === 'master') {
      const v = pickVariant(pl.variants, s.quality);
      if (!v) { throw new HttpError('Playlist không có luồng video nào', { fatal: true }); }
      if (v.audio) {
        const group = pl.audios.filter((a) => a.group === v.audio);
        const a = group.find((x) => x.def) || group[0];
        if (a && a.url !== v.url) { audioUrl = a.url; }
      }
      ({ body, url } = await fetchBuffer(v.url, opts));
      pl = parseM3u8(body.toString('utf8'), url);
      s.meta = { ...s.meta, width: v.width, height: v.height, bandwidth: v.bandwidth };
    }
    const tracks = [await this._hlsTrack(pl, 'video', opts)];
    if (audioUrl) {
      const r = await fetchBuffer(audioUrl, opts);
      tracks.push(await this._hlsTrack(parseM3u8(r.body.toString('utf8'), r.url), 'audio', opts));
    }
    return { tracks };
  }

  async _hlsTrack(pl, type, opts) {
    if (pl.unsupported) { throw new HttpError(pl.unsupported, { fatal: true }); }
    if (!pl.endlist) { throw new HttpError('Đây là luồng trực tiếp (live), chưa được hỗ trợ', { fatal: true }); }
    if (!pl.segments.length) { throw new HttpError('Playlist rỗng', { fatal: true }); }
    const keys = new Map();
    for (const seg of pl.segments) {
      if (seg.key && seg.key.uri && !keys.has(seg.key.uri)) {
        keys.set(seg.key.uri, (await fetchBuffer(seg.key.uri, opts)).body);
      }
    }
    const first = pl.segments[0].url.split('?')[0].toLowerCase();
    const isTs = !pl.map && !/\.(m4s|mp4|m4a|m4v|cmfv|cmfa)$/.test(first);
    return {
      type, container: isTs ? 'ts' : 'mp4', init: pl.map,
      segments: pl.segments.map((x) => ({
        url: x.url, range: x.range, duration: x.duration,
        key: x.key ? { key: keys.get(x.key.uri), iv: x.key.iv, seq: x.seq } : null,
      })),
    };
  }

  async _planDash() {
    const s = this.state;
    const { body, url } = await fetchBuffer(s.url, { headers: s.headers, signal: this.ac.signal });
    const mpd = parseMpd(body.toString('utf8'), url);
    if (mpd.protection) { throw new HttpError('Video được bảo vệ DRM, không thể tải', { fatal: true }); }
    const v = pickRepresentation(mpd.video, s.quality);
    const a = pickRepresentation(mpd.audio, 'best');
    if (!v && !a) { throw new HttpError('Manifest không có luồng video/audio nào', { fatal: true }); }
    if (v) { s.meta = { ...s.meta, width: v.width, height: v.height, bandwidth: v.bandwidth }; }
    const toTrack = (rep, type) => ({
      type, container: 'mp4', single: rep.single || null, init: rep.init || null, mime: rep.mime, codecs: rep.codecs,
      segments: rep.segments || [],
    });
    const tracks = [];
    if (v) { tracks.push(toTrack(v, 'video')); }
    if (a) { tracks.push(toTrack(a, 'audio')); }
    return { tracks };
  }

  // ---------- downloading ----------

  async _downloadAll(plan) {
    const s = this.state;
    const jobs = [];
    plan.tracks.forEach((t, ti) => {
      if (t.single) { return; }
      if (t.init) { jobs.push({ ti, idx: -1, url: t.init.url, range: t.init.range, key: null }); }
      t.segments.forEach((seg, idx) => jobs.push({ ti, idx, url: seg.url, range: seg.range, key: seg.key }));
    });
    this._totalSegs = jobs.length + plan.tracks.filter((t) => t.single).length;
    s.segTotal = this._totalSegs;

    // Count what earlier runs already finished.
    let have = 0;
    let haveBytes = 0;
    const pending = [];
    for (const job of jobs) {
      const f = this._segPath(job);
      try { const st = await fsp.stat(f); have++; haveBytes += st.size; } catch { pending.push(job); }
    }
    this._baseBytes = haveBytes;
    this._runBytes = 0;
    this._doneSegs = have;
    s.segDone = have;
    this._updateSizes();

    const workers = [];
    const conns = Math.max(1, Math.min(s.connections || 8, 24));
    let next = 0;
    let failure = null;
    const worker = async () => {
      while (!this._stopReason && !failure) {
        const job = pending[next++];
        if (!job) { return; }
        this._active++;
        try { await this._fetchSegment(job); }
        catch (e) { if (!this._stopReason) { failure = failure || e; this.ac.abort(); } }
        finally { this._active--; }
      }
    };
    for (let i = 0; i < Math.min(conns, pending.length); i++) { workers.push(worker()); }
    // Whole-file tracks use the multi-connection file engine.
    const singles = plan.tracks.map((t, ti) => ({ t, ti })).filter((x) => x.t.single);
    const singleTasks = singles.map(({ t, ti }) => this._downloadSingle(t, ti).catch((e) => {
      if (!this._stopReason) { failure = failure || e; this.ac.abort(); }
    }));
    await Promise.all([...workers, ...singleTasks]);
    if (this._stopReason) { return; }
    if (failure) { throw failure; }
  }

  _segPath(job) { return path.join(this.partsDir, `t${job.ti}-${String(job.idx + 1).padStart(6, '0')}.seg`); }

  _updateSizes() {
    const s = this.state;
    s.downloaded = this._baseBytes + this._runBytes + this._singleBytes;
    if (this._doneSegs > 0 && this._totalSegs > 0) {
      s.size = Math.max(s.downloaded, Math.round((s.downloaded / Math.max(1, this._doneSegs)) * this._totalSegs));
    }
  }

  async _fetchSegment(job) {
    const s = this.state;
    let attempt = 0;
    for (;;) {
      let received = 0;
      const t0 = Date.now();
      try {
        const headers = { ...s.headers };
        if (job.range) { headers.range = `bytes=${job.range.start}-${job.range.end}`; }
        const { res } = await request(job.url, { headers, signal: this.ac.signal, timeout: 20000, idleTimeout: SEG_IDLE_MS });
        if (res.statusCode !== 200 && res.statusCode !== 206) { res.destroy(); throw classifyStatus(res.statusCode, res); }
        const chunks = [];
        for await (const c of res) {
          if (this._stopReason) { res.destroy(); return; }
          await this.limiter.wait(c.length);
          chunks.push(c);
          received += c.length;
          this._runBytes += c.length;
          this.meter.add(c.length);
          this._updateSizes();
          this._emitProgress();
        }
        let data = Buffer.concat(chunks);
        if (job.key && job.key.key) {
          const iv = job.key.iv || (() => { const b = Buffer.alloc(16); b.writeUInt32BE(job.key.seq >>> 0, 12); return b; })();
          const d = crypto.createDecipheriv('aes-128-cbc', job.key.key, iv);
          data = Buffer.concat([d.update(data), d.final()]);
        }
        const f = this._segPath(job);
        await fsp.writeFile(f + '.tmp', data);
        await renameRetry(f + '.tmp', f); // antivirus / indexers may hold the new file for a moment on Windows
        this._doneSegs++;
        s.segDone = this._doneSegs;
        this._updateSizes();
        this._emitProgress();
        if (Date.now() - t0 > 6000) { this.emit('warn', `slow segment t${job.ti}#${job.idx} took ${Date.now() - t0} ms (${received} bytes)`); }
        return;
      } catch (err) {
        if (this._stopReason || err.fatal) { throw err; }
        this._runBytes -= received; // the failed attempt's bytes are thrown away, do not count them twice
        this._updateSizes();
        if (++attempt > SEG_RETRIES) { throw err; }
        const wait = Math.min(8000, 300 * 2 ** (attempt - 1));
        this.emit('warn', `segment t${job.ti}#${job.idx} attempt ${attempt} failed after ${Date.now() - t0} ms (${err.code || err.status || err.message}), retry in ${wait} ms`);
        await sleep(wait);
      }
    }
  }

  async _downloadSingle(track, ti) {
    const s = this.state;
    const st = Download.create({
      id: s.id + '-t' + ti, url: track.single, headers: s.headers, dir: this.partsDir, filename: `t${ti}.bin`, connections: s.connections || 8,
    });
    const d = new Download(st, { limiter: this.limiter });
    this._inner.push(d);
    let last = 0;
    d.on('progress', (p) => {
      this._singleBytes += p.downloaded - last;
      this.meter.add(Math.max(0, p.downloaded - last));
      last = p.downloaded;
      this._updateSizes();
      this._emitProgress();
    });
    // Finished from a previous run?
    const donePath = path.join(this.partsDir, `t${ti}.bin`);
    if (fs.existsSync(donePath)) { this._doneSegs++; s.segDone = this._doneSegs; return; }
    if (this._stopReason) { return; }
    // Size estimate before the first segment finishes.
    d.once('status', (p) => { if (p.size) { this._totalSizeHint = (this._totalSizeHint || 0) + p.size; } });
    await d.start();
    if (this._stopReason) { return; }
    if (d.state.status !== 'done') { throw new Error(d.state.error || 'Không tải được luồng DASH'); }
    this._doneSegs++;
    s.segDone = this._doneSegs;
  }

  // ---------- merging ----------

  async _merge(plan) {
    const out = [];
    for (let ti = 0; ti < plan.tracks.length; ti++) {
      const t = plan.tracks[ti];
      if (t.single) { out.push(path.join(this.partsDir, `t${ti}.bin`)); continue; }
      const ext = t.container === 'ts' ? 'ts' : 'mp4';
      const file = path.join(this.partsDir, `track${ti}.${ext}`);
      const ws = fs.createWriteStream(file);
      const append = (f) => new Promise((resolve, reject) => {
        const rs = fs.createReadStream(f);
        rs.on('error', reject);
        rs.on('end', resolve);
        rs.pipe(ws, { end: false });
      });
      try {
        if (t.init) { await append(this._segPath({ ti, idx: -1 })); }
        for (let i = 0; i < t.segments.length; i++) { await append(this._segPath({ ti, idx: i })); }
      } finally {
        await new Promise((r) => ws.end(r));
      }
      out.push(file);
    }
    return out;
  }

  _runFfmpeg(args) {
    return new Promise((resolve, reject) => {
      const p = spawn(this.ffmpegPath, args, { windowsHide: true });
      let err = '';
      p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 8000) { err = err.slice(-4000); } });
      p.on('error', (e) => reject(Object.assign(e, { noFfmpeg: e.code === 'ENOENT' })));
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg lỗi: ' + err.trim().split('\n').slice(-3).join(' | ')))));
      this._ffmpeg = p;
    });
  }

  async _mux(plan, files) {
    const s = this.state;
    const tmpOut = s.path + '.mux' + path.extname(s.path);
    const ts = plan.tracks.some((t) => t.container === 'ts');
    const args = ['-y', '-hide_banner', '-loglevel', 'error'];
    for (const f of files) { args.push('-i', f); }
    if (files.length === 1) { args.push('-map', '0:v?', '-map', '0:a?'); }
    else { args.push('-map', '0:v:0', '-map', '1:a:0'); }
    args.push('-c', 'copy');
    if (ts) { args.push('-bsf:a', 'aac_adtstoasc'); }
    if (/\.mp4$/i.test(s.path)) { args.push('-movflags', '+faststart'); }
    args.push(tmpOut);
    try {
      await this._runFfmpeg(args);
      this._muxed = tmpOut;
    } catch (e) {
      if (this._stopReason) { return; }
      if (e.noFfmpeg && files.length === 1) {
        // No ffmpeg: keep the raw stream so the user still gets something playable.
        const raw = s.path.replace(/\.[^.]+$/, '') + (plan.tracks[0].container === 'ts' ? '.ts' : '.mp4');
        s.path = uniquePath(path.dirname(raw), path.basename(raw));
        s.filename = path.basename(s.path);
        await fsp.copyFile(files[0], s.path);
        this._muxed = '';
        return;
      }
      if (e.noFfmpeg) { throw new Error('Cần cài ffmpeg để ghép video và âm thanh (đặt ffmpeg.exe vào PATH)'); }
      throw e;
    }
  }

  async _finish() {
    const s = this.state;
    if (this._muxed) { await fsp.rename(this._muxed, s.path); }
    try { s.size = (await fsp.stat(s.path)).size; s.downloaded = s.size; } catch { /* ignore */ }
    await fsp.rm(this.partsDir, { recursive: true, force: true });
    s.status = 'done';
    s.completedAt = Date.now();
    this._phase = '';
    this._emitProgress(true);
    this.emit('status', this.progress());
    this.emit('done', this.progress());
  }

  // ---------- control ----------

  async _stopAll() {
    if (this.ac) { this.ac.abort(); }
    for (const d of this._inner) { try { await d.pause(); } catch { /* ignore */ } }
    if (this._ffmpeg) { try { this._ffmpeg.kill(); } catch { /* ignore */ } }
    const t0 = Date.now();
    while (this._active > 0 && Date.now() - t0 < 3000) { await sleep(20); }
    this._active = 0;
  }

  async pause() {
    if (this.state.status !== 'downloading' && this.state.status !== 'queued') { return; }
    this._stopReason = 'pause';
    await this._stopAll();
    this._inner = [];
    this._singleBytes = 0;
    this.state.status = 'paused';
    this.emit('status', this.progress());
  }

  async cancel({ removeFile = true } = {}) {
    this._stopReason = 'cancel';
    await this._stopAll();
    if (removeFile) { await fsp.rm(this.partsDir, { recursive: true, force: true }); }
  }
}

module.exports = { SegmentedDownload, resolveFfmpeg };
