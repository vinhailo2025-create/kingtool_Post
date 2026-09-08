const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('nút chọn Media có icon rõ, focus nổi bật và trạng thái đang mở', () => {
  const dataManager = read('public/js/data-manager.js');
  const css = read('public/css/style.css');
  assert.match(dataManager, /browseBtn\.setAttribute\('aria-label', 'Chọn Media từ máy'\)/);
  assert.match(dataManager, /browseFile\(params, browseBtn\)/);
  assert.match(dataManager, /ID Sản phẩm \(tùy chọn\)/);
  assert.match(dataManager, /triggerButton\.classList\.add\('is-loading'\)/);
  assert.match(css, /\.image-browse-btn:focus-visible/);
  assert.match(css, /linear-gradient\(135deg, var\(--accent\), var\(--orange\)\)/);
});

test('hộp chọn file Windows bật visual style và luôn ở phía trước tool', () => {
  const route = read('src/routes/data.routes.js');
  assert.match(route, /EnableVisualStyles/);
  assert.match(route, /\$owner\.TopMost = \$true/);
  assert.match(route, /\$owner\.Show\(\); \$owner\.Activate\(\)/);
  assert.match(route, /Media ho tro/);
});
