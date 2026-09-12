# Agent API & MCP — Super Post King

Luồng tích hợp:

`OpenClaw / Claude / ChatGPT → MCP/Agent API → Super Post King Runner → kết quả về agent`

Agent gửi dữ liệu và mapping profile/target. Super Post King chịu trách nhiệm mở profile, chạy
đa luồng, delay, thao tác nền tảng, đăng bài, lấy link/thời gian và xử lý bình luận.

Tích hợp được tách thành hai skill:

- `$super-post-profile-mapper`: đọc profile, nhóm profile, target, dữ liệu nền tảng và đổi
  `name_profile`; không đăng bài.
- `$post-face-super-post`: nhận manifest đã mapping, gọi đăng, theo dõi và trả kết quả/link.

## Nguyên tắc cài đặt

Concurrency, delay giữa bài, delay giữa profile, giới hạn bài mỗi profile, timeout thao tác và
chống bot luôn đọc từ mục Cài đặt của Super Post King. MCP không có quyền ghi đè. Dùng
`super_post_get_runtime_config` để đọc giá trị hiệu lực.

Trong batch, profile khác nhau chạy đồng thời theo `max_concurrency`; các bài của cùng một
profile chạy tuần tự. Giới hạn bài/profile tạo nhiều wave cho tới khi batch hết hàng.

## Khởi động

Mở Super Post King. Chỉ khi phát triển từ mã nguồn mới chạy:

```powershell
Set-Location "<thu-muc-ma-nguon>"
npm start
```

Kiểm tra `/api/agent/v1/health`. API chỉ lắng nghe `127.0.0.1` và sinh key tại `key_file`.

## Tool MCP

- `super_post_get_capabilities`
- `super_post_get_runtime_config`
- `super_post_get_data_schema`
- `super_post_list_profiles`
- `super_post_list_profile_groups`
- `super_post_list_targets`
- `super_post_list_platform_data`
- `super_post_create_data`
- `super_post_create_data_batch`
- `super_post_assign_profiles`
- `super_post_publish_data`
- `super_post_publish_data_batch`
- `super_post_list_publish_groups`
- `super_post_get_publish_group`
- `super_post_create_publish_group`
- `super_post_update_publish_group`
- `super_post_delete_publish_group`
- `super_post_publish_group`
- `super_post_list_publish_campaigns`
- `super_post_get_publish_campaign`
- `super_post_create_publish_campaign`
- `super_post_update_publish_campaign`
- `super_post_delete_publish_campaign`
- `super_post_publish_campaign`
- `super_post_list_schedules`
- `super_post_get_schedule`
- `super_post_create_schedule`
- `super_post_update_schedule`
- `super_post_set_schedule_enabled`
- `super_post_delete_schedule`
- `super_post_publish`
- `super_post_publish_batch`
- `super_post_get_job`
- `super_post_wait_job`
- `super_post_wait_events`
- `super_post_get_batch`
- `super_post_list_jobs`
- `super_post_cancel_job`
- `super_post_stop_runner`
- `super_post_delete_data`

Cách cài khuyến nghị là mở `Cài đặt > Agent & MCP` và bấm `Cài kết nối AI`. Agent Kit đã được
đóng sẵn trong bộ cài; app tự chép MCP và Node runtime vào `%LOCALAPPDATA%\King Automation AI\Super Post
Agent Kit`, rồi ghi đường dẫn tuyệt đối ổn định cho Claude Desktop, Claude Code, Codex và OpenClaw.
File Agent Kit ZIP chỉ là phương án offline/IT/khôi phục. Không cấu hình đường dẫn folder code và không ghim
`SUPER_POST_BASE_URL` vào một cổng cụ thể.

Mỗi lần job đổi trạng thái, backend ghi một sự kiện bền vững với `event_id` tăng dần. MCP gửi
`notifications/message` tới client hỗ trợ realtime. Client không nhận notification dùng
`super_post_wait_job` hoặc `super_post_wait_events`; `after_event_id` giúp nối lại mà không bỏ lỡ sự kiện.

Bridge ưu tiên `SUPER_POST_BASE_URL`, sau đó tự dò các cổng desktop `3004`, `3000`–`3005`.
Mỗi instance công bố `key_file` qua endpoint health; bridge luôn ghép đúng cổng với đúng file key
và ưu tiên bản desktop nếu đồng thời có bản desktop và bản chạy mã nguồn. Key được đọc lại ở mỗi
lần gọi, nên không cần khởi động lại agent sau khi app tạo lại file.

Bản desktop còn cập nhật endpoint hiện hành tại
`%LOCALAPPDATA%\King Automation AI\Super Post King\agent-api-endpoint.json`. MCP đọc registry
này trước mỗi lệnh. Khi tắt/mở app và port thay đổi, cùng tiến trình MCP tự bỏ kết nối cũ, dò port
mới rồi gọi tiếp; không cần sửa cấu hình, khởi động lại Claude Desktop, Claude Code, Codex,
OpenClaw hoặc khởi động lại máy.
Bản desktop dùng single-instance mutex để một người dùng không vô tình mở hai server cùng ghi vào
database. Lần mở EXE thứ hai chỉ đưa cửa sổ hiện có lên trước. Server Node còn theo dõi PID của
launcher và tự tắt nếu launcher bị Task Manager/Windows đóng đột ngột, tránh để lại server orphan
chiếm `3004` khiến lần mở sau phải nhảy sang cổng khác.

MCP giữ instance đã chọn miễn là instance đó còn trả lời, nên một endpoint registry bị tiến trình
khác ghi đè không làm phiên agent nhảy cổng. Khi kết nối thật sự mất, MCP dò lại với backoff.
Các lệnh publish luôn có `request_id`; nếu mất phản hồi đúng lúc app đổi cổng, MCP có thể gửi lại
mà Agent API trả job cũ thay vì tạo bài trùng. Kết quả dạng danh sách được trả trong
`structuredContent` dưới dạng `{ "items": [...], "count": n }` để tương thích Claude/Codex/OpenClaw.

Không cần chép key thủ công. Chỉ dùng `SUPER_POST_AGENT_KEY_FILE` cho cấu hình cũ không trả
`key_file`; nếu đặt sai đường dẫn, bridge của bản mới vẫn ưu tiên file do instance đang chạy công bố.

Trong bản cài đặt, MCP bridge nằm tại:

```text
%LOCALAPPDATA%\Programs\King Automation AI\Super Post King\scripts\super-post-mcp-server.js
```

Có thể cấu hình Claude/OpenClaw dùng `bin\node.exe` và script này mà không cần cài Node.js riêng.
Gói **Super Post Agent Kit** đã chứa sẵn bridge và là cách cài khuyến nghị cho Codex.
Với Claude Desktop, Claude Code và OpenClaw, script cài đặt sao chép Agent Kit và một Node runtime vào
`%LOCALAPPDATA%\King Automation AI\Super Post Agent Kit`; cấu hình không phụ thuộc thư mục giải
nén, folder code hoặc vị trí cài app. Launcher của plugin Codex ưu tiên `node_path` của app đang
chạy, sau đó đọc thư mục cài từ Registry nên vẫn hoạt động nếu khách chọn thư mục khác mặc định.

Nếu gặp `AGENT_API_UNAUTHORIZED`, kiểm tra xem có nhiều bản Super Post King cũ đang chạy hay
không và cập nhật Agent Kit. Không xóa hoặc chia sẻ `agent-api-key.txt`.

## Đọc và đổi mapping mà không đăng

`super_post_list_profile_groups` trả từng nhóm cùng danh sách profile thành viên thực tế.
`super_post_list_targets` trả Fanpage/kênh đã quét và Group Facebook đã lưu trong dữ liệu.
`super_post_list_platform_data` trả hàng dữ liệu cùng `custom_fields` theo nền tảng.

`super_post_assign_profiles` nhận `platform` và mảng `assignments` gồm `post_id` với
`profile_id` hoặc `profile`. Tool cập nhật `name_profile` theo transaction, không tạo job đăng và
từ chối hàng đang thuộc job `queued`/`running`.

## Thêm dữ liệu vào Đợi mà không đăng

`super_post_create_data` thêm một hàng, còn `super_post_create_data_batch` thêm tối đa 500 hàng
cùng nền tảng theo transaction. Mỗi item cần `data_key` ổn định và `content` hoặc `media`.
Profile có thể để trống để gán sau. Nếu đã truyền profile/media/target/custom field, Agent API
xác minh trước khi ghi.

Kết quả luôn có `status: pending`, `job_created: false` và `runner_started: false`. Không có
`agent_jobs` nào được tạo và runner không khởi động. Đây là trạng thái **Đợi** trong bảng dữ liệu,
khác với job `queued` của một lệnh publish.

```json
{
  "platform": "facebook",
  "items": [
    {
      "data_key": "campaign-01-row-001",
      "profile_id": 2,
      "content": "Nội dung chuẩn bị trước",
      "media": ["C:\\Media\\image.jpg"],
      "fanpage": "https://www.facebook.com/example.page"
    },
    {
      "data_key": "campaign-01-row-002",
      "content": "Hàng chưa gán profile"
    }
  ]
}
```

Gọi lại cùng `data_key` và cùng payload trả `post_id` cũ. Cùng khóa nhưng payload khác, hoặc một
batch trộn khóa cũ với khóa mới, bị từ chối toàn bộ để tránh nhập trùng/nhập dở.

Nếu có lịch `all_pending` đang bật và cùng profile, thao tác tạo/gán profile mặc định bị chặn bằng
`AGENT_DATA_ACTIVE_ALL_PENDING_SCHEDULE`. Chỉ truyền `allow_scheduled_consumption: true` khi người
dùng chủ động muốn lịch đó lấy dữ liệu mới. Kết quả trả `matching_schedules` để biết chính xác lịch nào
có thể tiêu thụ hàng.

## Đăng hàng Đợi đã có mà không tạo bản sao

`super_post_publish_data` nhận `platform`, `post_id`, `request_id` tùy chọn và `wait_seconds`.
`super_post_publish_data_batch` nhận `platform`, `batch_key` cùng các item `{ item_key, post_id }`.
Hai tool chỉ tạo job cho đúng hàng hiện có, không gọi luồng tạo dữ liệu và không sinh thêm một hàng.
Hàng phải còn `pending`, có `name_profile` khớp chính xác với profile đang tồn tại và chưa thuộc job
`queued`/`running`. Retry cùng khóa trả job/batch cũ.

## Nhóm đăng tái sử dụng

Nhóm đăng lưu một danh sách đích kết hợp. Mỗi thành viên gồm profile thực thi và `target_type`:

- `profile`: timeline profile.
- `fanpage`: Fanpage Facebook và URL, profile phải có quyền đăng.
- `group`: Facebook Group và URL.
- `default`: đích mặc định của profile trên nền tảng khác.

Ví dụ tạo nhóm:

```json
{
  "group_key": "sales-team-01",
  "name": "Nhóm bán hàng 01",
  "platform": "facebook",
  "members": [
    { "target_type": "profile", "profile_id": 11 },
    { "target_type": "profile", "profile_id": 12 },
    { "target_type": "fanpage", "profile_id": 11, "target_url": "https://facebook.com/page-a" }
  ]
}
```

`super_post_publish_group` nhận `identifier`, `batch_key` và nội dung/media chung, rồi tạo đúng
một job cho mỗi thành viên. Kết quả trả metadata nhóm cùng mảng job/permalink như batch thường.

## Chiến dịch đa nền tảng

Chiến dịch tham chiếu nhiều Nhóm đăng thuộc một hoặc nhiều nền tảng. Một lệnh
`super_post_publish_campaign` phát các nhóm độc lập song song và trả một `batch_id` cho mỗi
nhóm. Dữ liệu chung có thể được ghi đè theo nền tảng bằng `platform_overrides`. Concurrency và
delay của từng runner vẫn lấy từ Cài đặt Super Post King.

## Đăng một job

`super_post_publish` nhận một `profile`/`profile_id`, một target và trả `job_id`. Trường chung:
`request_id`, `platform`, `content`, `media`, `comments`, `custom_fields`, `wait_seconds`.

## Hẹn giờ qua MCP

MCP quản lý lịch bền vững bằng sáu tool list/get/create/update/set-enabled/delete. Lịch `once`
dùng ISO 8601, `daily` dùng `HH:mm`, `custom` dùng cron; daily/custom chạy theo
`Asia/Ho_Chi_Minh`. `schedule_key` chống tạo trùng khi client retry. Lịch tham chiếu các hàng
đang Chờ qua `data_ids`, hoặc `all_pending: true` nếu muốn lấy mọi hàng Chờ hiện tại và tương
lai. Với `data_ids`, từng hàng phải còn `pending` và `name_profile` phải khớp chính xác một trong
`profile_ids`; runner từ chối hoặc không chọn được hàng sẽ làm lịch `once` thành `error`, không báo
hoàn tất giả. Profile phải tồn tại trên đúng nền tảng. MCP không được truyền concurrency/delay.

## Đăng batch đa profile

```json
{
  "batch_key": "campaign-20260901-01",
  "platform": "facebook",
  "profile_ids": [2, 5],
  "distribution": "mapped",
  "items": [
    {
      "item_key": "row-1",
      "profile_id": 2,
      "content": "Bài cho Fanpage",
      "media": ["D:\\Media\\image.jpg"],
      "fanpages": ["https://www.facebook.com/page-a"]
    },
    {
      "item_key": "row-2",
      "profile_id": 5,
      "content": "Bài đăng timeline profile"
    }
  ],
  "wait_seconds": 300
}
```

`mapped` yêu cầu mỗi item xác định được đúng một profile. `all_profiles` chỉ dùng khi muốn đăng
cùng item trên mọi profile đã chọn. Với Facebook, có `fanpages` thì đăng Fanpage; không có
Fanpage/Group thì đăng timeline profile; `groups` tạo một job cho mỗi Group.

## Trường nền tảng

| Nền tảng | Trường |
|---|---|
| Facebook | `fanpage`, `fanpages`, `group`, `groups` |
| TikTok | `product_id`, `product_ids` |
| YouTube | `description`, `channel`, `channel_name`, `playlist`, `privacy_status`, `thumbnail`, `keywords` |
| Zalo Video | `playlist` |
| Threads, Instagram, X | trường chung |

Media phải là đường dẫn tuyệt đối tồn tại trên máy chạy tool. `custom_fields` ánh xạ biến tùy
chỉnh đã tồn tại trong bảng dữ liệu.

## REST

- `GET /api/agent/v1/capabilities`
- `GET /api/agent/v1/runtime-config?platform=facebook`
- `GET /api/agent/v1/data-schema?platform=facebook`
- `GET /api/agent/v1/profiles?platform=facebook`
- `GET /api/agent/v1/profile-groups?platform=facebook`
- `GET /api/agent/v1/targets?platform=facebook&profile_ids=2,5`
- `GET /api/agent/v1/platform-data?platform=facebook&status=pending&limit=200`
- `POST /api/agent/v1/platform-data`
- `POST /api/agent/v1/platform-data/batch`
- `DELETE /api/agent/v1/platform-data` (body `{platform, post_ids[]}`; từ chối hàng còn job chờ/chạy)
- `POST /api/agent/v1/runner/stop` (body `{platform, cancel_queued?}`; dừng runner ngay)
- `POST /api/agent/v1/assign-profiles`
- `POST /api/agent/v1/publish-data`
- `POST /api/agent/v1/publish-data-batch`
- `GET /api/agent/v1/publish-groups?platform=facebook`
- `POST /api/agent/v1/publish-groups`
- `GET /api/agent/v1/publish-groups/:identifier`
- `PUT /api/agent/v1/publish-groups/:identifier`
- `DELETE /api/agent/v1/publish-groups/:identifier`
- `GET /api/agent/v1/publish-campaigns`
- `POST /api/agent/v1/publish-campaigns`
- `GET /api/agent/v1/publish-campaigns/:identifier`
- `PUT /api/agent/v1/publish-campaigns/:identifier`
- `DELETE /api/agent/v1/publish-campaigns/:identifier`
- `GET /api/agent/v1/schedules`
- `POST /api/agent/v1/schedules`
- `GET /api/agent/v1/schedules/:identifier`
- `PUT /api/agent/v1/schedules/:identifier`
- `PATCH /api/agent/v1/schedules/:identifier/enabled`
- `DELETE /api/agent/v1/schedules/:identifier`
- `POST /api/agent/v1/publish`
- `POST /api/agent/v1/publish-batch`
- `GET /api/agent/v1/jobs/:jobId`
- `POST /api/agent/v1/jobs/:jobId/cancel` (chỉ job `queued`)
- `GET /api/agent/v1/batches/:batchId`

Mọi endpoint ngoài health yêu cầu `Authorization: Bearer <agent-api-key>`.

## Chống trùng và kết quả

`request_id` là khóa chống đăng trùng cho từng job. Batch MCP sinh ID ổn định từ `batch_key`,
`item_key`, platform, profile và target. Sau timeout dùng lại `job_id`/`batch_id`; không publish
lại.

Kết quả job nằm tại `result.link_post`, `result.time_post`, `result.note` và `error`. Kết quả
batch trả tổng số thành công/lỗi/đang chờ cùng mảng `jobs`. Trạng thái hỗn hợp là
`partial_success`.
