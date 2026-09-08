# Hợp đồng MCP Super Post King

## Tool MCP

- `super_post_get_capabilities`: trả nền tảng, trường dữ liệu, logic target/profile và chính
  sách thực thi.
- `super_post_get_runtime_config`: đọc concurrency, delay và giới hạn bài hiệu lực từ Cài đặt
  của tool; agent không được ghi đè.
- `super_post_get_data_schema`: đọc các cột hệ thống/custom thực tế của nền tảng trong tool.
- `super_post_list_profiles`: chỉ xác minh profile đã có trong manifest.
- `super_post_publish`: một profile, một target, một job.
- `super_post_publish_batch`: một/nhiều profile, item và target; chạy chung một runner đa luồng.
- `super_post_publish_data`: tạo job cho đúng một hàng `pending` đã có bằng `post_id`.
- `super_post_publish_data_batch`: tạo một batch cho nhiều hàng `pending` đã có, không tạo bản sao.
- `super_post_get_publish_group`: đọc preset Nhóm đăng đã chuẩn bị.
- `super_post_publish_group`: dùng một nội dung chung và tạo một job cho mỗi thành viên nhóm.
- `super_post_get_publish_campaign`: đọc preset đa nền tảng đã chuẩn bị.
- `super_post_publish_campaign`: chạy mọi Nhóm đăng trong Chiến dịch và gom kết quả từng batch.
- `super_post_get_job` / `super_post_get_batch`: theo dõi kết quả mà không publish lại.
- `super_post_wait_job`: chờ một job kết thúc trong cùng request, không polling liên tục.
- `super_post_wait_events`: nhận các sự kiện mới sau `event_id` và tiếp tục được sau khi mất kết nối.
- `super_post_list_schedules` / `super_post_get_schedule`: đọc lịch hẹn.
- `super_post_create_schedule` / `super_post_update_schedule`: tạo hoặc sửa lịch bền vững.
- `super_post_set_schedule_enabled` / `super_post_delete_schedule`: bật, tắt hoặc xóa đúng lịch.

Nền tảng: `facebook`, `tiktok`, `youtube`, `threads`, `instagram`, `x`, `zalovideo`.

## Hẹn giờ

Lịch chạy trên các hàng đang Chờ đã có trong bảng dữ liệu:

```json
{
  "schedule_key": "facebook-evening-20260905",
  "name": "Facebook tối 05/09",
  "platform": "facebook",
  "schedule_type": "once",
  "schedule_time": "2026-09-05T20:00:00+07:00",
  "profile_ids": [2],
  "data_ids": [42, 43],
  "enabled": true
}
```

`once` dùng ISO 8601; `daily` dùng `HH:mm`; `custom` dùng `cron_expr`. Lịch daily/custom chạy
theo `Asia/Ho_Chi_Minh`. Có thể thay `data_ids` bằng `all_pending: true` khi người dùng cho phép
chạy mọi hàng Chờ, kể cả hàng được thêm sau. `schedule_key` là khóa idempotency; không gửi
concurrency/delay vì API lấy từ Cài đặt của app.

Với `data_ids`, mỗi hàng phải còn `pending` và `name_profile` phải khớp chính xác một profile
trong `profile_ids`. Runner trả `success: false` làm lịch `once` thành `error`, không được coi là
đã hoàn tất. `all_pending` đang bật sẽ chặn create/assign cùng profile trừ khi người dùng xác nhận
và truyền `allow_scheduled_consumption: true`.

Việc xem nhóm profile/target/dữ liệu và đổi `name_profile` thuộc
`$super-post-profile-mapper`. Tạo/sửa/xóa Nhóm đăng cũng thuộc mapper. Skill đăng không gọi
`super_post_assign_profiles` hoặc các tool CRUD Nhóm đăng.

## Chiến dịch đa nền tảng

```json
{
  "identifier": "launch-all-channels",
  "campaign_key": "launch-run-20260901-01",
  "content": "Nội dung chung",
  "media": ["C:\\Media\\image.jpg"],
  "platform_overrides": {
    "tiktok": { "product_ids": ["sku-1"] },
    "youtube": { "content": "Tiêu đề YouTube", "description": "Mô tả" }
  },
  "wait_seconds": 300
}
```

Mỗi Nhóm đăng tạo một batch riêng. Các nền tảng được phát lệnh song song; cùng một nền tảng xếp
hàng an toàn trong runner của nền tảng đó. Kết quả trả mảng `groups`, mỗi phần tử có `batch_id`.
Sau timeout chỉ theo dõi các batch này, không gọi lại lệnh đăng Chiến dịch.

## Đăng preset Nhóm đăng

```json
{
  "identifier": "sales-team-01",
  "platform": "facebook",
  "batch_key": "campaign-20260901-01",
  "content": "Một nội dung dùng chung",
  "media": ["C:\\Media\\image.jpg"],
  "wait_seconds": 300
}
```

Mỗi thành viên đã lưu tạo một job. Thành viên `profile` đăng timeline, `fanpage` đăng URL
Fanpage, `group` đăng URL Facebook Group. Kết quả vẫn dùng cùng schema batch và trả thêm metadata
`publish_group`.

## Batch schema

```json
{
  "batch_key": "campaign-20260901-01",
  "platform": "facebook",
  "profile_ids": [2, 5],
  "distribution": "mapped",
  "items": [
    {
      "item_key": "row-42",
      "profile_id": 2,
      "content": "Nội dung hoàn chỉnh",
      "media": ["C:\\Media\\image.jpg"],
      "fanpages": ["https://www.facebook.com/page-a"],
      "comments": ["Bình luận 1"]
    }
  ],
  "wait_seconds": 300
}
```

Không truyền `concurrency`, delay, giới hạn bài hay timeout thao tác. API lấy các giá trị này từ
Cài đặt Super Post King lúc runner bắt đầu.

## Đăng dữ liệu đã có

```json
{
  "platform": "facebook",
  "batch_key": "existing-rows-20260904",
  "items": [
    { "item_key": "row-42", "post_id": 42 },
    { "item_key": "row-43", "post_id": 43 }
  ],
  "wait_seconds": 300
}
```

Dùng `super_post_publish_data` cho một `post_id` và `super_post_publish_data_batch` cho nhiều
hàng. API giữ nguyên ID hàng, chỉ thêm `agent_jobs`, kiểm tra trạng thái `pending`, mapping
`name_profile` và job active. Retry cùng `request_id` hoặc `batch_key`/`item_key` trả job cũ.

## Mapping profile

- Mỗi item có `profile`/`profile_id`: `distribution: mapped`.
- Cấp batch chỉ có một profile: mọi item chưa mapping dùng profile đó.
- Đăng cùng item trên mọi profile đã chọn: `distribution: all_profiles` và phải do người dùng
  yêu cầu rõ.
- Có nhiều profile nhưng item chưa mapping: trả `BATCH_PROFILE_MAPPING_REQUIRED`.

MCP hiện thực batch thành các hàng có `name_profile`, rồi gọi một runner với nhiều
`profileIds`/`dataIds`. Profile khác nhau chạy đồng thời theo `max_concurrency`; các bài của cùng
một profile chạy tuần tự. Nếu tool giới hạn số bài mỗi profile/lượt, batch chạy thành nhiều wave.

## Logic Facebook

| Input item | Payload/job được mở rộng | Đích |
|---|---|---|
| `fanpage` hoặc `fanpages` | một job cho mỗi URL, `group: ""` | Fanpage |
| `group` hoặc `groups` | một job cho mỗi URL, `fanpage: ""` | Group |
| không có cả hai | cả hai trường rỗng | Timeline profile |

Không nhét nhiều URL vào một chuỗi. Không trộn Fanpage và Group trong cùng item. Nhiều profile
và nhiều target chỉ tạo tích Descartes khi người dùng chọn `all_profiles`; nếu không phải mapping
rõ từng item.

## Ánh xạ dữ liệu tool ↔ MCP

| Tool | MCP |
|---|---|
| `name_profile` | `profile` / `profile_id` |
| `content` | `content` |
| `image_path` | `media` |
| `link_fanpage` | `fanpage` / `fanpages` |
| `post_group` | `group` / `groups` |
| `product_id` | `product_id` / `product_ids` |
| `description` | `description` |
| `channel_name` | `channel` / `channel_name` |
| `playlist` | `playlist` |
| `privacy_status` | `privacy_status` |
| `thumbnail` | `thumbnail` |
| `keywords` | `keywords` |
| cột bình luận | `comments` |
| cột biến tùy chỉnh đã tồn tại | `custom_fields` |

`custom_fields` chỉ gán vào cột custom đã tồn tại trong tool. Các trường hệ thống được MCP ánh
xạ rõ ràng có quyền ưu tiên. Không truyền `Hook` riêng nếu `content` đã chứa Hook.

## Request ID và chống trùng

Mỗi item cần `item_key` và batch cần `batch_key` ổn định. MCP sinh `request_id` từ batch, item,
platform, profile và target; target URL dùng SHA-256 rút gọn. Gọi lại cùng payload trả batch/job
cũ. Sau timeout luôn dùng `batch_id` với `super_post_get_batch`.

## Kết quả

```yaml
batch_id: batch_...
status: queued | running | success | partial_success | error
total: 4
success_count: 3
error_count: 1
pending_count: 0
jobs:
  - item_key: row-42
    profile: super-1
    target_type: fanpage
    target_url: https://www.facebook.com/page-a
    job_id: job_...
    status: success
    result:
      link_post: https://www.facebook.com/...
      time_post: 02:29:20 1/9/2026
```

`queued`/`running`: chưa ghi link. `success` có `link_pending: true`: bài đã được nền tảng nhận,
Super Post King đang tự dò permalink; tiếp tục gọi get job/batch và không publish lại. Chỉ dùng
`NEEDS_REVIEW` khi `link_recovery_status: expired` hoặc khi `success` thiếu `link_post` và không
có trạng thái recovery. `expired` chỉ dừng dò link, không phải lỗi đăng. Batch có cả thành công
và lỗi: `PARTIAL_SUCCESS`; không publish lại toàn batch.

## Cấu hình khách hàng tùy chọn

```yaml
super_post:
  profile_id: 12
  profile: "Profile 01"
  profile_ids: [12, 18]
  profiles: ["Profile 01", "Profile 02"]
```

Ưu tiên ID. Nếu ID/tên không tồn tại trên nền tảng, dừng; không âm thầm đổi profile.
