'use strict';
/* Video sites (YouTube, TikTok, Facebook, Instagram) through yt-dlp.
 * Vexlo does not bundle yt-dlp: the program is downloaded once from its official GitHub releases into the app's data folder
 * (and can be updated from Settings), because these sites change often and yt-dlp follows them. ffmpeg is the one the app already has. */
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { EventEmitter } = require('events');
const { spawn, execFile } = require('child_process');
const { SpeedMeter } = require('./limiter');
const { sanitizeFilename, sleep, copyPrefix } = require('./util');
const { Download } = require('./download');
const http = require('./http');
const { resolveFfmpeg } = require('./segmented');

const releaseUrl = () => process.env.VEXLO_YTDLP_URL || 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/'; // the variable is for tests

// ---------------------------------------------------------------- which links are videos of these sites

const SITES = [
  // YouTube: watch pages, shorts, live, embeds, youtu.be short links
  (u) => /(^|\.)youtube\.com$|(^|\.)youtube-nocookie\.com$/.test(u.hostname) && (/^\/(watch|shorts\/|live\/|embed\/|v\/|clip\/)/.test(u.pathname) || u.pathname === '/watch'),
  (u) => u.hostname === 'youtu.be' && u.pathname.length > 1,
  // TikTok: /@user/video/id, /t/xxx, short links vm. / vt.
  (u) => /(^|\.)tiktok\.com$/.test(u.hostname) && (/\/video\/\d+/.test(u.pathname) || /^\/(t|v)\//.test(u.pathname) || /^(vm|vt)\./.test(u.hostname) || /\/photo\/\d+/.test(u.pathname)),
  // Facebook: /watch, reels, videos, share links, fb.watch
  (u) => /(^|\.)facebook\.com$/.test(u.hostname) && (/^\/(watch|reel\/|reels\/|share\/(v|r)\/|video\.php)/.test(u.pathname) || /\/videos\/\d+/.test(u.pathname) || /\/(posts|permalink)\//.test(u.pathname) && /[?&]v=/.test(u.search)),
  (u) => u.hostname === 'fb.watch' && u.pathname.length > 1,
  // Instagram: reels, posts with video, IGTV
  (u) => /(^|\.)instagram\.com$/.test(u.hostname) && /^\/(reel|reels|p|tv)\//.test(u.pathname),
];

function isMediaUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') { return false; }
  return SITES.some((f) => { try { return !!f(u); } catch { return false; } });
}

// ---------------------------------------------------------------- yt-dlp arguments and output

/** -f selector (and whether to keep only the sound) for a quality choice of the dialogs. */
function formatSelector(quality) {
  const q = String(quality || 'best');
  if (q === 'audio') { return { fmt: 'ba/b', audio: true }; }
  if (q === 'worst') { return { fmt: 'wv*+wa/w', audio: false }; }
  const h = Number(q);
  if (h > 0) { return { fmt: `bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b`, audio: false }; }
  return { fmt: 'bv*+ba/b', audio: false };
}

/** One line of the progress template ("VXP|done|total|estimate|speed|eta") -> numbers (0 when unknown). */
function parseProgress(line) {
  const m = /^VXP\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)/.exec(String(line).trim());
  if (!m) { return null; }
  const n = (v) => { const x = Number(String(v).trim()); return Number.isFinite(x) && x > 0 ? x : 0; };
  return { done: n(m[1]), total: n(m[2]) || n(m[3]), speed: n(m[4]), eta: n(m[5]) };
}

/** From the output of `yt-dlp -J`: the title, the extension the result will have and the expected size. */
function parseInfo(json, audio) {
  let j;
  try { j = typeof json === 'string' ? JSON.parse(json) : json; } catch { return null; }
  if (!j || typeof j !== 'object') { return null; }
  if (Array.isArray(j.entries) && j.entries.length) { j = j.entries[0] || j; }
  const parts = Array.isArray(j.requested_formats) && j.requested_formats.length ? j.requested_formats : [j];
  const total = parts.reduce((n, f) => n + (Number(f && (f.filesize || f.filesize_approx)) || 0), 0);
  const merged = parts.length > 1;
  const ext = audio ? 'mp3' : (merged ? 'mp4' : (j.ext || 'mp4'));
  return {
    title: String(j.title || j.fulltitle || j.id || 'video'), id: String(j.id || ''), site: String(j.extractor_key || j.extractor || ''),
    uploader: String(j.uploader || j.channel || ''), duration: Number(j.duration) || 0, total, ext,
  };
}

/**
 * Plain reason for a failed run, from what yt-dlp wrote.
 * @returns {{code:string, message:string}}
 */
function friendlyError(text) {
  const t = String(text || '');
  const last = (t.split('\n').map((x) => x.trim()).filter((x) => /^ERROR:/i.test(x)).pop() || t.split('\n').map((x) => x.trim()).filter(Boolean).pop() || '').replace(/^ERROR:\s*/i, '').replace(/\[[a-z:]+\]\s*[\w-]*:\s*/i, '').slice(0, 220);
  if (/sign in to confirm you.?re not a bot|confirm your age|use --cookies|cookies.*(required|needed)/i.test(t)) { return { code: 'login', message: 'Trang yêu cầu đăng nhập hoặc xác minh. Hãy chọn "Cookie trình duyệt" (Firefox) trong Tùy chọn > Cập nhật & công cụ rồi thử lại.' }; }
  if (/private video|this video is private|login required|log in|requires (a )?login|restricted video|you must be 18|members-only|join this channel/i.test(t)) { return { code: 'private', message: 'Video riêng tư hoặc cần đăng nhập. Hãy đăng nhập trong Firefox, rồi chọn "Cookie trình duyệt" trong Tùy chọn > Cập nhật & công cụ.' }; }
  if (/unsupported url|no video could be found|there is no video in this post/i.test(t)) { return { code: 'unsupported', message: 'Không tìm thấy video trong liên kết này.' }; }
  if (/video unavailable|has been removed|not available|deleted|no longer available|account.*terminated|blocked it/i.test(t)) { return { code: 'unavailable', message: 'Video không còn khả dụng hoặc bị chặn ở khu vực của bạn.' }; }
  if (/http error 429|too many requests|rate.?limit/i.test(t)) { return { code: 'rate', message: 'Trang đang giới hạn lượt truy cập (HTTP 429). Hãy thử lại sau ít phút.' }; }
  if (/ffmpeg|ffprobe/i.test(t) && /not found|no such file|not installed|cannot find/i.test(t)) { return { code: 'ffmpeg', message: 'Thiếu ffmpeg để ghép hình và tiếng.' }; }
  if (/no space left|not enough space|disk full/i.test(t)) { return { code: 'space', message: 'Ổ đĩa đã đầy.' }; }
  if (/unable to extract|nsig|signature|requested format is not available|player response|sabr|http error 403|forbidden/i.test(t)) { return { code: 'extract', message: 'yt-dlp chưa theo kịp thay đổi của trang này. Hãy bấm "Cập nhật yt-dlp" trong Tùy chọn > Cập nhật & công cụ.' }; }
  if (/getaddrinfo|name resolution|timed out|timeout|connection (reset|aborted|refused)|network is unreachable|temporary failure|remote end closed|incomplete read/i.test(t)) { return { code: 'network', message: 'Mất kết nối mạng (timeout) khi tải video.' }; }
  return { code: 'unknown', message: last || 'yt-dlp báo lỗi không rõ nguyên nhân.' };
}

// ---------------------------------------------------------------- the yt-dlp program itself

function binaryName(platform = process.platform) {
  return platform === 'win32' ? 'yt-dlp.exe' : platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux';
}
function binaryPath(binDir) {
  return process.env.VEXLO_YTDLP || path.join(binDir, binaryName());
}

/** The program to start. Tests stand in for yt-dlp with a Node script (VEXLO_TEST_NODE_SCRIPTS=1), which Windows cannot start directly. */
function launch(bin, args) {
  if (process.env.VEXLO_TEST_NODE_SCRIPTS === '1') { return { file: process.execPath, args: [bin, ...args] }; }
  return { file: bin, args };
}

function run(file, args, { timeout = 30000, env = process.env } = {}) {
  const l = launch(file, args);
  return new Promise((resolve) => {
    execFile(l.file, l.args, { timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024, env }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

/** Version of the installed yt-dlp, or '' when it is not there. */
async function ytdlpVersion(binDir) {
  const f = binaryPath(binDir);
  if (!fs.existsSync(f)) { return ''; }
  const r = await run(f, ['--version'], { timeout: 20000 });
  return r.err ? '' : r.stdout.trim().split('\n')[0];
}

/** Download the newest yt-dlp from GitHub (when missing, or `force`). Returns the program's path. */
async function ensureYtdlp(binDir, { force = false, onProgress } = {}) {
  const f = binaryPath(binDir);
  if (process.env.VEXLO_YTDLP && !process.env.VEXLO_YTDLP_URL) { return f; }
  if (!force && fs.existsSync(f)) { return f; }
  await fsp.mkdir(binDir, { recursive: true });
  const tmp = f.replace(/(\.exe)?$/i, '.new$1'); // keeps the .exe ending on Windows
  try {
    const { res } = await http.request(releaseUrl() + binaryName(), { timeout: 30000, idleTimeout: 30000 });
    if (res.statusCode !== 200) { res.resume(); throw new Error(`HTTP ${res.statusCode}`); }
    const total = Number(res.headers['content-length']) || 0;
    let got = 0;
    const out = fs.createWriteStream(tmp);
    await new Promise((resolve, reject) => {
      res.on('data', (c) => { got += c.length; if (onProgress && total) { onProgress(got, total); } });
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      res.pipe(out);
    });
    if (total && got < total) { throw new Error('tải chưa đủ'); }
    if (process.platform !== 'win32') { await fsp.chmod(tmp, 0o755); }
    const t = await run(tmp, ['--version'], { timeout: 60000 });
    if (t.err) { throw new Error('tệp tải về không chạy được'); }
    for (let i = 0; ; i++) { // the old one may still be in use for a moment
      try { await fsp.rename(tmp, f); break; } catch (e) { if (i >= 6 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { throw e; } await sleep(300 * (i + 1)); }
    }
    return f;
  } catch (e) {
    try { await fsp.rm(tmp, { force: true }); } catch { /* ignore */ }
    if (!force && fs.existsSync(f)) { return f; }
    throw Object.assign(new Error('Không tải được yt-dlp từ GitHub: ' + (e.message || e)), { fatal: true });
  }
}

/** Stop a program and everything it started (the Windows build of yt-dlp runs as two processes). */
function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) { return; }
  if (process.platform === 'win32') {
    try { execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch { /* ignore */ }
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  }
}

/** Options every yt-dlp run gets: no playlists, timeouts, the app's ffmpeg, the proxy, browser cookies, the JavaScript runtime. */
function commonArgs(m = {}, ffmpegPath = '', headers = {}) {
  const a = ['--no-playlist', '--no-warnings', '--no-colors', '--ignore-config', '--socket-timeout', '30', '--retries', '5', '--fragment-retries', '8'];
  if (ffmpegPath && ffmpegPath !== 'ffmpeg') { a.push('--ffmpeg-location', ffmpegPath); }
  const px = http.getProxy ? http.getProxy() : '';
  if (px) { a.push('--proxy', px); }
  if (m.cookies && /^[a-z]+$/.test(m.cookies)) { a.push('--cookies-from-browser', m.cookies); }
  if (m.jsRuntime) { a.push('--js-runtimes', 'node:' + m.jsRuntime); }
  for (const [k, v] of Object.entries(headers || {})) { if (k === 'user-agent' && v) { a.push('--user-agent', v); } }
  return a;
}

function envFor(m = {}) {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
  if (m.jsRuntime && m.jsRuntime === process.execPath && process.versions && process.versions.electron) { env.ELECTRON_RUN_AS_NODE = '1'; } // Vexlo itself acts as the "node" yt-dlp needs for YouTube
  return env;
}

/**
 * What the confirmation window shows before the download starts: title, picture, length, uploader, best height.
 * @returns {Promise<{ok:true, title, thumbnail, duration, uploader, site, maxHeight} | {ok:false, error:string}>}
 */
async function fetchInfo(binDir, url, { media = {}, ffmpegPath = '' } = {}) {
  let bin;
  try { bin = await ensureYtdlp(binDir, {}); } catch (e) { return { ok: false, error: e.message }; }
  const r = await run(bin, [...commonArgs(media, ffmpegPath), '--skip-download', '-J', url], { timeout: 75000, env: envFor(media) });
  if (r.err) { return { ok: false, error: friendlyError(r.stderr || r.stdout || r.err.message).message }; }
  let j;
  try { j = JSON.parse(r.stdout); } catch { return { ok: false, error: 'Không đọc được thông tin video.' }; }
  if (Array.isArray(j.entries) && j.entries.length) { j = j.entries[0] || j; }
  const heights = (Array.isArray(j.formats) ? j.formats : []).map((f) => Number(f && f.height) || 0).filter((h) => h > 0);
  return {
    ok: true, title: String(j.title || j.fulltitle || ''), thumbnail: /^https?:\/\//i.test(j.thumbnail || '') ? String(j.thumbnail) : '',
    duration: Number(j.duration) || 0, uploader: String(j.uploader || j.channel || ''), site: String(j.extractor_key || j.extractor || ''),
    maxHeight: heights.length ? Math.max(...heights) : 0,
  };
}

// ---------------------------------------------------------------- the download task

class MediaDownload extends EventEmitter {
  /**
   * @param state    task state (see create)
   * @param deps     { limiter, ffmpegPath, resolvePath, binDir, getMedia: () => ({cookies, jsRuntime}), getLimitKB: () => number }
   */
  constructor(state, deps = {}) {
    super();
    this.state = state;
    this.deps = deps;
    this.meter = new SpeedMeter();
    this.ffmpegPath = resolveFfmpeg(deps.ffmpegPath);
    this._child = null;
    this._stopReason = null;
    this._lastEmit = 0;
    this._phase = '';
    this._eta = 0;
  }

  static create(opts) {
    const s = Download.create(opts);
    s.kind = 'media';
    s.quality = opts.quality || 'best';
    s.base = '';      // file name without extension, chosen once
    s.info = null;    // title etc. from yt-dlp
    s.segDone = 0;
    s.segTotal = 0;
    return s;
  }

  progress() {
    const s = this.state;
    const speed = s.status === 'downloading' ? this.meter.speed : 0;
    const left = s.size > 0 && speed > 0 ? Math.max(0, (s.size - s.downloaded) / speed) : (this._eta || 0);
    return {
      id: s.id, status: s.status, size: s.size, downloaded: s.downloaded, speed, eta: s.status === 'downloading' ? left : 0,
      connections: this._child ? 1 : 0, filename: s.filename, error: s.error, segDone: 0, segTotal: 0, phase: this._phase || '',
    };
  }

  _emitProgress(force = false) {
    const now = Date.now();
    if (!force && now - this._lastEmit < 250) { return; }
    this._lastEmit = now;
    this.emit('progress', this.progress());
  }

  _common() { return commonArgs((this.deps.getMedia && this.deps.getMedia()) || {}, this.ffmpegPath, this.state.headers); }

  _env() { return envFor((this.deps.getMedia && this.deps.getMedia()) || {}); }

  _spawn(bin, args, onLine) {
    return new Promise((resolve) => {
      const l = launch(bin, args);
      const child = spawn(l.file, l.args, { windowsHide: true, env: this._env(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      this._child = child;
      let out = ''; let err = '';
      const feed = (buf, which) => {
        const text = buf.toString('utf8');
        if (which === 'err') { err = (err + text).slice(-20000); } else if (!onLine) { out += text; }
        if (onLine) {
          const key = which === 'err' ? '_eb' : '_ob';
          this[key] = (this[key] || '') + text;
          const lines = this[key].split(/\r?\n|\r/);
          this[key] = lines.pop();
          for (const l of lines) { onLine(l, which); }
        }
      };
      child.stdout.on('data', (d) => feed(d, 'out'));
      child.stderr.on('data', (d) => feed(d, 'err'));
      child.on('error', (e) => { this._child = null; resolve({ code: -1, out, err: err + String(e.message) }); });
      child.on('close', (code) => { this._child = null; this._ob = ''; this._eb = ''; resolve({ code, out, err }); });
    });
  }

  async start() {
    const s = this.state;
    if (s.status === 'done' || s.status === 'downloading') { return; }
    this._stopReason = null;
    s.status = 'downloading';
    s.error = '';
    this.meter.reset();
    this._phase = 'prepare';
    this.emit('status', this.progress());
    try {
      await this._run();
    } catch (err) {
      if (this._stopReason) { return; }
      s.status = 'error';
      s.error = err.message || String(err);
      this._phase = '';
      this.emit('status', this.progress());
      this.emit('error', err);
    }
  }

  async _run() {
    const s = this.state;
    const binDir = this.deps.binDir;
    let bin = await ensureYtdlp(binDir, {});
    if (this._stopReason) { return; }
    const { fmt, audio } = formatSelector(s.quality);
    let updated = false;
    for (;;) {
      if (!s.info) {
        const r = await this._spawn(bin, [...this._common(), '-f', fmt, '-J', s.url]);
        if (this._stopReason) { return; }
        const info = r.code === 0 ? parseInfo(r.out, audio) : null;
        if (!info) {
          const fe = friendlyError(r.err || r.out);
          if (fe.code === 'extract' && !updated && !process.env.VEXLO_YTDLP) { updated = true; this.emit('warn', 'yt-dlp could not read the page, updating it once: ' + String(r.err).slice(-200)); try { bin = await ensureYtdlp(binDir, { force: true }); } catch { /* keep the old one */ } continue; }
          this.emit('warn', 'yt-dlp -J failed: ' + String(r.err || r.out).slice(-400).replace(/\n/g, ' | '));
          throw Object.assign(new Error(fe.message), { fatal: true });
        }
        s.info = info;
        this._chooseName(info);
      }
      if (s.size < (s.info.total || 0)) { s.size = s.info.total; }
      this._phase = 'download';
      this._emitProgress(true);
      const r = await this._download(bin, fmt, audio);
      if (this._stopReason) { return; }
      if (r.code === 0) { await this._finish(audio); return; }
      const fe = friendlyError(r.err);
      this.emit('warn', `yt-dlp exited ${r.code}: ${String(r.err).slice(-400).replace(/\n/g, ' | ')}`);
      if (fe.code === 'extract' && !updated && !process.env.VEXLO_YTDLP) { updated = true; try { bin = await ensureYtdlp(binDir, { force: true }); continue; } catch { /* report the original error */ } }
      throw Object.assign(new Error(fe.message), { fatal: fe.code !== 'network' });
    }
  }

  /** Pick the file name once: the video title, made safe and unique in the folder. */
  _chooseName(info) {
    const s = this.state;
    if (!s.base) {
      const want = s.userNamed && s.filename ? s.filename.replace(/\.[a-z0-9]{2,4}$/i, '') : info.title;
      let base = sanitizeFilename(want, 'video').slice(0, 120).replace(/[. ]+$/, '');
      const taken = (b) => { try { return fs.readdirSync(s.dir).some((n) => n.toLowerCase().startsWith((b + '.').toLowerCase())); } catch { return false; } };
      let b = base; let i = 1;
      while (taken(b) || this._reserved(b)) { b = `${base} (${++i})`; }
      s.base = b;
    }
    s.filename = `${s.base}.${info.ext}`;
  }

  _reserved(b) {
    return !!(this.deps.isNameTaken && this.deps.isNameTaken(this.state.id, this.state.dir, b));
  }

  async _download(bin, fmt, audio) {
    const s = this.state;
    await fsp.mkdir(s.dir, { recursive: true });
    const args = [...this._common(), '-f', fmt, '--newline', '--progress',
      '--progress-template', 'download:VXP|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
      '--no-mtime', '--continue', '--concurrent-fragments', '4', '--windows-filenames', '-o', path.join(s.dir, s.base + '.%(ext)s')];
    if (audio) { args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0'); } else { args.push('--merge-output-format', 'mp4'); }
    const kb = Number(this.deps.getLimitKB && this.deps.getLimitKB()) || 0;
    if (kb > 0) { args.push('--limit-rate', `${kb}K`); }
    args.push(s.url);
    let base = 0; let lastDone = 0; let lastTotal = 0; let curTotal = 0;
    return this._spawn(bin, args, (line, which) => {
      if (which !== 'out') { return; }
      const p = parseProgress(line);
      if (p) {
        if (p.done < lastDone && lastTotal > 0) { base += lastTotal; } // a second stream (the sound) started
        lastDone = p.done; if (p.total) { lastTotal = p.total; curTotal = p.total; }
        const before = s.downloaded;
        s.downloaded = base + p.done;
        const known = Math.max(s.info ? s.info.total : 0, base + curTotal);
        s.size = Math.max(known, s.downloaded);
        if (p.speed) { this.meter.add(Math.max(0, s.downloaded - before)); }
        this._eta = p.eta;
        this._phase = 'download';
        this._emitProgress();
      } else if (/^\[(Merger|VideoRemuxer|ExtractAudio|FixupM3u8|FixupM4a|FixupStretched|Fixup\w*)\]/.test(line)) {
        this._phase = 'merge';
        this._emitProgress(true);
      }
    });
  }

  async _finish(audio) {
    const s = this.state;
    const names = await fsp.readdir(s.dir);
    const prefix = (s.base + '.').toLowerCase();
    const cands = [];
    for (const n of names) {
      const l = n.toLowerCase();
      if (!l.startsWith(prefix) || /\.(part|ytdl|temp|tmp)$/.test(l) || /\.f\d+(-\w+)?\.[a-z0-9]+$/.test(l)) { continue; }
      try { const st = await fsp.stat(path.join(s.dir, n)); if (st.isFile()) { cands.push({ n, st }); } } catch { /* vanished */ }
    }
    if (!cands.length) { throw Object.assign(new Error('yt-dlp báo xong nhưng không thấy tệp video.'), { fatal: true }); }
    cands.sort((a, b) => b.st.size - a.st.size);
    const best = cands[0];
    // Leftover pieces (separate video / sound streams) are not needed once the merged file exists.
    for (const n of names) { if (n !== best.n && n.toLowerCase().startsWith(prefix) && /\.f\d+(-\w+)?\.[a-z0-9]+$/.test(n.toLowerCase())) { try { await fsp.rm(path.join(s.dir, n), { force: true }); } catch { /* ignore */ } } }
    s.path = path.join(s.dir, best.n);
    s.filename = best.n;
    s.size = best.st.size; s.downloaded = best.st.size;
    s.status = 'done';
    s.completedAt = Date.now();
    this._phase = '';
    this._emitProgress(true);
    this.emit('status', this.progress());
    this.emit('done', this.progress());
  }

  async _stop() {
    const c = this._child;
    if (!c) { return; }
    killTree(c);
    const t0 = Date.now();
    while (this._child && Date.now() - t0 < 4000) { await sleep(25); }
  }

  async pause() {
    if (this.state.status !== 'downloading' && this.state.status !== 'queued') { return; }
    this._stopReason = 'pause';
    await this._stop();
    this.state.status = 'paused';
    this._phase = '';
    this.emit('status', this.progress());
  }

  /** A copy of the biggest piece yt-dlp has so far (the video stream; fragmented files play up to where they stop). */
  async previewFile(outDir, maxBytes = 1024 * 1024 * 1024) {
    const s = this.state;
    if (!s.base) { return { ok: false, reason: 'none' }; }
    let best = null;
    try {
      const prefix = (s.base + '.').toLowerCase();
      for (const n of await fsp.readdir(s.dir)) {
        const l = n.toLowerCase();
        if (!l.startsWith(prefix) || /\.(ytdl|temp|tmp)$/.test(l)) { continue; }
        const st = await fsp.stat(path.join(s.dir, n)).catch(() => null);
        if (st && st.isFile() && (!best || st.size > best.size)) { best = { n, size: st.size }; }
      }
    } catch { return { ok: false, reason: 'none' }; }
    if (!best || best.size < 256 * 1024) { return { ok: false, reason: 'small' }; }
    const name = best.n.replace(/\.part$/i, '');
    const to = path.join(outDir, name);
    const bytes = await copyPrefix(path.join(s.dir, best.n), to, Math.min(best.size, maxBytes));
    return { ok: true, path: to, bytes };
  }

  async cancel({ removeFile = true } = {}) {
    this._stopReason = 'cancel';
    await this._stop();
    const s = this.state;
    if (!removeFile || !s.base || s.status === 'done') { return; }
    try {
      const prefix = (s.base + '.').toLowerCase();
      for (const n of await fsp.readdir(s.dir)) { if (n.toLowerCase().startsWith(prefix)) { await fsp.rm(path.join(s.dir, n), { force: true }); } }
    } catch { /* folder gone */ }
  }
}

module.exports = {
  MediaDownload, isMediaUrl, formatSelector, parseProgress, parseInfo, friendlyError, ensureYtdlp, ytdlpVersion, fetchInfo, binaryName, binaryPath, killTree,
};
