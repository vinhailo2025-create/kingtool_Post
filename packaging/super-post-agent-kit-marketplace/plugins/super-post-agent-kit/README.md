# Super Post Agent Kit

Một gói chứa một MCP cục bộ và hai skill độc lập:

- `super-post-profile-mapper`: đọc profile, nhóm, target, thêm dữ liệu ở trạng thái Đợi và đổi
  `name_profile`; không đăng bài; đồng thời tạo/sửa/xóa Nhóm đăng tái sử dụng.
- `post-face-super-post`: đăng manifest đã mapping, theo dõi job/batch và trả permalink.

MCP có 38 tool, gồm nhập một/nhiều hàng Đợi, đăng đúng hàng Đợi đã có, CRUD Nhóm đăng, CRUD Chiến dịch đa nền tảng, CRUD lịch hẹn,
`super_post_publish_group` và `super_post_publish_campaign`. Một Nhóm đăng có thể kết hợp
timeline của nhiều profile, Fanpage và nhiều Facebook Group; mỗi thành viên tạo một job riêng.
Một Chiến dịch kết hợp nhiều Nhóm đăng/nền tảng và chạy chúng bằng một lệnh.

MCP không chứa API key, database hoặc cài đặt runner. Nó tự tìm Super Post King trên
`127.0.0.1`, đọc API key cục bộ do tool tạo và lấy concurrency/delay/giới hạn bài trực tiếp từ
mục Cài đặt của tool.

Từ bản 0.3.9, MCP ghép cổng với `key_file` do đúng instance công bố và giữ nguyên instance đang
khỏe ngay cả khi một tiến trình khác ghi lại endpoint registry. Nếu app thật sự khởi động lại bằng
cổng khác, cùng phiên agent tự dò lại. Lệnh publish có `request_id` chống trùng nên được phép thử
lại an toàn khi mất kết nối giữa lúc đổi cổng. Mọi kết quả list được bọc trong object
`{ items, count }` đúng chuẩn `structuredContent` của MCP.

Từ bản 0.3.11, job đã được Facebook nhận nhưng permalink xuất hiện chậm trả
`link_pending: true`. Agent chỉ theo dõi lại job/batch; Super Post King tự tìm link bền vững qua
các lần khởi động và cập nhật cùng job, không đăng lại target. Việc dò tự dừng ở trạng thái
`expired` sau giới hạn an toàn để không mở profile vô hạn; có thể yêu cầu dò lại thủ công.

Từ bản 0.3.12, Claude, Codex và OpenClaw có thể đọc/tạo/sửa/bật/tắt/xóa lịch hẹn trong app.
Lịch dùng `schedule_key` chống tạo trùng, tồn tại qua lần khởi động và luôn lấy cấu hình runner
từ Super Post King.

Từ bản 0.3.13, MCP có thể thêm một hoặc nhiều hàng `pending` bằng `data_key` chống trùng.
Thao tác này không tạo job và không khởi động runner; người dùng có thể gán profile, đăng hoặc
hẹn giờ riêng sau đó.

Từ bản 0.3.14, MCP có thể đăng trực tiếp một hoặc nhiều hàng `pending` đã có bằng `post_id` mà
không tạo bản sao. Lịch chỉ nhận hàng có `name_profile` khớp profile đã chọn; runner từ chối không
còn bị ghi hoàn tất giả. Lịch `all_pending` đang bật sẽ chặn tạo/gán dữ liệu cùng profile trừ khi
người dùng chủ động truyền `allow_scheduled_consumption: true`.

Từ bản 0.4.0, MCP nhận sự kiện job realtime có `event_id` bền vững để tiếp tục sau khi mất kết nối.
Client hỗ trợ notification nhận ngay thay đổi trạng thái; client khác dùng `super_post_wait_job` hoặc
`super_post_wait_events` để giữ một request chờ thay vì gọi kiểm tra liên tục.

Launcher dùng Node.js đã đi kèm bộ cài Super Post King, nên máy khách không phải cài Node riêng.
Script cài Claude/Codex/OpenClaw tự sao chép Agent Kit và một Node runtime ổn định vào LocalAppData; xóa
hoặc di chuyển thư mục ZIP/folder code sau đó không làm mất MCP.

## Cài trong Codex

Gói được đăng ký trong marketplace cá nhân với tên `super-post-agent-kit`. Cài bằng:

```powershell
codex plugin add super-post-agent-kit@personal
```

Mở một thread mới sau khi cài để Codex nạp hai skill và danh sách MCP tool.

## Dùng với Claude Desktop, Claude Code và OpenClaw

Chạy script cài liên kết skill và cấu hình MCP:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-cross-agent.ps1 -Agent All
```

Script cập nhật cấu hình MCP cho cả Claude Desktop và Claude Code, không xóa skill cũ. Thêm
`-ReplaceExisting` nếu muốn chuyển bản cũ sang thư mục backup rồi liên kết tới skill trong gói.
Khởi động lại Claude/OpenClaw sau khi cài.

## Điều kiện

- Super Post King bản mới đang mở.
- Node.js 18 trở lên chỉ cần khi chạy Super Post King từ mã nguồn.
- Profile và phiên đăng nhập được thiết lập trong tool.
- Cài đặt luồng, delay và giới hạn bài được cấu hình trong Super Post King.

## Luồng gọi

1. Gọi `$super-post-profile-mapper` để thêm hàng Đợi, xem/chọn/đổi mapping, tạo Nhóm đăng hoặc Chiến dịch.
2. Chỉ khi cần đăng, gọi `$post-face-super-post` với manifest đã mapping.
3. Sau timeout, dùng `job_id`/`batch_id` để lấy kết quả; không gửi đăng lại.
