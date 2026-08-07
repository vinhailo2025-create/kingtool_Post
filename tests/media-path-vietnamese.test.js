// Đường dẫn video/ảnh có dấu tiếng Việt phải nhận được, dù chuỗi ở dạng chuẩn hoá
// nào hoặc dính ký tự ẩn khi copy từ Excel/web.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  sanitizeMediaPath,
  resolveMediaPath,
  mediaPathExists,
} = require('../src/services/media-path.utils');

const TEN_FILE = 'video giới thiệu sản phẩm mới nhất.mp4'.normalize('NFC');
let thuMuc = '';
let duongDanThat = '';

test.before(() => {
  thuMuc = fs.mkdtempSync(path.join(os.tmpdir(), 'media-dau-'));
  duongDanThat = path.join(thuMuc, TEN_FILE);
  fs.writeFileSync(duongDanThat, 'noi dung gia lap');
});

test.after(() => {
  if (thuMuc) fs.rmSync(thuMuc, { recursive: true, force: true });
});

test('nhận đường dẫn dạng NFC như Windows lưu', () => {
  assert.strictEqual(resolveMediaPath(duongDanThat), duongDanThat);
});

test('nhận đường dẫn dạng NFD (copy từ máy Mac hoặc web)', () => {
  const nfd = duongDanThat.normalize('NFD');
  assert.notStrictEqual(nfd, duongDanThat, 'hai dạng phải khác nhau về chuỗi');
  assert.ok(mediaPathExists(nfd), 'phải tìm được file dù chuỗi ở dạng NFD');
  assert.strictEqual(fs.existsSync(resolveMediaPath(nfd)), true);
});

test('nhận đường dẫn dính khoảng trắng không ngắt từ Excel', () => {
  const nbsp = path.join(thuMuc, TEN_FILE.replace(/ /g, '\u00A0'));
  assert.ok(mediaPathExists(nbsp));
});

test('nhận đường dẫn có ký tự zero-width', () => {
  const zw = path.join(thuMuc, TEN_FILE.replace('giới', 'gi\u200Bới'));
  assert.ok(mediaPathExists(zw));
});

test('bỏ dấu nháy khi kéo thả từ Explorer và khoảng trắng thừa', () => {
  assert.ok(mediaPathExists(`"${duongDanThat}"`));
  assert.ok(mediaPathExists(`  ${duongDanThat}  `));
  assert.ok(mediaPathExists(`'${duongDanThat}'`));
});

test('file không tồn tại thì vẫn báo không tìm thấy', () => {
  assert.strictEqual(mediaPathExists(path.join(thuMuc, 'khong-co-thuc.mp4')), false);
  assert.strictEqual(resolveMediaPath(''), '');
  assert.strictEqual(resolveMediaPath(null), '');
});

test('làm sạch chuỗi trước khi lưu vào cột dữ liệu', () => {
  assert.strictEqual(sanitizeMediaPath('"C:/anh/ảnh đẹp.jpg"'), 'C:/anh/ảnh đẹp.jpg');
  assert.strictEqual(sanitizeMediaPath('  C:/anh/ảnh.jpg  '), 'C:/anh/ảnh.jpg');
  assert.strictEqual(sanitizeMediaPath('C:/anh/ảnh\u200B.jpg'), 'C:/anh/ảnh.jpg');
  // Chuỗi NFD được đưa về NFC để khớp cách Windows lưu tên file
  assert.strictEqual(
    sanitizeMediaPath('C:/anh/ảnh.jpg'.normalize('NFD')),
    'C:/anh/ảnh.jpg'.normalize('NFC'),
  );
  assert.strictEqual(sanitizeMediaPath(null), '');
});

test('nhiều file ngăn cách bằng dấu phẩy đều nhận được', () => {
  const anh = path.join(thuMuc, 'ảnh sản phẩm số 2.jpg'.normalize('NFC'));
  fs.writeFileSync(anh, 'x');
  const chuoi = `${duongDanThat.normalize('NFD')}, ${anh.normalize('NFD')}`;
  const ketQua = chuoi.split(',').map((value) => resolveMediaPath(value)).filter(Boolean);
  assert.strictEqual(ketQua.length, 2, 'cả hai file đều phải tìm được');
  ketQua.forEach((duong) => assert.ok(fs.existsSync(duong)));
});
