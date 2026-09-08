const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dataManager = fs.readFileSync(path.join(root, 'public/js/data-manager.js'), 'utf8');
const postConfig = fs.readFileSync(path.join(root, 'public/js/post-config.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');

test('Thêm cột có lựa chọn Bình luận và tự thêm nhóm bốn cột không cần mật khẩu', () => {
  assert.match(dataManager, /value="comment_group"/);
  assert.match(dataManager, /\/api\/data\/columns\/comment-group/);
  assert.match(dataManager, /Bình luận N/);
  assert.match(dataManager, /Media bình luận N/);
  assert.match(dataManager, /Thời gian bình luận N/);
  assert.match(dataManager, /Trạng thái bình luận N/);

  const addFunction = dataManager.slice(
    dataManager.indexOf('function showAddColumnModal()'),
    dataManager.indexOf('async function _confirmAddColumn()')
  );
  assert.doesNotMatch(addFunction, /requireCustomAccess/);
});

test('chỉ màn hình Biến còn yêu cầu mật khẩu và giao diện không còn nút sửa cột', () => {
  const gateCalls = [...dataManager.matchAll(/requireCustomAccess\(([^)]+)\)/g)]
    .map(match => match[1])
    .filter(value => value !== 'onSuccess');
  assert.deepEqual(gateCalls, ['showVariableMappingModal']);
  assert.doesNotMatch(app, /showManageColumnsModal\(\)">✎ Cột/);
  assert.match(dataManager, /Cột mặc định được khóa và không thể sửa hoặc xóa/);
});

test('Cấu hình hiển thị thời gian cho từng cặp bình luận và lưu lựa chọn tiếp tục khi lỗi', () => {
  assert.match(postConfig, /commentSequences/);
  assert.match(postConfig, /Khoảng chờ giữa các bình luận/);
  assert.match(postConfig, /comment_intervals/);
  assert.match(postConfig, /comment_continue_on_error/);
  assert.match(postConfig, /Bình luận lỗi vẫn tiếp tục chạy bình luận sau/);
});
