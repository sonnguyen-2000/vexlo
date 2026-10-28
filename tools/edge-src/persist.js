/* A Manifest V3 service worker is unloaded after ~30 s of silence and loses its memory.
 * Keep the per-tab list of captured media in storage.session (memory only, never written to disk) and restore it on wake-up.
 * Runs after background.js and shares its top-level variables (tabMedia, hlsChildren, updateBadge). */
(function () {
  'use strict';
  const store = browser.storage && browser.storage.session;
  if (!store) { return; }
  const KEY = 'sg-tabmedia';
  let timer = null;

  function snapshot() {
    return [...tabMedia.entries()].map(([tab, map]) => [tab, [...map.values()].map((i) => ({ ...i, inspecting: false }))]);
  }
  function save() {
    timer = null;
    store.set({ [KEY]: { media: snapshot(), kids: [...hlsChildren.entries()].map(([t, s]) => [t, [...s]]) } }).catch(() => {});
  }

  const baseBadge = updateBadge; // eslint-disable-line no-undef
  // eslint-disable-next-line no-global-assign
  updateBadge = (tabId) => { baseBadge(tabId); if (!timer) { timer = setTimeout(save, 150); } };

  globalThis.SGReady = store.get(KEY).then((r) => {
    const data = r && r[KEY];
    if (!data) { return; }
    for (const [tab, items] of data.media || []) {
      if (!tabMedia.has(tab)) { tabMedia.set(tab, new Map(items.map((i) => [i.id, i]))); }
    }
    for (const [tab, keys] of data.kids || []) { if (!hlsChildren.has(tab)) { hlsChildren.set(tab, new Set(keys)); } }
  }).catch(() => {});
}());
