'use strict';
const { URL } = require('url');

function parseAttrs(str) {
  const out = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) { out[m[1]] = m[3] !== undefined ? m[3] : m[2]; }
  return out;
}

const abs = (u, base) => new URL(u, base).toString();

function parseByteRange(v, prevEnd) {
  const m = /^(\d+)(?:@(\d+))?$/.exec(v || '');
  if (!m) { return null; }
  const len = Number(m[1]);
  const start = m[2] !== undefined ? Number(m[2]) : prevEnd;
  return { start, end: start + len - 1 };
}

/**
 * Parse an HLS playlist.
 * Master  -> { type:'master', variants:[...], audios:[...] }
 * Media   -> { type:'media', segments:[...], map, endlist, encrypted, unsupportedKey }
 */
function parseM3u8(text, baseUrl) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines[0] || !lines[0].startsWith('#EXTM3U')) { throw new Error('Không phải playlist M3U8 hợp lệ'); }

  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) { return parseMaster(lines, baseUrl); }

  const res = { type: 'media', segments: [], map: null, endlist: false, mediaSequence: 0, targetDuration: 0, unsupported: '' };
  let key = null;
  let duration = 0;
  let range = null;
  let lastRangeEnd = 0;
  let seq = 0;
  let discontinuity = false;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) { res.mediaSequence = Number(line.split(':')[1]) || 0; seq = res.mediaSequence; }
    else if (line.startsWith('#EXT-X-TARGETDURATION:')) { res.targetDuration = Number(line.split(':')[1]) || 0; }
    else if (line.startsWith('#EXT-X-ENDLIST')) { res.endlist = true; }
    else if (line.startsWith('#EXT-X-DISCONTINUITY')) { discontinuity = true; }
    else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(line.slice(11));
      if (!a.METHOD || a.METHOD === 'NONE') { key = null; }
      else if (a.METHOD === 'AES-128') {
        key = { method: 'AES-128', uri: a.URI ? abs(a.URI, baseUrl) : '', iv: a.IV ? Buffer.from(a.IV.replace(/^0x/i, '').padStart(32, '0'), 'hex') : null };
      } else {
        key = null;
        res.unsupported = a.METHOD === 'SAMPLE-AES' || /widevine|playready|fairplay/i.test(a.KEYFORMAT || '')
          ? 'Video được bảo vệ DRM / mã hóa SAMPLE-AES, không thể tải'
          : 'Kiểu mã hóa ' + a.METHOD + ' chưa được hỗ trợ';
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(line.slice(11));
      res.map = { url: abs(a.URI, baseUrl), range: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null };
    } else if (line.startsWith('#EXTINF:')) { duration = parseFloat(line.slice(8)) || 0; }
    else if (line.startsWith('#EXT-X-BYTERANGE:')) { range = parseByteRange(line.slice(17), lastRangeEnd); }
    else if (!line.startsWith('#')) {
      if (range) { lastRangeEnd = range.end + 1; }
      res.segments.push({
        url: abs(line, baseUrl), duration, range, key: key ? { ...key } : null, seq: seq++, discontinuity,
      });
      duration = 0; range = null; discontinuity = false;
    }
  }
  res.totalDuration = res.segments.reduce((a, s) => a + s.duration, 0);
  return res;
}

function parseMaster(lines, baseUrl) {
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
        peak: Number(a.BANDWIDTH) || 0, width: w || 0, height: h || 0, codecs: a.CODECS || '', audio: a.AUDIO || '',
      });
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttrs(line.slice(13));
      if (a.TYPE === 'AUDIO' && a.URI) {
        audios.push({ group: a['GROUP-ID'], name: a.NAME || '', lang: a.LANGUAGE || '', def: a.DEFAULT === 'YES', url: abs(a.URI, baseUrl) });
      }
    }
  }
  return { type: 'master', variants, audios };
}

/** Pick a variant: 'best' (default), 'worst', or a target height such as 720. */
function pickVariant(variants, quality = 'best') {
  if (!variants.length) { return null; }
  const sorted = [...variants].sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  if (quality === 'worst') { return sorted[sorted.length - 1]; }
  const target = Number(quality);
  if (target > 0) {
    const fit = sorted.find((v) => v.height && v.height <= target);
    return fit || sorted[sorted.length - 1];
  }
  return sorted[0];
}

module.exports = { parseM3u8, pickVariant, parseAttrs };
