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
 * @param {{url:string, filename?:string, dir?:string, page?:string, kind?:string}} q the new download
 * @param {{exists?:(p:string)=>boolean, ignoreId?:string}} opts
 * @returns {null | {type:'active'|'error'|'done', task?:object, path?:string}}
 */
function findDuplicate(tasks, q, { exists = () => false, ignoreId = '' } = {}) {
  const others = tasks.filter((t) => t.id !== ignoreId);
  const sameUrl = (t) => stripHash(t.url) === stripHash(q.url);
  const sameName = (t) => !!q.filename && !!t.filename && lc(t.filename) === lc(q.filename);
  const samePage = (t) => !!q.page && !!(t.meta && t.meta.page) && t.meta.page === q.page && t.kind !== 'file' && q.kind !== 'file';

  const active = others.find((t) => ['downloading', 'queued', 'paused'].includes(t.status) && !t.pending && sameUrl(t));
  if (active) { return { type: 'active', task: active }; }

  // A failed attempt: same link, same file name, or (streams) the same page. Its link may have expired, so the URL can differ.
  const failed = others.find((t) => t.status === 'error' && (sameUrl(t) || sameName(t) || samePage(t)));
  if (failed) { return { type: 'error', task: failed }; }

  if (q.filename && q.dir) {
    const p = path.join(q.dir, q.filename);
    if (exists(p)) { return { type: 'done', path: p, task: others.find((t) => t.status === 'done' && t.path === p) }; }
  }
  return null;
}

module.exports = { findDuplicate };
