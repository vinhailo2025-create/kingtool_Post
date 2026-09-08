---
name: post-face-super-post
description: "Đăng một hoặc nhiều bài đã được mapping qua Super Post King bằng MCP cho Facebook, TikTok, YouTube, Threads, Instagram, X và Zalo Video; dùng để gửi job/batch, theo dõi và trả link/kết quả về agent."
---

# Đăng qua Super Post King

Nhận dữ liệu đã được chuẩn bị với mỗi hàng/bài thuộc đúng một profile. Dùng
`super_post_publish` cho một hàng độc lập; dùng
`super_post_publish_batch` khi có nhiều hàng, nhiều profile hoặc nhiều target.
Nếu dữ liệu đã tồn tại trong bảng và manifest có `post_id`, dùng
`super_post_publish_data` cho một hàng hoặc `super_post_publish_data_batch` cho nhiều hàng để
không tạo bản sao.

Với Facebook `full_workflow`, giữ phần chọn hàng Excel, tạo nội dung và tạo ảnh của
`C:\Users\Admin\.claude\skills\post-face-chrome\SKILL.md`. Đọc đầy đủ skill nguồn, chỉ chạy
tới `CONTENT_READY`, rồi thay bước điều khiển Chrome/bấm Đăng bằng MCP Super Post King.

## Ranh giới bắt buộc

- Không dùng trình duyệt để đăng khi MCP lỗi hoặc tool chưa mở.
- Không đổi `name_profile`, quản lý nhóm profile hoặc khám phá target trong skill này. Khi mapping
  thiếu hoặc cần thay đổi, dùng `$super-post-profile-mapper` trước.
- Không gọi `super_post_assign_profiles`.
- Không gọi create/update/delete Nhóm đăng. Khi cần thay đổi thành viên, dùng
  `$super-post-profile-mapper` trước.
- Không gọi create/update/delete Chiến dịch đăng. Khi cần thay đổi danh sách nhóm, dùng mapper.
- Không gọi lại publish vì timeout. Giữ `job_id`/`batch_id`; ưu tiên `super_post_wait_job` hoặc
  notification realtime, chỉ dùng `super_post_get_job`/`super_post_get_batch` khi cần đọc tức thời.
- Job `success` có `link_pending: true` nghĩa là Facebook đã nhận bài và tool đang tự dò
  permalink. Chỉ đọc lại job/batch; tuyệt đối không publish hoặc retry target đó.
- `link_recovery_status: expired` nghĩa là tool đã dừng tự dò sau giới hạn an toàn. Giữ nguyên
  kết quả bài đã đăng, báo người dùng kiểm tra Group hoặc bấm dò lại thủ công; không publish lại.
- Không tự nhân một bài lên nhiều profile. Chỉ fan-out khi người dùng nói rõ “tất cả profile”
  hoặc từng item đã có mapping.
- Agent không đặt hay ghi đè concurrency, delay, giới hạn bài, timeout thao tác hoặc chống bot.
  Các giá trị này luôn lấy từ mục Cài đặt của Super Post King.
- Chỉ ghi link/thời gian vào nguồn khi job `success` và có permalink hợp lệ. Không ghi đè một ô
  bằng nhiều link khi một hàng fan-out thành nhiều job.
- Đăng là thay đổi bên ngoài. Nếu yêu cầu hiện tại đã nói rõ “đăng”, “đăng ngay” hoặc xác nhận
  batch cụ thể thì được publish; nếu chưa, hỏi một lần ngay trước khi gửi.
- Tạo hoặc bật lịch là ủy quyền đăng trong tương lai. Chỉ gọi tool ghi lịch khi người dùng nói rõ
  muốn hẹn giờ; xem lịch bằng list/get là chỉ đọc.

## Chế độ và đầu vào

- `full_workflow`: có workbook hoặc `workflow_key`; phần chuẩn bị nguồn hiện áp dụng cho
  Facebook và giữ `source_row_id`, `Hook`, `Noi_dung`, `hinh_anh`.
- `publish_only`: nhận dữ liệu đã chuẩn bị cho bất kỳ nền tảng hỗ trợ nào; không viết lại nội
  dung nếu người dùng không yêu cầu.
- `publish_existing`: nhận các `post_id` đang `pending` và đã có `name_profile`; chỉ tạo job cho
  đúng hàng hiện có, không gửi lại content/media để tạo hàng mới.
- `publish_group`: nhận `identifier` của Nhóm đăng và một nội dung/media dùng chung; không thay
  đổi thành viên nhóm.
- `publish_campaign`: nhận `identifier` của Chiến dịch, nội dung chung và tùy chọn dữ liệu ghi đè
  theo nền tảng; không thay đổi cấu hình Chiến dịch.
- Chấp nhận `profile`/`profile_id` dạng đơn hoặc `profiles`/`profile_ids` dạng danh sách. Chuỗi
  nhiều dòng hoặc phân tách bằng dấu phẩy phải được chuẩn hóa và loại trùng.
- Với batch, mỗi `item` có thể chứa `profile`/`profile_id` riêng; đây là mapping tương đương cột
  `name_profile` trong tool.

## Xác nhận đầu vào và cài đặt

1. Gọi `super_post_get_capabilities` khi cần biết trường/logic nền tảng hiện được MCP hỗ trợ.
2. Gọi `super_post_get_data_schema(platform)` khi cần xác nhận trường của manifest.
3. Gọi `super_post_get_runtime_config(platform)` khi cần báo hoặc kiểm tra concurrency, delay và
   giới hạn bài đang có hiệu lực. Chỉ đọc; không yêu cầu agent truyền các giá trị này vào publish.
4. Có thể gọi `super_post_list_profiles(platform)` để xác minh lần cuối ID/tên đã có trong
   manifest, nhưng không chọn lại hoặc đổi mapping.

## Yêu cầu đối với manifest profile

Mapping phải được người dùng cung cấp hoặc được `$super-post-profile-mapper` bàn giao.

- Một profile đã chọn: gán cho mọi item chưa mapping.
- Nhiều profile và từng item đã mapping: dùng `distribution: mapped`.
- Người dùng nói rõ đăng cùng dữ liệu trên tất cả profile: dùng `distribution: all_profiles`.
- Nhiều profile nhưng item chưa mapping và chưa cho phép fan-out: dừng với
  `PROFILE_MAPPING_REQUIRED`; không tự zip hay round-robin.
- Chưa chọn profile hoặc cần đổi profile: trả `PROFILE_REQUIRED`/`PROFILE_MAPPING_REQUIRED` và
  chuyển sang mapper; không tự chọn trong skill đăng.

Không dùng tên Fanpage, tên kênh hoặc `browser.profile_key` để đoán profile Super Post.

## Đăng Nhóm đăng đã lưu

1. Gọi `super_post_get_publish_group(identifier, platform?)` để xác nhận đúng nhóm và hiển thị
   các đích trước khi đăng nếu yêu cầu chưa đủ rõ.
2. Khi người dùng đã yêu cầu đăng, gọi `super_post_publish_group` với `identifier`, `batch_key`
   ổn định, nội dung/media chung và `wait_seconds`.
3. MCP tạo đúng một job cho mỗi thành viên. Profile khác nhau có thể chạy đồng thời; nhiều đích
   dùng cùng profile chạy tuần tự theo cài đặt tool.
4. Giữ `batch_id` và theo dõi bằng `super_post_get_batch` nếu còn queued/running. Không gọi lại
   `super_post_publish_group` sau timeout.

Không tự thêm/bớt thành viên trong lúc đăng. Nếu nhóm sai, dừng và chuyển sang mapper để cập nhật.

## Đăng Chiến dịch đa nền tảng

1. Gọi `super_post_get_publish_campaign(identifier)` để xác nhận tên, nền tảng và các Nhóm đăng.
2. Gọi đúng một lần `super_post_publish_campaign` với `identifier`, `campaign_key` ổn định, dữ
   liệu chung, `platform_overrides` nếu cần và `wait_seconds`.
3. MCP khởi động các nhóm/nền tảng độc lập song song. Mỗi Nhóm đăng trả một `batch_id`; runner
   của từng nền tảng vẫn áp dụng concurrency/delay trong Cài đặt Super Post King.
4. Khi còn queued/running hoặc timeout, lưu toàn bộ `batch_id` và gọi `super_post_get_batch` cho
   từng batch. Không gọi lại `super_post_publish_campaign`.

`platform_overrides` ghi đè dữ liệu chung chỉ cho nền tảng tương ứng, ví dụ tiêu đề/mô tả
YouTube hoặc `product_ids` TikTok. Một nhóm lỗi không làm mất kết quả của các nhóm khác.

## Đích đăng Facebook

- Có `fanpage`/`fanpages`: loại trùng và tạo một job cho mỗi URL Fanpage; `group` để trống.
- Không có Fanpage và Group: để cả `fanpage` và `group` trống; tool đăng timeline profile.
- Có `group`/`groups`: tạo một job cho mỗi URL Group; `fanpage` để trống.
- Không trộn Fanpage và Group trong cùng item. Khi nhiều profile đi cùng nhiều target, phải có
  mapping item hoặc chỉ dẫn `all_profiles`; không suy đoán cặp theo thứ tự.

## Dữ liệu theo nền tảng

- Chung: `content`, `media`, `comments`, `custom_fields`.
- Facebook: `fanpage`/`fanpages`, `group`/`groups`.
- TikTok: `product_id`/`product_ids`.
- YouTube: `content` là tiêu đề, cùng `description`, `channel`/`channel_name`, `playlist`,
  `privacy_status`, `thumbnail`, `keywords`.
- Zalo Video: `playlist`.
- Threads, Instagram, X: dùng dữ liệu chung; không tạo khái niệm Fanpage.

Media/thumbnail/comment media phải là đường dẫn tuyệt đối tồn tại trên máy chạy Super Post King.
Đọc [references/super-post-contract.md](references/super-post-contract.md) trước batch đa
profile/target hoặc khi dùng trường riêng nền tảng.

## Chạy và theo dõi

1. Chuẩn hóa dữ liệu thành manifest không mơ hồ; mỗi item có `item_key` ổn định.
2. Nếu manifest chứa hàng có `post_id`, gọi `super_post_publish_data` hoặc
   `super_post_publish_data_batch` với `batch_key` ổn định. Hàng phải còn `pending`, không có job
   active và `name_profile` phải khớp chính xác profile thật. Không thay bằng tool publish thường.
3. Dùng `super_post_publish_campaign` cho preset đa nền tảng, `super_post_publish_group` cho
   preset một nền tảng; nếu không dùng preset và không có `post_id` thì gọi
   `super_post_publish_batch` với `batch_key`, `platform`, danh sách profile, `distribution`,
   `items` và `wait_seconds`. Không truyền cài đặt runner.
4. MCP mở rộng mỗi cặp item–profile–target thành một request có ID chống trùng, sau đó gửi toàn
   bộ vào một batch của runner. Các profile chạy đồng thời theo cài đặt tool; bài trong cùng một
   profile chạy tuần tự.
5. Nếu trả `queued`, `running` hoặc timeout, giữ `batch_id` và chỉ gọi
   `super_post_get_batch`.
   `max_posts_per_profile` chỉ giới hạn số bài của một profile trong mỗi lượt runner. Các job
   còn `queued` tự chạy ở lượt kế tiếp sau khoảng `delay_min`–`delay_max`; không gọi đây là bị
   chặn và không gửi lại batch.
6. Thu kết quả từng job. Một job lỗi không được làm publish lại các job đã thành công.
7. Với Excel: một hàng–một job thì cập nhật đúng hàng. Nếu một hàng fan-out nhiều job, chỉ cập
   nhật khi workbook có hàng/cột kết quả riêng; nếu không, trả manifest và giữ nguồn nguyên vẹn.

## Hẹn giờ

- Dùng `super_post_list_schedules`/`super_post_get_schedule` để đọc lịch.
- Dùng `super_post_create_schedule` khi người dùng đã chỉ rõ thời gian, nền tảng, profile và
  `data_ids`; chỉ dùng `all_pending: true` khi người dùng cho phép chạy mọi hàng đang Chờ.
- Với `data_ids`, từng hàng phải còn `pending` và `custom_fields.name_profile` phải khớp chính
  xác một profile trong `profile_ids`; không tạo lịch khi mapping thiếu hoặc lệch.
- Nếu dữ liệu chưa có trong tool, dùng `$super-post-profile-mapper` để tạo hàng Đợi trước, lấy
  `post_id`, rồi mới tạo lịch. Không dùng publish để thay cho bước tạo dữ liệu.
- `once` nhận thời gian ISO 8601 trong tương lai; `daily` nhận `HH:mm`; `custom` nhận cron.
  `daily` và `custom` chạy theo `Asia/Ho_Chi_Minh`.
- Mỗi lần tạo phải có `schedule_key` ổn định. Gọi lại cùng khóa và cùng dữ liệu trả lịch cũ;
  cùng khóa nhưng khác dữ liệu là lỗi, không tạo lịch thứ hai.
- Không truyền concurrency hoặc delay. Agent API lấy các giá trị này từ Cài đặt Super Post King.
- Dùng `super_post_update_schedule`, `super_post_set_schedule_enabled` hoặc
  `super_post_delete_schedule` chỉ với lịch người dùng xác định rõ. Sau thay đổi phải gọi get để
  xác nhận trạng thái.
- Lịch `daily`/`custom` với `all_pending: true` có thể lấy các hàng Chờ được thêm sau này; phải
  nói rõ phạm vi này cho người dùng. Tắt/mở app không làm mất lịch.
- Khi thêm/gán hàng cho profile có lịch `all_pending` đang bật, không tự truyền
  `allow_scheduled_consumption: true`; chỉ dùng sau khi người dùng xác nhận lịch được phép lấy hàng.

## Chạy lại job đã lỗi

- Chỉ chạy lại khi job đã ở trạng thái cuối `error` và người dùng xác nhận chạy lại.
- Tạo batch mới chỉ chứa đúng các target lỗi; không gửi lại target đã `success`.
- Dùng `batch_key` mới dạng `<batch_key_cũ>:retry:<lần>` và giữ khóa đó ổn định trong suốt lần
  retry. Không dùng lại `request_id` của job lỗi vì server sẽ trả nguyên kết quả cũ theo cơ chế
  chống trùng.
- Nếu retry bị timeout hoặc còn `queued`/`running`, tiếp tục lấy trạng thái batch retry; không tăng
  số `<lần>` và không gửi thêm batch.
- Báo cả `batch_id` cũ và batch retry để người dùng phân biệt lỗi lịch sử với kết quả mới.

## Kết quả trả về

```yaml
status: READY_TO_PUBLISH | SUBMITTED | PARTIAL_SUCCESS | POSTED | NEEDS_REVIEW | PROFILE_REQUIRED | PROFILE_MAPPING_REQUIRED | TOOL_UNAVAILABLE | FAILED
batch_key: ""
batch_id: ""
platform: ""
runtime_config:
  concurrency: 0
  delay_min: 0
  delay_max: 0
jobs:
  - item_key: ""
    request_id: ""
    job_id: ""
    profile_id: 0
    profile: ""
    target_type: profile | fanpage | group | default
    target_url: ""
    status: queued | running | success | error
    link_pending: false
    link_recovery_status: waiting | running | success | expired | null
    post_url: ""
    posted_at: ""
    error: ""
```

Dùng `POSTED` khi mọi job thành công và có link; `PARTIAL_SUCCESS` khi có cả thành công và lỗi;
`SUBMITTED` khi còn job `queued`/`running` hoặc có job `success` nhưng `link_pending: true`.
Với link pending, tiếp tục gọi get job/batch cho tới khi `link_recovery_status` thành `success`
hoặc `expired`; không đăng lại. `expired` chỉ kết thúc việc tự dò link, không biến bài đã được
Facebook nhận thành lỗi đăng. Chỉ kết luận nguyên nhân đăng thất bại khi job đã thành `error` và
có trường `error`; không suy lỗi từ trạng thái `queued`. Báo rõ từng profile, target và permalink.
