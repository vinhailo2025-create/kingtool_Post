# HƯỚNG DẪN CẬP NHẬT FILE WORD

Tài liệu này dùng để cập nhật lại các file hướng dẫn khi giao diện hoặc chức
năng của tool thay đổi.

## 1. Hướng dẫn sử dụng đầy đủ

Đây là tài liệu chính dành cho người dùng:

- Nội dung nguồn:
  `docs/HUONG_DAN_SU_DUNG_SUPER_POST_DAY_DU.md`
- Ảnh minh họa:
  `docs/images/huong-dan-toan-bo/`
- Script tạo Word:
  `scripts/build_full_user_guide_docx.py`
- File Word bàn giao:
  `docs/HUONG_DAN_SU_DUNG_SUPER_POST_DAY_DU.docx`

### Cách cập nhật

1. Đóng file Word đang mở.
2. Chụp lại ảnh từ bản EXE mới nhất.
3. Làm mờ tên profile, đường dẫn, nội dung bài, link và log thật.
4. Thay ảnh trong `docs/images/huong-dan-toan-bo/`, giữ nguyên tên nếu chỉ cập
   nhật giao diện.
5. Sửa nội dung trong `docs/HUONG_DAN_SU_DUNG_SUPER_POST_DAY_DU.md`.
6. Chạy:

```powershell
cd C:\Users\Admin\Documents\covergemauto
.\docs\.docx-venv\Scripts\python.exe .\scripts\build_full_user_guide_docx.py
```

7. Mở `docs/HUONG_DAN_SU_DUNG_SUPER_POST_DAY_DU.docx` bằng Microsoft Word và
   kiểm tra toàn bộ tài liệu.

> File Word đầy đủ được tạo trực tiếp từ file `.md`. Chỉ cần sửa nội dung `.md`,
> ảnh và chạy lại script; không cần chép nội dung sang script.

### Nguyên tắc viết

- Chỉ hướng dẫn thao tác người dùng nhìn thấy trên tool.
- Dùng câu ngắn, mỗi bước bắt đầu bằng hành động.
- Dùng đúng tên menu, nút và cột trên bản EXE hiện tại.
- Không đưa mã nguồn, cấu trúc lưu trữ, cách tự động hóa bên trong hoặc mật khẩu
  cấu hình.
- Không chụp khóa AI, file JSON, dữ liệu khách, số điện thoại hoặc tài khoản
  thật.
- Nếu chức năng chưa hỗ trợ ở một nền tảng, phải ghi rõ, không hướng dẫn như đã
  hoạt động.

## 2. Hướng dẫn riêng về đồng bộ dữ liệu

### Các file liên quan

- Nội dung dễ đọc và chỉnh sửa:
  `HUONG_DAN_DONG_BO_DU_LIEU.md`
- Script tạo file Word:
  `scripts/build_sync_guide_docx.py`
- Ảnh minh họa:
  `docs/images/`
- File Word bàn giao:
  `docs/HUONG_DAN_DONG_BO_DU_LIEU.docx`

> Lưu ý: File Word hiện được tạo từ nội dung nằm trong
> `scripts/build_sync_guide_docx.py`. Sửa riêng file `.md` sẽ chưa làm thay đổi
> file Word. Khi cập nhật nội dung, cần sửa đồng thời file `.md` và script.

### Quy trình cập nhật

#### Bước 1: Đóng file Word

Đóng `HUONG_DAN_DONG_BO_DU_LIEU.docx` trước khi tạo lại để tránh lỗi file đang
được sử dụng.

#### Bước 2: Chụp lại ảnh mới

1. Mở bản EXE mới nhất.
2. Đi đến đúng chức năng cần hướng dẫn.
3. Chụp giao diện rõ nét, không để lộ mật khẩu, API, file JSON hoặc dữ liệu riêng
   của khách.
4. Cắt gọn ảnh, chỉ giữ phần cần hướng dẫn.
5. Thay ảnh cũ trong `docs/images/` và giữ nguyên tên:

   - `dong-bo-du-lieu-da-nen-tang.png`
   - `xem-truoc-dong-bo-du-lieu.png`
   - `dong-bo-google-sheets-cai-dat.png`

Nếu thêm ảnh mới, phải thêm ảnh đó vào `docs/images/` và cập nhật cả file `.md`
lẫn `scripts/build_sync_guide_docx.py`.

#### Bước 3: Cập nhật nội dung

1. Sửa nội dung trong `HUONG_DAN_DONG_BO_DU_LIEU.md`.
2. Sửa phần nội dung tương ứng trong `scripts/build_sync_guide_docx.py`.
3. Giữ câu hướng dẫn ngắn, dùng đúng tên nút đang hiển thị trên tool.
4. Đặt ảnh ngay sau phần giới thiệu chức năng tương ứng.
5. Cập nhật ngày sửa tài liệu.
6. Lưu file với mã hóa UTF-8 để tiếng Việt không bị lỗi.

#### Bước 4: Tạo lại file Word

Mở PowerShell tại thư mục dự án:

```powershell
cd C:\Users\Admin\Documents\covergemauto
python .\scripts\build_sync_guide_docx.py
```

Kết quả mới sẽ ghi đè vào:

```text
C:\Users\Admin\Documents\covergemauto\docs\HUONG_DAN_DONG_BO_DU_LIEU.docx
```

#### Bước 5: Kiểm tra trước khi bàn giao

Mở file Word bằng Microsoft Word và kiểm tra:

- Không xuất hiện `Compatibility Mode`.
- Tiêu đề, ngày cập nhật và số trang đúng.
- Tiếng Việt hiển thị đầy đủ, không có ký tự lỗi.
- Ảnh đúng chức năng, rõ nét và không bị cắt.
- Mỗi ảnh nằm ngay dưới phần hướng dẫn tương ứng.
- Các bước hướng dẫn đúng thứ tự thao tác trên bản EXE mới nhất.
- Không có thông tin riêng của khách trong nội dung hoặc ảnh.
- File mở lại bình thường sau khi đóng Word.

### Cách cập nhật từng trường hợp

#### Chỉ thay ảnh

1. Đóng Word.
2. Thay ảnh trong `docs/images/`, giữ nguyên tên file.
3. Chạy lại script tạo Word.
4. Mở Word kiểm tra ảnh.

#### Chỉ sửa nội dung

1. Sửa `HUONG_DAN_DONG_BO_DU_LIEU.md`.
2. Sửa cùng nội dung trong `scripts/build_sync_guide_docx.py`.
3. Chạy lại script tạo Word.
4. Mở Word kiểm tra nội dung và bố cục.

#### Thêm một phần hướng dẫn mới

1. Viết phần mới trong file `.md`.
2. Thêm nội dung và ảnh tương ứng vào script.
3. Đặt ảnh mới trong `docs/images/`.
4. Chạy lại script.
5. Kiểm tra toàn bộ tài liệu, không chỉ trang vừa thêm.

### Lưu ý quan trọng

- Script sẽ ghi đè file Word hiện tại. Nếu cần giữ bản cũ, hãy sao lưu trước.
- Không chỉnh trực tiếp file Word rồi chạy script, vì phần chỉnh trực tiếp sẽ bị
  mất khi Word được tạo lại.
- Không cần cài LibreOffice; có thể kiểm tra trực tiếp bằng Microsoft Word.
- Nếu PowerShell hiển thị tiếng Việt không đúng nhưng Word vẫn đúng, không tự
  chuyển đổi mã hóa hàng loạt. Hãy mở file bằng trình soạn thảo hỗ trợ UTF-8 để
  kiểm tra trước.
- Chỉ bàn giao sau khi đã mở và kiểm tra trực quan file Word hoàn chỉnh.

## 3. Checklist bàn giao

- [ ] Đã đóng Word trước khi tạo lại.
- [ ] Đã cập nhật nội dung `.md`.
- [ ] Đã cập nhật nội dung trong script.
- [ ] Đã thay đúng ảnh mới.
- [ ] Đã chạy script thành công.
- [ ] Đã mở file Word kiểm tra toàn bộ trang.
- [ ] Không lỗi tiếng Việt hoặc ảnh.
- [ ] Không có dữ liệu nhạy cảm.
- [ ] File bàn giao đúng tại `docs/HUONG_DAN_DONG_BO_DU_LIEU.docx`.
- [ ] File hướng dẫn đầy đủ đúng tại
  `docs/HUONG_DAN_SU_DUNG_SUPER_POST_DAY_DU.docx`.
