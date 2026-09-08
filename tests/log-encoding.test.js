const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { repairMojibake } = require('../src/services/text-encoding.utils');

test('log tiếng Việt đúng được giữ nguyên và log lỗi nhiều lớp được phục hồi', () => {
  const original = 'Đang xử lý bài đăng - Không tìm thấy profile nào.';
  let broken = original;
  for (let index = 0; index < 4; index += 1) {
    broken = Buffer.from(broken, 'utf8').toString('latin1');
  }
  assert.equal(repairMojibake(original), original);
  assert.equal(repairMojibake(broken), original);
});

test('chuỗi log lỗi thật trong runner được đổi lại thành tiếng Việt đọc được', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'runner.service.js'),
    'utf8'
  );
  const line = source.split(/\r?\n/).find(value =>
    value.includes("this._log(null, '") && value.includes('profile n')
  );
  const broken = line?.match(/this\._log\(null, '([^']+)'/)?.[1] || '';
  assert.ok(broken);
  assert.equal(repairMojibake(broken), 'Không tìm thấy profile nào.');
});

test('server chuẩn hóa mọi log websocket và lịch sử hoạt động', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const stats = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'stats.service.js'),
    'utf8'
  );
  assert.match(server, /message: repairMojibake\(data\?\.message\)/);
  assert.match(stats, /message: repairMojibake\(row\.message\)/);
});
