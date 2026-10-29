/* Per-download progress window. Talks to the main process only through window.vexlo (see preload.js). */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const api = window.vexlo;
  const SG = window.SG;
  const T = window.I18N.tr;
  let task = null;
  let autoTimer = null;
  let onErr = 'ask';
  let closedForErr = false;

  function render(t) {
    task = t;
    const cat = SG.categoryOf(t.filename || t.url, t.kind);
    $('badge').dataset.cat = cat;
    $('badgeUse').setAttribute('href', '#' + SG.GROUPS[cat].icon);
    $('name').textContent = t.filename || t.url || '';
    $('name').title = t.filename || '';
    const meta = [t.kind === 'hls' ? T('Luồng HLS') : t.kind === 'dash' ? T('Luồng DASH') : SG.GROUPS[cat].label, SG.hostOf(t.url)].filter(Boolean);
    $('meta').textContent = meta.join('  ·  ');
    $('meta').title = t.url || '';
    const p = SG.percent(t);
    $('pct').textContent = Math.floor(p) + '%';
    $('fill').style.width = p.toFixed(1) + '%';
    $('bar').className = 'bar' + (t.status === 'paused' ? ' paused' : t.status === 'error' ? ' error' : '');
    const total = t.size > 0 && t.kind === 'file' ? SG.fmtSize(t.size) : '';
    $('got').textContent = SG.fmtSize(t.downloaded) ? SG.fmtSize(t.downloaded) + (total ? ' / ' + total : '') : '—';
    $('spd').textContent = t.status === 'downloading' ? (SG.fmtSpeed(t.speed) || '—') : '—';
    $('eta').textContent = t.status === 'downloading' ? (SG.fmtEta(t.eta) || '—') : '—';
    $('stat').textContent = SG.statusText(t);
    $('stat').className = t.status === 'error' ? 'err' : '';
    $('stat').title = $('stat').textContent;
    document.title = t.status === 'done' ? T('Đã tải xong') : Math.floor(p) + '% · ' + (t.filename || T('Đang tải'));

    const isErr = t.status === 'error';
    $('stats').classList.toggle('hidden', isErr && onErr === 'ask');
    $('errAsk').classList.toggle('hidden', !(isErr && onErr === 'ask'));
    $('errTxt').textContent = T('Tải bị lỗi: {e}', { e: T(t.error || 'không rõ nguyên nhân') });
    if (!isErr) { closedForErr = false; }
    else if (onErr === 'close' && !closedForErr) { closedForErr = true; setTimeout(() => api.progressClose(), 600); }
    const done = t.status === 'done';
    $('actDl').classList.toggle('hidden', done);
    $('actDone').classList.toggle('hidden', !done);
    $('pause').textContent = t.status === 'paused' || t.status === 'error' ? T('Tiếp tục') : T('Tạm dừng');
    if (done) { onDone(); }
  }

  function onDone() {
    if (autoTimer) { return; }
    if ($('auto').checked) { autoTimer = setTimeout(() => api.progressClose(), 1200); }
  }

  async function init() {
    if (!api) { document.body.textContent = T('Thiếu cầu nối với ứng dụng (preload).'); return; }
    const s = await api.getSettings().catch(() => ({}));
    $('auto').checked = s.progressAutoClose !== false;
    onErr = s.progressOnError || 'ask';
    api.on('settings:changed', (n) => { onErr = (n && n.progressOnError) || 'ask'; if (task) { render(task); } });
    $('errKeep').addEventListener('click', () => { onErr = 'keep'; api.setSettings({ progressOnError: 'keep' }); if (task) { render(task); } });
    $('errClose').addEventListener('click', () => { onErr = 'close'; api.setSettings({ progressOnError: 'close' }); api.progressClose(); });
    $('auto').addEventListener('change', () => { api.setSettings({ progressAutoClose: $('auto').checked }); });
    const t = await api.progressGet().catch(() => null);
    if (!t) { api.progressClose(); return; }
    render(t);
    api.on('dl:update', (u) => { if (task && u && u.id === task.id) { render(u); } });
    api.on('dl:removed', (u) => { if (task && u && u.id === task.id) { api.progressClose(); } });
    $('pause').addEventListener('click', () => {
      if (!task) { return; }
      if (task.status === 'paused' || task.status === 'error') { api.resume(task.id); } else { api.pause(task.id); }
    });
    $('cancel').addEventListener('click', () => { if (task) { api.remove(task.id, false); } });
    $('hide').addEventListener('click', () => api.progressClose());
    $('close').addEventListener('click', () => api.progressClose());
    $('open').addEventListener('click', () => { if (task) { api.open(task.id); api.progressClose(); } });
    $('folder').addEventListener('click', () => { if (task) { api.showInFolder(task.id); api.progressClose(); } });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { api.progressClose(); } });
  }
  init();
}());
