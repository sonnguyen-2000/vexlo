'use strict';
const { categoryOf } = require('./category');
const { filenameFromUrl } = require('./util');

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'tif', 'tiff', 'heic']);
const decodeEntities = (s) => String(s).replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  const l = e.toLowerCase();
  if (l === 'amp') { return '&'; } if (l === 'lt') { return '<'; } if (l === 'gt') { return '>'; } if (l === 'quot') { return '"'; } if (l === 'apos') { return "'"; }
  const n = l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
  return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
});

/** 'image' or one of the category ids ('video', 'music', 'archive', 'program', 'document', 'other'). */
function linkType(url) {
  const m = /\.([a-z0-9]{1,6})(?:[?#]|$)/i.exec(String(url).split('?')[0] + '?');
  const ext = m ? m[1].toLowerCase() : '';
  if (IMAGE_EXT.has(ext)) { return 'image'; }
  return categoryOf(url);
}

/**
 * Every downloadable-looking address in an HTML page: links, images (incl. srcset), video / audio / source tags.
 * Relative addresses are resolved against `baseUrl`; only http(s) is kept; duplicates are merged.
 * Plain pages (".html", folders) are marked `page: true` so the window can hide them by default.
 * @returns {{url:string, name:string, text:string, type:string, tag:string, page:boolean}[]}
 */
function extractPageLinks(html, baseUrl) {
  const src = String(html || '');
  let base;
  try { base = new URL(baseUrl); } catch { return []; }
  const baseTag = /<base\s[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(src);
  if (baseTag) { try { base = new URL(decodeEntities(baseTag[1] || baseTag[2]), base); } catch { /* keep */ } }
  const out = new Map();
  const add = (raw, tag, text = '') => {
    if (!raw) { return; }
    const v = decodeEntities(raw).trim();
    if (!v || /^(javascript|mailto|tel|data|blob|about):/i.test(v) || v.startsWith('#')) { return; }
    let u;
    try { u = new URL(v, base); } catch { return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { return; }
    u.hash = '';
    const url = u.href;
    if (out.has(url)) { if (text && !out.get(url).text) { out.get(url).text = text; } return; }
    const type = linkType(url);
    const name = filenameFromUrl(url) || '';
    out.set(url, { url, name, text, type, tag, page: type === 'other' && (!/\.[a-z0-9]{1,6}$/i.test(u.pathname) || /\.(html?|php|aspx?|jsp)$/i.test(u.pathname)) });
  };
  const attr = (tagText, name) => {
    const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tagText);
    return m ? (m[1] ?? m[2] ?? m[3]) : '';
  };
  for (const m of src.matchAll(/<a\s[^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = decodeEntities(m[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 120);
    add(attr(m[0], 'href'), 'a', text);
  }
  for (const m of src.matchAll(/<(img|video|audio|source|embed|track)\s[^>]*>/gi)) {
    const tag = m[1].toLowerCase();
    add(attr(m[0], 'src') || attr(m[0], 'data-src') || attr(m[0], 'data-original'), tag);
    if (tag === 'video') { add(attr(m[0], 'poster'), 'img'); }
    const set = attr(m[0], 'srcset') || attr(m[0], 'data-srcset');
    if (set) { for (const part of set.split(',')) { add(part.trim().split(/\s+/)[0], tag); } }
  }
  return [...out.values()];
}

/** Page title (for the window heading). */
function pageTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 150) : '';
}

module.exports = { extractPageLinks, pageTitle, linkType };
