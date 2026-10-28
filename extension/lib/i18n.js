/* Tiny i18n helper shared by popup/options/content script. Vietnamese by default for vi locales, English otherwise. */
(function (root) {
  'use strict';
  const vi = {
    download: 'Tải video này', downloadShort: 'Tải', sent: 'Đã thêm vào Vexlo', noApp: 'Không kết nối được Vexlo. Hãy mở ứng dụng.',
    none: 'Chưa bắt được video nào. Hãy bấm phát video rồi thử lại.', title: 'Video đã bắt được', close: 'Đóng',
    connected: 'Đã kết nối Vexlo', disconnected: 'Vexlo chưa chạy', noMediaTab: 'Chưa có video nào trong tab này.',
    stream: 'Luồng', file: 'Tệp', audio: 'Âm thanh', unknownSize: 'không rõ dung lượng', openApp: 'Mở Vexlo',
    menuLink: 'Tải bằng Vexlo', menuMedia: 'Tải video/âm thanh bằng Vexlo', pausedBrowser: 'Đã trả lại cho Firefox vì Vexlo chưa chạy',
    save: 'Lưu', saved: 'Đã lưu', takeover: 'Tiếp quản mọi tải xuống của Firefox', floating: 'Hiện nút tải nổi trên video',
    enabled: 'Bật tiện ích', port: 'Cổng Vexlo', token: 'Mã ghép nối (chỉ cần nếu không kết nối được)',
    exclude: 'Không tiếp quản các trang này (mỗi dòng một tên miền)', minSize: 'Bỏ qua video nhỏ hơn (KB)', minTake: 'Chỉ tiếp quản tệp từ (KB)',
    pair: 'Kiểm tra kết nối',
    hlsStream: 'Luồng HLS', dashStream: 'Luồng DASH', fileWord: 'tệp', qualityWord: 'chất lượng', liveWord: 'phát trực tiếp', drmWord: 'có DRM',
    unitH: 'giờ', unitMin: 'phút', unitSec: 'giây',
    errGone: 'Video này vừa được gộp vào mục khác. Hãy bấm nút tải lần nữa.',
    errToken: 'Vexlo từ chối kết nối vì sai mã ghép nối. Dán lại mã trong Tùy chọn của tiện ích.',
  };
  const en = {
    download: 'Download this video', downloadShort: 'Download', sent: 'Added to Vexlo', noApp: 'Cannot reach Vexlo. Please start the app.',
    none: 'No media captured yet. Press play and try again.', title: 'Captured media', close: 'Close',
    connected: 'Connected to Vexlo', disconnected: 'Vexlo is not running', noMediaTab: 'No media found on this tab yet.',
    stream: 'Stream', file: 'File', audio: 'Audio', unknownSize: 'size unknown', openApp: 'Open Vexlo',
    menuLink: 'Download with Vexlo', menuMedia: 'Download media with Vexlo', pausedBrowser: 'Handed back to Firefox because Vexlo is not running',
    save: 'Save', saved: 'Saved', takeover: 'Take over all Firefox downloads', floating: 'Show floating download button on videos',
    enabled: 'Enable extension', port: 'Vexlo port', token: 'Pairing code (only needed if connection fails)',
    exclude: 'Do not take over these sites (one domain per line)', minSize: 'Ignore media smaller than (KB)', minTake: 'Only take over files from (KB)',
    pair: 'Test connection',
    hlsStream: 'HLS stream', dashStream: 'DASH stream', fileWord: 'file', qualityWord: 'quality', liveWord: 'live', drmWord: 'DRM protected',
    unitH: 'h', unitMin: 'min', unitSec: 'sec',
    errGone: 'That item was just merged into another one. Click the download button again.',
    errToken: 'Vexlo refused the connection: wrong pairing code. Paste it again in the extension options.',
  };
  const lang = (typeof navigator !== 'undefined' && navigator.language || 'en').toLowerCase();
  const dict = lang.startsWith('vi') ? vi : en;
  root.t = (k) => dict[k] || en[k] || k;
  root.fmtSize = (n) => {
    if (!n) { return ''; }
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(i > 1 ? 1 : 0) + ' ' + u[i];
  };
}(typeof self !== 'undefined' ? self : this));
