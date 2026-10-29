/* Helpers shared by the main window and the confirmation window. Pure functions, unit-tested in Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.SG = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const I = (typeof module === 'object' && module.exports) ? require('./i18n') : self.I18N;
  const tr = (k, v) => I.tr(k, v);

  const GROUPS = {
    video: { get label() { return tr('Video'); }, icon: 'i-film', ext: 'mp4 mkv avi mov wmv flv f4v webm m4v mpg mpeg 3gp ogv ts m2ts m3u8 mpd' },
    music: { get label() { return tr('Âm thanh'); }, icon: 'i-music', ext: 'mp3 m4a aac wav flac ogg oga opus wma weba amr' },
    archive: { get label() { return tr('Nén'); }, icon: 'i-archive', ext: 'zip rar 7z tar gz tgz bz2 xz zst iso img cab' },
    program: { get label() { return tr('Chương trình'); }, icon: 'i-package', ext: 'exe msi msix apk dmg pkg deb rpm appimage bat jar' },
    document: { get label() { return tr('Tài liệu'); }, icon: 'i-doc', ext: 'pdf doc docx xls xlsx ppt pptx txt epub mobi csv rtf odt ods' },
    other: { get label() { return tr('Khác'); }, icon: 'i-file', ext: '' },
  };
  const BY_EXT = {};
  for (const [id, g] of Object.entries(GROUPS)) { for (const e of g.ext.split(' ').filter(Boolean)) { BY_EXT[e] = id; } }

  function categoryOf(name, kind) {
    if (kind === 'hls' || kind === 'dash') { return 'video'; }
    const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || ''));
    return (m && BY_EXT[m[1].toLowerCase()]) || 'other';
  }

  function fmtSize(n) {
    if (!n || n < 0) { return ''; }
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? String(Math.round(v)) : v >= 100 ? v.toFixed(0) : v.toFixed(v >= 10 ? 1 : 2)) + ' ' + u[i];
  }

  function fmtSpeed(n) { return n > 0 ? fmtSize(n) + '/s' : ''; }

  function fmtEta(sec) {
    if (!sec || !isFinite(sec) || sec <= 0) { return ''; }
    sec = Math.round(sec);
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (d) { return tr('{d} ngày {h} giờ', { d, h }); }
    if (h) { return tr('{h} giờ {m} phút', { h, m: String(m).padStart(2, '0') }); }
    if (m) { return tr('{m} phút {s} giây', { m, s: String(s).padStart(2, '0') }); }
    return tr('{s} giây', { s });
  }

  function fmtDate(ts, now = Date.now()) {
    if (!ts) { return ''; }
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
    const t = new Date(now);
    if (d.toDateString() === t.toDateString()) { return tr('Hôm nay {t}', { t: hm }); }
    const y = new Date(now - 86400000);
    if (d.toDateString() === y.toDateString()) { return tr('Hôm qua {t}', { t: hm }); }
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
  }

  function hostOf(url) { try { return new URL(url).hostname; } catch { return ''; } }

  function percent(t) {
    if (t.status === 'done') { return 100; }
    if (t.size > 0) { return Math.max(0, Math.min(100, (t.downloaded / t.size) * 100)); }
    if (t.segTotal > 0) { return Math.max(0, Math.min(100, (t.segDone / t.segTotal) * 100)); }
    return 0;
  }

  const PHASES = { prepare: 'Đang chuẩn bị', merge: 'Đang ghép các đoạn', mux: 'Đang xuất MP4' };

  /** Text under the progress bar. */
  function statusText(t) {
    switch (t.status) {
      case 'done': return tr('Hoàn tất');
      case 'error': return tr(t.error || 'Lỗi');
      case 'queued': return tr('Đang chờ trong hàng đợi');
      case 'paused': return tr(t.downloaded > 0 ? 'Đã dừng' : 'Chưa bắt đầu');
      case 'downloading': {
        if (t.phase && t.phase !== 'download') { return PHASES[t.phase] ? tr(PHASES[t.phase]) : t.phase; }
        const bits = [];
        if (t.kind !== 'file' && t.segTotal) { bits.push(tr('{a}/{b} đoạn', { a: t.segDone, b: t.segTotal })); }
        else if (t.connections > 1) { bits.push(tr('{n} kết nối', { n: t.connections })); }
        return bits.join(' · ') || tr('Đang tải');
      }
      default: return '';
    }
  }

  const FILTERS = {
    all: () => true,
    active: (t) => t.status === 'downloading' || t.status === 'queued',
    unfinished: (t) => t.status !== 'done',
    done: (t) => t.status === 'done',
  };

  return { GROUPS, categoryOf, fmtSize, fmtSpeed, fmtEta, fmtDate, hostOf, percent, statusText, FILTERS };
}));
