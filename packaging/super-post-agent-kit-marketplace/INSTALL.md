# Cài Super Post Agent Kit trên máy khác

Giải nén toàn bộ thư mục này, mở PowerShell tại thư mục vừa giải nén và giữ nguyên cấu trúc
`.agents`, `plugins`.

## Claude Desktop, Claude Code, Codex và OpenClaw

```powershell
powershell -ExecutionPolicy Bypass -File .\plugins\super-post-agent-kit\scripts\install-cross-agent.ps1 -Agent All
```

Mở phiên agent mới sau khi cài. Script cập nhật Claude Desktop (`claude_desktop_config.json`),
Claude Code (`.claude.json`), Codex (`config.toml`) và OpenClaw, đồng thời tạo backup cấu hình trước khi cập nhật và
không xóa skill không thuộc Super Post. Agent Kit và Node runtime dùng cho MCP được sao chép vào
`%LOCALAPPDATA%\King Automation AI\Super Post Agent Kit`, nên có thể xóa hoặc di chuyển thư mục
vừa giải nén sau khi cài. Nếu muốn thay một skill trùng tên nhưng không do Super Post quản lý,
thêm `-ReplaceExisting`.

## Yêu cầu

- Cài và mở Super Post King bản mới. Agent Kit tự dùng Node.js đi kèm bản cài đặt.
- Nếu chỉ chạy mã nguồn thay vì bản cài đặt, cần Node.js 18 trở lên trong `PATH`.
- Thiết lập profile, phiên đăng nhập và cài đặt runner ngay trong Super Post King.

Không chép API key hoặc database từ máy cũ. Super Post King ở máy mới tự tạo key cục bộ; MCP
tự ghép đúng key với cổng API của tool, kể cả khi có nhiều instance đang chạy.
