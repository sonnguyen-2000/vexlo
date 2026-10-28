# Đưa Vexlo lên GitHub và phát hành bản cài đặt

Hướng dẫn cho Windows, người mới dùng Git. Làm lần lượt từ trên xuống. Dự án đã có sẵn `.gitignore`, `LICENSE` (MIT)
và workflow tự build bản cài khi bạn đẩy một "tag" phiên bản (`.github/workflows/release.yml`).

## 0. Chuẩn bị (một lần)

1. Cài **Git for Windows**: https://git-scm.com/download/win (cứ bấm Next).
2. Tạo tài khoản https://github.com (nếu chưa có).
3. Cài **GitHub CLI** để đăng nhập cho dễ: https://cli.github.com, rồi mở PowerShell gõ:
   ```
   gh auth login
   ```
   Chọn GitHub.com, HTTPS, "Login with a web browser" và làm theo hướng dẫn.
4. Cho Git biết bạn là ai:
   ```
   git config --global user.name "Tên của bạn"
   git config --global user.email "email-ban-dung-tren-github@example.com"
   ```

## 1. Đặt tên và sửa thông tin dự án

Tìm trên GitHub xem tên `vexlo` đã có ai dùng chưa (https://github.com/search?q=vexlo&type=repositories). Nếu trùng, đổi tên mới ở mọi nơi bên dưới.

Sửa 3 chỗ trong `package.json` (thay `YOUR_GITHUB_USERNAME` bằng tên tài khoản GitHub của bạn, `YOUR_NAME` bằng tên bạn):

- `"author"`, `"homepage"`, `"repository"` (phần đầu file)
- `"build"` › `"publish"` › `"owner"` và `"repo"`

Sửa luôn `YOUR_NAME` trong file `LICENSE`.

> `owner` và `repo` phải đúng thật, vì app dùng chúng để tìm bản cập nhật mới.

## 2. Tạo repository và đẩy code lên

Trong thư mục dự án (PowerShell hoặc terminal của VS Code):

```
npm install
git init -b main
git add .
git commit -m "Vexlo 0.1.0"
gh repo create vexlo --public --source . --remote origin --push
```

- `npm install` tạo file `package-lock.json`, hãy để nó được commit cùng.
- Lệnh `gh repo create` tạo repo public tên `vexlo` trên tài khoản của bạn và đẩy toàn bộ code lên. Mở trang repo để kiểm tra.
- Không bị đẩy lên: `node_modules/`, `dist/`, `extension-edge/` (đã nằm trong `.gitignore`).

Nếu bạn thích giao diện đồ họa, dùng **GitHub Desktop** (https://desktop.github.com): "Add local repository" › "Publish repository".

## 3. Phát hành bản đầu tiên

Mỗi bản phát hành làm đúng 4 bước:

1. Sửa số phiên bản `"version"` trong `package.json` (ví dụ `0.1.0`). Bản sau phải **lớn hơn** bản trước.
2. Commit và đẩy:
   ```
   git add .
   git commit -m "Phát hành 0.1.0"
   git push
   ```
3. Gắn tag trùng số phiên bản, có chữ `v` ở đầu, rồi đẩy tag lên:
   ```
   git tag v0.1.0
   git push origin v0.1.0
   ```
4. Vào tab **Actions** của repo, workflow "Release" sẽ chạy khoảng 5–10 phút. Xong thì vào tab **Releases** sẽ thấy:
   - `Vexlo-Setup-0.1.0.exe`: bộ cài cho Windows
   - `latest.yml` và `*.blockmap`: file để app tự cập nhật (đừng xóa)
   - `Vexlo-firefox-extension.zip`, `Vexlo-edge-extension.zip`: extension

Nếu workflow báo lỗi đỏ, bấm vào lần chạy đó để xem dòng lỗi (thường là sai `owner`/`repo`, hoặc thiếu `package-lock.json`).

Muốn tự build trên máy bạn (không qua GitHub): `npm run dist`. File nằm ở `dist\`.

## 4. Người dùng cài đặt và tự cập nhật

- Người dùng tải `Vexlo-Setup-x.y.z.exe` ở trang Releases rồi chạy.
- Do bộ cài **chưa ký số**, Windows SmartScreen sẽ hiện "Windows protected your PC": bấm **More info** › **Run anyway**.
  Hãy ghi rõ điều này trong README của repo để mọi người không hoảng.
- Từ lúc cài, app tự kiểm tra bản mới trên GitHub Releases khi mở và mỗi 6 giờ. Có bản mới thì tải ngầm và cài khi thoát app.
  Người dùng tắt được ở Tùy chọn › Chung › "Tự kiểm tra bản cập nhật mới".
- Muốn ký số miễn phí cho dự án mã nguồn mở, xem chương trình **SignPath Foundation** (https://signpath.org). Không bắt buộc.

## 5. Đưa extension lên cửa hàng (để cài một lần bấm)

### Firefox (addons.mozilla.org, miễn phí)

1. Đăng nhập https://addons.mozilla.org/developers/ › **Submit a New Add-on**.
2. Chọn **On your own** (tự phân phối, được ký nhanh, không công khai trên cửa hàng) hoặc **On this site** (công khai, duyệt lâu hơn).
3. Tải lên `Vexlo-firefox-extension.zip` (lấy từ trang Releases). Bên trong phải có `manifest.json` ở gốc file nén: nếu Mozilla báo
   không thấy, nén lại **nội dung** thư mục `extension` chứ không nén cả thư mục.
4. Khi được duyệt, tải file `.xpi` đã ký về, đính kèm vào Release (hoặc để người dùng cài trực tiếp từ trang cửa hàng).
5. Người dùng kéo file `.xpi` vào Firefox để cài.

### Edge (Microsoft Edge Add-ons, miễn phí)

1. Đăng ký nhà phát triển tại https://partner.microsoft.com/dashboard/microsoftedge (miễn phí).
2. **Create new extension** › tải lên `Vexlo-edge-extension.zip`.
3. **Quan trọng:** sau khi được duyệt, Edge cấp cho extension một **ID mới**. Mở `src/main/main.js`, tìm `CHROMIUM_EXT_IDS`
   và thêm ID đó vào mảng, rồi phát hành bản mới của app. Nếu không, app sẽ không tự ghép nối với extension cài từ cửa hàng.

### Chrome (tùy chọn)

Chrome Web Store thu phí đăng ký nhà phát triển một lần khoảng 5 USD. Dùng chung `Vexlo-edge-extension.zip` và làm tương tự Edge (cũng thêm ID vào `CHROMIUM_EXT_IDS`).

## 6. Danh sách kiểm tra mỗi lần ra bản mới

- [ ] `npm test` chạy xong không lỗi
- [ ] Tăng `"version"` trong `package.json`
- [ ] Ghi chú thay đổi (tùy chọn): sửa phần mô tả của Release trên GitHub sau khi workflow xong
- [ ] `git commit` › `git push` › `git tag vX.Y.Z` › `git push origin vX.Y.Z`
- [ ] Cài thử bản mới lên máy sạch, kiểm tra: tải được, extension tự ghép nối, gỡ cài đặt xóa sạch dữ liệu

## 7. Lỗi thường gặp

| Hiện tượng | Cách xử lý |
|---|---|
| `git push` bị từ chối đăng nhập | Chạy lại `gh auth login` |
| Workflow lỗi `npm ci` hoặc thiếu lockfile | Chạy `npm install` rồi commit file `package-lock.json` |
| Release không có `latest.yml` | Workflow chưa chạy xong hoặc lỗi. Mở tab Actions để xem |
| App không thấy bản cập nhật | Kiểm tra `owner`/`repo` trong `package.json` và số version bản mới có lớn hơn bản đang cài |
| Tag đã đẩy nhưng muốn làm lại | `git tag -d v0.1.0`, `git push origin :refs/tags/v0.1.0`, xóa Release trên GitHub rồi tag lại |
