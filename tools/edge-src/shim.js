/* Vexlo - Chromium (Edge/Chrome) compatibility layer. Loaded first in every context (service worker, popup, options, content script).
 * Gives the shared Firefox code the `browser` object it expects. */
(function () {
  'use strict';
  const g = typeof globalThis !== 'undefined' ? globalThis : self;
  if (typeof g.chrome === 'undefined') { return; }
  const b = g.chrome;
  if (typeof g.browser === 'undefined') { g.browser = b; }
  // Newer Chromium may already define `browser`; patch whichever object the shared code will use.
  for (const api of new Set([b, g.browser])) {
    if (api.action && !api.browserAction) { try { api.browserAction = api.action; } catch { /* read-only */ } }
  }
  g.SG_EXTRA_HEADERS = ['extraHeaders']; // Chromium hides Cookie/Referer from webRequest unless asked
  g.SG_ICON = 'icons/icon128.png';       // Chromium cannot show SVG in notifications
  // Firefox lets a message listener answer by returning a Promise; Chromium needs sendResponse + `return true`.
  const ev = g.browser.runtime && g.browser.runtime.onMessage;
  if (ev && !ev.__sgWrapped) {
    const orig = ev.addListener.bind(ev);
    ev.addListener = (fn) => orig((msg, sender, sendResponse) => {
      let r;
      try { r = fn(msg, sender); } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); return false; }
      if (r && typeof r.then === 'function') {
        r.then((v) => { try { sendResponse(v); } catch { /* sender gone */ } },
               (e) => { try { sendResponse({ ok: false, error: String(e && e.message || e) }); } catch { /* sender gone */ } });
        return true;
      }
      return false;
    });
    ev.__sgWrapped = true;
  }
}());
