/* Vexlo - floating "Download this video" button (IDM style). Runs in every frame. */
(function () {
  'use strict';
  if (window.__vexloLoaded) { return; }
  window.__vexloLoaded = true;
  const api = typeof browser !== 'undefined' ? browser : chrome;
  if (!api || !api.runtime || !api.runtime.sendMessage) { return; }

  const vi = /^vi/i.test(navigator.language || '');
  const L = vi
    ? { download: 'Tải video này', sent: 'Đã thêm vào Vexlo', noApp: 'Không kết nối được Vexlo. Hãy mở ứng dụng.', none: 'Chưa bắt được video. Hãy bấm phát rồi thử lại.', title: 'Chọn video để tải', stream: 'Luồng', audio: 'Âm thanh', file: 'Tệp', failed: 'Vexlo báo lỗi' }
    : { download: 'Download this video', sent: 'Added to Vexlo', noApp: 'Cannot reach Vexlo. Please start the app.', none: 'No media captured yet. Press play and try again.', title: 'Choose media to download', stream: 'Stream', audio: 'Audio', file: 'File', failed: 'Vexlo reported an error' };

  let enabled = true;
  api.runtime.sendMessage({ type: 'getSettings' }).then((s) => { enabled = !s || s.floating !== false; }).catch(() => {});

  const MIN_W = 220;
  const MIN_H = 130;
  let host; let root; let btn; let panel; let toast;
  let current = null; let hideTimer = null; let panelOpen = false;

  function build() {
    if (host) { return; }
    host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;';
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
<style>
  *{box-sizing:border-box}
  .btn{position:fixed;display:none;align-items:center;gap:7px;padding:7px 12px 7px 9px;border:0;border-radius:7px;
    background:linear-gradient(180deg,#2fbf6c,#169a50);color:#fff;font:600 13px/1 system-ui,'Segoe UI',sans-serif;cursor:pointer;
    box-shadow:0 2px 10px rgba(0,0,0,.45);opacity:.95;white-space:nowrap}
  .btn:hover{opacity:1;filter:brightness(1.08)}
  .btn svg{width:16px;height:16px}
  .panel{position:fixed;display:none;width:min(340px,92vw);max-height:300px;overflow:auto;background:#1c1f24;color:#e8eaed;
    border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.6);font:13px/1.35 system-ui,'Segoe UI',sans-serif}
  .hd{padding:10px 12px;font-weight:600;border-bottom:1px solid #2e333a;position:sticky;top:0;background:#1c1f24}
  .it{display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:pointer;border-bottom:1px solid #262a30}
  .it:hover{background:#262c33}
  .tag{flex:none;padding:2px 6px;border-radius:4px;background:#2b3a31;color:#7be0a4;font-size:11px;font-weight:600}
  .tag.audio{background:#3a2f2b;color:#e0b07b}
  .col{flex:1;min-width:0}
  .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .mt{margin-top:2px;color:#9aa3ad;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .it{align-items:flex-start}
  .tag{margin-top:1px}
  .toast{position:fixed;display:none;padding:9px 14px;border-radius:8px;background:#1c1f24;color:#fff;font:13px system-ui,sans-serif;
    box-shadow:0 4px 18px rgba(0,0,0,.5);max-width:80vw}
  .toast.err{background:#7a2323}
</style>
<button class="btn" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/></svg><span></span></button>
<div class="panel"></div><div class="toast"></div>`;
    btn = root.querySelector('.btn');
    btn.querySelector('span').textContent = L.download;
    panel = root.querySelector('.panel');
    toast = root.querySelector('.toast');
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onButton(); });
    (document.documentElement || document.body).appendChild(host);
  }

  function showToast(text, isErr) {
    build();
    toast.textContent = text;
    toast.className = 'toast' + (isErr ? ' err' : '');
    toast.style.display = 'block';
    const r = current ? current.getBoundingClientRect() : { left: 20, bottom: 60, width: 300 };
    toast.style.left = Math.max(8, r.left + 10) + 'px';
    toast.style.top = Math.max(8, Math.min(window.innerHeight - 50, r.top + 52)) + 'px';
    clearTimeout(showToast.t);
    showToast.t = setTimeout(() => { toast.style.display = 'none'; }, 2600);
  }

  async function doSend(msg) {
    closePanel();
    let r;
    try { r = await api.runtime.sendMessage(msg); } catch { r = { ok: false }; }
    if (r && r.ok) { showToast(L.sent, false); }
    // Only a failed connection means "app not running"; anything else is a real error the user should be able to read.
    else if (r && r.code === 'app-error' && r.error) { showToast(`${L.failed}: ${r.error}`, true); }
    else { showToast(L.noApp, true); }
  }

  async function onButton() {
    if (panelOpen) { closePanel(); return; }
    let list = [];
    try { list = await api.runtime.sendMessage({ type: 'getMedia' }); } catch { list = []; }
    list = list || [];
    // One clear candidate: send it straight away like IDM does.
    if (list.length === 1) { return doSend({ type: 'send', id: list[0].id }); }
    if (!list.length) {
      const src = current && (current.currentSrc || current.src);
      if (src && /^https?:/i.test(src)) { return doSend({ type: 'sendUrl', url: src }); }
      return showToast(L.none, true);
    }
    return openPanel(list);
  }

  function openPanel(list) {
    panel.innerHTML = '';
    const hd = document.createElement('div');
    hd.className = 'hd';
    hd.textContent = L.title;
    panel.appendChild(hd);
    for (const m of list.slice(0, 20)) {
      const row = document.createElement('div');
      row.className = 'it';
      const tag = document.createElement('span');
      tag.className = 'tag' + (m.audioOnly ? ' audio' : '');
      tag.textContent = m.kind === 'file' ? (m.audioOnly ? L.audio : (m.ext || L.file).toUpperCase()) : (m.kind === 'hls' ? 'HLS' : 'DASH');
      const col = document.createElement('div');
      col.className = 'col';
      const nm = document.createElement('div');
      nm.className = 'nm';
      let fallback = '';
      try { fallback = decodeURIComponent(new URL(m.url).pathname.split('/').filter(Boolean).pop() || ''); } catch { fallback = m.url; }
      nm.textContent = m.name || m.title || fallback || m.url;
      nm.title = m.url;
      col.appendChild(nm);
      const meta = m.meta || (m.size ? fmt(m.size) : '');
      if (meta) {
        const mt = document.createElement('div');
        mt.className = 'mt';
        mt.textContent = meta;
        mt.title = meta;
        col.appendChild(mt);
      }
      row.append(tag, col);
      row.addEventListener('click', () => doSend({ type: 'send', id: m.id }));
      panel.appendChild(row);
    }
    placePanel();
    panel.style.display = 'block';
    panelOpen = true;
  }

  function fmt(n) {
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < 3) { n /= 1024; i++; }
    return n.toFixed(i > 1 ? 1 : 0) + ' ' + u[i];
  }

  function closePanel() {
    panelOpen = false;
    if (panel) { panel.style.display = 'none'; }
  }

  function placePanel() {
    const r = btn.getBoundingClientRect();
    panel.style.top = Math.min(r.bottom + 6, Math.max(8, window.innerHeight - 320)) + 'px';
    panel.style.left = Math.max(8, Math.min(r.right - 340, window.innerWidth - 350)) + 'px';
  }

  function placeButton(video) {
    build();
    const r = video.getBoundingClientRect();
    btn.style.display = 'flex';
    const w = btn.offsetWidth || 150;
    btn.style.top = Math.max(r.top + 8, 6) + 'px';
    btn.style.left = Math.max(Math.min(r.right - w - 8, window.innerWidth - w - 6), 6) + 'px';
    current = video;
    if (panelOpen) { placePanel(); }
  }

  function hideButton() {
    if (btn) { btn.style.display = 'none'; }
    current = null;
    closePanel();
  }

  // The button only appears when there is really something to download: the tab has captured media (stream or file),
  // or the <video> points at a plain http(s) file. A freshly opened page, or a player that has not started loading yet, shows nothing.
  let mediaCount = 0;
  let countAt = 0;
  let countBusy = false;
  function refreshCount(done) {
    if (countBusy || Date.now() - countAt < 1200) { return; }
    countBusy = true;
    api.runtime.sendMessage({ type: 'mediaCount' })
      .then((n) => { mediaCount = Number(n) || 0; }, () => { mediaCount = 0; })
      .finally(() => { countBusy = false; countAt = Date.now(); if (done) { done(); } });
  }
  const hasDirectSrc = (v) => /^https?:/i.test(v.currentSrc || v.src || '');
  const canDownload = (v) => mediaCount > 0 || hasDirectSrc(v);

  function videoAt(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el.tagName === 'VIDEO') {
        const r = el.getBoundingClientRect();
        if (r.width >= MIN_W && r.height >= MIN_H) { return el; }
      }
    }
    return null;
  }

  let last = 0;
  let lastX = 0;
  let lastY = 0;
  document.addEventListener('mousemove', (e) => {
    if (!enabled) { return; }
    lastX = e.clientX; lastY = e.clientY;
    const now = Date.now();
    if (now - last < 100) { return; }
    last = now;
    if (host && e.target === host) { clearTimeout(hideTimer); return; }
    const v = videoAt(e.clientX, e.clientY);
    if (v) {
      refreshCount(() => { if (v === current || !current) { const again = videoAt(lastX, lastY); if (again && canDownload(again)) { clearTimeout(hideTimer); placeButton(again); if (!panelOpen) { hideTimer = setTimeout(hideButton, 3500); } } } });
      if (!canDownload(v)) { if (current && !panelOpen) { hideButton(); } return; }
      clearTimeout(hideTimer);
      placeButton(v);
      if (!panelOpen) { hideTimer = setTimeout(hideButton, 3500); }
    } else if (current && !panelOpen) {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hideButton, 700);
    }
  }, { passive: true, capture: true });
  window.addEventListener('scroll', () => { if (current) { placeButton(current); } }, { passive: true, capture: true });
  window.addEventListener('resize', () => { if (current) { placeButton(current); } }, { passive: true });
  document.addEventListener('click', (e) => { if (panelOpen && e.target !== host) { closePanel(); } }, true);

  // Tabs opened by the app's "Refresh link": start the video by itself (muted, so browsers allow it) so the new link is captured.
  api.runtime.sendMessage({ type: 'refreshTab' }).then((yes) => {
    if (!yes) { return; }
    let tries = 0;
    const timer = setInterval(() => {
      if (++tries > 40) { clearInterval(timer); return; } // about 20 seconds
      for (const v of document.querySelectorAll('video')) {
        if (v.paused) { v.muted = true; const p = v.play(); if (p && p.catch) { p.catch(() => {}); } }
      }
    }, 500);
  }).catch(() => {});

  // The background page asks this frame to read a playlist with the page's own cookies/origin when its own request is refused.
  api.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'fetchText' || !/^https?:\/\//i.test(msg.url || '')) { return undefined; }
    return fetch(msg.url, { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error('http ' + r.status))))
      .then((text) => (text.length < 2 * 1024 * 1024 ? { ok: true, text } : { ok: false }))
      .catch(() => ({ ok: false }));
  });
})();
