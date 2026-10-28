# Vexlo — trình quản lý tải kiểu IDM

Engine tải đa luồng (chia đoạn động, resume, tự thử lại, giới hạn tốc độ), tải HLS/m3u8 + DASH
(AES-128, fMP4, ghép bằng ffmpeg), giao diện kiểu IDM (hộp xác nhận, danh mục, khay hệ thống)
và extension Firefox (bắt video, nút nổi trên video, tiếp quản download của Firefox).

## Chạy thử (Windows)
1. Cài Node.js 20+ (https://nodejs.org).
2. Trong thư mục này: `npm install` rồi `npm start`.
3. Tạo bộ cài: `npm run dist` (ra file .exe trong thư mục `dist/`).
4. Chạy kiểm thử engine/extension: `npm test`.

## Cài extension vào Firefox
- Thử nhanh: mở `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" → chọn `extension/manifest.json`
  (mất khi tắt Firefox).
- Dùng lâu dài: ký extension miễn phí (chế độ "unlisted") tại addons.mozilla.org, hoặc dùng Firefox Developer/Nightly
  và đặt `xpinstall.signatures.required = false`.
- Sau khi cài app bằng bộ cài, extension tự lấy cổng + mã ghép đôi riêng của máy đó (native messaging), không cần nhập tay. Nếu chạy `npm start` mà chưa từng cài, mở app một lần là đủ; vẫn có thể dán token thủ công trong Tùy chọn extension.

## Extension cho Edge / Chrome
- Chạy `node tools/make-edge.js` (đã tạo sẵn thư mục `extension-edge/`). Mở `edge://extensions` → bật "Chế độ nhà phát triển" → "Tải tiện ích đã giải nén" → chọn thư mục `extension-edge`.
- ID extension cố định (`tools/edge-id.txt`), nên sau khi mở app một lần, extension tự lấy cổng + mã ghép đôi của máy đó qua native messaging.
- Sửa code trong `extension/` rồi chạy lại `node tools/make-edge.js` và bấm "Tải lại" ở trang extensions.

## Bảo mật
API cục bộ chỉ nghe ở 127.0.0.1, kiểm tra Host, chỉ nhận Origin của extension, và bắt buộc token với client khác.
Extension chỉ được gợi ý tên file, không được chọn thư mục lưu.

## Giới hạn đã biết
- Video có DRM (Widevine/PlayReady/SAMPLE-AES) không tải được.
- Live stream (HLS live, DASH dynamic) chưa hỗ trợ.
- Giao diện Electron chưa được chạy thử bằng người thật; các phần lõi và extension có kiểm thử tự động.
