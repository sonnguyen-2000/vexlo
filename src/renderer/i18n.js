/* Tiny i18n layer. The app is written in Vietnamese, so the Vietnamese text IS the key; English is looked up in EN.
 * tr('Xóa {n} mục', {n: 3}) -> "Delete 3 items" when the language is English, otherwise the Vietnamese text with {n} filled in.
 * The language comes from the page address (?lang=en|vi), set by the main process from Settings > Language. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else {
    root.I18N = factory();
    root.I18N.initFromLocation(root.location);
    root.I18N.applyDom(root.document); // scripts sit at the end of <body>, so the static text is already there
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EN = {
    // ---- toolbar, sidebar, table
    'Thêm link (Ctrl+N)': 'Add link (Ctrl+N)', 'Thêm link': 'Add link', 'Tiếp tục': 'Resume', 'Tạm dừng': 'Pause',
    'Dừng tất cả': 'Pause all', 'Xóa (Delete)': 'Delete (Del)', 'Xóa': 'Delete',
    'Xóa các tải bị lỗi (chưa tải thành công) khỏi danh sách': 'Remove failed downloads from the list', 'Xóa lỗi': 'Clear failed',
    'Xóa các tệp đã tải xong khỏi danh sách': 'Remove finished downloads from the list', 'Xóa đã xong': 'Clear finished',
    'Tùy chọn': 'Settings', 'Tìm tệp…': 'Search files…', 'Chưa có tệp nào': 'No files yet', 'Không có tệp phù hợp': 'No matching files',
    'Dán link bằng': 'Paste a link with', ', kéo thả link vào đây, hoặc dùng tiện ích Vexlo trên Firefox để tự bắt video và tệp tải.': ', drag a link here, or use the Vexlo browser extension to capture videos and files automatically.',
    'Dán link bằng <kbd>Ctrl</kbd> + <kbd>V</kbd>, kéo thả link vào đây, hoặc dùng tiện ích Vexlo trên Firefox để tự bắt video và tệp tải.': 'Paste a link with <kbd>Ctrl</kbd> + <kbd>V</kbd>, drag a link here, or use the Vexlo browser extension to capture videos and files automatically.',
    'Thử đổi bộ lọc hoặc từ khóa tìm kiếm.': 'Try another filter or search term.',
    'Chỉ chọn một lần: khi tệp cuối cùng tải xong sẽ hiện đếm ngược 60 giây rồi mới thực hiện': 'Choose once: after the last file finishes, a 60-second countdown appears before the action runs',
    'Khi tải xong hết:': 'When all done:', 'Khi tải xong hết': 'When all downloads finish', 'Không làm gì': 'Do nothing', 'Tắt máy': 'Shut down',
    'Ngủ': 'Sleep', 'Ngủ đông': 'Hibernate', 'Thoát Vexlo': 'Quit Vexlo', 'Trình duyệt': 'Browser',
    'Trạng thái': 'Status', 'Loại tệp': 'File type', 'Tất cả': 'All', 'Đang tải': 'Downloading', 'Chưa xong': 'Unfinished', 'Đã xong': 'Finished',
    'Tên tệp': 'File name', 'Dung lượng': 'Size', 'Tiến độ': 'Progress', 'Còn lại': 'Remaining', 'Tốc độ': 'Speed', 'Thêm lúc': 'Added',
    'Video': 'Video', 'Âm thanh': 'Audio', 'Nén': 'Archives', 'Chương trình': 'Programs', 'Tài liệu': 'Documents', 'Khác': 'Other',
    // ---- add-link dialog
    'Thêm link tải': 'Add download links', 'Link (mỗi dòng một link)': 'Links (one per line)', 'https://… (hỗ trợ tệp thường, .m3u8, .mpd)': 'https://… (regular files, .m3u8, .mpd)',
    'Tên tệp (không bắt buộc)': 'File name (optional)', 'Tự lấy từ máy chủ': 'Taken from the server', 'Lưu vào': 'Save to',
    'Tự phân loại theo loại tệp': 'Sort into folders by file type', 'Chọn…': 'Browse…', 'Số kết nối': 'Connections',
    'Chất lượng (video luồng)': 'Quality (streaming video)', 'Cao nhất': 'Best', 'Tối đa 1080p': 'Up to 1080p', 'Tối đa 720p': 'Up to 720p',
    'Tối đa 480p': 'Up to 480p', 'Tối đa 360p': 'Up to 360p', 'Thấp nhất': 'Lowest', 'Hủy': 'Cancel', 'Tải sau': 'Download later', 'Bắt đầu tải': 'Start download', 'Đóng': 'Close',
    // ---- ask dialog
    'Xóa luôn tệp đã tải trên ổ đĩa': 'Also delete the downloaded files from disk', 'Không thể khôi phục. Bỏ chọn để chỉ xóa khỏi danh sách và giữ lại tệp.': 'This cannot be undone. Untick to only remove from the list and keep the files.',
    'Ghi nhớ lựa chọn này, không hỏi lại': 'Remember this choice, do not ask again', 'Có thể đổi lại trong Tùy chọn › Chung.': 'You can change this in Settings › General.', 'Đồng ý': 'OK',
    // ---- settings
    'Chung': 'General', 'Tải xuống': 'Downloads', 'Lịch tải': 'Schedule',
    'Ngôn ngữ': 'Language', 'Tự động (theo hệ thống)': 'Automatic (follow system)', 'Tiếng Việt': 'Vietnamese', 'English': 'English',
    'Áp dụng sau khi bấm Lưu': 'Applied after you press Save',
    'Thư mục tải mặc định': 'Default download folder', 'Tự phân loại vào thư mục con': 'Sort into sub-folders automatically',
    'Hiện hộp thoại xác nhận khi bắt được link từ trình duyệt': 'Show the confirmation window when a link comes from the browser',
    'Giống IDM: cho phép đổi tên, thư mục, chất lượng trước khi tải': 'Like IDM: lets you change the name, folder and quality before downloading',
    'Khi xóa một mục đã tải xong': 'When deleting a finished item', 'Luôn hỏi tôi (có thể chọn xóa luôn tệp)': 'Always ask me (with an option to delete the file)',
    'Chỉ xóa khỏi danh sách, giữ lại tệp': 'Only remove from the list, keep the file', 'Xóa cả tệp trên ổ đĩa': 'Also delete the file from disk',
    'Mục chưa tải xong thì chỉ xóa dữ liệu tải dở của chính nó.': 'For unfinished items only their partial data is deleted.',
    'Hiện cửa sổ nhỏ theo dõi tiến độ khi bắt đầu tải': 'Show a small progress window when a download starts',
    'Giống IDM: tốc độ, thời gian còn lại, tạm dừng/hủy ngay trên cửa sổ đó': 'Like IDM: speed, time left, pause/cancel right in that window',
    'Cửa sổ tiến độ nổi lên trên các ứng dụng khác lúc bắt đầu tải': 'Progress window pops up above other apps when a download starts',
    'Hiện nổi bật vài giây cho bạn biết, sau đó ứng dụng khác có thể che lên. Tắt để chạy âm thầm': 'Stays on top for a few seconds so you notice it, then other windows can cover it. Turn off to run quietly',
    'Khi tải bị lỗi, cửa sổ tiến độ': 'When a download fails, the progress window', 'Hỏi tôi một lần': 'Ask me once', 'Giữ lại hiển thị lỗi': 'Stays and shows the error', 'Tự đóng': 'Closes itself',
    'Thông báo khi tải xong': 'Notify when a download finishes', 'Đóng cửa sổ thì thu nhỏ xuống khay hệ thống': 'Closing the window minimizes to the system tray',
    'Để Vexlo tiếp tục bắt link từ trình duyệt': 'Lets Vexlo keep capturing links from the browser', 'Tự kiểm tra bản cập nhật mới': 'Check for updates automatically',
    'Lấy từ trang phát hành của dự án trên GitHub': 'Taken from the project releases page on GitHub', 'Chạy cùng Windows': 'Start with Windows',
    'Số kết nối mỗi tệp (1–32)': 'Connections per file (1–32)', '8 là mức cân bằng. Một số máy chủ chặn khi quá nhiều kết nối.': '8 is a good balance. Some servers block too many connections.',
    'Số tệp tải cùng lúc (1–10)': 'Simultaneous downloads (1–10)',
    'Các tệp còn lại xếp hàng chờ, tải xong tệp nào thì tệp tiếp theo tự bắt đầu. Ít tệp cùng lúc thì mỗi tệp nhanh hơn.': 'The other files wait in the queue and start as soon as one finishes. Fewer at once means each one is faster.',
    'Giới hạn tốc độ (KB/s, 0 = không giới hạn)': 'Speed limit (KB/s, 0 = unlimited)', 'Áp dụng cho tổng tốc độ của mọi tệp.': 'Applies to the total speed of all files.',
    'Bật lịch tải': 'Enable schedule',
    'Đến giờ bắt đầu, mọi tệp đang tạm dừng (ví dụ chọn "Tải sau") sẽ tự tải. Đến giờ dừng, các tệp đang tải được tạm dừng.': 'At the start time, every paused file (for example those set to "Download later") starts. At the stop time, running downloads are paused.',
    'Bắt đầu lúc': 'Start at', 'Dừng lúc (có thể để trống)': 'Stop at (optional)', 'Các ngày trong tuần': 'Days of the week',
    'Muốn tắt máy sau khi tải xong, chọn "Khi tải xong hết" ở thanh dưới cùng của cửa sổ chính. App cần đang chạy (có thể thu nhỏ xuống khay) đúng giờ hẹn.': 'To shut down after downloads finish, use "When all done" in the bottom bar of the main window. The app must be running (it can sit in the tray) at the scheduled time.',
    'Cổng kết nối': 'Connection port', 'Mã ghép nối': 'Pairing code', 'Chép': 'Copy', 'Cài tiện ích Firefox': 'Install the Firefox extension', 'Mở thư mục tiện ích': 'Open extension folder',
    'Mở Firefox, vào': 'Open Firefox and go to', 'Chọn': 'Click', 'Tải tiện ích tạm thời…': 'Load Temporary Add-on…', 'và chọn tệp': 'and choose the file', 'trong thư mục vừa mở': 'in the folder that just opened',
    'Nếu tiện ích báo không kết nối được, dán mã ghép nối ở trên vào trang cài đặt của tiện ích': 'If the extension says it cannot connect, paste the pairing code above into the extension settings page',
    'Lưu': 'Save', 'Thả link vào đây để tải': 'Drop links here to download',
    // ---- status bar / toasts / main window
    'Số tệp đang tải / số tệp tối đa tải cùng lúc': 'Active downloads / maximum at the same time',
    '{n} đang tải': '{n} active', '{n} đang chờ': '{n} waiting', '{n} tệp': '{n} files', 'Giới hạn: {v}/s': 'Limit: {v}/s',
    '. {n} tệp đang xếp hàng, sẽ tự tải khi có chỗ trống.': '. {n} files are queued and will start when a slot is free.',
    'Trình duyệt: sẵn sàng': 'Browser: ready', 'Trình duyệt: chưa kết nối': 'Browser: not connected', 'Đang lắng nghe cổng {port}': 'Listening on port {port}', 'Chưa sẵn sàng': 'Not ready',
    '(ước tính)': '(estimated)', 'Xóa lỗi ({n})': 'Clear failed ({n})',
    'Xóa kèm tệp': 'Delete with files', 'Xóa cả tệp': 'Delete files too',
    'Xóa {n} mục khỏi danh sách và xóa luôn {m} tệp đã tải trên ổ đĩa? Không thể khôi phục.': 'Remove {n} items from the list and also delete {m} downloaded files from disk? This cannot be undone.',
    ' {n} mục chưa tải xong sẽ bị xóa dữ liệu tải dở.': ' {n} unfinished items will have their partial data deleted.',
    'Xóa {n} mục': 'Delete {n} items', 'Xóa mục này': 'Delete this item', 'Xóa {n} mục khỏi danh sách tải?': 'Remove {n} items from the download list?',
    'Đã lưu lựa chọn. Đổi lại trong Tùy chọn › Chung.': 'Choice saved. Change it in Settings › General.', 'Xóa khỏi danh sách': 'Remove from list',
    'Xóa {n} mục khỏi danh sách{extra}?': 'Remove {n} items from the list{extra}?', ' và xóa luôn tệp đã tải': ' and delete the downloaded files', ' (giữ lại tệp đã tải)': ' (keeping the downloaded files)',
    'Mở tệp': 'Open file', 'Mở thư mục chứa tệp': 'Show in folder', 'Sao chép link': 'Copy link', 'Đã sao chép link': 'Link copied', 'Mở trang web gốc': 'Open original web page',
    'Không có địa chỉ trang gốc': 'No original page address', 'Xóa khỏi danh sách (giữ tệp)': 'Remove from list (keep file)', 'Xóa kèm tệp trên ổ đĩa…': 'Delete with file on disk…',
    '{n} link không hợp lệ': '{n} invalid links', 'Đã thêm {n} tệp': 'Added {n} files', 'Đã thêm {n} tệp (chưa tải)': 'Added {n} files (not started)',
    'Đã chép mã ghép nối': 'Pairing code copied', 'Không chép được': 'Could not copy', 'Đã lưu tùy chọn': 'Settings saved', 'Đã xóa {n} tải bị lỗi': 'Removed {n} failed downloads',
    'Đã xóa các tệp đã xong khỏi danh sách': 'Finished files removed from the list',
    'Sẽ thực hiện khi tệp cuối cùng tải xong (có đếm ngược 60 giây để hủy)': 'Will run when the last file finishes (with a 60-second countdown to cancel)',
    'Cập nhật': 'Updates', 'Kiểm tra cập nhật': 'Check for updates', 'Đang kiểm tra…': 'Checking…',
    'Bạn đang dùng bản mới nhất ({v})': 'You are on the latest version ({v})', 'Đang tải bản {v}…': 'Downloading version {v}…',
    'Đã tải bản {v}. Bấm để khởi động lại và cập nhật.': 'Version {v} is ready. Click to restart and update.', 'Khởi động lại để cập nhật': 'Restart to update',
    'Không kiểm tra được: {e}': 'Could not check: {e}', 'Bản chạy từ mã nguồn không tự cập nhật.': 'A build run from source does not update itself.',
    'Vexlo đang cập nhật': 'Vexlo is updating', 'Đang cập nhật lên bản {v}. Vexlo sẽ tự khởi động lại sau vài giây.': 'Updating to version {v}. Vexlo will restart by itself in a few seconds.',
    'Vexlo đã được cập nhật lên bản {v}.': 'Vexlo has been updated to version {v}.',
    'Cập nhật Vexlo': 'Vexlo update', 'Đang tải bản cập nhật {v}': 'Downloading update {v}', 'Bạn vẫn dùng Vexlo bình thường trong lúc tải.': 'You can keep using Vexlo while it downloads.',
    'Đã tải xong bản {v}': 'Version {v} downloaded', 'Vexlo sẽ cài và khởi động lại khi các tệp đang tải xong.': 'Vexlo will install it and restart when your current downloads finish.',
    'Đang cài bản {v}': 'Installing version {v}', 'Vexlo sẽ tự đóng rồi mở lại sau khoảng một phút. Đây là bình thường, bạn không cần làm gì.': 'Vexlo will close and reopen by itself in about a minute. This is normal, you do not need to do anything.',
    'Đang cài bản {v}. Vexlo sẽ tự mở lại sau khoảng một phút, bạn không cần làm gì.': 'Installing version {v}. Vexlo will reopen by itself in about a minute, you do not need to do anything.',
    // ---- progress window
    'Đã tải': 'Downloaded', 'Tải bị lỗi.': 'Download failed.', 'Lần sau khi tải lỗi:': 'Next time a download fails:', 'Giữ cửa sổ': 'Keep window', 'Tự đóng khi xong': 'Close when finished',
    'Hủy tải': 'Cancel download', 'Ẩn': 'Hide', 'Mở thư mục': 'Open folder', 'Đã tải xong': 'Download complete', 'Tất cả tệp đã tải xong.': 'All files have finished downloading.', 'Thực hiện ngay': 'Do it now',
    'Tải bị lỗi: {e}': 'Download failed: {e}', 'không rõ nguyên nhân': 'unknown cause', 'Thiếu cầu nối với ứng dụng (preload).': 'The bridge to the app is missing (preload).',
    'Máy sẽ tắt sau ': 'The PC will shut down in ', 'Máy sẽ chuyển sang chế độ ngủ sau ': 'The PC will go to sleep in ', 'Máy sẽ ngủ đông sau ': 'The PC will hibernate in ', 'Vexlo sẽ thoát sau ': 'Vexlo will quit in ',
    ' giây.': ' seconds.',
    // ---- confirm window
    'Thông tin tải xuống': 'Download info', 'Tự động theo máy chủ': 'Automatic (from server)', 'Chọn thư mục khác': 'Choose another folder', 'Chất lượng video': 'Video quality', 'Kết nối': 'Connections',
    'Lần sau tải ngay, không hiện hộp thoại này. Bật lại trong Tùy chọn.': 'Next time download immediately without this window. Turn it back on in Settings.', 'Không hỏi lại': "Don't ask again", 'Tải ngay': 'Download now',
    'Tải song song và ghép thành MP4': 'Downloaded in parallel and merged into MP4', 'Đang kiểm tra liên kết…': 'Checking the link…', 'Chưa kiểm tra được liên kết': 'Could not check the link',
    'Hỗ trợ tải tiếp, nhiều kết nối': 'Resume supported, multiple connections', 'Không hỗ trợ tải tiếp, dùng 1 kết nối': 'Resume not supported, using 1 connection',
    '{e}. Bạn vẫn có thể thử tải.': '{e}. You can still try to download.', 'Bản tải lỗi trước đó của tệp này sẽ được thay thế.': 'The earlier failed download of this file will be replaced.',
    'Không tìm thấy tác vụ tải này. Có thể nó đã bị hủy.': 'This download was not found. It may have been cancelled.', 'Luồng HLS': 'HLS stream', 'Luồng DASH': 'DASH stream',
    // ---- statuses
    'Hoàn tất': 'Complete', 'Lỗi': 'Error', 'Đang chờ trong hàng đợi': 'Waiting in the queue', 'Đã dừng': 'Paused', 'Chưa bắt đầu': 'Not started',
    '{a}/{b} đoạn': '{a}/{b} segments', '{n} kết nối': '{n} connections', 'Đang chuẩn bị': 'Preparing', 'Đang ghép các đoạn': 'Joining segments', 'Đang xuất MP4': 'Writing MP4',
    '{d} ngày {h} giờ': '{d}d {h}h', '{h} giờ {m} phút': '{h}h {m}m', '{m} phút {s} giây': '{m}m {s}s', '{s} giây': '{s}s',
    'Hôm nay {t}': 'Today {t}', 'Hôm qua {t}': 'Yesterday {t}',
    // ---- engine errors
    'Body quá lớn': 'Body too large', 'JSON không hợp lệ': 'Invalid JSON', 'Không phải manifest DASH hợp lệ': 'Not a valid DASH manifest',
    'Luồng trực tiếp (live DASH) chưa được hỗ trợ': 'Live DASH streams are not supported yet', 'Manifest không có Period': 'Manifest has no Period',
    'Manifest thiếu thông tin thời lượng segment': 'Manifest is missing segment duration info', 'Kết nối bị ngắt sớm': 'Connection closed early',
    'Máy chủ bỏ qua Range': 'The server ignored Range', 'Content-Range không khớp': 'Content-Range mismatch', 'Tệp tải về chưa đủ dung lượng': 'The downloaded file is smaller than expected',
    'Không phải playlist M3U8 hợp lệ': 'Not a valid M3U8 playlist', 'Video được bảo vệ DRM / mã hóa SAMPLE-AES, không thể tải': 'The video is DRM protected / SAMPLE-AES encrypted and cannot be downloaded',
    'Kiểu mã hóa ': 'Unsupported encryption: ', 'URL không hợp lệ': 'Invalid URL', 'Giao thức không hỗ trợ': 'Unsupported protocol', 'Quá nhiều chuyển hướng': 'Too many redirects',
    'Playlist không có luồng video nào': 'The playlist has no video stream', 'Đây là luồng trực tiếp (live), chưa được hỗ trợ': 'This is a live stream, which is not supported yet', 'Playlist rỗng': 'Empty playlist',
    'Video được bảo vệ DRM, không thể tải': 'The video is DRM protected and cannot be downloaded', 'Manifest không có luồng video/audio nào': 'The manifest has no video/audio stream',
    'Không tải được luồng DASH': 'Could not download the DASH stream', 'ffmpeg lỗi': 'ffmpeg error', 'Cần cài ffmpeg để ghép video và âm thanh (đặt ffmpeg.exe vào PATH)': 'ffmpeg is needed to join video and audio (put ffmpeg.exe on PATH)',
    // ---- main process
    'Mở Vexlo': 'Open Vexlo', 'Tạm dừng tất cả': 'Pause all', 'Tiếp tục tất cả': 'Resume all', 'Thoát': 'Quit',
    'Cổng {port} đang được chương trình khác dùng': 'Port {port} is used by another program',
    'Tệp "{f}" đã có trong thư mục này. Bản mới sẽ được lưu thành "{alt}".': 'The file "{f}" already exists in this folder. The new one will be saved as "{alt}".',
    'Đã có trong danh sách tải: {f}': 'Already in the download list: {f}', 'Không tìm thấy tệp (có thể đã bị xóa hoặc di chuyển)': 'File not found (it may have been deleted or moved)',
    'Lịch tải: bắt đầu': 'Schedule: started', 'Đang tải {n} tệp đã hẹn.': 'Downloading {n} scheduled files.', 'Không có tệp nào đang chờ.': 'No files are waiting.',
    'Lịch tải: đã dừng': 'Schedule: stopped', 'Các tệp đang tải được tạm dừng theo giờ đã hẹn.': 'Running downloads were paused at the scheduled time.',
  };

  let lang = 'vi';
  function setLang(l) { lang = l === 'en' ? 'en' : 'vi'; }
  function getLang() { return lang; }
  function fill(s, vars) { return vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : String(s); }
  function lookup(key) {
    if (Object.prototype.hasOwnProperty.call(EN, key)) { return EN[key]; }
    // "Message: detail" (e.g. engine errors carrying a URL or a code): translate the head only.
    const i = String(key).indexOf(': ');
    if (i > 0) { const h = key.slice(0, i); if (Object.prototype.hasOwnProperty.call(EN, h)) { return EN[h] + key.slice(i); } }
    return key;
  }
  function tr(key, vars) { return fill(lang === 'en' ? lookup(key) : key, vars); }

  /** Translate static text of a document (text nodes + title/placeholder/aria-label) in place. */
  function applyDom(doc) {
    if (lang !== 'en' || !doc) { return; }
    const walker = doc.createTreeWalker(doc.body, 4 /* SHOW_TEXT */);
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) { nodes.push(n); }
    for (const n of nodes) {
      const raw = n.nodeValue; const key = raw.replace(/\s+/g, ' ').trim();
      if (!key || !Object.prototype.hasOwnProperty.call(EN, key)) { continue; }
      n.nodeValue = raw.replace(key, EN[key]);
    }
    for (const el of doc.querySelectorAll('[title],[placeholder],[aria-label]')) {
      for (const a of ['title', 'placeholder', 'aria-label']) {
        const v = el.getAttribute(a);
        if (v && Object.prototype.hasOwnProperty.call(EN, v.trim())) { el.setAttribute(a, EN[v.trim()]); }
      }
    }
    if (doc.title && Object.prototype.hasOwnProperty.call(EN, doc.title)) { doc.title = EN[doc.title]; }
    doc.documentElement.lang = 'en';
  }

  function initFromLocation(loc) {
    try { setLang(new URLSearchParams(loc.search).get('lang')); } catch { setLang('vi'); }
  }

  return { EN, tr, setLang, getLang, applyDom, initFromLocation };
}));
