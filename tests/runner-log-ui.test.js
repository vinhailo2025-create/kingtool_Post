const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('Log chạy dùng font giao diện dễ đọc và chỉ giữ giờ ở font monospace', () => {
  assert.match(css, /\.runner-log\s*\{[\s\S]*font-family:\s*'Inter',\s*sans-serif/);
  assert.match(css, /\.log-time\s*\{[\s\S]*font-family:\s*"SFMono-Regular",\s*Consolas,\s*monospace/);
  assert.match(css, /\.log-message\s*\{[\s\S]*white-space:\s*pre-wrap[\s\S]*overflow-wrap:\s*anywhere/);
});

test('Log dài không vỡ giao diện desktop và mobile', () => {
  assert.match(css, /\.log-entry\s*\{[\s\S]*grid-template-columns:\s*72px\s+minmax\(90px,\s*max-content\)\s+minmax\(0,\s*1fr\)/);
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.log-message\s*\{\s*grid-column:\s*1\s*\/\s*-1/);
  assert.match(html, /runner\.js\?v=20260919schedule2/);
});
