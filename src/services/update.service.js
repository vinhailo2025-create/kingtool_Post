const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const config = require('../../config');

const INSTALLER_NAME = 'Super-Post-King-Setup.exe';
const CHECKSUM_NAME = `${INSTALLER_NAME}.sha256`;
const CACHE_MS = 5 * 60 * 1000;
const MAX_INSTALLER_BYTES = 500 * 1024 * 1024;

function versionParts(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i);
  return match ? match.slice(1, 4).map(Number) : null;
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) throw new Error('Phiên bản cập nhật không đúng định dạng x.y.z.');
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function safeVersion(value) {
  const parts = versionParts(value);
  if (!parts) throw new Error('Phiên bản cập nhật không hợp lệ.');
  return parts.join('.');
}

function isAllowedDownloadUrl(value, repository) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') return false;
    const expectedPrefix = `/${repository}/releases/download/`.toLowerCase();
    return parsed.hostname === 'github.com'
      && parsed.pathname.toLowerCase().startsWith(expectedPrefix);
  } catch (_) {
    return false;
  }
}

function publicRelease(release, currentVersion, repository, driveUrl) {
  const latestVersion = safeVersion(release.tag_name);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const installer = assets.find(asset => asset?.name === INSTALLER_NAME);
  const checksum = assets.find(asset => asset?.name === CHECKSUM_NAME);
  const downloadUrl = String(installer?.browser_download_url || '');
  const checksumUrl = String(checksum?.browser_download_url || '');
  const automaticReady = Boolean(
    installer
    && checksum
    && isAllowedDownloadUrl(downloadUrl, repository)
    && isAllowedDownloadUrl(checksumUrl, repository)
  );

  return {
    current_version: currentVersion,
    latest_version: latestVersion,
    update_available: compareVersions(latestVersion, currentVersion) > 0,
    automatic_update_ready: automaticReady,
    release_name: String(release.name || `Super Post King ${latestVersion}`),
    release_notes: String(release.body || '').trim().slice(0, 8000),
    published_at: release.published_at || null,
    release_url: String(release.html_url || `https://github.com/${repository}/releases/latest`),
    download_url: automaticReady ? downloadUrl : '',
    checksum_url: automaticReady ? checksumUrl : '',
    installer_bytes: Number(installer?.size || 0),
    drive_url: driveUrl,
  };
}

function defaultBusyState() {
  const runnerStatuses = require('./runner-manager.service').getStatus();
  const runningPlatforms = Object.entries(runnerStatuses)
    .filter(([, status]) => status?.isRunning)
    .map(([platform]) => platform);

  let backgroundJobs = 0;
  try {
    const db = require('../database/init');
    for (const table of ['agent_jobs', 'comment_jobs', 'post_link_recovery']) {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE status = 'running'`).get();
      backgroundJobs += Number(row?.count || 0);
    }
  } catch (_) {}

  return {
    busy: runningPlatforms.length > 0 || backgroundJobs > 0,
    running_platforms: runningPlatforms,
    background_jobs: backgroundJobs,
  };
}

class UpdateService {
  constructor(options = {}) {
    this.currentVersion = safeVersion(options.currentVersion || config.APP_VERSION);
    this.repository = String(options.repository || config.UPDATE_GITHUB_REPOSITORY).trim();
    this.driveUrl = String(options.driveUrl || config.UPDATE_DRIVE_URL).trim();
    this.releaseApiUrl = String(
      options.releaseApiUrl || `https://api.github.com/repos/${this.repository}/releases/latest`
    );
    this.dataRoot = path.resolve(options.dataRoot || config.DATA_ROOT);
    this.fetch = options.fetchImpl || global.fetch;
    this.busyState = options.busyState || defaultBusyState;
    this.allowLocalDownloads = options.allowLocalDownloads === true;
    this.cached = null;
    this.downloadPromise = null;
  }

  async check({ force = false } = {}) {
    if (!force && this.cached && Date.now() - this.cached.checkedAt < CACHE_MS) {
      return this.cached.value;
    }
    if (typeof this.fetch !== 'function') throw new Error('Máy này không hỗ trợ kiểm tra cập nhật.');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await this.fetch(this.releaseApiUrl, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `Super-Post-King/${this.currentVersion}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Không đọc được GitHub Release (${response.status}).`);
      const release = await response.json();
      if (release?.draft || release?.prerelease) {
        throw new Error('Release mới nhất chưa phải bản phát hành ổn định.');
      }
      const value = {
        ...publicRelease(release, this.currentVersion, this.repository, this.driveUrl),
        checked_at: new Date().toISOString(),
      };
      this.cached = { checkedAt: Date.now(), value };
      return value;
    } finally {
      clearTimeout(timer);
    }
  }

  _isAllowedAssetUrl(value) {
    if (isAllowedDownloadUrl(value, this.repository)) return true;
    if (!this.allowLocalDownloads) return false;
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname);
    } catch (_) {
      return false;
    }
  }

  async _fetchChecksum(url) {
    if (!this._isAllowedAssetUrl(url)) throw new Error('Link checksum không thuộc Release chính thức.');
    const response = await this.fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': `Super-Post-King/${this.currentVersion}` },
    });
    if (!response.ok) throw new Error(`Không tải được checksum (${response.status}).`);
    const text = await response.text();
    const match = text.match(/\b([a-f0-9]{64})\b/i);
    if (!match) throw new Error('Release thiếu mã SHA-256 hợp lệ.');
    return match[1].toLowerCase();
  }

  async _downloadInstaller(status) {
    const busy = await Promise.resolve(this.busyState());
    if (busy?.busy) {
      const suffix = busy.running_platforms?.length
        ? ` (${busy.running_platforms.join(', ')})`
        : '';
      throw new Error(`Tool đang chạy tác vụ${suffix}. Hãy cập nhật sau khi tác vụ hoàn tất.`);
    }
    if (!status.update_available) throw new Error('Bạn đang dùng phiên bản mới nhất.');
    if (!status.automatic_update_ready) {
      throw new Error('Bản này chưa có file tự động cập nhật. Hãy tải từ Drive.');
    }
    if (!this._isAllowedAssetUrl(status.download_url)) {
      throw new Error('Link installer không thuộc Release chính thức.');
    }

    const expectedHash = await this._fetchChecksum(status.checksum_url);
    const updatesDir = path.join(this.dataRoot, 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    const installerPath = path.join(updatesDir, `Super-Post-King-Setup-${status.latest_version}.exe`);
    const partialPath = `${installerPath}.part`;
    const pendingPath = path.join(updatesDir, 'pending-update.json');
    try { fs.unlinkSync(partialPath); } catch (_) {}

    const response = await this.fetch(status.download_url, {
      redirect: 'follow',
      headers: { 'User-Agent': `Super-Post-King/${this.currentVersion}` },
    });
    if (!response.ok || !response.body) {
      throw new Error(`Không tải được installer (${response.status}).`);
    }
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_INSTALLER_BYTES) throw new Error('Installer vượt quá giới hạn an toàn.');

    let bytes = 0;
    const hasher = crypto.createHash('sha256');
    const verifier = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_INSTALLER_BYTES) {
          callback(new Error('Installer vượt quá giới hạn an toàn.'));
          return;
        }
        hasher.update(chunk);
        callback(null, chunk);
      },
    });

    try {
      await pipeline(Readable.fromWeb(response.body), verifier, fs.createWriteStream(partialPath, { flags: 'wx' }));
      const actualHash = hasher.digest('hex').toLowerCase();
      if (actualHash !== expectedHash) throw new Error('SHA-256 không khớp; đã hủy bản tải.');
      const header = Buffer.alloc(2);
      const handle = fs.openSync(partialPath, 'r');
      try { fs.readSync(handle, header, 0, 2, 0); } finally { fs.closeSync(handle); }
      if (header.toString('ascii') !== 'MZ') throw new Error('File tải về không phải installer Windows hợp lệ.');

      try { fs.unlinkSync(installerPath); } catch (_) {}
      fs.renameSync(partialPath, installerPath);
      const pending = {
        version: status.latest_version,
        installer_path: installerPath,
        sha256: actualHash,
        bytes,
        created_at: new Date().toISOString(),
      };
      fs.writeFileSync(pendingPath, `${JSON.stringify(pending, null, 2)}\n`, 'utf8');
      return {
        ready: true,
        version: status.latest_version,
        bytes,
        sha256: actualHash,
      };
    } catch (error) {
      try { fs.unlinkSync(partialPath); } catch (_) {}
      throw error;
    }
  }

  async download() {
    if (this.downloadPromise) return this.downloadPromise;
    this.downloadPromise = this.check({ force: true })
      .then(status => this._downloadInstaller(status))
      .finally(() => { this.downloadPromise = null; });
    return this.downloadPromise;
  }
}

const service = new UpdateService();

module.exports = service;
module.exports.UpdateService = UpdateService;
module.exports.compareVersions = compareVersions;
module.exports.publicRelease = publicRelease;
module.exports.INSTALLER_NAME = INSTALLER_NAME;
module.exports.CHECKSUM_NAME = CHECKSUM_NAME;
