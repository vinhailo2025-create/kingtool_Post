const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const databaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spk-agent-kit-sync-db-'));
process.env.COVERGEMAUTO_DATA_DIR = databaseRoot;

const db = require('../src/database/init');
const config = require('../config');
const AgentKitService = require('../src/services/agent-kit.service');

test.before(async () => {
  await db.waitReady();
});

test.after(() => {
  db.close();
  fs.rmSync(databaseRoot, { recursive: true, force: true });
});

function createSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spk-agent-kit-sync-'));
  const previousLocalAppData = process.env.LOCALAPPDATA;
  const previousAppData = process.env.APPDATA;
  process.env.LOCALAPPDATA = path.join(root, 'local');
  process.env.APPDATA = path.join(root, 'roaming');
  return {
    root,
    stableRoot: path.join(
      process.env.LOCALAPPDATA,
      'King Automation AI',
      'Super Post Agent Kit'
    ),
    restore() {
      if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previousLocalAppData;
      if (previousAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = previousAppData;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function writeInstalledManifest(root, version) {
  const manifestDir = path.join(root, '.codex-plugin');
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, 'plugin.json'),
    JSON.stringify({ name: 'super-post-agent-kit', version }),
    'utf8'
  );
}

test('auto-sync không tự cài MCP cho khách chưa từng cài', async () => {
  const sandbox = createSandbox();
  let installerCalls = 0;
  try {
    const result = await AgentKitService.syncInstalled({
      runInstaller: async () => { installerCalls += 1; },
    });

    assert.equal(result.synced, false);
    assert.equal(result.sync_reason, 'not-installed');
    assert.equal(installerCalls, 0);
    assert.equal(fs.existsSync(sandbox.stableRoot), false);
  } finally {
    sandbox.restore();
  }
});

test('cài thủ công ghi lại phiên bản ứng dụng đã cung cấp Agent Kit', async () => {
  const sandbox = createSandbox();
  try {
    await AgentKitService.installOrRepair({
      runInstaller: async () => {
        writeInstalledManifest(sandbox.stableRoot, '0.4.0-test');
      },
    });

    assert.equal(
      fs.readFileSync(path.join(sandbox.stableRoot, '.source-app-version'), 'utf8').trim(),
      config.APP_VERSION
    );
  } finally {
    sandbox.restore();
  }
});

test('auto-sync cập nhật MCP đã cài khi app hoặc Agent Kit đổi phiên bản', async () => {
  const sandbox = createSandbox();
  let installerCalls = 0;
  try {
    writeInstalledManifest(sandbox.stableRoot, '0.3.0');
    fs.writeFileSync(
      path.join(sandbox.stableRoot, '.source-app-version'),
      '1.0.0\n',
      'utf8'
    );

    const result = await AgentKitService.syncInstalled({
      runInstaller: async () => {
        installerCalls += 1;
        const bundled = JSON.parse(fs.readFileSync(
          path.join(
            config.ROOT_DIR,
            'packaging',
            'super-post-agent-kit-marketplace',
            'plugins',
            'super-post-agent-kit',
            '.codex-plugin',
            'plugin.json'
          ),
          'utf8'
        ));
        writeInstalledManifest(sandbox.stableRoot, bundled.version);
      },
    });

    assert.equal(result.synced, true);
    assert.equal(installerCalls, 1);
    assert.equal(
      fs.readFileSync(path.join(sandbox.stableRoot, '.source-app-version'), 'utf8').trim(),
      config.APP_VERSION
    );
  } finally {
    sandbox.restore();
  }
});

test('auto-sync bỏ qua khi app và Agent Kit đều đang là bản hiện tại', async () => {
  const sandbox = createSandbox();
  let installerCalls = 0;
  try {
    const bundled = AgentKitService.status().bundled_version;
    writeInstalledManifest(sandbox.stableRoot, bundled);
    fs.writeFileSync(
      path.join(sandbox.stableRoot, '.source-app-version'),
      `${config.APP_VERSION}\n`,
      'utf8'
    );

    const result = await AgentKitService.syncInstalled({
      runInstaller: async () => { installerCalls += 1; },
    });

    assert.equal(result.synced, false);
    assert.equal(result.sync_reason, 'current');
    assert.equal(installerCalls, 0);
  } finally {
    sandbox.restore();
  }
});
