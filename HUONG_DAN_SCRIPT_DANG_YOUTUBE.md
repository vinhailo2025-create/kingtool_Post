# Hướng dẫn script đăng video YouTube

Tài liệu này mô tả đúng luồng đang được dùng trong dự án, từ lúc mở trình
duyệt đến khi đăng xong, lấy link video và lưu kết quả.

Phạm vi không bao gồm: tạo profile, nhập profile, đăng nhập tài khoản lần đầu,
chuẩn bị dữ liệu trên giao diện, hẹn giờ hoặc bình luận sau đăng.

## 1. Các file triển khai chính

- `src/services/browser.service.js`: mở, dùng lại và đóng trình duyệt/profile.
- `src/services/runner.service.js`: chọn bài theo profile, gọi script đăng và
  lưu kết quả.
- `src/platforms/youtube.adapter.js`: toàn bộ thao tác trên YouTube và YouTube
  Studio.
- `src/services/data.service.js`: khai báo các cột dữ liệu riêng của YouTube.

Luồng tổng quát:

```text
Mở profile trình duyệt
  -> lấy tab điều khiển
  -> kiểm tra dữ liệu và phiên đăng nhập
  -> chọn đúng kênh
  -> mở YouTube Studio
  -> tải video
  -> điền thông tin
  -> chọn đối tượng và trạng thái hiển thị
  -> xuất bản
  -> xác nhận kết quả
  -> lấy link
  -> lưu trạng thái/link/thời gian
  -> đóng trình duyệt
```

## 2. Dữ liệu cần có

### 2.1. Dữ liệu để runner chọn đúng bài và đúng trình duyệt

| Dữ liệu | Bắt buộc | Ý nghĩa |
|---|---:|---|
| `profile.id` | Có | ID profile trình duyệt dùng để mở Chrome. |
| `profile.name` | Có | Tên profile trong danh sách trình duyệt. |
| `name_profile` | Có | Phải trùng chính xác với `profile.name`. |
| `status` | Có | Bài chỉ được chọn khi đang ở trạng thái chờ đăng. |
| `platform` | Có | Phải là `youtube`. |

Profile phải được gán nền tảng YouTube và đã đăng nhập tài khoản Google/YouTube.

### 2.2. Dữ liệu video

| Cột giao diện | Biến script | Bắt buộc | Quy tắc |
|---|---|---:|---|
| Nội dung | `content` | Có | Được dùng làm tiêu đề video; không được rỗng. |
| Media | `media` / `image_path` | Có | Đường dẫn file video tồn tại trên máy. |
| Mô tả video | `description` | Không | Điền vào phần mô tả khi có giá trị. |
| Tên kênh | `channel_name` | Không | Nếu có, script chuyển sang kênh này trước khi mở Studio. |
| Danh sách phát | `playlist` | Không | Tên playlist đã tồn tại trên kênh. |
| Trạng thái lưu | `privacy_status` | Không | `Không công khai`, `Riêng tư` hoặc `Công khai`; mặc định là `Không công khai`. |
| Hình Thumbnail | `thumbnail` | Không | Đường dẫn file ảnh thumbnail tồn tại trên máy. |
| Từ khóa | `keywords` | Không | Chuỗi thẻ/từ khóa, thường phân tách bằng dấu phẩy. |

Định dạng video được chấp nhận:

```text
.mp4, .mov, .m4v, .avi, .mkv, .webm, .wmv, .mpeg, .mpg, .3gp
```

Định dạng thumbnail được chấp nhận:

```text
.jpg, .jpeg, .png, .webp
```

Các trường hỗ trợ biến mẫu dạng `{{ten_bien}}`. Trước khi thao tác trên
YouTube, runner dựng bản đồ biến rồi thay biến trong từng giá trị.

## 3. Mở trình duyệt và lấy tab điều khiển

Runner gọi:

```js
const instance = await BrowserService.acquire(profile.id, {
  platform: 'youtube',
});
const page = instance.page;
```

Quy trình của `acquire()`:

1. Nếu profile đang mở ở chế độ đăng nhập thủ công, đóng cửa sổ đó.
2. Tăng số lượt đang sử dụng profile.
3. Mở trình duyệt hoặc dùng lại phiên tự động đang mở.
4. Với trình duyệt anti-detect, kết nối qua CDP của nhà cung cấp.
5. Với Chrome/profile trực tiếp, mở Chromium ở chế độ có giao diện
   (`headless: false`) và dùng đúng thư mục dữ liệu profile.
6. Lấy tab đầu tiên; nếu chưa có tab thì tạo tab mới.
7. Lưu `{ browser, page }` để runner sử dụng.

Nếu không lấy được `page`, dừng bài với lỗi không lấy được tab trình duyệt.

Khi toàn bộ bài của profile đã xử lý xong, runner luôn gọi
`BrowserService.release(profile.id)`. Khi không còn tác vụ nào dùng profile,
trình duyệt được đóng.

## 4. Kiểm tra trước khi đăng

Script kiểm tra theo thứ tự:

1. Có đối tượng `page`.
2. `content` có tiêu đề.
3. `media` có phần mở rộng video hợp lệ.
4. File video tồn tại và đường dẫn được phân giải đúng, kể cả tên tiếng Việt.
5. Nếu có `thumbnail`, file phải tồn tại và có phần mở rộng ảnh hợp lệ.
6. Profile còn phiên đăng nhập YouTube.

Phiên đăng nhập được xem là hợp lệ khi profile có ít nhất một cookie đăng nhập:

```text
SAPISID
__Secure-1PAPISID
__Secure-3PAPISID
SID
__Secure-1PSID
__Secure-3PSID
```

Cookie được đọc trên các miền:

```text
https://www.youtube.com
https://studio.youtube.com
https://accounts.google.com
```

Lưu ý: kiểm tra cookie chỉ xác nhận profile có dấu hiệu đăng nhập. Nếu Google
yêu cầu xác minh lại, giao diện Studio vẫn có thể không mở được và script sẽ
hết thời gian chờ.

## 5. Chọn kênh YouTube

Chỉ thực hiện khi `channel_name` có giá trị.

1. Mở `https://www.youtube.com/channel_switcher`.
2. Đọc các phần tử `ytd-account-item-renderer`.
3. So sánh `channel-title`, `channel-handle` và nội dung thẻ với tên kênh.
4. Ưu tiên kết quả trùng chính xác, sau đó mới dùng kết quả chứa tên cần tìm.
5. Bấm vào kênh và chờ rời trang chuyển kênh.
6. Sau khi mở YouTube Studio, kiểm tra nội dung trang có tên kênh đã chọn.

Nếu không tìm thấy hoặc không chuyển đúng kênh, phải dừng bài; không được tiếp
tục đăng nhầm sang kênh hiện tại.

## 6. Mở YouTube Studio và tải video

1. Mở `https://studio.youtube.com/`.
2. Tìm nút có nội dung chính xác:

```text
Tải video lên
Upload videos
Upload video
```

3. Chờ input:

```css
input[type="file"][name="Filedata"]
```

4. Gọi `uploadFile(media)` với đường dẫn video đã được phân giải.
5. Chờ trình biên tập xuất hiện đủ hai ô:

```css
ytcp-video-title [contenteditable="true"]
ytcp-video-description [contenteditable="true"]
```

Việc thấy hai ô trên có nghĩa YouTube đã nhận file và mở phần cài đặt video;
không có nghĩa video đã tải hoặc xử lý xong hoàn toàn.

## 7. Điền thông tin video

### 7.1. Tiêu đề và mô tả

- Xóa toàn bộ nội dung hiện có trong ô tiêu đề rồi nhập `content`.
- Nếu `description` không rỗng, xóa nội dung cũ rồi nhập mô tả.
- Sau khi nhập, script đọc lại `innerText`. Nếu không đúng, script dùng
  `document.execCommand('insertText')` và phát sự kiện `input`/`change`.

### 7.2. Thumbnail

Nếu có `thumbnail`:

1. Tìm `ytcp-thumbnail-uploader input#file-loader`.
2. Gọi `uploadFile(thumbnail)`.
3. Chờ YouTube xuất hiện nhãn xác nhận thumbnail đã tải lên.

### 7.3. Danh sách phát

Nếu có `playlist`:

1. Mở dropdown trong `ytcp-video-metadata-playlists`.
2. Tìm option có tên trùng hoặc chứa tên playlist.
3. Chọn playlist.
4. Bấm `Xong`, `Lưu`, `Done` hoặc `Save` nếu nút xuất hiện.

### 7.4. Đối tượng người xem và từ khóa

Script luôn chọn:

```text
Không, nội dung này không dành cho trẻ em
```

hoặc nhãn tiếng Anh tương ứng.

Sau đó:

1. Bấm `Hiện chế độ cài đặt nâng cao`, `Hiện thêm`, `Show advanced settings`
   hoặc `Show more`.
2. Nếu có `keywords`, tìm input có `aria-label` chứa `Thẻ` hoặc `Tags`.
3. Nhập toàn bộ chuỗi từ khóa và nhấn `Enter`.

## 8. Đi qua các bước kiểm tra

Script chờ nút `#next-button` được bật rồi bấm ba lần:

1. Từ Chi tiết sang Thành phần video.
2. Sang bước Kiểm tra.
3. Sang bước Chế độ hiển thị.

Mỗi lần chỉ bấm khi nút không `disabled` và `aria-disabled` khác `true`.

Tại bước Chế độ hiển thị:

- Giá trị chứa `công khai` nhưng không chứa `không` -> chọn `Công khai` /
  `Public`.
- Giá trị chứa `riêng tư` -> chọn `Riêng tư` / `Private`.
- Mọi giá trị khác hoặc rỗng -> chọn `Không công khai` / `Unlisted`.

## 9. Xuất bản video

1. Tìm nút đang hiển thị trong hộp tải video, có nhãn chính xác:

```text
Xuất bản
Publish
Lưu
Save
```

2. Chỉ bấm khi nút không bị vô hiệu hóa.
3. Nếu YouTube báo vẫn đang kiểm tra nội dung, tìm hộp thoại có nội dung:

```text
Vẫn đang kiểm tra nội dung
Checks are still running
Still checking your video
```

4. Bấm `Vẫn xuất bản` hoặc `Publish anyway`.
5. Tiếp tục chờ hộp thoại xác nhận và link video.

## 10. Lấy link video thành công

Script ưu tiên tìm link trong `ytcp-uploads-dialog`; nếu không có hộp này thì
tìm trên toàn bộ trang.

### Cách 1: đọc thuộc tính `href`

Đọc tất cả thẻ `a[href]` và lấy link đầu tiên khớp một trong các dạng:

```text
https://www.youtube.com/watch?v=VIDEO_ID
https://www.youtube.com/shorts/VIDEO_ID
https://youtu.be/VIDEO_ID
```

### Cách 2: đọc nội dung hộp thoại

Nếu chưa tìm thấy thẻ `a`, đọc nội dung của `ytcp-video-info` hoặc toàn bộ hộp
thoại, sau đó dùng biểu thức chính quy để trích link YouTube.

### Tiêu chí kết quả

Cần phân biệt hai mức thành công:

1. **Đăng thành công:** YouTube đã xác nhận video được xuất bản.
2. **Lấy link thành công:** `postLink` là chuỗi không rỗng và khớp URL video
   YouTube.

Kết quả đầy đủ khi lấy được link:

```js
{
  success: true,
  postedAt: 'thời gian theo vi-VN',
  publishedAtMs: 0,
  postLink: 'https://www.youtube.com/watch?v=VIDEO_ID',
  linkPending: false,
}
```

Nếu YouTube xác nhận đã đăng nhưng chưa trả link, code hiện tại vẫn trả:

```js
{
  success: true,
  postLink: '',
  linkPending: true,
}
```

Trường hợp này chỉ là **đăng thành công, link đang chờ**; không được coi là
**lấy link thành công**. Runner ghi chú `Link video đang đợi cập nhật`.

Sau khi đã bấm `Vẫn xuất bản`, script chờ tối đa khoảng 45 giây để đọc link.
Nếu vẫn không có link, kết quả có thể là `linkPending: true`. Code hiện tại
chưa có bước quay lại trang Nội dung của Studio để truy tìm link lần hai.

## 11. Lưu kết quả

Khi adapter trả kết quả thành công, runner lưu trong một transaction:

| Nơi lưu | Giá trị |
|---|---|
| `posts.status` | `success` |
| `posts.note` | Thời gian đăng; thêm ghi chú nếu link đang chờ hoặc chưa lấy được. |
| `posts.link` | `postLink` |
| Cột `link_post` | `postLink` |
| Cột `time_post` | Thời gian đăng theo định dạng `vi-VN` |
| `activity_logs` | Profile, ID bài, thời gian và link nếu có |

Nếu đăng lỗi:

- `posts.status` được đặt thành `error`.
- `posts.note` lưu thông báo lỗi.
- `posts.link` và `link_post` lưu `Lỗi: <thông báo>`.

## 12. Thời gian chờ

| Cấu hình | Mặc định | Dùng cho |
|---|---:|---|
| `navigationTimeout` | 90 giây | Mở YouTube/channel switcher/Studio. |
| `editorTimeout` | 180 giây | Chờ nút tải lên, editor, nút Tiếp và các control. |
| `uploadTimeout` | 900 giây | Chờ YouTube nhận video và mở phần cài đặt. |
| `publishTimeout` | 180 giây | Xuất bản, xử lý hộp thoại kiểm tra và lấy link. |
| `settleMs` | 1,2 giây | Nghỉ ngắn sau các thao tác giao diện. |

Đặt timeout bằng `0` nghĩa là chờ không giới hạn.

## 13. Pseudocode hoàn chỉnh

```js
async function postYouTube(profile, post) {
  let leased = false;

  try {
    const instance = await BrowserService.acquire(profile.id, {
      platform: 'youtube',
    });
    leased = true;

    const page = instance.page;
    if (!page) throw new Error('Không lấy được tab trình duyệt');

    validateRequiredData(post);
    validateVideoAndThumbnailFiles(post);
    await validateYouTubeSession(page);

    if (post.channel_name) {
      await switchChannel(page, post.channel_name);
    }

    await openYouTubeStudio(page);
    await clickUploadVideo(page);
    await uploadVideo(page, post.media);
    await waitForVideoEditor(page);

    await fillTitle(page, post.content);
    await fillDescription(page, post.description);
    await uploadThumbnailIfPresent(page, post.thumbnail);
    await selectPlaylistIfPresent(page, post.playlist);
    await selectNotMadeForKids(page);
    await fillTagsIfPresent(page, post.keywords);

    await clickNextWhenEnabled(page);
    await clickNextWhenEnabled(page);
    await clickNextWhenEnabled(page);
    await chooseVisibility(page, post.privacy_status || 'Không công khai');

    await clickPublish(page);
    await confirmPublishAnywayIfChecksPending(page);

    const result = await waitForPublishedResultAndLink(page);
    await savePostResult(profile, post, result);
    return result;
  } catch (error) {
    await savePostError(post, error);
    throw error;
  } finally {
    if (leased) await BrowserService.release(profile.id);
  }
}
```

## 14. Checklist xác nhận hoàn tất

- [ ] Mở đúng profile và lấy được tab điều khiển.
- [ ] Profile còn đăng nhập YouTube.
- [ ] Chọn đúng kênh nếu có `channel_name`.
- [ ] File video hợp lệ và đã được YouTube nhận.
- [ ] Tiêu đề đã được thay bằng `content`.
- [ ] Mô tả, thumbnail, playlist và từ khóa được điền khi có dữ liệu.
- [ ] Đã chọn `Không dành cho trẻ em`.
- [ ] Đã đi qua đủ ba nút `Tiếp`.
- [ ] Đã chọn đúng chế độ hiển thị.
- [ ] Đã bấm `Xuất bản`/`Lưu`.
- [ ] Đã xử lý hộp thoại `Vẫn xuất bản` nếu xuất hiện.
- [ ] YouTube đã xác nhận đăng video.
- [ ] `postLink` khớp URL video YouTube nếu yêu cầu lấy link thành công.
- [ ] Đã lưu `status`, `link_post` và `time_post`.
- [ ] Đã giải phóng/đóng trình duyệt sau khi xử lý xong profile.
