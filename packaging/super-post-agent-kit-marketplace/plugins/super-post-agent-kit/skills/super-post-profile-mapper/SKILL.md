---
name: super-post-profile-mapper
description: "Đọc và quản lý profile, Nhóm đăng, Chiến dịch đa nền tảng, nhóm profile, Fanpage, Group, kênh và dữ liệu trong Super Post King qua MCP; dùng khi cần tạo/sửa đích hoặc đổi mapping mà chưa đăng bài."
---

# Profile và target Super Post King

Chuẩn bị một manifest rõ ràng cho skill đăng. Skill này chỉ đọc dữ liệu hoặc đổi mapping
`name_profile` trong Super Post King; tuyệt đối không đăng bài.

## Ranh giới bắt buộc

- Không gọi `super_post_publish`, `super_post_publish_batch`, `super_post_publish_data` hoặc
  `super_post_publish_data_batch` trong skill này.
- Không gọi `super_post_publish_group`; tạo/sửa Nhóm đăng không phải là lệnh đăng.
- Không gọi `super_post_publish_campaign`; tạo/sửa Chiến dịch không phải là lệnh đăng.
- Việc xem profile, nhóm, target, schema và dữ liệu là chỉ đọc.
- Chỉ gọi `super_post_create_data`/`super_post_create_data_batch` khi người dùng yêu cầu thêm dữ
  liệu vào tool. Hai tool này chỉ tạo hàng `pending`, không tạo job và không chạy đăng.
- Chỉ gọi `super_post_assign_profiles` khi người dùng yêu cầu đổi/gán profile cho các hàng cụ thể.
- Không đổi mapping của bài đang thuộc job `queued` hoặc `running`; trả nguyên lỗi từ tool.
- Không tự zip, round-robin hay nhân bài sang mọi profile nếu người dùng chưa nói rõ.
- Không sửa concurrency, delay, giới hạn bài hoặc thiết lập runner. Skill chỉ có thể đọc các giá
  trị đó từ `super_post_get_runtime_config`.

## Khám phá dữ liệu

1. Gọi `super_post_get_capabilities` khi cần xác định nền tảng và trường hỗ trợ.
2. Gọi `super_post_list_profiles(platform)` để lấy ID, tên, trạng thái và nhóm của profile.
3. Khi người dùng chọn nhóm profile, gọi `super_post_list_profile_groups(platform)` và dùng
   đúng danh sách thành viên mà tool trả về.
4. Gọi `super_post_list_targets(platform, profile_ids?)` để đọc Fanpage/kênh đã quét và Group
   Facebook đã lưu. Không đoán target từ tên profile.
5. Gọi `super_post_get_data_schema(platform)` và
   `super_post_list_platform_data(platform, status?, limit?)` để đọc hàng/cột thực tế.
6. Chỉ khi cần báo cài đặt đang có hiệu lực, gọi `super_post_get_runtime_config(platform)`.

Khi người dùng hỏi danh sách hoặc số lượng Fanpage:

- Chỉ `managed_targets` từ `super_post_list_targets(platform: facebook)` là danh mục Fanpage
  đã quét; `saved_groups` là Facebook Group, không phải Fanpage.
- Link trong `super_post_list_platform_data` chỉ chứng minh Fanpage từng xuất hiện trong dữ liệu
  bài đăng. Không gọi chúng là toàn bộ Fanpage và không thay thế danh mục target bằng nguồn này.
- Nêu rõ số profile đã có target và thời điểm `checked_at`. Nếu chưa quét đủ profile, nói đây là
  danh mục chưa đầy đủ và hướng dẫn cập nhật trong Super Post King.

## Thêm dữ liệu vào trạng thái Đợi

- Một hàng dùng `super_post_create_data`; nhiều hàng cùng nền tảng dùng
  `super_post_create_data_batch`.
- Mỗi hàng phải có `data_key` ổn định và `content` hoặc `media`. Gọi lại cùng khóa/cùng dữ liệu
  trả hàng cũ; cùng khóa nhưng khác dữ liệu là lỗi.
- Profile có thể chưa gán. Nếu truyền `profile`/`profile_id`, MCP phải xác minh đúng profile của
  nền tảng; không suy đoán hoặc tự phân phối.
- Mỗi hàng Facebook chỉ có tối đa một `fanpage` hoặc một `group`; muốn nhiều đích phải tạo nhiều
  item với `data_key` khác nhau.
- Batch là transaction: một item sai thì không tạo item nào. Không trộn `data_key` cũ và mới
  trong cùng batch.
- Nếu tool trả `AGENT_DATA_ACTIVE_ALL_PENDING_SCHEDULE`, báo đúng lịch trong lỗi và dừng. Chỉ
  truyền `allow_scheduled_consumption: true` khi người dùng đã xác nhận muốn lịch `all_pending`
  đang bật lấy các hàng mới này; không tự bật cờ.
- Kết quả bắt buộc có `status: pending`, `job_created: false`, `runner_started: false`. Đây là
  hàng Đợi trong bảng dữ liệu, hoàn toàn khác job `queued` đã được gửi vào runner.
- Muốn đăng sau đó phải có yêu cầu publish riêng hoặc tạo lịch riêng bằng các `post_id` vừa trả
  về. Skill đăng phải dùng `super_post_publish_data`/`super_post_publish_data_batch` cho các
  `post_id` này để không tạo bản sao. Không tự nối bước tạo dữ liệu với bước đăng.
- `super_post_delete_data` xóa hàng theo `post_ids` và không hoàn tác được: chỉ gọi khi người
  dùng nêu rõ đúng các `post_id` cần xóa, sau khi đã liệt kê lại cho họ thấy. Tool từ chối hàng
  còn job `queued`/`running` (`AGENT_POST_JOB_ACTIVE`); phải hủy job hoặc dừng runner trước, không
  tự làm thay.

## Nhóm đăng tái sử dụng

Nhóm đăng là một preset đích, khác với nhóm profile. Nó có thể chứa nhiều thành viên; mỗi thành
viên luôn ghi rõ profile thực thi và một `target_type`:

- `profile`: timeline của profile.
- `fanpage`: Fanpage Facebook, cần `target_url` và profile có quyền đăng.
- `group`: Facebook Group, cần `target_url` và profile dùng để đăng.
- `default`: đích mặc định của profile trên nền tảng khác.

Dùng các MCP tool:

- `super_post_list_publish_groups` và `super_post_get_publish_group` để đọc.
- `super_post_create_publish_group` khi người dùng yêu cầu tạo nhóm.
- `super_post_update_publish_group` khi người dùng yêu cầu đổi tên/thành viên.
- `super_post_delete_publish_group` chỉ khi người dùng yêu cầu xóa đúng nhóm.

Trước khi ghi, xác minh profile bằng `super_post_list_profiles` và target bằng
`super_post_list_targets`. Không suy đoán profile sở hữu Fanpage. Sau khi ghi, đọc lại nhóm và
trả `group_key`, tên cùng toàn bộ thành viên. Đọc
[references/profile-target-contract.md](references/profile-target-contract.md) trước khi tạo hoặc
sửa Nhóm đăng nhiều loại target.

Ví dụ hai timeline và một Fanpage:

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

## Chiến dịch đăng đa nền tảng

Chiến dịch là preset cấp cao tham chiếu một hoặc nhiều Nhóm đăng đã lưu. Mỗi Nhóm đăng vẫn chỉ
thuộc một nền tảng, nhưng một Chiến dịch có thể kết hợp Facebook, TikTok, YouTube, Threads,
Instagram, X và Zalo Video.

- Dùng `super_post_list_publish_campaigns` và `super_post_get_publish_campaign` để đọc.
- Dùng `super_post_create_publish_campaign`, `super_post_update_publish_campaign` và
  `super_post_delete_publish_campaign` chỉ khi người dùng yêu cầu quản lý cấu hình.
- Xác minh từng Nhóm đăng trước khi tạo. Ưu tiên `group_key`; thêm `platform` nếu tên có thể mơ hồ.
- Xóa Chiến dịch không xóa các Nhóm đăng bên dưới.

```json
{
  "campaign_key": "launch-all-channels",
  "name": "Ra mắt tất cả kênh",
  "publish_groups": [
    { "identifier": "launch-facebook", "platform": "facebook" },
    { "identifier": "launch-tiktok", "platform": "tiktok" }
  ]
}
```

## Chọn và mapping

- Một profile được chọn: có thể áp dụng cho mọi `post_id` người dùng chỉ rõ.
- Nhiều profile: từng `post_id` phải có profile cụ thể, trừ khi người dùng yêu cầu rõ một kiểu
  phân phối khác để chuẩn bị manifest.
- Nhóm profile: mở rộng thành các `profile_id` thành viên, không dùng tên nhóm làm tên profile.
- Dùng `profile_id` khi có thể. Nếu chỉ có tên, tên phải khớp duy nhất trong nền tảng.
- Facebook có link Fanpage thì target là Fanpage; có link Group thì target là Group; không có cả
  hai thì target là timeline profile. Không trộn Fanpage và Group trong một item.
- Các nền tảng khác dùng profile/kênh và trường đúng schema tool; không tạo khái niệm Fanpage.

Để ghi mapping vào dữ liệu tool, gọi một lần:

```json
{
  "platform": "facebook",
  "assignments": [
    { "post_id": 42, "profile_id": 2 },
    { "post_id": 43, "profile": "super-1" }
  ]
}
```

Sau khi tool trả thành công, đọc lại các hàng liên quan và xác nhận `custom_fields.name_profile`.
Thao tác này không tạo job và không gửi dữ liệu ra nền tảng.
Nếu có lịch `all_pending` cùng profile đang bật, không truyền `allow_scheduled_consumption: true`
trừ khi người dùng xác nhận hàng vừa gán được phép đi vào lịch đó.

Đọc [references/profile-target-contract.md](references/profile-target-contract.md) khi có nhiều
profile, nhiều target hoặc cần bàn giao cho skill đăng.

## Bàn giao cho skill đăng

Trả manifest có mapping tường minh:

```yaml
status: MAPPED | PREVIEW | PROFILE_REQUIRED | PROFILE_MAPPING_REQUIRED | FAILED
platform: facebook
profile_group: ""
publish_group:
  id: 0
  group_key: ""
  name: ""
publish_campaign:
  id: 0
  campaign_key: ""
  name: ""
items:
  - item_key: row-42
    post_id: 42
    profile_id: 2
    profile: super-1
    target_type: profile | fanpage | group | default
    target_url: ""
mapping_written: false
data_created: false
```

Nếu người dùng tiếp tục yêu cầu đăng, bàn giao manifest cho `$post-face-super-post`. Skill đăng
chịu trách nhiệm publish, theo dõi job và trả link; mapper không làm các bước đó.
