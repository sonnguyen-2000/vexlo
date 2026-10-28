'use strict';
const { URL } = require('url');

/** Tiny tolerant XML parser: enough for MPD manifests (no DTD, no CDATA tricks). */
function parseXml(xml) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const cur = stack[stack.length - 1];
    if (m[1] !== undefined) { cur.text += m[1]; }
    else if (m[2]) { if (stack.length > 1) { stack.pop(); } }
    else if (m[3]) {
      const attrs = {};
      const are = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = are.exec(m[4] || ''))) { attrs[a[1]] = decodeEntities(a[2] ?? a[3]); }
      const node = { name: m[3].replace(/^.*:/, ''), attrs, children: [], text: '' };
      cur.children.push(node);
      if (!m[5]) { stack.push(node); }
    } else if (m[6] !== undefined) { cur.text += decodeEntities(m[6]); }
  }
  return root.children[0];
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

const kids = (n, name) => (n ? n.children.filter((c) => c.name === name) : []);
const kid = (n, name) => kids(n, name)[0];

function parseDuration(s) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(s || '');
  if (!m) { return 0; }
  return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3] || 0) * 60) + Number(m[4] || 0);
}

function resolveBase(node, base) {
  const b = kid(node, 'BaseURL');
  return b && b.text.trim() ? new URL(b.text.trim(), base).toString() : base;
}

function fillTemplate(tpl, vars) {
  return tpl.replace(/\$(RepresentationID|Number|Bandwidth|Time)(?:%0(\d+)d)?\$/g, (_, k, pad) => {
    const v = String(vars[k] ?? '');
    return pad ? v.padStart(Number(pad), '0') : v;
  }).replace(/\$\$/g, '$');
}

function parseRange(r) {
  const m = /^(\d+)-(\d+)$/.exec(r || '');
  return m ? { start: Number(m[1]), end: Number(m[2]) } : null;
}

/**
 * Parse an MPD into a plan for the segmented downloader.
 * Returns { duration, video:[reps], audio:[reps] } where each rep is
 *   { id, bandwidth, width, height, codecs, mime, single?:url, init?:{url,range}, segments?:[{url,duration}] }
 */
function parseMpd(text, mpdUrl) {
  const mpd = parseXml(text);
  if (!mpd || mpd.name !== 'MPD') { throw new Error('Không phải manifest DASH hợp lệ'); }
  if (mpd.attrs.type === 'dynamic') { throw new Error('Luồng trực tiếp (live DASH) chưa được hỗ trợ'); }
  const totalDuration = parseDuration(mpd.attrs.mediaPresentationDuration);
  const base0 = resolveBase(mpd, mpdUrl);
  const out = { duration: totalDuration, video: [], audio: [], protection: false };

  const periods = kids(mpd, 'Period');
  const period = periods[0];
  if (!period) { throw new Error('Manifest không có Period'); }
  const pDur = parseDuration(period.attrs.duration) || totalDuration;
  const base1 = resolveBase(period, base0);

  for (const set of kids(period, 'AdaptationSet')) {
    if (kids(set, 'ContentProtection').some((c) => /edef8ba9|9a04f079|94ce86fb|urn:mpeg:dash:mp4protection/i.test(c.attrs.schemeIdUri || '') && !/mp4protection/i.test(c.attrs.schemeIdUri || ''))) {
      out.protection = true;
    }
    const base2 = resolveBase(set, base1);
    const setTpl = kid(set, 'SegmentTemplate');
    const setMime = set.attrs.mimeType || '';
    const setType = set.attrs.contentType || (setMime.split('/')[0]);
    for (const rep of kids(set, 'Representation')) {
      const mime = rep.attrs.mimeType || setMime;
      const type = rep.attrs.contentType || setType || mime.split('/')[0];
      if (type !== 'video' && type !== 'audio') { continue; }
      const base = resolveBase(rep, base2);
      const info = {
        id: rep.attrs.id, bandwidth: Number(rep.attrs.bandwidth) || 0, width: Number(rep.attrs.width || set.attrs.width) || 0,
        height: Number(rep.attrs.height || set.attrs.height) || 0, codecs: rep.attrs.codecs || set.attrs.codecs || '', mime, type,
        lang: set.attrs.lang || '',
      };
      const tpl = kid(rep, 'SegmentTemplate') || setTpl;
      const segBase = kid(rep, 'SegmentBase');
      const segList = kid(rep, 'SegmentList');
      if (tpl) {
        const timescale = Number(tpl.attrs.timescale) || 1;
        const startNumber = tpl.attrs.startNumber !== undefined ? Number(tpl.attrs.startNumber) : 1;
        const vars = { RepresentationID: info.id, Bandwidth: info.bandwidth };
        if (tpl.attrs.initialization) {
          info.init = { url: new URL(fillTemplate(tpl.attrs.initialization, vars), base).toString(), range: null };
        }
        const media = tpl.attrs.media;
        const segs = [];
        const timeline = kid(tpl, 'SegmentTimeline');
        if (timeline) {
          let t = 0;
          let number = startNumber;
          for (const s of kids(timeline, 'S')) {
            if (s.attrs.t !== undefined) { t = Number(s.attrs.t); }
            const d = Number(s.attrs.d);
            const repeat = Number(s.attrs.r || 0);
            for (let i = 0; i <= repeat; i++) {
              segs.push({ url: new URL(fillTemplate(media, { ...vars, Number: number, Time: t }), base).toString(), duration: d / timescale });
              t += d; number++;
            }
          }
        } else {
          const d = Number(tpl.attrs.duration);
          if (!d || !pDur) { throw new Error('Manifest thiếu thông tin thời lượng segment'); }
          const count = Math.ceil(pDur / (d / timescale));
          for (let i = 0; i < count; i++) {
            segs.push({ url: new URL(fillTemplate(media, { ...vars, Number: startNumber + i }), base).toString(), duration: d / timescale });
          }
        }
        info.segments = segs;
      } else if (segList) {
        const initEl = kid(segList, 'Initialization');
        if (initEl) { info.init = { url: new URL(initEl.attrs.sourceURL || '', base).toString(), range: parseRange(initEl.attrs.range) }; }
        info.segments = kids(segList, 'SegmentURL').map((s) => ({
          url: new URL(s.attrs.media || '', base).toString(), range: parseRange(s.attrs.mediaRange), duration: 0,
        }));
      } else if (segBase || kid(rep, 'BaseURL') || kid(set, 'BaseURL')) {
        // One whole file (on-demand profile): plain download.
        info.single = base;
      } else { continue; }
      (type === 'video' ? out.video : out.audio).push(info);
    }
  }
  return out;
}

function pickRepresentation(reps, quality = 'best') {
  if (!reps.length) { return null; }
  const sorted = [...reps].sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  if (quality === 'worst') { return sorted[sorted.length - 1]; }
  const target = Number(quality);
  if (target > 0) { return sorted.find((r) => r.height && r.height <= target) || sorted[sorted.length - 1]; }
  return sorted[0];
}

module.exports = { parseMpd, parseXml, pickRepresentation, parseDuration };
