// Kiểm thử xuất/nhập Excel giữ đúng các cột đang dùng trong bảng dữ liệu.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

const db = require('../src/database/init');
const DataService = require('../src/services/data.service');

const PLATFORM = 'facebook';
const NHAN = 'Bài kiểm thử xuất nhập ' + Date.now().toString(36);
const created = [];

test.before(async () => {
  await db.waitReady();
});

test.after(() => {
  try { if (created.length) DataService.deleteMany(created, PLATFORM); } catch { /* bỏ qua */ }
});

function tempFile(buffer) {
  const file = path.join(os.tmpdir(), `xuat-nhap-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`);
  fs.writeFileSync(file, buffer);
  return file;
}

test('xuất ra có đủ mọi cột đang dùng, kể cả cột tuỳ chỉnh', () => {
  const schema = DataService.getExportColumnSchema(PLATFORM);
  const buffer = DataService.exportToExcel(PLATFORM);
  const file = tempFile(buffer);
  try {
    const workbook = XLSX.readFile(file);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const header = XLSX.utils.sheet_to_json(sheet, { header: 1 })[0] || [];
    assert.deepStrictEqual(
      header,
      schema.map(column => column.header),
      'header phải đúng thứ tự cột của bảng dữ liệu'
    );
    for (const required of [
      'Tên Profile',
      'Nội dung',
      'Media',
      'Trạng thái',
      'Link Post',
      'Thời gian đăng',
      'Bình luận 1',
      'Media bình luận 1',
      'Thời gian bình luận 1',
      'Trạng thái bình luận 1',
    ]) {
      assert.ok(header.includes(required), `thiếu cột trên bảng: ${required}`);
    }
  } finally {
    fs.unlinkSync(file);
  }
});

test('xuất rồi nhập lại giữ nguyên dữ liệu, không rơi cột nào', () => {
  const columns = DataService.getCustomColumns(PLATFORM);
  const schema = DataService.getExportColumnSchema(PLATFORM);
  assert.ok(columns.length > 0, 'nền tảng phải có cột tuỳ chỉnh để kiểm thử');

  // Tạo một bài có đủ dữ liệu ở cả cột chuẩn lẫn cột tuỳ chỉnh
  const post = DataService.create({
    content: NHAN,
    image_path: 'C:/anh/kiem-thu.jpg',
    link: 'https://example.com/bai-viet',
    target: 'Nhóm kiểm thử',
    status: 'pending',
    note: 'ghi chú kiểm thử',
  }, PLATFORM);
  const id = post.id;
  created.push(id);

  const giaTri = {};
  columns.forEach((column, index) => {
    giaTri[column.id] = `gia-tri-${index}-${column.var_key}`;
    DataService.setCustomData(id, column.id, giaTri[column.id], PLATFORM);
  });

  // Xuất ra rồi nhập lại
  const file = tempFile(DataService.exportToExcel(PLATFORM));
  let nhapVao;
  try {
    const doc = DataService.importFromExcel(file);
    const rows = doc.sheets[0].data.filter((row) => row['Nội dung'] === NHAN);
    assert.strictEqual(rows.length, 1, 'phải tìm lại được đúng bài vừa tạo trong file xuất');

    for (const column of columns) {
      const exportColumn = schema.find(item => item.kind === 'custom' && item.id === column.id);
      assert.ok(exportColumn, `thiếu schema cho cột "${column.name}"`);
      assert.strictEqual(
        String(rows[0][exportColumn.header] || ''),
        giaTri[column.id],
        `cột "${column.name}" sai giá trị khi xuất`,
      );
    }

    nhapVao = DataService.importSheet(rows, PLATFORM);
  } finally {
    fs.unlinkSync(file);
  }

  assert.strictEqual(nhapVao.imported, 1);
  created.push(...nhapVao.ids);

  // Bài nhập lại phải giống hệt bài gốc
  const banSaoId = nhapVao.ids[0];
  const banSao = DataService.getAllWithCustomData(PLATFORM).find((post) => post.id === banSaoId);
  assert.ok(banSao, 'không tìm thấy bài vừa nhập');
  assert.strictEqual(banSao.content, NHAN);
  assert.strictEqual(banSao.image_path, 'C:/anh/kiem-thu.jpg');
  assert.strictEqual(banSao.link, 'https://example.com/bai-viet');
  assert.strictEqual(banSao.target, 'Nhóm kiểm thử');
  assert.strictEqual(banSao.note, 'ghi chú kiểm thử');
  for (const column of columns) {
    assert.strictEqual(
      banSao[`custom_${column.id}`],
      giaTri[column.id],
      `cột "${column.name}" bị mất khi nhập lại`,
    );
  }
});

test('nhập được file khách tự làm dùng var_key làm tiêu đề', () => {
  const columns = DataService.getCustomColumns(PLATFORM);
  const cot = columns[0];
  const rows = [{
    'Nội dung': 'Bài dùng var_key',
    'Link': 'https://example.com/varkey',
    [cot.var_key]: 'gia-tri-theo-var-key',
  }];
  const ketQua = DataService.importSheet(rows, PLATFORM);
  created.push(...ketQua.ids);
  assert.strictEqual(ketQua.imported, 1);

  const banGhi = DataService.getAllWithCustomData(PLATFORM).find((post) => post.id === ketQua.ids[0]);
  assert.strictEqual(banGhi.content, 'Bài dùng var_key');
  assert.strictEqual(banGhi[`custom_${cot.id}`], 'gia-tri-theo-var-key');
});

test('nhập được đúng các nhãn đang hiển thị trên bảng dữ liệu', () => {
  const rows = [{
    'Tên Profile': 'Profile UI',
    'Nội dung': 'Bài dùng tiêu đề UI',
    'Media': 'C:/media/ui.jpg',
    'Nội dung bình luận': 'Bình luận từ Excel',
    'Media bình luận': 'C:/media/comment.png',
    'Link Post': 'https://www.facebook.com/test/posts/ui',
    'Thời gian đăng': '07/08/2026 17:30',
  }];
  const ketQua = DataService.importSheet(rows, PLATFORM);
  created.push(...ketQua.ids);
  const banGhi = DataService.getAllWithCustomData(PLATFORM)
    .find(post => post.id === ketQua.ids[0]);
  const byVar = new Map(DataService.getCustomColumns(PLATFORM).map(column => [column.var_key, column]));

  assert.strictEqual(banGhi.content, 'Bài dùng tiêu đề UI');
  assert.strictEqual(banGhi.image_path, 'C:/media/ui.jpg');
  assert.strictEqual(banGhi[`custom_${byVar.get('name_profile').id}`], 'Profile UI');
  assert.strictEqual(banGhi[`custom_${byVar.get('comment').id}`], 'Bình luận từ Excel');
  assert.strictEqual(banGhi[`custom_${byVar.get('comment_media').id}`], 'C:/media/comment.png');
  assert.strictEqual(
    banGhi[`custom_${byVar.get('link_post').id}`],
    'https://www.facebook.com/test/posts/ui'
  );
  assert.strictEqual(banGhi[`custom_${byVar.get('time_post').id}`], '07/08/2026 17:30');
});

test('bỏ qua cột số thứ tự, không nhét nhầm vào nội dung', () => {
  const rows = [{ '#': 7, 'Nội dung': 'Bài có cột STT', 'Ghi chú': 'ok' }];
  const ketQua = DataService.importSheet(rows, PLATFORM);
  created.push(...ketQua.ids);

  const banGhi = DataService.getAllWithCustomData(PLATFORM).find((post) => post.id === ketQua.ids[0]);
  assert.strictEqual(banGhi.content, 'Bài có cột STT');
  assert.strictEqual(banGhi.note, 'ok');
});

test('dòng trống hoàn toàn thì không nhập', () => {
  const ketQua = DataService.importSheet([{ 'Nội dung': '', 'Ghi chú': '   ' }], PLATFORM);
  assert.strictEqual(ketQua.imported, 0);
});
