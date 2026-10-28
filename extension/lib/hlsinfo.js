/* Vexlo - HLS playlist inspection for the extension.
 * Pure functions (no browser APIs) so they are unit-tested in Node (test/hlsinfo.test.js).
 * Goal: show what IDM shows - one entry per video with duration, quality and bitrate -
 * instead of raw playlist URLs, and recognise which playlists are children of a master. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.SGHlsInfo = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function parseAttrs(str) {
    const out = {};
    const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
    let m;
    while ((m = re.exec(str))) { out[m[1]] = m[3] !== undefined ? m[3] : m[2]; }
    return out;
  }

  function abs(u, base) {
    try { return new URL(u, base).toString(); } catch { return ''; }
  }

  /**
   * @returns {null | {type:'master', variants:[], audios:[]} | {type:'media', duration:number, segments:number, endlist:boolean, drm:boolean}}
   */
  function parsePlaylist(text, baseUrl) {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length || !lines[0].startsWith('#EXTM3U')) { return null; }

    if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
      const variants = [];
      const audios = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
          const a = parseAttrs(line.slice(18));
          let j = i + 1;
          while (j < lines.length && lines[j].startsWith('#')) { j++; }
          if (!lines[j]) { continue; }
          const [w, h] = (a.RESOLUTION || '').split('x').map(Number);
          variants.push({
            url: abs(lines[j], baseUrl), bandwidth: Number(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH) || 0,
            width: w || 0, height: h || 0, codecs: a.CODECS || '', audio: a.AUDIO || '',
          });
        } else if (line.startsWith('#EXT-X-MEDIA:')) {
          const a = parseAttrs(line.slice(13));
          if (a.URI && (a.TYPE === 'AUDIO' || a.TYPE === 'SUBTITLES' || a.TYPE === 'VIDEO')) {
            audios.push({ type: a.TYPE, group: a['GROUP-ID'] || '', url: abs(a.URI, baseUrl), def: a.DEFAULT === 'YES' });
          }
        }
      }
      return { type: 'master', variants: variants.filter((v) => v.url), audios: audios.filter((v) => v.url) };
    }

    let duration = 0;
    let segments = 0;
    let endlist = false;
    let drm = false;
    for (const line of lines) {
      if (line.startsWith('#EXTINF:')) { duration += parseFloat(line.slice(8)) || 0; }
      else if (line.startsWith('#EXT-X-ENDLIST')) { endlist = true; }
      else if (line.startsWith('#EXT-X-KEY:')) {
        const a = parseAttrs(line.slice(11));
        if (a.METHOD === 'SAMPLE-AES' || a.METHOD === 'SAMPLE-AES-CTR' || /widevine|playready|fairplay/i.test(a.KEYFORMAT || '')) { drm = true; }
      } else if (!line.startsWith('#')) { segments++; }
    }
    return { type: 'media', duration, segments, endlist, drm };
  }

  /** Highest resolution first, then highest bitrate. */
  function pickBest(variants) {
    if (!variants || !variants.length) { return null; }
    return [...variants].sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth))[0];
  }

  function qualityLabel(height) {
    const h = Number(height) || 0;
    if (!h) { return ''; }
    if (h >= 4000) { return '8K'; }
    if (h >= 2000) { return '4K'; }
    if (h >= 1400) { return h + 'p 2K'; }
    if (h >= 1000) { return h + 'p Full HD'; }
    if (h >= 700) { return h + 'p HD'; }
    return h + 'p';
  }

  function formatDuration(sec, units = { h: 'h', m: 'min', s: 'sec' }) {
    const t = Math.round(Number(sec) || 0);
    if (t <= 0) { return ''; }
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    if (h) { return `${h} ${units.h} ${m} ${units.m} ${s} ${units.s}`; }
    return `${m} ${units.m} ${s} ${units.s}`;
  }

  /**
   * Build the grey sub-line shown under the file name, e.g.
   *   "HLS stream, 8 min 0 sec, quality 720p HD, 1593 kbps"
   * @param {object} item  {kind, ext, size, info:{duration,height,bandwidth,live,drm}}
   * @param {object} L     labels
   */
  function describe(item, L) {
    const info = item.info || {};
    const parts = [];
    if (item.kind === 'hls') { parts.push(L.hls); }
    else if (item.kind === 'dash') { parts.push(L.dash); }
    else { parts.push(`${String(item.ext || '').toUpperCase()} ${L.fileWord}`.trim()); }
    if (info.live) { parts.push(L.live); }
    else if (info.duration) { parts.push(formatDuration(info.duration, L.units)); }
    if (info.height) { parts.push(`${L.quality} ${qualityLabel(info.height)}`); }
    if (info.bandwidth) { parts.push(`${Math.round(info.bandwidth / 1000)} kbps`); }
    if (item.size && item.kind === 'file') { parts.push(L.size(item.size)); }
    if (info.drm) { parts.push(L.drm); }
    return parts.filter(Boolean).join(', ');
  }

  return { parsePlaylist, pickBest, qualityLabel, formatDuration, describe };
}));
