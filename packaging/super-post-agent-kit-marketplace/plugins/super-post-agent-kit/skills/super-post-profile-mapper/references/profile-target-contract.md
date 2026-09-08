# Hợp đồng profile và target

## MCP chỉ dùng trong mapper

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
- `super_post_list_publish_groups`
- `super_post_get_publish_group`
- `super_post_create_publish_group`
- `super_post_update_publish_group`
- `super_post_delete_publish_group`
- `super_post_list_publish_campaigns`
- `super_post_get_publish_campaign`
- `super_post_create_publish_campaign`
- `super_post_update_publish_campaign`
- `super_post_delete_publish_campaign`

Không gọi `super_post_publish`, `super_post_publish_batch`, `super_post_publish_group`,
`super_post_publish_data`, `super_post_publish_data_batch`, `super_post_publish_campaign`,
`get_job`, `get_batch` hoặc `cancel_job` từ mapper.

## Hợp đồng dữ liệu Đợi

`super_post_create_data` tạo một hàng; `super_post_create_data_batch` tạo 1-500 hàng atomically
trong một nền tảng. Mỗi item cần `data_key` dài 3-160 ký tự cùng `content` hoặc đường dẫn `media`
tuyệt đối có thật trên máy chạy Super Post King.

Hai tool chỉ ghi `posts.status = pending`, không ghi `agent_jobs` và không gọi runner. `data_key`
là khóa idempotency trong từng nền tảng. Gọi lại toàn bộ batch với cùng khóa/cùng payload trả
đúng các `post_id` cũ; dùng lại khóa với payload khác hoặc trộn khóa cũ/mới trong một batch là
lỗi và không ghi dở dữ liệu.

Profile là tùy chọn trong bước chuẩn bị. Nếu đã truyền thì phải khớp profile của nền tảng.
Facebook dùng đúng một `fanpage` hoặc `group` trên mỗi item. `custom_fields` chỉ nhận cột đã tồn
tại; mapping, target, bình luận và trường riêng nền tảng phải truyền qua field chuyên dụng.

Khi lịch `all_pending` cùng profile đang bật, create/assign mặc định trả
`AGENT_DATA_ACTIVE_ALL_PENDING_SCHEDULE`. Chỉ dùng `allow_scheduled_consumption: true` sau khi
người dùng xác nhận rõ rằng lịch đó được phép lấy hàng mới.

## Ý nghĩa dữ liệu

| Giá trị tool | Ý nghĩa mapper |
|---|---|
| profile `id` | khóa ưu tiên để chọn profile |
| profile `name` | giá trị được ghi vào `name_profile` |
| profile group `profiles` | danh sách thành viên thực tế của nhóm |
| `managed_targets` | Fanpage Facebook hoặc kênh YouTube đã quét, kèm profile sở hữu |
| `saved_groups` | URL Group Facebook đã có trong dữ liệu nền tảng |
| hàng `id` | `post_id` khi đổi mapping |
| `custom_fields.name_profile` | profile hiện được gán cho hàng |

`super_post_assign_profiles` cập nhật atomically toàn bộ assignments. Nếu một assignment sai,
không ghi assignment nào. Tool từ chối trùng `post_id`, profile không tồn tại và hàng đang có
job chờ/chạy.

## Hợp đồng Nhóm đăng

Mỗi nhóm có `id`, `group_key` ổn định, tên duy nhất trong nền tảng và ít nhất một thành viên.
Mỗi thành viên tạo đúng một job khi đăng nhóm.

| `target_type` | Nền tảng | Yêu cầu |
|---|---|---|
| `profile` | mọi nền tảng | profile thực thi; Facebook dùng timeline |
| `fanpage` | Facebook | `profile_id` có quyền và URL Fanpage |
| `group` | Facebook | `profile_id` và URL Facebook Group |
| `default` | ngoài Facebook | profile thực thi |

Create/update là transaction: một thành viên sai thì không lưu thay đổi nào. Update `members`
thay toàn bộ danh sách, nên luôn gửi danh sách hoàn chỉnh mong muốn. Xóa Nhóm đăng không xóa
profile, target, dữ liệu bài hoặc job.

## Hợp đồng Chiến dịch đăng

Mỗi Chiến dịch có `campaign_key` ổn định và tham chiếu 1–100 Nhóm đăng. Một Nhóm đăng vẫn chỉ
thuộc một nền tảng; danh sách nhóm trong Chiến dịch có thể thuộc nhiều nền tảng. Create/update là
transaction. Không lặp cùng một Nhóm đăng. Xóa Chiến dịch không xóa Nhóm đăng bên dưới.

## Manifest bàn giao

Nếu manifest giữ `post_id`, skill đăng phải dùng `super_post_publish_data` hoặc
`super_post_publish_data_batch` để giữ nguyên hàng và không tạo dữ liệu thứ hai.

Mỗi item phải có `item_key`, profile chính xác và target tường minh. Nếu chỉ chuẩn bị từ hàng dữ
liệu có sẵn, giữ `post_id` để đối chiếu. Không coi manifest là lệnh đăng; chỉ
`$post-face-super-post` mới được publish khi người dùng đã yêu cầu đăng.
