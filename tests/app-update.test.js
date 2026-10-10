const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const {
  UpdateService,
  compareVersions,
  publicRelease,
  INSTALLER_NAME,
  CHECKSUM_NAME,
} = require('../src/services/update.service');

test('so sánh semantic version và chỉ nhận asset từ GitHub Release chính thức', () => {
  assert.equal(compareVersions('1.2.0', '1.1.9'), 1);
  assert.equal(compareVersions('v1.1.0', '1.1.0'), 0);
  assert.equal(compareVersions('1.0.9', '1.1.0'), -1);

  const release = publicRelease({
    tag_name: 'v1.2.0',
    name: 'Super Post King 1.2.0',
    body: 'Sửa lỗi',
    html_url: 'https://github.com/vinhailo2025-create/super-post-king-releases/releases/tag/v1.2.0',
    assets: [
      {
        name: INSTALLER_NAME,
        size: 123,
        browser_download_url: `https://github.com/vinhailo2025-create/super-post-king-releases/releases/download/v1.2.0/${INSTALLER_NAME}`,
      },
      {
        name: CHECKSUM_NAME,
        browser_download_url: `https://github.com/vinhailo2025-create/super-post-king-releases/releases/download/v1.2.0/${CHECKSUM_NAME}`,
      },
    ],
  }, '1.1.0', 'vinhailo2025-create/super-post-king-releases', 'https://drive.google.com/folder');

  assert.equal(release.update_available, true);
  assert.equal(release.automatic_update_ready, true);
  assert.equal(release.drive_url, 'https://drive.google.com/folder');
});

test('tải installer vào AppData, xác minh SHA-256 và tạo yêu cầu cài đặt', async t => {
  const payload = Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(2048)]);
  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  const server = http.createServer((req, res) => {
    if (req.url === '/installer') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': payload.length,
      });
      res.end(payload);
      return;
    }
    if (req.url === '/checksum') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`${hash}  ${INSTALLER_NAME}\n`);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'super-post-update-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const service = new UpdateService({
    currentVersion: '1.1.0',
    repository: 'vinhailo2025-create/super-post-king-releases',
    dataRoot,
    allowLocalDownloads: true,
    busyState: () => ({ busy: false }),
  });

  const result = await service._downloadInstaller({
    update_available: true,
    automatic_update_ready: true,
    latest_version: '1.2.0',
    download_url: `${base}/installer`,
    checksum_url: `${base}/checksum`,
  });
  const pending = JSON.parse(fs.readFileSync(path.join(dataRoot, 'updates', 'pending-update.json'), 'utf8'));

  assert.equal(result.ready, true);
  assert.equal(result.sha256, hash);
  assert.equal(pending.sha256, hash);
  assert.equal(fs.readFileSync(pending.installer_path).subarray(0, 2).toString('ascii'), 'MZ');
  assert.equal(fs.existsSync(`${pending.installer_path}.part`), false);
});

test('không tải cập nhật khi một tác vụ đăng bài đang chạy', async () => {
  const service = new UpdateService({
    currentVersion: '1.1.0',
    repository: 'vinhailo2025-create/super-post-king-releases',
    dataRoot: os.tmpdir(),
    allowLocalDownloads: true,
    busyState: () => ({ busy: true, running_platforms: ['facebook'] }),
  });
  await assert.rejects(
    service._downloadInstaller({
      update_available: true,
      automatic_update_ready: true,
      latest_version: '1.2.0',
      download_url: 'http://127.0.0.1/installer',
      checksum_url: 'http://127.0.0.1/checksum',
    }),
    /đang chạy tác vụ.*facebook/
  );
});

test('giao diện chỉ hiện badge nhỏ và không ép khách cập nhật', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'public', 'js', 'updater.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const launcher = fs.readFileSync(path.join(root, 'desktop_launcher.py'), 'utf8');

  assert.match(html, /id="app-update-notice"[\s\S]*hidden/);
  assert.match(js, /CHECK_INTERVAL_MS:\s*6 \* 60 \* 60 \* 1000/);
  assert.match(js, /REMIND_LATER_MS:\s*24 \* 60 \* 60 \* 1000/);
  assert.match(js, /openSettingsUpdate\(button\)/);
  assert.match(js, /\/api\/update\/check\?force=1/);
  assert.match(js, /Bạn đang dùng phiên bản mới nhất/);
  assert.match(js, /Để sau/);
  assert.doesNotMatch(js, /force_update|bắt buộc/i);
  assert.match(css, /\.app-update-notice\s*\{/);
  assert.match(server, /app\.use\('\/api\/update'/);
  assert.match(launcher, /def install_update\(self\)/);
  assert.match(launcher, /VERYSILENT/);
  assert.match(launcher, /run-super-post-update\.cmd/);
  assert.match(launcher, /ShellExecuteW/);
  assert.doesNotMatch(launcher, /start "" \{command\}/);
  assert.doesNotMatch(launcher, /cmd\.exe \/d \/s \/c/);
});

test('version của app, installer và native executable được đồng bộ', () => {
  const pkg = require('../package.json');
  const iss = fs.readFileSync(path.join(root, 'packaging', 'SuperPostKing.iss'), 'utf8');
  const build = fs.readFileSync(path.join(root, 'build.bat'), 'utf8');
  assert.equal(pkg.version, '1.1.22');
  assert.match(iss, /MyAppVersion "1\.1\.22"/);
  assert.match(iss, /VersionInfoVersion=1\.1\.22\.0/);
  assert.match(build, /--product-version="1\.1\.22\.0"/);
});
