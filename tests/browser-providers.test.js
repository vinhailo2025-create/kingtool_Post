const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'covergem-provider-test-'));
process.env.COVERGEMAUTO_DATA_DIR = testRoot;

const db = require('../src/database/init');

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('GoLogin discovery imports multiple-platform link without copying or deleting original data', async () => {
  await db.waitReady();
  const BrowserProviderService = require('../src/services/browser-provider.service');
  const BrowserService = require('../src/services/browser.service');
  const root = path.join(testRoot, 'gologin-profiles');
  const original = path.join(root, 'provider-profile-01');
  const executable = path.join(testRoot, 'orbita', 'chrome.exe');
  fs.mkdirSync(path.join(original, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(original, 'Default', 'Preferences'), JSON.stringify({
    gologin: { profile_id: 'provider-profile-01', name: 'Tên GoLogin thật' },
    profile: { name: 'Person 1' },
  }));
  fs.writeFileSync(path.join(original, 'Local State'), JSON.stringify({
    profile: { info_cache: { Default: { name: 'Person 1' } } },
  }));
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, 'test');

  const discovered = await BrowserProviderService.discover('gologin', {
    gologin_profiles_dir: root,
    gologin_executable_path: executable,
  });
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].user_data_dir, original);
  assert.deepEqual(
    BrowserProviderService.ensureUserDataDirArg(
      ['--restore-last-session', '--user-data-dir=C:\\wrong', '--lang=vi'],
      original
    ).filter(arg => arg.startsWith('--user-data-dir=')),
    [`--user-data-dir=${path.resolve(original)}`]
  );
  assert.equal(discovered[0].name, 'Tên GoLogin thật');

  const imported = BrowserService.importProfiles(discovered, ['facebook', 'tiktok']);
  assert.equal(imported.created, 1);
  assert.equal(BrowserService.getAll('facebook')[0].provider, 'gologin');
  assert.equal(BrowserService.getAll('tiktok')[0].external_user_data_dir, original);

  const displaySync = BrowserProviderService.syncBrowserDisplayName(BrowserService.getAll('facebook')[0]);
  assert.equal(displaySync.changed, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(original, 'Local State'), 'utf8')).profile.info_cache.Default.name, 'Tên GoLogin thật');
  assert.equal(JSON.parse(fs.readFileSync(path.join(original, 'Local State'), 'utf8')).profile.info_cache.Default.shortcut_name, 'Tên GoLogin thật');
  assert.equal(JSON.parse(fs.readFileSync(path.join(original, 'Local State'), 'utf8')).profile.info_cache.Default.is_using_default_name, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(original, 'Default', 'Preferences'), 'utf8')).profile.name, 'Tên GoLogin thật');

  const id = imported.ids[0];
  assert.equal((await BrowserService.unlinkPlatform(id, 'facebook')).deletedPhysicalProfile, false);
  assert.equal((await BrowserService.unlinkPlatform(id, 'tiktok')).deletedPhysicalProfile, true);
  assert.equal(fs.existsSync(original), true);
});

test('GPM and GenLogin local APIs are discovered and started through CDP endpoints', async () => {
  const BrowserProviderService = require('../src/services/browser-provider.service');
  const calls = [];
  const server = await listen((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/gpm/profiles/start/')) return res.end(JSON.stringify({ success: true, data: { remote_debugging_port: 45678 } }));
    if (req.url.startsWith('/gpm/profiles')) return res.end(JSON.stringify({ success: true, data: { last_page: 1, data: [{ id: 'gpm-1', name: 'GPM One' }] } }));
    if (req.url === '/gem/profiles/start/1') return res.end(JSON.stringify({ success: true, data: { success: true, remote_debugging_address: '127.0.0.1:56789' } }));
    if (req.url === '/gem/profiles/close/1') return res.end(JSON.stringify({ success: true, message: 'closed' }));
    if (req.url.startsWith('/gem/profiles')) return res.end(JSON.stringify({ success: true, data: [{ id: 1, name: 'Gem đúng tên', browser_version: 999, profile_path: path.join(testRoot, 'gem-profile-1') }] }));
    if (req.url.startsWith('/gen/gen-1/ws-endpoint')) return res.end(JSON.stringify({ data: { wsEndpoint: '' } }));
    if (req.url.startsWith('/gen/gen-1/start')) return res.end(JSON.stringify({ wsEndpoint: 'ws://127.0.0.1:4444/devtools/browser/test' }));
    if (req.url.startsWith('/gen')) return res.end(JSON.stringify({ data: { items: [{ id: 'gen-1', name: 'Gen One' }] } }));
    res.statusCode = 404;
    res.end(JSON.stringify({ message: 'not found' }));
  });
  const port = server.address().port;

  try {
    const gpm = await BrowserProviderService.discover('gpm', { gpm_api_url: `http://127.0.0.1:${port}/gpm` });
    assert.deepEqual(gpm.map(item => item.name), ['GPM One']);
    const gpmSession = await BrowserProviderService.start({ provider: 'gpm', provider_profile_id: 'gpm-1' });
    assert.equal(gpmSession.endpoint, 'http://127.0.0.1:45678');

    const gemExecutable = path.join(testRoot, 'gem-chrome.exe');
    fs.writeFileSync(gemExecutable, 'test');
    const gem = await BrowserProviderService.discover('gemlogin', {
      gemlogin_api_url: `http://127.0.0.1:${port}/gem`,
      gemlogin_executable_path: gemExecutable,
    });
    assert.equal(gem[0].name, 'Gem đúng tên');

    assert.equal(gem[0].connection_mode, 'provider_api');
    assert.equal(BrowserProviderService.usesProviderApi(gem[0]), true);
    const gemSession = await BrowserProviderService.start(gem[0]);
    assert.equal(gemSession.endpoint, 'http://127.0.0.1:56789');
    await BrowserProviderService.stop(gem[0]);
    assert.ok(calls.includes('GET /gem/profiles/start/1'));
    assert.ok(calls.includes('GET /gem/profiles/close/1'));

    const gen = await BrowserProviderService.discover('genlogin', { genlogin_api_url: `http://127.0.0.1:${port}/gen` });
    assert.deepEqual(gen.map(item => item.name), ['Gen One']);
    const genSession = await BrowserProviderService.start({ provider: 'genlogin', provider_profile_id: 'gen-1' });
    assert.equal(genSession.endpoint, 'ws://127.0.0.1:4444/devtools/browser/test');
    assert.ok(calls.includes('PUT /gen/gen-1/start'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('GemLogin with local executable and profile directory launches independently of its desktop API', () => {
  const BrowserProviderService = require('../src/services/browser-provider.service');
  assert.equal(BrowserProviderService.usesProviderApi({
    provider: 'gemlogin',
    connection_mode: 'provider_api',
    external_executable_path: process.execPath,
    external_user_data_dir: __dirname,
    provider_metadata: JSON.stringify({ source: 'gemlogin-local-api' }),
  }), false);
  assert.equal(BrowserProviderService.usesProviderApi({
    provider: 'gemlogin',
    connection_mode: 'provider_api',
    external_executable_path: 'Z:\\missing\\chrome.exe',
    external_user_data_dir: 'Z:\\missing\\profile',
  }), true);
});

test('Windows command line capture preserves quoted GPM profile paths for independent relaunch', () => {
  const BrowserProviderService = require('../src/services/browser-provider.service');
  assert.deepEqual(BrowserProviderService.splitWindowsCommandLine(
    '"C:\\GPM Login\\chrome.exe" --user-data-dir="C:\\Profiles\\Profile 1818" --remote-debugging-port=49381'
  ), [
    'C:\\GPM Login\\chrome.exe',
    '--user-data-dir=C:\\Profiles\\Profile 1818',
    '--remote-debugging-port=49381',
  ]);
});

test('GPM discovery falls back to imported profiles while Local API is offline', async () => {
  const BrowserProviderService = require('../src/services/browser-provider.service');
  const BrowserService = require('../src/services/browser.service');
  BrowserService.importProfiles([{
    provider: 'gpm',
    provider_profile_id: 'gpm-offline-1',
    name: 'GPM Offline',
    connection_mode: 'provider_api',
    metadata: { source: 'test' },
  }], ['facebook']);
  const discovered = await BrowserProviderService.discover('gpm', {
    gpm_api_url: 'http://127.0.0.1:1/api/v1',
  });
  const offline = discovered.find(profile => profile.provider_profile_id === 'gpm-offline-1');
  assert.ok(offline);
  assert.equal(offline.metadata.offline, true);
});

test.after(() => {
  try { db.close(); } catch (_) {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});
