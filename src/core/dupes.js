'use strict';
/* Duplicate detection for new downloads (IDM style).
 *  - the same link is already downloading / waiting / paused  -> 'active'  (do not add it twice)
 *  - an earlier attempt for the same file FAILED               -> 'error'   (replace it: same name, no "(1)")
 *  - the file already exists on disk (finished earlier)        -> 'done'    (keep both; the new one is numbered "name (1).ext")
 * Pure functions: tasks are the snapshots the manager produces. */
const path = require('path');

const stripHash = (u) => String(u || '').split('#')[0];
const lc = (s) => String(s || '').toLowerCase();

/**
 * @param {Array} tasks existing task snapshots
 * @param {{url:string, filename?:string, dir?:string, page?:string, title?:string, kind?:string}} q the new download
 * @param {{exists?:(p:string)=>boolean, ignoreId?:string}} opts
 * @returns {null | {type:'active'|'error'|'done', task?:object, path?:string}}
 */
function findDuplicate(tasks, q, { exists = () => false, ignoreId = '' } = {}) {
  const others = tasks.filter((t) => t.id !== ignoreId);
  const sameUrl = (t) => stripHash(t.url) === stripHash(q.url);
  const sameName = (t) => !!q.filename && !!t.filename && lc(t.filename) === lc(q.filename);
  const stream = (t) => t.kind !== 'file' && q.kind !== 'file';
  const samePage = (t) => !!q.page && !!(t.meta && t.meta.page) && stripHash(t.meta.page) === stripHash(q.page) && stream(t);
  // Streams are named after the page title, so the same title means the same video even when the link (and page address) changed.
  const sameTitle = (t) => !!q.title && !!(t.meta && t.meta.title) && lc(t.meta.title) === lc(q.title) && stream(t);

  const active = others.find((t) => ['downloading', 'queued', 'paused'].includes(t.status) && !t.pending && sameUrl(t));
  if (active) { return { type: 'active', task: active }; }

  // A failed attempt: same link, same file name, or (streams) the same page or title. Its link may have expired, so the URL can differ.
  const failed = others.find((t) => t.status === 'error' && (sameUrl(t) || sameName(t) || samePage(t) || sameTitle(t)));
  if (failed) { return { type: 'error', task: failed }; }

  if (q.filename && q.dir) {
    const p = path.join(q.dir, q.filename);
    if (exists(p)) { return { type: 'done', path: p, task: others.find((t) => t.status === 'done' && t.path === p) }; }
  }
  return null;
}

module.exports = { findDuplicate };
