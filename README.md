# Super Post - King — Facebook, TikTok, YouTube, Threads, Instagram & X Automation Tool

Ứng dụng desktop/web (Node + Express) điều phối đăng bài Facebook/TikTok/YouTube/Threads/Instagram/X qua nhiều profile
trình duyệt, quản lý dữ liệu kiểu bảng Excel, tự lấy link bài sau khi đăng, hẹn giờ, bình luận,
thống kê và backup.

---

## Tính năng chính

- **Bảng dữ liệu kiểu Excel** (AG Grid): kéo chuột khoanh vùng, chọn hàng, copy/paste/fill,
  undo/redo, import/export Excel, cột tùy chỉnh + biến dữ liệu `{{ten_bien}}`.
- **Một trung tâm trình duyệt** cho Chrome, GoLogin, GemLogin, GPM Login và GenLogin: tìm kiếm,
  lọc, chọn một/nhiều profile, mở/đóng hàng loạt và đồng bộ gán Facebook ↔ TikTok.
- **Đăng bài tự động**: text, ảnh, video — chạy song song (concurrency) + delay ngẫu nhiên.
  - Threads mở đúng href profile, đăng nội dung + ảnh/video và lưu permalink chính xác của bài mới.
  - Instagram mở Create, tải ảnh/video, đi qua hai bước Next, nhập nội dung, Share và lưu permalink chính xác.
  - X mở composer, nhập nội dung, tải media, Post và lưu đúng permalink `/username/status/id`.
  - Tự **lấy link bài** sau khi đăng: bài thường → `/posts/…`, video → `/reel/…`
    (hover timestamp để Facebook lộ permalink), lưu vào cột `link_post`, thời gian vào `time_post`.
  - **Tự động bình luận** sau khi đăng: chờ một khoảng thời gian (giây/phút, ngẫu nhiên trong
    khoảng min–max) rồi mở lại bài và bình luận. Nội dung lấy theo biến `comment`, một ảnh/video
    tùy chọn theo `comment_media`; kết quả ghi vào `time_comment` và `comment_status`.
    Lịch được lưu trong database, tự phục hồi sau khi tool tắt/crash. Cấu hình trong tab **Cấu hình**.
- **Hẹn giờ** (node-cron): một lần / hàng ngày / cron; tự khôi phục lịch sau khi khởi động lại.
- **Log chạy realtime** qua WebSocket.
- **Dashboard** thống kê + **Backup/Restore**.
- **Giao diện Super Post**: sáng/tối (mặc định sáng), tối giản, hiện đại.

## Công nghệ

`express` · `sql.js` (SQLite/WebAssembly) · `puppeteer-core` · `ws` · `node-cron` ·
`proxy-chain` · `xlsx` · `archiver` / `extract-zip` · AG Grid Community · pywebview (bản desktop).

## Cấu trúc

```
super-post-king/
├─ server.js               # Express + WebSocket + mount routes
├─ config.js               # Đường dẫn, port, Chrome paths
├─ public/                 # Frontend (index.html, css/style.css, js/*)
├─ src/
│  ├─ database/init.js     # Wrapper sql.js (API giống better-sqlite3)
│  ├─ routes/              # data, browser, runner, scheduler, stats, settings
│  └─ services/            # data, browser, runner, scheduler, stats, backup
├─ desktop_launcher.py     # Bản đóng gói desktop (pywebview)
└─ build.bat / build.sh    # Script build desktop (Nuitka)
```

> Chi tiết kiến trúc, DB schema, API và luồng nghiệp vụ: xem **REBUILD_GUIDE.md**.

## Chạy (chế độ web)

```bash
npm install
npm start           # http://localhost:3000
```

## Sử dụng nhanh

1. **Trình duyệt** → tạo Chrome mới hoặc **Kết nối Anti-detect** → chọn một/nhiều profile →
   gán Facebook, TikTok, YouTube, Threads hoặc nhiều nền tảng cùng lúc.
2. **Bảng dữ liệu** → thêm bài, điền cột **name_profile** = tên profile sẽ đăng.
3. **Tự động hoá → Chạy ngay** (hoặc Hẹn giờ) → xem **Log chạy**; link vào cột **link_post**,
   thời gian đăng vào **time_post**.

## Trình duyệt Anti-detect

- **GoLogin/GemLogin:** tool dùng trực tiếp executable và thư mục `user-data-dir` gốc; không tạo
  bản sao cookie/fingerprint. Tên GoLogin lấy từ `gologin.name` trong Preferences; tên GemLogin
  lấy từ Local API `http://127.0.0.1:1010/api`. Nút **Đồng bộ tên** cập nhật lại profile đã nhập.
  Trước khi tool mở profile, tên này cũng được ghi vào metadata hiển thị nội bộ của Chromium
  (`Local State` và `Preferences`) để menu profile không còn hiện `Person 1`/`Your Gemlogin`.
  Nếu profile đang mở thủ công, đóng profile trước hoặc nhập CDP endpoint trong màn hình Sửa.
- **GPM Login:** dùng Local API mặc định `http://127.0.0.1:9495/api/v1`; GPM mở profile và trả
  cổng CDP để tool kết nối.
- **GenLogin:** dùng Local API 3.0 mặc định
  `http://127.0.0.1:55550/backend/profiles`; có thể nhập Bearer token khi dùng API có xác thực.
- Có thể nhập hàng loạt, chọn Facebook/TikTok/cả hai ngay khi nhập. Nhiều profile vật lý chạy
  song song; tác vụ Facebook và TikTok dùng cùng một profile vật lý sẽ được xếp hàng tuần tự.
- Xóa profile ngoài trong Super Post chỉ bỏ liên kết quản lý. Tool không xóa thư mục profile do
  GoLogin, GemLogin, GPM hoặc GenLogin sở hữu.

## Lấy link bài Facebook sau khi đăng

- Trước khi đăng, runner mở đúng timeline của profile đang đăng nhập (xác định bằng cookie `c_user`)
  và ghi nhận các permalink mới nhất để làm mốc so sánh.
- Sau khi Facebook đóng hộp **Tạo bài viết**, runner đợi bài xuất hiện trên timeline, tìm bài theo
  phần đầu nội dung rồi hover link thời gian. Facebook tải permalink theo kiểu lazy nên bước hover
  giúp lấy được URL thật của bài.
- Nếu cách chính chưa lấy được link, runner quét lại các bài đầu timeline và so sánh với danh sách
  trước khi đăng. Link được chuẩn hoá về `https://www.facebook.com/...`, bỏ các tham số theo dõi;
  hỗ trợ bài thường, ảnh, video, Reel và các dạng `story_fbid`.
- Riêng video, nếu timeline vẫn chưa có permalink, runner vào tab **Reels** và **Video**, lấy các
  Reel mới nhất rồi mở từng link để đối chiếu tối đa 80 ký tự đầu của caption. Chỉ Reel có caption
  khớp nội dung thật đã đăng mới được ghi nhận, tránh lấy nhầm video cũ.
- Kết quả được tự ghi vào cột **link_post**; thời điểm hoàn tất được ghi vào **time_post**. Hai cột
  này được ứng dụng tự tạo nếu chưa tồn tại.
- Đăng bài thành công nhưng chưa lấy được permalink không làm mất kết quả đăng: trạng thái vẫn là
  `success`, `link_post` để trống và Log chạy hiển thị **Chưa lấy được link**.

> Để nhận đúng bài, nên dùng nội dung không rỗng và đủ khác biệt với các bài gần nhất trên cùng
> timeline. Profile Chrome phải còn phiên đăng nhập Facebook hợp lệ.

## Hàng đợi bình luận

- Mỗi profile chỉ thao tác một lệnh Facebook tại một thời điểm. Comment đến hạn trong lúc đang đăng
  bài sẽ xếp hàng và chạy ngay sau khi thao tác hiện tại kết thúc; profile khác vẫn chạy song song.
- Bốn cột được tự tạo: `comment`, `comment_media`, `time_comment`, `comment_status`.
- Hỗ trợ text-only, media-only hoặc text + một media. Cả hai đầu vào trống thì trạng thái `skipped`.
- Job `waiting`/`running` được lưu ở bảng `comment_jobs`. Khi mở lại tool, job quá hạn chạy ngay
  theo thứ tự cũ; profile mất đăng nhập được giữ chờ và thử lại sau 5 phút.
- Tool chỉ ghi `success` khi hộp soạn đã reset và DOM xuất hiện comment mới. Upload/gửi lỗi được
  reload và thử lại tối đa một lần; chi tiết lỗi nằm trong Log chạy.

## Đóng gói bàn giao Windows

- Chạy `build.bat` để tạo EXE native, bộ cài và `dist/Super-Post-King-Ban-Giao.zip`.
- ZIP chỉ chứa `Super-Post-King-Setup.exe`, hướng dẫn cài đặt và mã SHA-256.
- Python, Node.js và VC++ runtime được nhúng trong ứng dụng. Bộ cài tự kiểm tra/cài WebView2 và Google Chrome khi máy còn thiếu.
- Database, backup, uploads và Chrome profile không được đưa vào bản phát hành.
- Dữ liệu từng khách hàng nằm tại `%LOCALAPPDATA%\King Automation AI\Super Post King` và được giữ lại khi nâng cấp/gỡ ứng dụng.

## Lưu ý bảo mật

- **Không commit** `src/chrome-profiles/` (chứa cookie đăng nhập Facebook), file `.db`,
  `node_modules/`, `dist/`, token/secret — đã loại trong `.gitignore`.
- Không hardcode token/mật khẩu trong code.

---

*Tác giả: [King Automation AI](https://kingautomationai.com). Xem thêm các Tool khác tại kingautomationai.com.*
