# Vexlo

**English** · [Tiếng Việt](#tiếng-việt)

A fast, free download manager for Windows in the style of IDM. Multi-connection downloads, HLS/DASH video capture, a confirmation window, a small progress window per download, queue, schedule, and a browser extension that grabs videos and takes over browser downloads.

## Features

- **Fast downloads:** multi-connection with dynamic segment splitting, resume, automatic retry, speed limit.
- **Video streams:** HLS (`.m3u8`) and DASH (`.mpd`), AES-128, fMP4, merged to MP4 with ffmpeg. Lists a video with its title, duration and quality like IDM.
- **IDM-style windows:** a compact confirmation window (name, folder, quality, connections) and a small progress window for each download.
- **Queue:** only a few downloads run at once, the rest wait their turn. Right-click a waiting file to download it first or send it to the end.
- **Speed limits:** an overall limit, a separate limit for certain hours of the day (also across midnight) and a limit for each file that can be changed while it downloads.
- **Duplicates:** the same link already in the list is not added twice; a failed earlier attempt of the same file is replaced; a finished file with the same name is kept and the new one is saved as `name (1).ext`.
- **Schedule:** start and stop downloads at set times on chosen days.
- **When everything is finished:** pick shut down, sleep, hibernate or quit once; one 60-second countdown appears after the last file ends (not one prompt per file).
- **Browser extension** for Firefox and Edge/Chrome: floating button on videos, capture list, download takeover, context menu. It pairs with the app automatically (no code to type); each PC has its own pairing code.
- **Verify files:** right-click a finished file to compute its SHA-256 and compare it with the publisher's hash.
- **Copy a link, download it:** optional; copy a file link and Vexlo offers to download it (works without the extension).
- **Quiet start:** start with Windows and stay in the tray without showing the window (optional).
- **Clean uninstall:** removes the app data and registry entries; your downloaded files are never touched.
- **Auto update** from GitHub Releases (can be turned off in Settings), with a "What's new" window after each update.
- Light and dark theme, tray icon, drag and drop or paste links.

## Install (users)

1. Download `Vexlo-Setup-x.y.z.exe` from the **Releases** page and run it.
2. Windows SmartScreen may say "Windows protected your PC" because the installer is not code-signed. Click **More info**, then **Run anyway**.
3. Install the browser extension (see below), open Vexlo once, and it connects by itself.

## Browser extension

- **Firefox:** use the signed `.xpi` from Releases (or the store page), or for a quick test open `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on" and choose `extension/manifest.json` (lost when Firefox closes).
- **Edge / Chrome:** run `node tools/make-edge.js`, open `edge://extensions`, turn on Developer mode, click "Load unpacked" and choose the `extension-edge` folder. After changing code in `extension/`, run the script again and click "Reload".
- After the app has been installed and opened once, the extension reads this PC's port and pairing code through native messaging. If that is not available you can still paste the token in the extension options.

## Build from source (developers)

Requires Windows and Node.js 20+.

```
npm install
npm start          # run the app
npm test           # engine, API and extension tests
npm run dist       # build dist/Vexlo-Setup-x.y.z.exe (also builds the Edge extension folder)
```

Publishing a release to GitHub is described in [`docs/PUBLISHING.en.md`](docs/PUBLISHING.en.md) ([Tiếng Việt](docs/PUBLISHING.md)). In short: set your GitHub name in `package.json`, push the code, then run `npm run ship -- patch "your message"`; it tests, bumps the version, commits, pushes and tags, and the workflow in `.github/workflows/release.yml` builds and publishes the installer with release notes made from your commit messages.

## Security

The local API listens on `127.0.0.1` only, checks the Host header, accepts only extension origins, and requires a token from any other client. The extension may suggest a file name but can never choose the save folder.

## Known limits

- Videos with DRM (Widevine, PlayReady, SAMPLE-AES) cannot be downloaded.
- Live streams (HLS live, DASH dynamic) are not supported yet.
- Sites that need special extractors (YouTube, Facebook, TikTok…) are not supported yet.
- The installer is not code-signed, so SmartScreen shows a warning.

## License

MIT, see [`LICENSE`](LICENSE).

---

# Tiếng Việt

Trình quản lý tải miễn phí cho Windows, kiểu IDM. Tải đa luồng, bắt video HLS/DASH, hộp xác nhận, cửa sổ nhỏ theo dõi tiến độ từng lượt tải, hàng đợi, lịch tải và extension trình duyệt để bắt video và tiếp quản các lần tải của trình duyệt.

## Tính năng

- **Tải nhanh:** nhiều kết nối, chia đoạn động, tải tiếp khi bị ngắt (resume), tự thử lại, giới hạn tốc độ.
- **Video luồng:** HLS (`.m3u8`) và DASH (`.mpd`), AES-128, fMP4, ghép thành MP4 bằng ffmpeg. Hiện từng video kèm tên, thời lượng, chất lượng giống IDM.
- **Cửa sổ kiểu IDM:** hộp xác nhận gọn (tên, thư mục, chất lượng, số kết nối) và cửa sổ nhỏ theo dõi tiến độ cho từng lượt tải.
- **Hàng đợi:** chỉ tải một số tệp cùng lúc, các tệp còn lại chờ đến lượt. Chuột phải vào tệp đang chờ để tải trước hoặc cho xuống cuối.
- **Giới hạn tốc độ:** giới hạn chung, giới hạn riêng cho một khoảng giờ trong ngày (kể cả qua nửa đêm) và giới hạn riêng từng tệp, đổi được cả khi đang tải.
- **Tải trùng:** cùng một link đã có trong danh sách thì không thêm lần hai; lần tải trước của tệp đó bị lỗi thì được thay thế; tệp cùng tên đã tải xong thì giữ lại và bản mới lưu thành `tên (1).đuôi`.
- **Lịch tải:** tự bắt đầu và dừng tải vào giờ, ngày bạn chọn.
- **Khi tải xong hết:** chọn một lần tắt máy, ngủ, ngủ đông hoặc thoát app; chỉ có một lần đếm ngược 60 giây sau tệp cuối cùng (không hỏi từng tệp).
- **Extension** cho Firefox và Edge/Chrome: nút nổi trên video, danh sách video bắt được, tiếp quản tải của trình duyệt, menu chuột phải. Tự ghép nối với app, không cần nhập mã; mỗi máy một mã riêng.
- **Kiểm tra tệp:** chuột phải vào tệp đã tải xong để tính SHA-256 và so với mã của nhà phát hành.
- **Sao chép link là tải:** tùy chọn; chép link file là Vexlo gợi ý tải (không cần extension).
- **Khởi động êm:** chạy cùng Windows nhưng chỉ nằm ở khay, không hiện cửa sổ (tùy chọn).
- **Gỡ cài đặt sạch:** xóa dữ liệu app và các mục registry; tệp bạn đã tải không bao giờ bị xóa.
- **Tự cập nhật** từ GitHub Releases (có thể tắt trong Tùy chọn), có cửa sổ "Có gì mới" sau mỗi lần cập nhật.
- Giao diện sáng/tối, khay hệ thống, kéo thả hoặc dán link.

## Cài đặt (người dùng)

1. Tải `Vexlo-Setup-x.y.z.exe` ở trang **Releases** rồi chạy.
2. Windows SmartScreen có thể báo "Windows protected your PC" vì bộ cài chưa ký số. Bấm **More info**, rồi **Run anyway**.
3. Cài extension cho trình duyệt (xem dưới), mở Vexlo một lần là tự kết nối.

## Extension trình duyệt

- **Firefox:** dùng file `.xpi` đã ký ở Releases (hoặc trang cửa hàng). Thử nhanh: mở `about:debugging#/runtime/this-firefox`, bấm "Load Temporary Add-on" và chọn `extension/manifest.json` (mất khi tắt Firefox).
- **Edge / Chrome:** chạy `node tools/make-edge.js`, mở `edge://extensions`, bật "Chế độ nhà phát triển", bấm "Tải tiện ích đã giải nén" và chọn thư mục `extension-edge`. Sửa code trong `extension/` thì chạy lại script rồi bấm "Tải lại".
- Sau khi đã cài và mở app một lần, extension tự lấy cổng và mã ghép đôi của máy qua native messaging. Nếu không dùng được thì vẫn có thể dán token thủ công trong Tùy chọn của extension.

## Chạy và đóng gói từ mã nguồn (lập trình viên)

Cần Windows và Node.js 20+.

```
npm install
npm start          # chạy app
npm test           # kiểm thử engine, API và extension
npm run dist       # tạo dist/Vexlo-Setup-x.y.z.exe (tự tạo luôn thư mục extension cho Edge)
```

Cách phát hành lên GitHub xem trong [`docs/PUBLISHING.md`](docs/PUBLISHING.md) ([English](docs/PUBLISHING.en.md)). Tóm tắt: điền tên GitHub của bạn trong `package.json`, đẩy code lên, rồi chạy `npm run ship -- patch "nội dung commit"`; lệnh này chạy thử, tăng phiên bản, commit, đẩy code và gắn tag, workflow `.github/workflows/release.yml` tự build, đăng bộ cài kèm ghi chú phát hành tạo từ nội dung commit.

## Bảo mật

API cục bộ chỉ nghe ở `127.0.0.1`, kiểm tra Host, chỉ nhận Origin của extension, và bắt buộc token với client khác. Extension chỉ được gợi ý tên tệp, không được chọn thư mục lưu.

## Giới hạn đã biết

- Video có DRM (Widevine, PlayReady, SAMPLE-AES) không tải được.
- Live stream (HLS live, DASH dynamic) chưa hỗ trợ.
- Các trang cần bộ trích xuất riêng (YouTube, Facebook, TikTok…) chưa hỗ trợ.
- Bộ cài chưa ký số nên SmartScreen hiện cảnh báo.

## Giấy phép

MIT, xem [`LICENSE`](LICENSE).
