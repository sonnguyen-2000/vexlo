/* Small window that follows an app update: download progress, "waiting for your downloads", then "installing".
 * It listens to 'update:status' / 'update:restarting' from the main process (see main.js). */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const api = window.vexlo;
  const T = window.I18N.tr;

  function draw(u) {
    if (!u) { return; }
    const bar = $('bar');
    bar.classList.remove('busy');
    if (u.state === 'downloading') {
      const p = Number(u.message) || 0;
      $('title').textContent = T('Đang tải bản cập nhật {v}', { v: u.version || '' });
      $('pct').textContent = p ? p + '%' : '';
      $('fill').style.width = p + '%';
      $('msg').textContent = T('Bạn vẫn dùng Vexlo bình thường trong lúc tải.');
    } else if (u.state === 'ready') {
      $('title').textContent = T('Đã tải xong bản {v}', { v: u.version || '' });
      $('pct').textContent = '100%';
      $('fill').style.width = '100%';
      $('msg').textContent = T('Vexlo sẽ cài và khởi động lại khi các tệp đang tải xong.');
    }
  }

  function restarting(u) {
    $('title').textContent = T('Đang cài bản {v}', { v: (u && u.version) || '' });
    $('pct').textContent = '';
    $('bar').classList.add('busy');
    $('msg').textContent = T('Vexlo sẽ tự đóng rồi mở lại sau khoảng một phút. Đây là bình thường, bạn không cần làm gì.');
    $('hide').classList.add('hidden');
  }

  async function init() {
    if (!api) { return; }
    $('hide').addEventListener('click', () => window.close());
    api.on('update:status', draw);
    api.on('update:restarting', restarting);
    draw(await api.updateStatus().catch(() => null));
  }
  init();
}());
