/* Vexlo - media request classifier.
 * Pure functions, no browser APIs, so it is unit-tested in Node (test/classify.test.js)
 * and loaded as a normal script by the extension background page. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.SGClassify = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VIDEO_EXT = new Set(['mp4', 'webm', 'mkv', 'mov', 'flv', 'f4v', 'avi', 'wmv', 'mpg', 'mpeg', 'm4v', '3gp', 'ogv']);
  const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'weba', 'wma']);
  // Fragments of a stream: never useful on their own.
  const SEGMENT_EXT = new Set(['ts', 'm4s', 'cmfv', 'cmfa', 'mts', 'm2ts']);
  const HLS_MIME = new Set([
    'application/vnd.apple.mpegurl', 'application/x-mpegurl', 'application/mpegurl', 'audio/mpegurl', 'audio/x-mpegurl',
    'application/octet-stream-m3u8',
  ]);
  const DASH_MIME = new Set(['application/dash+xml']);
  const SEGMENT_MIME = new Set(['video/mp2t', 'video/iso.segment', 'audio/iso.segment', 'video/vnd.dlna.mpeg-tts']);
  const GENERIC_MIME = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/x-octet-stream', 'application/force-download', 'text/plain']);
  const NOT_MEDIA_MIME = /^(text\/(html|css|javascript|xml)|image\/|application\/(json|javascript|xhtml\+xml|pdf|zip)|font\/)/;

  // Hosts whose "video" is ads/analytics or a protocol this tool cannot download.
  const SKIP_HOSTS = [
    'doubleclick.net', 'googlesyndication.com', 'imasdk.googleapis.com', 'googleadservices.com', 'adnxs.com',
    'googlevideo.com', // YouTube adaptive streams: signed, chunked by range, not downloadable as a file
  ];
  const SEGMENT_NAME = /(^|[/_.-])(seg|segment|frag|fragment|chunk)[-_]?\d+/i;
  // Query params that only select a byte range or a cache-buster; they do not change *which* media it is.
  const NOISE_PARAMS = new Set(['bytestart', 'byteend', 'range', 'rn', 'rbuf', '_', 'cachebust', 'nocache']);

  const MIME_EXT = {
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/x-matroska': 'mkv', 'video/quicktime': 'mov', 'video/x-flv': 'flv',
    'video/ogg': 'ogv', 'video/mpeg': 'mpg', 'video/x-msvideo': 'avi', 'video/x-ms-wmv': 'wmv', 'video/3gpp': '3gp',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
    'audio/webm': 'weba', 'audio/flac': 'flac', 'audio/x-m4a': 'm4a',
  };

  function parseUrl(url) {
    try { return new URL(url); } catch { return null; }
  }

  function extOf(pathname) {
    const last = pathname.split('/').pop() || '';
    const i = last.lastIndexOf('.');
    return i > 0 ? last.slice(i + 1).toLowerCase() : '';
  }

  function hostMatches(host, list) {
    return list.some((h) => host === h || host.endsWith('.' + h));
  }

  /** Normalised content-type: lower-case, no parameters. */
  function normMime(v) { return String(v || '').split(';')[0].trim().toLowerCase(); }

  /** Total resource size from a response, or 0 when unknown (never the size of a partial range). */
  function totalSize({ status, contentLength, contentRange }) {
    const m = /\/(\d+)\s*$/.exec(contentRange || '');
    if (m) { return Number(m[1]); }
    if (status === 206) { return 0; }
    const n = Number(contentLength);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** Stable identity so repeated range/seek requests for one video collapse into one list entry. */
  function mediaKey(url, kind, size) {
    const u = parseUrl(url);
    if (!u) { return url; }
    if (kind === 'hls' || kind === 'dash') { return `${kind}|${u.origin}${u.pathname}`; }
    const keep = [];
    for (const [k, v] of u.searchParams) { if (!NOISE_PARAMS.has(k.toLowerCase())) { keep.push(k + '=' + v); } }
    // Signed CDN URLs change their token on every request; same path + same size is the same file.
    if (size) { return `file|${u.origin}${u.pathname}|${size}`; }
    return `file|${u.origin}${u.pathname}?${keep.sort().join('&')}`;
  }

  /**
   * @param {object} r
   *   url, status, method, mime, contentLength, contentRange, contentDisposition, requestRange, resourceType
   * @param {object} [opts] { minFileSize }
   * @returns {null | {kind:'hls'|'dash'|'file', ext:string, mime:string, size:number, key:string, audioOnly:boolean}}
   */
  function classify(r, opts = {}) {
    const minFileSize = opts.minFileSize ?? 150 * 1024;
    if (!r || !r.url) { return null; }
    if (r.method && r.method !== 'GET') { return null; }
    if (r.status !== undefined && r.status !== 200 && r.status !== 206) { return null; }
    const u = parseUrl(r.url);
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) { return null; }
    const host = u.hostname.toLowerCase();
    if (hostMatches(host, SKIP_HOSTS)) { return null; }

    const path = u.pathname.toLowerCase();
    const ext = extOf(path);
    const mime = normMime(r.mime);

    // --- playlists / manifests ---
    if (HLS_MIME.has(mime) || ((ext === 'm3u8' || ext === 'm3u') && !NOT_MEDIA_MIME.test(mime))) {
      return { kind: 'hls', ext: 'm3u8', mime, size: 0, key: mediaKey(r.url, 'hls', 0), audioOnly: false };
    }
    if (DASH_MIME.has(mime) || (ext === 'mpd' && !NOT_MEDIA_MIME.test(mime))) {
      return { kind: 'dash', ext: 'mpd', mime, size: 0, key: mediaKey(r.url, 'dash', 0), audioOnly: false };
    }

    // --- fragments of a stream ---
    if (SEGMENT_EXT.has(ext) || SEGMENT_MIME.has(mime)) { return null; }

    // --- plain media files ---
    if (NOT_MEDIA_MIME.test(mime)) { return null; }
    const mimeIsMedia = mime.startsWith('video/') || mime.startsWith('audio/');
    const extIsVideo = VIDEO_EXT.has(ext);
    const extIsAudio = AUDIO_EXT.has(ext);
    const extIsMedia = extIsVideo || extIsAudio;
    if (!mimeIsMedia && !(extIsMedia && GENERIC_MIME.has(mime))) { return null; }
    if ((ext === 'mp4' || ext === 'm4s' || ext === '') && SEGMENT_NAME.test(path)) { return null; }

    const size = totalSize(r);
    if (size && size < minFileSize) { return null; }

    const finalExt = extIsMedia ? ext : (MIME_EXT[mime] || (mime.startsWith('audio/') ? 'm4a' : 'mp4'));
    const audioOnly = mime.startsWith('audio/') || extIsAudio;
    return { kind: 'file', ext: finalExt, mime, size, key: mediaKey(r.url, 'file', size), audioOnly };
  }

  const GENERIC_BASENAME = /^(video|index|master|playlist|stream|media|main|manifest|chunklist|file|play|source|\d+|[0-9a-f-]{16,}|[\w-]{24,})(\.\w+)?$/i;

  function cleanTitle(title) {
    return String(title || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  /** True when a URL's last path segment says nothing about the video (index.m3u8, a hash, 12345.mp4 ...). */
  function isGenericName(url) {
    const u = parseUrl(url);
    if (!u) { return true; }
    let last = u.pathname.split('/').filter(Boolean).pop() || '';
    try { last = decodeURIComponent(last); } catch { /* keep raw */ }
    return !last || GENERIC_BASENAME.test(last);
  }

  /** Name shown in the list: the page title for streams and for files with an uninformative URL name. */
  function displayName(item, title) {
    const t = cleanTitle(title || item.title);
    let base = '';
    const u = parseUrl(item.url);
    if (u) { try { base = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || ''); } catch { base = ''; } }
    if (item.kind === 'hls' || item.kind === 'dash') { return t || base || item.url; }
    if (t && isGenericName(item.url)) { return item.ext ? `${t}.${item.ext}` : t; }
    return base || t || item.url;
  }

  /** File name proposed to the app. Streams are saved as .mp4 under the page title; plain files keep the server's name. */
  function suggestName(item, title) {
    const t = cleanTitle(title);
    if (item.kind === 'hls' || item.kind === 'dash') { return t ? `${t}.mp4` : ''; }
    // Plain files: leave naming to the app, which honours the server's Content-Disposition.
    return '';
  }

  return { classify, mediaKey, totalSize, suggestName, displayName, isGenericName, normMime };
}));
