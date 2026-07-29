# CovergemAuto — Hướng Dẫn Dựng Lại 100% (Giao Diện + Chức Năng)

> Tài liệu này mô tả đầy đủ để tái tạo lại ứng dụng **CovergemAuto - Facebook Automation Tool** giống hệt bản hiện tại: kiến trúc, database, API, giao diện, luồng nghiệp vụ và các điểm còn dở.

---

## 1. Tổng quan

- **Loại app:** Web app local (Node + Express), chạy tại `http://localhost:3000` (build desktop dùng port 3004 qua pywebview).
- **Mục đích:** Quản lý dữ liệu bài đăng Facebook, quản lý nhiều profile Chrome (có proxy), chạy tự động hóa đăng bài theo hàng loạt profile với concurrency + delay ngẫu nhiên, hẹn giờ, thống kê dashboard, backup/restore.
- **Kiến trúc:** SPA thuần (vanilla JS, không framework) + REST API + WebSocket log realtime.
- **Frontend:** HTML tĩnh + vanilla JS module pattern, AG Grid Community cho bảng dữ liệu, Google Font Inter, dark theme thuần CSS (không Tailwind).
- **Backend:** Express, `sql.js` (SQLite chạy trong WebAssembly, lưu ra file `.db`), `puppeteer-core` điều khiển Chrome thật, `node-cron` hẹn giờ, `proxy-chain` cho proxy có auth, `xlsx` import/export Excel, `archiver` + `extract-zip` backup.

### Tech stack & dependencies (`package.json`)

```json
{
  "name": "covergemauto",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": { "start": "node server.js", "dev": "node server.js" },
  "dependencies": {
    "express": "^4.18.2",
    "sql.js": "^1.10.0",
    "puppeteer-core": "^21.7.0",
    "xlsx": "^0.18.5",
    "multer": "^1.4.5-lts.1",
    "ws": "^8.16.0",
    "node-cron": "^3.0.3",
    "proxy-chain": "^2.4.0",
    "archiver": "^6.0.1",
    "extract-zip": "^2.0.1",
    "open": "^10.0.3"
  }
}
```

---

## 2. Cấu trúc thư mục

```
covergemauto/
├─ server.js                 # Điểm khởi động: Express + WS + mount routes
├─ config.js                 # Đường dẫn, port, Chrome paths, mặc định runner
├─ package.json
├─ public/                   # Frontend tĩnh
│  ├─ index.html
│  ├─ css/style.css
│  └─ js/
│     ├─ app.js              # Navigation, toast, modal, api helper, websocket
│     ├─ dashboard.js        # Thống kê + biểu đồ CSS
│     ├─ data-manager.js     # AG Grid quản lý bài đăng + custom column + Excel
│     ├─ browser-manager.js  # Quản lý profile Chrome + panel tự động hóa
│     ├─ runner.js           # UI chạy tác vụ + log realtime + progress
│     ├─ scheduler.js        # UI hẹn giờ
│     └─ settings.js         # Cài đặt + backup/restore
├─ src/
│  ├─ database/
│  │  ├─ init.js             # Wrapper sql.js giả lập API better-sqlite3
│  │  └─ covergem.db         # File DB (tự tạo)
│  ├─ routes/                # 6 route files (data, browser, runner, scheduler, settings, stats)
│  ├─ services/              # 6 service files (data, browser, runner, scheduler, stats, backup)
│  ├─ chrome-profiles/       # Mỗi profile = 1 thư mục userDataDir Chrome (tự tạo)
│  └─ backups/               # File .zip backup (tự tạo)
├─ uploads/                  # File Excel tạm khi import (tự xóa sau khi đọc)
├─ desktop_launcher.py       # Bản đóng gói desktop (pywebview) — tùy chọn
└─ build.bat / build.sh      # Script build desktop (Nuitka)
```

> **Lưu ý:** `src/chrome-profiles/`, `src/backups/`, `uploads/` là dữ liệu runtime, **không phải code**. Khi dựng lại chỉ cần tạo thư mục rỗng, hệ thống tự tạo phần còn lại.

---

## 3. Config (`config.js`)

```js
const path = require('path');
module.exports = {
  PORT: process.env.PORT || 3000,
  ROOT_DIR: __dirname,
  DB_PATH: path.join(__dirname, 'src', 'database', 'covergem.db'),
  CHROME_PROFILES_DIR: path.join(__dirname, 'src', 'chrome-profiles'),
  BACKUPS_DIR: path.join(__dirname, 'src', 'backups'),
  UPLOADS_DIR: path.join(__dirname, 'uploads'),
  PUBLIC_DIR: path.join(__dirname, 'public'),
  CHROME_PATHS: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  ],
  DEFAULT_CONCURRENCY: 2,
  DEFAULT_DELAY_MIN: 30, DEFAULT_DELAY_MAX: 90,
  DEFAULT_PROFILE_DELAY_MIN: 10, DEFAULT_PROFILE_DELAY_MAX: 30,
};
```

---

## 4. Khởi động server (`server.js`)

Luồng:
1. Tạo sẵn các thư mục `CHROME_PROFILES_DIR`, `BACKUPS_DIR`, `UPLOADS_DIR` nếu chưa có.
2. `await db.waitReady()` — vì `sql.js` init bất đồng bộ.
3. Tạo Express app + HTTP server.
4. Tạo **WebSocketServer** tại path `/ws/logs`, giữ `Set` các client. Hàm `broadcastLog(data)` gửi JSON tới mọi client đang mở. Gắn `app.locals.broadcastLog` và `app.locals.db`.
5. Middleware: `express.json({ limit: '50mb' })`, `urlencoded`, `express.static(PUBLIC_DIR, { etag:false, lastModified:false, setHeaders })` — **gửi header `Cache-Control: no-store, no-cache, must-revalidate` + `Pragma:no-cache` + `Expires:0`** cho mọi file tĩnh. SPA fallback cũng set no-cache. **Bắt buộc** vì WebView2 (Edge trong bản desktop) cache JS/CSS rất mạnh → nếu không chặn, mọi lần sửa frontend sẽ không nạp vào app. Kết hợp thêm version query `?v=YYYYMMDDx` trên mỗi thẻ `<script>/<link>` trong `index.html` (đổi version mỗi lần deploy để chắc chắn bypass cache).
6. Mount routes:
   - `/api/data` → data.routes
   - `/api/browsers` → browser.routes
   - `/api/runner` → runner.routes
   - `/api/schedules` → scheduler.routes
   - `/api/stats` → stats.routes
   - `/api/settings` → settings.routes
7. SPA fallback: `app.get('*')` trả `index.html`.
8. `server.listen(PORT)` → log `⚡ CovergemAuto đang chạy tại http://localhost:PORT`. Nếu `process.env.AUTO_OPEN_BROWSER !== '0'` thì dynamic import `open` mở trình duyệt.
9. `SIGINT`: đóng db, đóng server, exit.

> Scheduler service có `initAllJobs()` / `stopAllJobs()` — gọi khi khởi động/tắt để khôi phục các lịch đang bật (bản hiện tại chưa nối vào `server.js`, xem mục 12).

---

## 5. Database (`src/database/init.js`)

Dùng `sql.js` nhưng **bọc lại thành API giống `better-sqlite3`** để service dùng cú pháp đồng bộ (`prepare().run/get/all`, `transaction()`, `exec()`, `pragma()`). Sau mỗi lần ghi → `export()` ra buffer và `writeFileSync` xuống file `.db`.

### Đặc điểm wrapper cần giữ đúng
- `prepare(sql)` trả object có `run(...args)`, `get(...args)`, `all(...args)`.
- `run()` trả `{ lastInsertRowid, changes }` (lấy qua `SELECT last_insert_rowid()` và `SELECT changes()` **trước khi** save).
- Chuẩn hóa param: object `{key: val}` → `@key`; boolean → 0/1; `undefined` → null.
- `transaction(fn)`: BEGIN → fn → COMMIT (rollback nếu lỗi).
- **Quan trọng (lỗi đã sửa):** trong `run()`, chỉ gọi `_save()` (tức `db.export()` + ghi file) khi **KHÔNG ở trong transaction**. Dùng cờ `_inTransaction`: `transaction()` bật cờ trước khi chạy `fn`, tắt trước `COMMIT`, rồi `_save()` một lần sau COMMIT. Nếu `_save()` chạy giữa transaction, `db.export()` của sql.js phá trạng thái transaction → khi COMMIT báo lỗi **"cannot commit - no transaction is active"**.
- Async init: `waitReady()` phải được await trước khi query.

### Schema (7 bảng) — tạo trong `_createTables()`

**posts** (bài đăng)
| Cột | Kiểu | Ghi chú |
|-----|------|---------|
| id | INTEGER PK AUTOINCREMENT | |
| sort_order | INTEGER | thứ tự kéo-thả |
| content | TEXT | nội dung bài |
| image_path | TEXT | đường dẫn ảnh |
| link | TEXT | |
| target | TEXT | nhóm/trang |
| status | TEXT default 'pending' | pending/running/success/error |
| note | TEXT | ghi chú (cũng lưu lỗi khi chạy) |
| created_at / updated_at | DATETIME default CURRENT_TIMESTAMP | |

**browsers** (profile Chrome)
| Cột | Kiểu | Ghi chú |
|-----|------|---------|
| id | INTEGER PK | |
| name | TEXT NOT NULL | |
| profile_dir | TEXT NOT NULL UNIQUE | slug + timestamp |
| proxy_type | TEXT default 'none' | none/http/socks5 |
| proxy_host / proxy_port / proxy_user / proxy_pass | | |
| status | TEXT default 'closed' | closed/open |
| session_valid | INTEGER default 0 | có cookie c_user không |
| note | TEXT | |
| created_at | DATETIME | |

**schedules** (lịch hẹn)
| Cột | Kiểu | Ghi chú |
|-----|------|---------|
| id | INTEGER PK | |
| name | TEXT | |
| schedule_time | TEXT | ISO datetime hoặc HH:MM |
| schedule_type | TEXT default 'once' | once/daily/custom |
| cron_expr | TEXT | khi type=custom |
| profile_ids | TEXT | JSON array |
| data_ids | TEXT | JSON array hoặc 'all' |
| concurrency | INTEGER default 1 | |
| delay_min / delay_max | INTEGER (30/90) | |
| enabled | INTEGER default 1 | |
| last_run | DATETIME | |
| status | TEXT default 'waiting' | waiting/running/completed/error/disabled |
| created_at | DATETIME | |

**activity_logs** (nhật ký hoạt động — nguồn cho dashboard)
`id, type, profile_id, post_id, message, status, created_at`. `type` thường là `'post'` hoặc `'schedule'`; `status` = success/error/info/warning.

**custom_columns** (cột do người dùng tự thêm ở bảng dữ liệu)
`id, name, col_type ('text'/'file'/'number'/'select'), var_key, sort_order, created_at`.
- `var_key`: **token biến độc lập với tên cột** (dùng khi chạy/đăng bài). Tên cột chỉ để hiển thị; khi chạy hệ thống lấy `var_key`. Tự chuẩn hoá bằng slug (bỏ dấu, `đ→d`, khoảng trắng→`_`) và **tự chống trùng** (thêm `_2`, `_3`…).
- **Migration tự động** trong `_createTables()`: `ALTER TABLE custom_columns ADD COLUMN var_key TEXT` (bọc try/catch nếu đã có) rồi backfill `var_key = slugKey(name)` cho hàng cũ. Hàm `slugKey()` khai báo ở đầu `init.js`.

**post_custom_data** (giá trị cột động theo từng bài)
`id, post_id, column_id, value, UNIQUE(post_id, column_id)`.

**settings** (key-value)
`key TEXT PK, value TEXT`. Seed mặc định (INSERT OR IGNORE):

```
chrome_path = ''
max_concurrency = '5'
default_delay_min = '30'
default_delay_max = '90'
default_profile_delay_min = '10'
default_profile_delay_max = '30'
browser_per_screen = '1'
auto_backup = '0'
```

---

## 6. Design System (CSS — dark theme)

Font: **Inter** (Google Fonts, weights 300–700). Toàn bộ dùng CSS variables, không framework.

### CSS Variables (`:root`)
```css
--bg-primary:#0f1117; --bg-secondary:#161822; --bg-tertiary:#1c1f2e;
--bg-card:#1a1d2e; --bg-card-hover:#212538; --bg-input:#12141f; --bg-sidebar:#0c0e16;
--border-color:#2a2d3e; --border-hover:#3d4158; --border-focus:#6366f1;
--text-primary:#e2e8f0; --text-secondary:#94a3b8; --text-muted:#64748b; --text-white:#fff;
--accent:#6366f1; --accent-hover:#818cf8; --accent-glow:rgba(99,102,241,.15); --accent-soft:rgba(99,102,241,.1);
--success:#22c55e; --warning:#f59e0b; --error:#ef4444; --info:#3b82f6; (+ *-bg biến thể alpha .1)
--sidebar-width:220px; --header-height:60px;
--radius-sm:6px; --radius-md:10px; --radius-lg:14px; --radius-xl:18px;
--shadow-sm/md/lg/glow; --transition-fast:150ms; --transition-base:250ms; --transition-slow:350ms;
```

> **Điểm nhấn thương hiệu:** accent chính là tím `#6366f1`, nhưng khu vực workspace (bảng trình duyệt/hẹn giờ/log — class `lux-*`, AG Grid, workspace-tab active) dùng **vàng gold `#eab308 / #facc15`** làm màu nhấn thứ hai. Giữ đúng cặp màu tím + vàng để "giống 100%".

### Các nhóm class chính (phải tái tạo)
- **Layout:** `.app-layout` (flex, 100vh), `.sidebar` (220px), `.main-content`, `.page-header` (60px), `.page-container`, `.page` (absolute inset:0, fade opacity/visibility, `.active` để hiện).
- **Sidebar:** `.sidebar-brand` (logo gradient tím), `.sidebar-nav`, `.nav-item` (+ `.active` có thanh dọc `::before` tím), `.nav-icon`, `.sidebar-footer`, `.server-status` + `.status-dot.online` (chấm xanh nhấp nháy `pulse-dot`).
- **Workspace tabs:** `.workspace-tabs` (ẩn mặc định, hiện khi ở nhóm trang workspace), `.workspace-tab` + `.active` (nền gradient vàng gold).
- **Buttons:** `.btn` + biến thể `.btn-primary/secondary/danger/success/ghost` + size `.btn-sm/lg/icon`, trạng thái `:disabled` opacity .5.
- **Form:** `.form-group`, `.form-label`, `.form-input/.form-select/.form-textarea` (focus viền tím + glow), `.form-row`.
- **Card & Stat:** `.card`, `.card-header`, `.card-title`; `.stats-grid` (auto-fill minmax 200px), `.stat-card` (icon/value/label, hover nhấc lên).
- **Badge:** `.badge` bo tròn 20px + `.badge-pending/running/success/error/closed/open` (map màu info/warning/success/error/muted/success).
- **Browser:** `.browser-grid` (card grid — layout cũ), và layout mới bảng `.lux-panel/.lux-panel-title/.lux-title/.lux-subtitle/.lux-table` (bảng gold), `.browser-avatar` (ô vuông gradient tím chữ cái đầu), `.automation-dock` (panel tự động hóa), `.automation-mode` (radio Chạy ngay/Hẹn giờ), `.auto-field`.
- **AG Grid theme:** class `.ag-theme-alpine-dark-custom` override biến `--ag-*` (nền `#11131b`, header `#202433`, range selection viền vàng `#eab308`, checkbox vàng). Row min-height 48px, cell wrap `overflow-wrap:anywhere`.
- **Runner:** `.runner-layout` (grid 2 cột), `.runner-log` (monospace Consolas, nền input), `.log-entry/.log-time/.log-profile/.log-message` (+ màu theo type success/error/warning/info), `.progress-bar/.progress-fill` (gradient tím).
- **Scheduler:** `.schedule-list/.schedule-item`, bảng `.lux-table`, `.toggle/.toggle-slider` (switch bật/tắt).
- **Toast:** `.toast-container` (fixed top-right), `.toast` + `.toast-success/error/warning/info` (viền trái màu), animation `toastIn/toastOut`.
- **Modal:** `.modal-overlay` (blur backdrop, `.active` để hiện), `.modal` (max-width 520px, scale-in), `.modal-header/body/footer`.
- **Chart CSS thuần:** `.bar-chart/.bar-column/.bar` (cột gradient tím), `.donut-chart` (conic-gradient), `.donut-center`.
- **Khác:** `.empty-state/.empty-icon/.empty-text`, `.profile-checklist/.profile-check-item`, `.settings-section`, `.backup-list/.backup-item`, utility (`.flex/.gap-*/.mb-*/.text-muted/.grid-2`...).
- **Responsive** `@media(max-width:900px)`: runner 1 cột, browser grid 1 cột, stats 2 cột.

---

## 7. Khung HTML & Navigation (`index.html` + `app.js`)

### Cấu trúc HTML
- `<aside class="sidebar">`: brand `⚡ CovergemAuto` + 3 nav item chính:
  - `📊 Dashboard` (data-page="dashboard")
  - `▦ Đăng bài Facebook` (data-page="data" — đây là "nhóm workspace")
  - `⚙️ Cài đặt` (data-page="settings")
  - footer: chấm xanh "Server đang chạy".
- `<main>`: `.page-header` (title + `#page-actions` nút động) → `.workspace-tabs` (ẩn/hiện) với 4 tab: **Dữ liệu / Trình duyệt / Hẹn giờ / Log chạy** → `.page-container` chứa 6 div page: `page-dashboard`, `page-data`, `page-browsers`, `page-runner`, `page-scheduler`, `page-settings`.
- Cuối body: `#toast-container`, `#modal-overlay` (modal dùng chung).
- CDN: Google Font Inter + **AG Grid Community 31.0.3** (css `ag-grid.css` + `ag-theme-alpine.css` + `ag-grid-community.min.noStyle.js`).
- Thứ tự nạp script: app.js → dashboard → data-manager → browser-manager → runner → scheduler → settings.

### Navigation (`App` trong app.js)
- `workspacePages = ['data','browsers','scheduler','runner']`. Khi vào 1 trong 4 trang này → hiện `.workspace-tabs`, sidebar giữ mục "Đăng bài Facebook" active.
- `navigateTo(page)`: set active nav, toggle workspace tabs, toggle `.page.active`, đổi tiêu đề (map `titles` + `workspaceTitles`), gọi `updatePageActions(page)` (đổ nút vào `#page-actions`), rồi `loadPage(page)` gọi module tương ứng `.load()`.
- **Nút header động theo trang** (`updatePageActions`):
  - `data`: Import Excel / Export Excel / Thêm hàng / Xóa hàng / Thêm cột / **✎ Sửa cột** / Xóa cột / Biến dữ liệu / Fill xuống / Hoàn tác / Tiến tới / **Lưu dữ liệu** (success).
  - `browsers`: ➕ Thêm Profile.
  - `scheduler`: Làm mới.
  - `runner`: Xóa log / Dừng chạy.
  - `settings`: 💾 Tạo Backup.

### Tiện ích dùng chung (app.js)
- `showToast(message, type, duration=3000)` — icon theo type, tự biến mất + animation out.
- `showModal(title, bodyHtml, footerHtml)` / `closeModal()` — modal dùng chung; đóng khi click overlay/nút X.
- `showConfirm(title, message)` → Promise<boolean> (nút Hủy/Xác nhận).
- `api(url, options)` — fetch JSON, tự `JSON.stringify` body, throw + toast lỗi nếu `!res.ok`.
- `apiUpload(url, formData)` — upload file (không set Content-Type).
- `formatDate/formatTime` (locale vi-VN), `statusBadge(status)` (map badge HTML).
- **WebSocket:** `connectWebSocket()` nối `ws(s)://host/ws/logs`, tự reconnect sau 3s, `onmessage` chuyển data cho `Runner.onLogMessage`.
- `DOMContentLoaded` → `App.init()` (mặc định vào dashboard) + `connectWebSocket()`.

---

## 8. Chi tiết từng trang (UI + chức năng)

### 8.1 Dashboard (`dashboard.js`)
Gọi song song `GET /api/stats/summary | /chart | /activity`, rồi render:
- **stats-grid** 4 ô: Bài đăng hôm nay, Tuần này, Profile hoạt động (`active / total`), Lịch hẹn.
- **grid-2**: biểu đồ cột CSS "Bài đăng 7 ngày qua" (`_renderBarChart`, cao theo tỉ lệ max) + biểu đồ donut CSS "Tỷ lệ thành công" (`conic-gradient` success/error, hiển thị %).
- **Card "Hoạt động gần đây"**: list activity (icon theo type/status, thời gian, tên profile màu accent, message, badge trạng thái). Escape HTML.
- Có dữ liệu rỗng → hiển thị "Chưa có dữ liệu".

### 8.2 Đăng bài Facebook › Dữ liệu (`data-manager.js`) — AG Grid
Module IIFE, quản lý `gridApi`, `customColumns`.

**Cột cố định:** checkbox (chọn nhiều, pinned trái, colId `checkbox`) · `#` (số thứ tự, colId `rownum`, **kiêm luôn kéo-thả sắp xếp hàng** qua `rowDrag:true` — đã bỏ cột drag riêng) · **Nội dung** (editor `agLargeTextCellEditor` popup, wrap) · **Hình ảnh** (renderer có nút 📁 chọn file) · **Link** · **Nhóm/Trang** · **Trạng thái** (select: pending/running/success/error, render badge) · **Ghi chú**. Sau đó nối thêm **custom columns**.

**Custom columns** 4 loại: `text`, `file` (renderer + nút chọn file), `number`, `select`. Thêm/sửa/xóa qua modal, lưu qua API. Mỗi cột có **tên hiển thị** (`name`) và **biến** (`var_key`) sửa riêng.

**Grid options quan trọng:** `rowSelection:'multiple'`, `rowDragManaged`, `undoRedoCellEditing` (limit 30), clipboard copy/paste, `autoHeight` + `wrapText`, `getRowId = data.id`.
> **Không dùng** `enableRangeSelection/RangeHandle/FillHandle` (Enterprise-only, AG Grid Community không có → gây lỗi). Range selection được **tự implement** (xem dưới).

**Range selection tự viết (Excel-style, không cần Enterprise):**
- Kéo chuột từ ô → ô để khoanh vùng nhiều hàng × nhiều cột. Bám ô theo `document.elementFromPoint` (không lệ thuộc `e.target` khi kéo nhanh). Loại cột `checkbox`/`rownum` khỏi vùng.
- **Tô vùng bằng 1 `<div id="range-overlay">` vẽ ĐÈ LÊN TRÊN** (translucent tím 12% + viền `#a5b4fc`, `pointer-events:none`), tính bằng union bounding-rect của các ô trong vùng, clamp trong body viewport, bám theo `bodyScroll`. **Không gán class/tô màu vào ô dữ liệu** → không bao giờ che/mất/nhân đôi chữ (bài học: cách gán class vào cell bị AG Grid tái sử dụng DOM làm dính nhầm ô).
- Thao tác trên vùng: **Delete** xoá dữ liệu vùng · **Ctrl+C** copy (TSV) · **Ctrl+V** dán (1 giá trị → điền hàng loạt cả vùng; nhiều dòng TSV → dán theo khối, tương thích copy từ Excel) · **Fill xuống** lấy giá trị hàng đầu điền xuống theo từng cột. Tất cả có undo/redo (undo type `clearCells`/`setCells`). Cờ `isUndoRedoInProgress` chặn `onCellValueChanged` gọi lưu lặp khi undo/paste.

**Sự kiện & lưu:**
- `onCellValueChanged`: cột thường → `PUT /api/data/:id`; cột custom → `PUT /api/data/custom-data` (qua `apiSilent`, tự revert khi lỗi).
- `onRowDragEnd`: `POST /api/data/reorder { orderedIds }`.
- Phím: `Delete/Backspace`, `Ctrl+C/V`, `Ctrl+Z/Y`, `Ctrl+Enter` (thêm hàng).
- Footer: đếm số hàng + số ô vùng chọn + nhắc phím tắt.
- **`api()` vs `apiSilent()`**: `api()` tự show toast lỗi + throw (double toast nếu caller cũng toast) → các hàm có try/catch riêng dùng `apiSilent()` (không toast, để caller xử lý).

**Chọn file native (cột Hình ảnh / cột file):** nút 📁 gọi `POST /api/data/pick-file` → server mở **hộp thoại OpenFileDialog của Windows qua PowerShell** (`-STA`, multiselect) → trả **đường dẫn tuyệt đối đầy đủ** (giống tự gõ tay). Chế độ web thường (không phải desktop) tự fallback về `<input type=file>` (chỉ có tên file).

**Mật khẩu tính năng biến / cột tùy chỉnh:** hằng `CUSTOM_PASSWORD = '123456'` (cố định trong code, giống nhau mọi máy). Các hàm `showVariableMappingModal`, `showAddColumnModal`, `showDeleteColumnModal`, `showManageColumnsModal` gọi `requireCustomAccess()` — hỏi mật khẩu 1 lần/phiên (cờ `customUnlocked`).

**Modal "Biến dữ liệu":** liệt kê biến cố định (`{{content}}`, `{{image_path}}`, `{{link}}`, `{{target}}`, `{{status}}`, `{{note}}`) + cột tùy chỉnh với **2 ô sửa riêng**: Tên cột (hiển thị) và Biến (`var_key`, khi chạy). Bấm 💾 → `_saveCustomVar()` → `PUT /api/data/columns/:id { name, var_key }`. Click token để copy.

**Thao tác (nút header):** Import Excel · Export Excel · Thêm hàng · Xóa hàng · Thêm cột · **✎ Sửa cột** (`showManageColumnsModal` — đổi tên/loại/xóa) · Xóa cột · **Biến dữ liệu** · Fill xuống · Hoàn tác · Tiến tới · **Lưu dữ liệu**.
- Thêm hàng → `POST /api/data` rồi tự vào edit ô Nội dung.
- Xóa hàng đã chọn → confirm → `DELETE /api/data/bulk { ids }`.
- **Import Excel:** chọn file → `POST /api/data/import-excel` (multipart) → modal preview nhiều sheet (5 hàng đầu) → chọn sheet → `POST /api/data/import-sheet { rows }`.
- **Export Excel:** mở `GET /api/data/export-excel` (tải file).
- **Lưu dữ liệu:** thu thập toàn bộ row (cả cột custom) trong 1 vòng `forEachNode` đồng bộ rồi lưu tuần tự bằng `await` (KHÔNG dùng callback `async` trong `forEachNode` — sẽ nuốt lỗi).

### 8.3 Đăng bài Facebook › Trình duyệt (`browser-manager.js`)
Render **bảng `lux-table`** mỗi profile 1 dòng: checkbox chọn · avatar chữ cái đầu + tên + note · trạng thái (Đang mở/Đã đóng) · phiên (Đã/Chưa đăng nhập theo `session_valid`) · proxy · thư mục profile · nút Log · thao tác (**Mở/Đóng** Chrome, Sửa, Xóa).

**Panel "Tự động hoá" (`automation-dock`)** phía trên bảng:
- Radio **Chạy ngay** / **Hẹn giờ**.
- Nếu Hẹn giờ: hiện field tên lịch, kiểu (Một lần/Hàng ngày/Cron), input thời gian tương ứng (datetime-local / time / cron).
- Nút: Chọn tất cả / Bỏ chọn / **Tự động hoá**.
- `runAutomation()`:
  - **Chạy ngay** → `POST /api/runner/start { profileIds, dataIds:'all' }` (delay/concurrency lấy mặc định từ Cài đặt) → bật Runner polling.
  - **Hẹn giờ** → `POST /api/schedules {...}` rồi chuyển sang tab Hẹn giờ.

**CRUD profile:** modal thêm/sửa gồm Tên (bắt buộc), Loại proxy (none/http/socks5 — hiện field host/port/user/pass khi có proxy), Ghi chú. Tạo → `POST /api/browsers`; sửa → `PUT /api/browsers/:id`; xóa → confirm → `DELETE /api/browsers/:id` (xóa cả thư mục Chrome). Mở → `POST /api/browsers/:id/launch`; đóng → `POST /api/browsers/:id/close`.

> Có 2 hàm render: `renderProfilesTable` (bảng — dùng chính) và `renderProfiles` (card grid — layout cũ, vẫn giữ trong code).

### 8.4 Đăng bài Facebook › Hẹn giờ (`scheduler.js`)
Bảng `lux-table` liệt kê lịch: tên + note · loại (badge Một lần/Hàng ngày/Cron) · trạng thái · thời gian (format theo type) · số profile · lần chạy cuối · **toggle bật/tắt** · Sửa/Xóa.

Modal tạo/sửa: Tên, Loại lịch (once/daily/custom — hiện field datetime / time / cron tương ứng), chọn profile (checkbox), concurrency, delay min/max.
- Tạo → `POST /api/schedules`; sửa → `PUT /api/schedules/:id`; xóa → confirm → `DELETE`; bật/tắt → `PATCH /api/schedules/:id/toggle`.

### 8.5 Đăng bài Facebook › Log chạy (`runner.js`)
Panel `lux-panel` "Log trạng thái chạy": badge Đang chạy/Đang nghỉ, nút Xóa log / Dừng, thanh **tiến trình** (`x / total (%) - ✅ completed | ❌ errors`), và khung **log realtime** (monospace).

- Nhận log qua WebSocket (`onLogMessage`): cập nhật progress, xử lý sự kiện `runner_stopped`, append log entry (thời gian + [profile] + message màu theo type), auto-scroll.
- Có **cấu hình chạy chi tiết** (`render()`): chọn profile, concurrency, delay bài min/max, delay profile min/max, chọn dữ liệu (tất cả / đã chọn) → `startRunner()` gọi `POST /api/runner/start`.
- `fetchStatus()/pollStatus()` mỗi 2s gọi `GET /api/runner/status` để đồng bộ nút + progress; khi runner dừng → toast hoàn tất.
- `stopRunner()` → `POST /api/runner/stop`. `clearLog()` reset log + progress.

### 8.6 Cài đặt (`settings.js`)
2 khối:
1. **Cài đặt chung:** Đường dẫn Chrome (+ nút tự phát hiện), Giới hạn Chrome đồng thời (1–10), Số trình duyệt trên 1 màn hình (1–12, để chia lưới cửa sổ), Delay mặc định giữa bài (min~max), Delay mặc định giữa profile (min~max), toggle Auto backup. Nút **Lưu cài đặt** → `PUT /api/settings` (có validate min≤max, khoảng cho phép).
2. **Backup & Restore:** nút Tạo Backup → `POST /api/settings/backup/create`; danh sách backup (`GET /api/settings/backup/list`) mỗi mục có kích thước + ngày + nút Khôi phục (`POST .../restore/:filename`, confirm) + Xóa (`DELETE .../backup/:filename`).

---

## 9. REST API đầy đủ

### `/api/data` (posts)
| Method | Path | Chức năng |
|--------|------|-----------|
| GET | `/` | Tất cả bài + custom data (`getAllWithCustomData`) |
| POST | `/` | Tạo 1 bài (object) hoặc nhiều (array) |
| PUT | `/bulk` | Cập nhật nhiều `{updates:[{id,...}]}` |
| PUT | `/:id` | Cập nhật 1 bài (chỉ `:id` là số) |
| DELETE | `/bulk` | Xóa nhiều `{ids:[]}` |
| POST | `/restore` | Khôi phục hàng đã xóa `{rows:[]}` (undo) |
| POST | `/reorder` | Sắp xếp `{orderedIds:[]}` |
| POST | `/import-excel` | Upload xlsx/xls/csv (multipart, ≤50MB) → trả sheets + preview |
| POST | `/import-sheet` | Import `{rows:[]}` vào DB (map cột) |
| GET | `/export-excel` | Tải xlsx toàn bộ |
| GET | `/columns` | List custom column (kèm `var_key`) |
| POST | `/columns` | Thêm `{name, col_type, var_key?}` (var_key tự slug nếu bỏ trống) |
| PUT | `/columns/:id` | Sửa cột `{name?, col_type?, var_key?}` (var_key tự chống trùng) |
| DELETE | `/columns/:id` | Xóa cột + data (trả snapshot để undo) |
| POST | `/columns/restore` | Khôi phục cột `{snapshot}` |
| PUT | `/custom-data` | Set giá trị `{post_id, column_id, value}` |
| POST | `/pick-file` | Mở hộp thoại chọn file Windows (PowerShell OpenFileDialog) → `{paths:[]}` đường dẫn đầy đủ (desktop only) |

### `/api/browsers`
| GET `/` · POST `/` · PUT `/:id` · DELETE `/:id` · POST `/:id/launch` · POST `/:id/close` · GET `/:id/status` |

### `/api/runner`
| POST `/start` (config) · POST `/stop` · GET `/status` |
`/start` body: `profileIds[]`, `dataIds[]|'all'`, `concurrency`, `delayMin/Max`, `profileDelayMin/Max`. Server tự clamp (concurrency 1–10, max≥min) và lấy mặc định từ bảng `settings` nếu thiếu. Trả ngay, chạy nền, log qua WS.

### `/api/schedules`
| GET `/` · POST `/` · PUT `/:id` · DELETE `/:id` · PATCH `/:id/toggle` | (mỗi thao tác broadcast 1 log `type:'schedule'`).

### `/api/stats`
| GET `/summary` · GET `/chart?days=7` · GET `/activity?limit=10` |

### `/api/settings`
| GET `/` · PUT `/` · POST `/backup/create` · GET `/backup/list` · POST `/backup/restore/:filename` · DELETE `/backup/:filename` |

**Chuẩn response:** thành công `{ success:true, data }`; lỗi `res.status(4xx/5xx).json({ error })`. Frontend `api()` đọc `data.error` khi `!ok`.

---

## 10. Logic Service (backend)

### DataService
- `getAll` sắp theo `sort_order, id`. `create/createMany` tự tăng `sort_order` (MAX+1), dùng transaction cho bulk.
- `update/updateMany` chỉ set field cho phép (`content,image_path,link,target,status,note,sort_order`) + `updated_at`.
- `importFromExcel` đọc mọi sheet bằng `XLSX.sheet_to_json({defval:''})`.
- `importSheet` **map tên cột** (đa dạng tiếng Việt/Anh) → field DB: content/image_path/link/target/status/note. Nếu không map được → dùng thứ tự cột đầu. Bỏ hàng rỗng.
- `exportToExcel` xuất cột tiếng Việt (#, Nội dung, Hình ảnh, Link, Nhóm/Trang, Trạng thái, Ghi chú) + set độ rộng cột.
- Custom columns: CRUD + `getAllWithCustomData` merge `custom_<id>` vào từng post; xóa cột trả snapshot để undo.

### BrowserService (puppeteer-core)
- `getAll/getById` gắn `profile_path` (join CHROME_PROFILES_DIR + profile_dir) và status live theo `activeBrowsers` Map.
- `create`: sinh slug từ tên + timestamp làm `profile_dir`, tạo thư mục userDataDir.
- `launch(id)`:
  - Tìm Chrome path (ưu tiên `settings.chrome_path`, rồi `config.CHROME_PATHS`).
  - Tính layout cửa sổ theo `browser_per_screen` (chia lưới 1920×1040).
  - Args Chrome: no-first-run, tắt automation flag (`ignoreDefaultArgs:['--enable-automation']`), window-size/position.
  - Proxy: nếu có user/pass → dùng `proxy-chain.anonymizeProxy` (http/socks5); nếu không → `--proxy-server` trực tiếp.
  - `puppeteer.launch({ executablePath, userDataDir, headless:false, defaultViewport:null, args })`; lưu vào `activeBrowsers`; set status='open'; lắng nghe `disconnected` để dọn dẹp.
- `close(id)`: đóng browser + proxy-chain, set status='closed'.
- `getStatus(id)`: kiểm tra cookie `c_user` trên facebook.com → `session_valid`.

### RunnerService (engine — singleton)
- State: `isRunning, shouldStop, progress{total,completed,errors}`.
- `start(config, broadcastLog)`:
  - Lấy profiles + posts (theo `dataIds` hoặc all, sắp theo sort_order).
  - `total = profiles × posts`.
  - **Promise pool** giới hạn `concurrency`: mỗi profile chạy `_processProfile`, có delay ngẫu nhiên giữa các profile.
  - `_processProfile`: mở Chrome (qua BrowserService, lỗi thì chạy "mô phỏng"), lặp từng post → `processPost` → cập nhật `posts.status` + ghi `activity_logs` + tăng progress + broadcast `progress` + delay ngẫu nhiên giữa bài; cuối cùng đóng Chrome.
  - Kết thúc broadcast sự kiện `runner_stopped` kèm progress.
- **`processPost(page, post)` hiện là PLACEHOLDER** — chỉ `sleep(2000)` và log "Tác vụ đăng bài sẽ được cập nhật sau". → **Đây là phần chưa hoàn thiện** (xem mục 13).
- `_randomSeconds/_sleep` (sleep có thể hủy qua `shouldStop`, check mỗi 500ms).
- `stop()` set `shouldStop=true`. `getStatus()` trả state.

### SchedulerService (node-cron)
- `create` lưu profile_ids/data_ids dạng JSON; nếu enabled → `startJob`.
- `startJob` theo type:
  - **once** → `setTimeout` tới `schedule_time` (cap 2147483647ms); chạy xong set completed + tắt enabled. Quá hạn → đánh dấu completed ngay.
  - **daily** → cron `${m} ${h} * * *` (timezone `Asia/Ho_Chi_Minh`).
  - **custom** → dùng `cron_expr` (validate bằng `cron.validate`).
- `_executeJob` → gọi `RunnerService.start(...)` với config của lịch, cập nhật `last_run/status`.
- `toggle/update/delete` đều stop job cũ trước. `initAllJobs()` khôi phục lịch enabled lúc khởi động; `stopAllJobs()` khi tắt.

### StatsService
- `getSummary`: totalPosts, todayPosts/weekPosts (từ `activity_logs` status=success), successRate (success/(success+error)), active/total profiles, upcomingSchedules (enabled=1).
- `getDailyChart(days)`: đếm success theo từng ngày (SQLite `date('now','-N days')`).
- `getRecentActivity(limit)`: join `activity_logs` với `browsers` để lấy `profile_name` (mặc định 'Hệ thống').

### BackupService
- `createBackup`: zip (`archiver`) gồm `covergem.db` (+ wal/shm nếu có) + thư mục `chrome-profiles/` → `backups/backup_YYYY-MM-DD_HH-mm-ss.zip`.
- `listBackups`: liệt kê file `backup_*.zip` sắp mới→cũ (filename, size, createdAt).
- `restoreBackup`: sanitize filename, đóng Chrome, `extract-zip` ra temp, copy DB + chrome-profiles đè, dọn temp. Trả thông báo "khởi động lại server để áp dụng".
- `deleteBackup`, `getSettings`, `updateSettings` (INSERT OR REPLACE, transaction).

---

## 11. WebSocket log realtime
- Server: `WebSocketServer` path `/ws/logs`; `broadcastLog(data)` gửi JSON tới mọi client.
- Payload log: `{ time, profile|null, message, type:'info'|'success'|'error'|'warning', event?, progress? }`.
- `event` đặc biệt: `progress` (chỉ cập nhật tiến trình), `runner_stopped` (kết thúc), `runner_error`.
- Client tự reconnect 3s; chỉ Runner tiêu thụ.

---

## 12. Hẹn giờ khởi động lại (lưu ý tích hợp)
`SchedulerService.initAllJobs()` và `stopAllJobs()` đã có sẵn nhưng **bản `server.js` hiện tại chưa gọi**. Nếu muốn lịch tự chạy lại sau khi restart server, thêm:
```js
const SchedulerService = require('./src/services/scheduler.service');
SchedulerService.initAllJobs();               // sau khi db ready
process.on('SIGINT', () => { SchedulerService.stopAllJobs(); /* ... */ });
```

---

## 13. Điểm CHƯA hoàn thiện (cần làm tiếp)
1. **`RunnerService.processPost()` là placeholder** — chưa có logic đăng bài Facebook thật bằng puppeteer (điều hướng tới nhóm/trang, điền nội dung, đính ảnh từ `image_path`, submit, xác minh). Toàn bộ khung concurrency/delay/log/DB đã sẵn sàng, chỉ cần cắm logic đăng bài vào đây.
2. **Thay thế biến `{{var_key}}` khi đăng bài CHƯA nối vào runner** — hiện `var_key` đã được lưu/sửa/hiển thị đầy đủ ở UI, nhưng lúc `processPost` chưa có bước thay `{{ten_bien}}` trong `content` bằng giá trị cột tương ứng của bài. Khi làm mục 1, thêm bước: với mỗi post, map `var_key → giá trị custom_<id>` (và các field cố định content/image_path/…) rồi `content.replace(/{{key}}/g, value)`.
3. **initAllJobs chưa nối vào server** (mục 12).
4. Build desktop (Nuitka) có `nuitka-crash-report.xml` — cần xử lý riêng nếu muốn đóng gói `.exe`.

> **ĐÃ hoàn thiện gần đây** (không còn là điểm dở): chọn file trả full path (native dialog), range selection + copy/paste/fill/delete, undo/redo đầy đủ, tên cột & biến độc lập, mật khẩu tính năng, chống cache WebView2.

### Quy trình deploy nhanh (không build lại `.exe`)
`public/` và `src/` được Nuitka nhúng dạng `--include-data-dir`, còn `desktop_launcher.py` bị **biên dịch cứng vào binary**. Vì vậy:
- Sửa **frontend (`public/`) hoặc backend JS (`server.js`, `src/`)** → chỉ cần **copy đè file vào `dist/desktop_launcher.dist/…`** rồi mở lại `.exe` (Node đọc lại `server.js`/`src/` từ dist, không cần build). Nhớ **đổi version query `?v=`** trong `index.html` để bypass cache WebView2.
- Sửa **`desktop_launcher.py`** → **bắt buộc build lại** bằng `build.bat` (Nuitka).

---

## 14. Checklist dựng lại nhanh
1. `npm init` + cài đúng dependencies (mục 1).
2. Tạo `config.js`, `server.js` (mục 3–4).
3. Tạo `src/database/init.js` (wrapper sql.js + 7 bảng + seed settings) — mục 5.
4. Tạo 6 service + 6 route (mục 9–10).
5. Tạo `public/index.html` + `css/style.css` (design system mục 6–7).
6. Tạo 7 file JS frontend (mục 7–8).
7. Tạo thư mục rỗng: `src/chrome-profiles`, `src/backups`, `uploads`.
8. `npm start` → mở `http://localhost:3000`.
9. Cài đường dẫn Chrome trong Cài đặt → thêm profile → thêm dữ liệu → chạy thử (hiện chạy mô phỏng do `processPost` placeholder).

---

*Tài liệu tạo tự động từ việc đọc toàn bộ mã nguồn hiện tại của CovergemAuto.*
