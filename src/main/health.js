'use strict';
/* Start-up guard and self-check, kept free of Electron so it can be tested.
 * - The app writes "starting.json" when it begins and removes it once it is fully up. If the file is still there on the next start,
 *   the previous start did not finish ("safe mode").
 * - healthCheck() looks at the data files and the download folder, and repairs what can be repaired without losing anything:
 *   a damaged file is moved aside (never deleted) so the app starts from defaults. */
const fs = require('fs');
const path = require('path');

const FLAG = 'starting.json';

function markStarting(dir, pid) { try { fs.writeFileSync(path.join(dir, FLAG), JSON.stringify({ pid, at: Date.now() })); } catch { /* best effort */ } }
function markStarted(dir) { try { fs.rmSync(path.join(dir, FLAG), { force: true }); } catch { /* best effort */ } }
/** True when an earlier start began but never finished. Call before markStarting(). */
function previousStartFailed(dir) { try { return fs.existsSync(path.join(dir, FLAG)); } catch { return false; } }

function asideName(file) { return `${file}.bad-${new Date().toISOString().replace(/[:.]/g, '-')}`; }

function checkJson(dir, name, fix) {
  const file = path.join(dir, name);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { id: name, ok: true, detail: 'missing' }; } // a new install has none: fine
  try { JSON.parse(text); return { id: name, ok: true, detail: 'ok' }; } catch { /* damaged */ }
  if (!fix) { return { id: name, ok: false, fixed: false, detail: 'damaged' }; }
  try { fs.renameSync(file, asideName(file)); return { id: name, ok: false, fixed: true, detail: 'damaged' }; } catch { return { id: name, ok: false, fixed: false, detail: 'damaged' }; }
}

/** Can the folder be reached (and created) within `ms`? Never blocks the caller for longer. */
function folderReachable(folder, ms) {
  if (!folder) { return Promise.resolve(true); }
  // An existing folder is enough (mkdir on a drive root such as D:\\ fails on some Windows setups even though the folder is fine).
  const reach = fs.promises.stat(folder).then((st) => st.isDirectory(), () => false)
    .then((exists) => exists || fs.promises.mkdir(folder, { recursive: true }).then(() => true, () => false));
  return Promise.race([
    reach,
    new Promise((r) => setTimeout(() => r(false), ms)),
  ]);
}

/** @returns {Promise<{id: string, ok: boolean, fixed?: boolean, detail?: string}[]> } */
async function healthCheck({ dir, fix = true, folderMs = 4000, checkFolder = true }) {
  const out = [];
  out.push(checkJson(dir, 'settings.json', fix));
  out.push(checkJson(dir, 'downloads.json', fix));
  let folder = '';
  try { folder = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).downloadDir || ''; } catch { /* defaults */ }
  if (checkFolder) { out.push({ id: 'download-folder', ok: await folderReachable(folder, folderMs), detail: folder }); }
  try { // a leftover marker from a copy started by the browser helper long ago
    const f = path.join(dir, 'start-hidden.flag');
    if (fs.existsSync(f) && Date.now() - Number(fs.readFileSync(f, 'utf8')) > 90000) { fs.rmSync(f, { force: true }); out.push({ id: 'stale-flag', ok: false, fixed: true }); }
  } catch { /* ignore */ }
  return out;
}

module.exports = { markStarting, markStarted, previousStartFailed, healthCheck, folderReachable, FLAG };
