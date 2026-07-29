# KingTool — Facebook Automation Tool

Ứng dụng desktop/web (Node + Express) tự động **đăng bài Facebook hàng loạt** qua nhiều
profile Chrome, quản lý dữ liệu kiểu bảng Excel, tự lấy link bài sau khi đăng, hẹn giờ,
thống kê và backup.

---

## Tính năng chính

- **Bảng dữ liệu kiểu Excel** (AG Grid): kéo chuột khoanh vùng, chọn hàng, copy/paste/fill,
  undo/redo, import/export Excel, cột tùy chỉnh + biến dữ liệu `{{ten_bien}}`.
- **Quản lý nhiều profile Chrome** (puppeteer-core) có proxy, mở/đóng, kiểm tra phiên đăng nhập.
- **Đăng bài tự động**: text, ảnh, video — chạy song song (concurrency) + delay ngẫu nhiên.
  - Tự **lấy link bài** sau khi đăng: bài thường → `/posts/…`, video → `/reel/…`
    (hover timestamp để Facebook lộ permalink), lưu vào cột `link_post`, thời gian vào `time_post`.
- **Hẹn giờ** (node-cron): một lần / hàng ngày / cron; tự khôi phục lịch sau khi khởi động lại.
- **Log chạy realtime** qua WebSocket.
- **Dashboard** thống kê + **Backup/Restore**.
- **Giao diện KingTool**: sáng/tối (mặc định sáng), tối giản, hiện đại.

## Công nghệ

`express` · `sql.js` (SQLite/WebAssembly) · `puppeteer-core` · `ws` · `node-cron` ·
`proxy-chain` · `xlsx` · `archiver` / `extract-zip` · AG Grid Community · pywebview (bản desktop).

## Cấu trúc

```
covergemauto/
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

1. **Trình duyệt** → thêm/mở profile → đăng nhập Facebook (1 lần).
2. **Bảng dữ liệu** → thêm bài, điền cột **name_profile** = tên profile sẽ đăng.
3. **Tự động hoá → Chạy ngay** (hoặc Hẹn giờ) → xem **Log chạy**; link vào cột **link_post**,
   thời gian đăng vào **time_post**.

## Lưu ý bảo mật

- **Không commit** `src/chrome-profiles/` (chứa cookie đăng nhập Facebook), file `.db`,
  `node_modules/`, `dist/`, token/secret — đã loại trong `.gitignore`.
- Không hardcode token/mật khẩu trong code.

---

*Repo cá nhân. © KingTool.*
