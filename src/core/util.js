'use strict';
const fs = require('fs');
const path = require('path');

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Make a string safe to use as a file name on Windows/macOS/Linux. */
function sanitizeFilename(name, fallback = 'download') {
  let s = String(name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/\uFFFD/g, '') // broken-encoding placeholder that sometimes ends up in page titles
    .replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  if (!s) { s = fallback; }
  if (WIN_RESERVED.test(s)) { s = '_' + s; }
  if (s.length > 180) {
    const ext = path.extname(s).slice(0, 16);
    s = s.slice(0, 180 - ext.length) + ext;
  }
  return s;
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Parse Content-Disposition (RFC 6266 / 5987) and return a file name or ''. */
function filenameFromContentDisposition(cd) {
  if (!cd) { return ''; }
  let m = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(cd);
  if (m) {
    const charset = (m[1] || 'utf-8').toLowerCase();
    const raw = m[2].trim().replace(/^"|"$/g, '');
    if (charset === 'utf-8' || charset === 'utf8') { return safeDecode(raw); }
    return safeDecode(raw);
  }
  m = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(cd);
  if (m) {
    let v = m[1].replace(/\\(.)/g, '$1');
    // Some servers send raw UTF-8 bytes interpreted as latin1.
    if (/[Â-ô][\u0080-¿]/.test(v)) {
      try { v = Buffer.from(v, 'latin1').toString('utf8'); } catch { /* keep */ }
    }
    return v;
  }
  m = /filename\s*=\s*([^;]+)/i.exec(cd);
  return m ? safeDecode(m[1].trim()) : '';
}

function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    return safeDecode(last);
  } catch { return ''; }
}

const MIME_EXT = {
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/x-matroska': '.mkv', 'video/quicktime': '.mov',
  'video/x-flv': '.flv', 'video/mpeg': '.mpg', 'video/mp2t': '.ts', 'video/ogg': '.ogv',
  'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/ogg': '.ogg',
  'audio/wav': '.wav', 'audio/webm': '.weba', 'audio/flac': '.flac',
  'application/zip': '.zip', 'application/x-7z-compressed': '.7z', 'application/x-rar-compressed': '.rar',
  'application/pdf': '.pdf', 'application/x-msdownload': '.exe', 'application/vnd.microsoft.portable-executable': '.exe',
  'application/x-iso9660-image': '.iso', 'application/vnd.apple.mpegurl': '.m3u8', 'application/x-mpegurl': '.m3u8',
  'application/dash+xml': '.mpd', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
};

function extFromMime(mime) {
  if (!mime) { return ''; }
  return MIME_EXT[String(mime).split(';')[0].trim().toLowerCase()] || '';
}

/** Choose a final file name from headers/url/mime. */
function pickFilename({ contentDisposition, url, mime, hint }) {
  let name = hint || filenameFromContentDisposition(contentDisposition) || filenameFromUrl(url) || 'download';
  name = sanitizeFilename(name);
  if (!path.extname(name)) { name += extFromMime(mime); }
  return name;
}

/** Return a path in dir that does not collide with an existing file or a leftover .part. */
function uniquePath(dir, filename, reserved = new Set()) {
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  let candidate = path.join(dir, filename);
  let n = 1;
  const taken = (p) => fs.existsSync(p) || fs.existsSync(p + '.part') || reserved.has(p.toLowerCase());
  while (taken(candidate)) {
    candidate = path.join(dir, `${base} (${n})${ext}`);
    n++;
  }
  return candidate;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function atomicWriteJson(file, data) {
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

const DL_EXT = /\.(zip|rar|7z|tar|gz|bz2|xz|iso|exe|msi|dmg|apk|deb|rpm|pkg|pdf|epub|docx?|xlsx?|pptx?|mp4|mkv|avi|mov|webm|flv|m3u8|mpd|mp3|flac|wav|m4a|aac|ogg|jpg|jpeg|png|gif|webp|torrent)$/i;

/** Text on the clipboard that is exactly one http(s) link to a file (not just any web page). Returns the URL or ''. */
function downloadLinkIn(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 2048 || /\s/.test(t)) { return ''; }
  let u;
  try { u = new URL(t); } catch { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') { return ''; }
  return DL_EXT.test(u.pathname) ? t : '';
}

/** GitHub release text (Markdown) turned into plain readable lines for the "What's new" window. */
function plainNotes(md, max = 4000) {
  let t = String(md || '').replace(/\r\n?/g, '\n');
  t = t.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]*/gm, '').replace(/^[ \t]*[-*+][ \t]+/gm, '\u2022 ');
  t = t.replace(/(\*\*|__)(.*?)\1/g, '$2').replace(/`([^`]*)`/g, '$1');
  t = t.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '\u2026' : t;
}

/**
 * Read a list of downloads from a file the user picked: either a Vexlo export ({ app:'vexlo', items:[{url,filename,kind,page}] })
 * or plain text with one link per line. Returns [{ url, filename, kind, page }] with only http(s) links, no repeats.
 */
function parseImportList(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '');
  let items = [];
  try {
    const j = JSON.parse(raw);
    const arr = Array.isArray(j) ? j : (j && Array.isArray(j.items) ? j.items : null);
    if (arr) { items = arr.map((x) => (typeof x === 'string' ? { url: x } : x)); }
  } catch { items = raw.split(/\r?\n/).map((l) => ({ url: l.trim() })); }
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const url = it && typeof it.url === 'string' ? it.url.trim() : '';
    if (!/^https?:\/\/\S+$/i.test(url) || seen.has(url)) { continue; }
    seen.add(url);
    out.push({
      url,
      filename: typeof it.filename === 'string' ? sanitizeFilename(it.filename) : '',
      kind: ['file', 'hls', 'dash'].includes(it.kind) ? it.kind : undefined,
      page: typeof it.page === 'string' && /^https?:\/\//i.test(it.page) ? it.page : '',
    });
  }
  return out;
}

const ARCHIVE_EXT = /\.(zip|7z|rar|tar|tgz|tbz2|txz|tar\.gz|tar\.bz2|tar\.xz|gz|bz2|xz)$/i;
const isArchive = (name) => ARCHIVE_EXT.test(String(name || ''));

/** Folder to extract "dir/Name.tar.gz" into: "dir/Name" (a numbered name if that already exists). */
function extractDirFor(file) {
  const dir = path.dirname(file);
  const name = path.basename(file).replace(ARCHIVE_EXT, '') || 'extracted';
  return uniquePath(dir, sanitizeFilename(name) || 'extracted');
}

/**
 * Programs that can extract `file` into `dest`, best choice first. On Windows this looks for WinRAR (UnRAR.exe / WinRAR.exe)
 * and 7-Zip in their usual folders and always ends with tar (built into Windows 10+, also fine for zip/tar).
 * @returns {{name:string, exe:string, args:string[]}[]}
 */
function extractCommands(file, dest, { platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  const ext = (/\.([a-z0-9]+)$/i.exec(file) || [])[1] || '';
  const tar = { name: 'tar', exe: platform === 'win32' ? path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar', args: ['-xf', file, '-C', dest] };
  if (platform !== 'win32') { return [tar]; }
  const roots = [...new Set([env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, 'C:\\Program Files', 'C:\\Program Files (x86)'].filter(Boolean))];
  const find = (rel) => { for (const r of roots) { const f = path.win32.join(r, rel); if (exists(f)) { return f; } } return ''; };
  const withSlash = dest.endsWith('\\') ? dest : dest + '\\';
  const found = [];
  const unrar = find('WinRAR\\UnRAR.exe');
  const winrar = find('WinRAR\\WinRAR.exe');
  const seven = find('7-Zip\\7z.exe');
  const cmdUnrar = unrar && { name: 'unrar', exe: unrar, args: ['x', '-y', '-p-', '-idq', file, withSlash] };
  const cmdWinrar = winrar && { name: 'winrar', exe: winrar, args: ['x', '-ibck', '-y', '-p-', file, withSlash] };
  const cmdSeven = seven && { name: '7zip', exe: seven, args: ['x', '-y', `-o${dest}`, file] };
  if (ext.toLowerCase() === 'rar') { found.push(cmdUnrar, cmdWinrar, cmdSeven, tar); }
  else if (ext.toLowerCase() === '7z') { found.push(cmdSeven, cmdUnrar || cmdWinrar, tar); }
  else { found.push(tar, cmdSeven, cmdUnrar || cmdWinrar); }
  return found.filter(Boolean);
}

/**
 * A short, plain reason for a failed extraction, from what the programs reported.
 * @param {{name:string, code:(number|string), msg:string}[]} attempts
 * @returns {'password'|'corrupt'|'format'|'missing'|'space'|'unknown'}
 */
function explainExtractFailure(attempts) {
  const all = attempts.map((a) => `${a.msg || ''}`).join(' | ');
  const codes = attempts.filter((a) => a.name !== 'tar').map((a) => a.code);
  if (/password|encrypted/i.test(all) || codes.includes(11)) { return 'password'; }
  if (/no space|disk full|not enough space/i.test(all) || attempts.some((a) => a.code === 5 && a.name !== 'tar')) { return 'space'; }
  if (/crc|checksum|corrupt|data error|unexpected end|damaged|truncated|headers error/i.test(all) || codes.includes(3)) { return 'corrupt'; }
  if (/unrecognized|not an archive|unsupported|cannot open|is not rar|not supported|unknown archive/i.test(all)) { return 'format'; }
  if (/no such file|cannot find|not found/i.test(all)) { return 'missing'; }
  return 'unknown';
}

module.exports = {
  explainExtractFailure, extractCommands, isArchive, extractDirFor, parseImportList, plainNotes, downloadLinkIn, sanitizeFilename, filenameFromContentDisposition, filenameFromUrl, extFromMime,
  pickFilename, uniquePath, sleep, atomicWriteJson,
};
