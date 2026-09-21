const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('Super Post branding is wired into the web UI and desktop package', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const launcher = fs.readFileSync(path.join(root, 'desktop_launcher.py'), 'utf8');
  const windowsBuild = fs.readFileSync(path.join(root, 'build.bat'), 'utf8');

  assert.match(html, /<title>Super Post - King/);
  assert.match(html, /class="brand-text">Super Post</);
  assert.match(html, /https:\/\/kingautomationai\.com/);
  assert.match(html, /King Automation AI/);
  assert.match(html, /Xem thêm các Tool khác/);
  assert.match(launcher, /APP_NAME = "Super Post - King"/);
  assert.match(windowsBuild, /set "APP_NAME=Super Post - King"/);
  assert.match(windowsBuild, /super-post-king-logo\.ico/);
  assert.match(windowsBuild, /--file-version="1\.1\.16\.0"/);
  assert.match(windowsBuild, /--company-name="King Automation AI"/);
  assert.ok(fs.existsSync(path.join(root, 'public', 'assets', 'branding', 'super-post-king-logo.png')));
  assert.ok(fs.existsSync(path.join(root, 'public', 'assets', 'branding', 'super-post-king-logo.ico')));
});
