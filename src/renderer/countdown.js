/* "All downloads finished" countdown: one single prompt for the whole batch, with a cancel button. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const api = window.vexlo;
  const T = window.I18N.tr;
  const LABEL = { shutdown: 'Máy sẽ tắt sau ', sleep: 'Máy sẽ chuyển sang chế độ ngủ sau ', hibernate: 'Máy sẽ ngủ đông sau ', exit: 'Vexlo sẽ thoát sau ' };
  async function init() {
    if (!api) { return; }
    const info = await api.afterCountdown().catch(() => null);
    if (!info) { return; }
    let left = info.seconds || 60;
    const draw = () => { $('sec').textContent = String(left); $('msg').textContent = T(LABEL[info.action] || '') + left + T(' giây.'); };
    draw();
    const timer = setInterval(() => {
      left--;
      if (left <= 0) { clearInterval(timer); api.afterNow(); return; }
      draw();
    }, 1000);
    $('cancel').addEventListener('click', () => { clearInterval(timer); api.afterCancel(); });
    $('now').addEventListener('click', () => { clearInterval(timer); api.afterNow(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { clearInterval(timer); api.afterCancel(); } });
  }
  init();
}());
