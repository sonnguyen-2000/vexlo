/* Extraction progress window: what is being extracted, how far it is, and when it has finished. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const api = window.vexlo;
  const T = window.I18N.tr;
  const { fmtSize } = window.SG;
  const TOOLS = { unrar: 'WinRAR', winrar: 'WinRAR', '7zip': '7-Zip', tar: 'tar' };
  let st = null;
  let tick = 0;

  const mmss = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const x = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
  };

  function render() {
    if (!st) { return; }
    const running = st.phase === 'prepare' || st.phase === 'extract';
    $('name').textContent = st.name;
    $('name').title = st.name;
    $('tool').textContent = TOOLS[st.tool] || '—';
    $('time').textContent = mmss((st.endedAt || Date.now()) - st.startedAt);
    $('got').textContent = st.done || st.total ? fmtSize(st.done) + (st.total ? ' / ' + fmtSize(st.total) : '') : '—';
    const bar = $('bar');
    const known = st.percent >= 0;
    bar.classList.toggle('ind', running && !known);
    bar.classList.toggle('done', st.phase === 'done');
    bar.classList.toggle('error', st.phase === 'error');
    $('fill').style.width = st.phase === 'done' ? '100%' : known ? st.percent + '%' : '';
    $('pct').textContent = st.phase === 'done' ? '100%' : known && running ? st.percent + '%' : '';
    $('meta').textContent = st.phase === 'prepare' ? T('Đang chuẩn bị…')
      : st.phase === 'extract' ? T('Đang giải nén…')
        : st.phase === 'done' ? T('Đã giải nén xong')
          : st.phase === 'error' ? T('Không giải nén được') : '';
    $('actRun').classList.toggle('hidden', !running);
    $('actDone').classList.toggle('hidden', running);
    $('note').classList.toggle('hidden', !running);
    $('err').classList.toggle('hidden', st.phase !== 'error');
    if (st.phase === 'error') { $('errTxt').textContent = T(st.reasonText || ''); $('tech').textContent = st.tech || ''; $('tech').classList.toggle('hidden', !st.tech); }
    $('folder').textContent = st.phase === 'done' ? T('Mở thư mục') : T('Mở thư mục chứa tệp');
    document.title = (running ? (known ? st.percent + '% ' : '') : '') + T('Giải nén');
    if (!running) { clearInterval(tick); tick = 0; } else if (!tick) { tick = setInterval(render, 1000); }
  }

  async function init() {
    if (!api) { return; }
    api.on('extract:update', (s) => { st = s; render(); });
    st = await api.extractGet().catch(() => null);
    render();
    $('cancel').addEventListener('click', () => api.extractCancel());
    $('hide').addEventListener('click', () => api.extractClose());
    $('close').addEventListener('click', () => api.extractClose());
    $('folder').addEventListener('click', () => api.extractFolder());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { api.extractClose(); } });
  }
  init();
}());
