/* Which web pages are "a video of YouTube / TikTok / Facebook / Instagram". On such a page the app downloads the video itself with yt-dlp,
 * so the extension only has to hand over the page address. Keep in step with SITES in src/core/ytdlp.js (a test compares the two). */
(function (root) {
  'use strict';
  const SITES = [
    (u) => /(^|\.)youtube\.com$|(^|\.)youtube-nocookie\.com$/.test(u.hostname) && (/^\/(watch|shorts\/|live\/|embed\/|v\/|clip\/)/.test(u.pathname) || u.pathname === '/watch'),
    (u) => u.hostname === 'youtu.be' && u.pathname.length > 1,
    (u) => /(^|\.)tiktok\.com$/.test(u.hostname) && (/\/video\/\d+/.test(u.pathname) || /^\/(t|v)\//.test(u.pathname) || /^(vm|vt)\./.test(u.hostname) || /\/photo\/\d+/.test(u.pathname)),
    (u) => /(^|\.)facebook\.com$/.test(u.hostname) && (/^\/(watch|reel\/|reels\/|share\/(v|r)\/|video\.php)/.test(u.pathname) || /\/videos\/\d+/.test(u.pathname) || /\/(posts|permalink)\//.test(u.pathname) && /[?&]v=/.test(u.search)),
    (u) => u.hostname === 'fb.watch' && u.pathname.length > 1,
    (u) => /(^|\.)instagram\.com$/.test(u.hostname) && /^\/(reel|reels|p|tv)\//.test(u.pathname),
  ];
  function isVideoPage(url) {
    let u;
    try { u = new URL(url); } catch { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { return false; }
    return SITES.some((f) => { try { return !!f(u); } catch { return false; } });
  }
  root.SGMediaSite = { isVideoPage };
}(typeof self !== 'undefined' ? self : this));
