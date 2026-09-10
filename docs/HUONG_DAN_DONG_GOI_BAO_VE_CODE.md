# Hướng dẫn đóng gói và bảo vệ code

Tài liệu này là checklist bắt buộc khi sửa `scripts/obfuscate.js`, thêm automation
trình duyệt hoặc tạo bản bàn giao mới.

## Vì sao cần cấu hình riêng

Puppeteer chuyển callback của các API như `page.evaluate()` từ Node.js sang
Chromium để chạy trong context của trang web. Callback đó không còn truy cập
được biến, hàm giải mã hoặc bảng chuỗi nằm trong module Node.js.

Hai phép biến đổi sau của `javascript-obfuscator` có thể tạo phụ thuộc bên ngoài
callback:

- `stringArray`
- `controlFlowFlattening`

Triệu chứng thường gặp trong bản phát hành:

- source chạy đúng nhưng bản trong `dist` trả dữ liệu rỗng;
- lỗi `_0x... is not defined`;
- lỗi bị `.catch(() => '')`, `.catch(() => [])` hoặc `.catch(() => false)` che đi;
- tool báo không tìm thấy nút, profile, Fanpage hoặc kênh dù phần tử đang hiển thị.

## Quy tắc bắt buộc

`scripts/obfuscate.js` tự quét nội dung từng file. Nếu file Node.js sử dụng một
trong các API chạy callback ở Chromium, script phải tắt `stringArray` và
`controlFlowFlattening` cho toàn bộ file đó:

- `evaluate`
- `evaluateHandle`
- `evaluateOnNewDocument`
- `waitForFunction`
- `$eval`
- `$$eval`
- `addInitScript`

Không thay cơ chế tự phát hiện bằng danh sách adapter viết tay. Service mới cũng
có thể sử dụng Puppeteer và sẽ gặp đúng lỗi này.

Các lớp bảo vệ còn lại vẫn được giữ: làm gọn code, đổi tên identifier, biến đổi
số và object key. Agent Kit/MCP tiếp tục được đóng thành bytecode `.jsc`.

## Khi thêm API mới

Nếu thêm một API khác có chức năng chuyển callback sang browser, phải:

1. Bổ sung API đó vào `REMOTE_BROWSER_CALLBACK_PATTERN`.
2. Bổ sung trường hợp kiểm thử trong
   `tests/obfuscation-browser-callbacks.test.js`.
3. Chạy toàn bộ test và kiểm tra bản bảo vệ, không chỉ chạy source.

Callback truyền vào browser phải tự chứa toàn bộ logic cần thiết. Không tham
chiếu biến hoặc helper nằm ngoài callback, kể cả khi source chưa báo lỗi.

## Checklist phát hành

Chạy theo thứ tự:

```powershell
npm test
.\build.bat
npm run verify:release
```

`build.bat` đã tự chạy `npm run build:release`; không cần chạy lại riêng khi
đóng gói đầy đủ.

Chỉ phát hành khi:

- toàn bộ test đạt;
- `verify:release` báo protected build healthy;
- test callback bảo vệ đạt;
- kiểm tra callback trực tiếp trên các module trong `dist` đạt;
- chạy thử ít nhất một luồng browser trên chính
  `dist\desktop_launcher.dist`, không chạy bằng source;
- không có lỗi `_0x... is not defined` trong log;
- bộ cài, ZIP bàn giao và file trên Drive có SHA-256 khớp.

Không copy riêng source chưa bảo vệ vào `dist` để chữa tạm. Mọi thay đổi phải đi
qua `build:release` để bản GitHub, bộ cài và Drive chứa cùng một trạng thái code.
