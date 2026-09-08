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

test('existing Chrome is blocked and retired references never delete browser data', async () => {
  await db.waitReady();
  const BrowserProviderService = require('../src/services/browser-provider.service');
  const BrowserService = require('../src/services/browser.service');
  const config = require('../config');
  const chromeRoot = path.join(testRoot, 'system-chrome', 'User Data');
  const executable = path.join(testRoot, 'system-chrome', 'Application', 'chrome.exe');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, 'test');
  fs.mkdirSync(chromeRoot, { recursive: true });
  fs.writeFileSync(path.join(chromeRoot, 'Local State'), JSON.stringify({
    profile: {
      info_cache: {
        Default: { name: 'Chrome chính' },
        'Profile 1': { name: 'Chrome bán hàng' },
      },
    },
  }));
  for (const directory of ['Default', 'Profile 1']) {
    const profileDir = path.join(chromeRoot, directory);
    fs.mkdirSync(path.join(profileDir, 'Network'), { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'Preferences'), JSON.stringify({ profile: { name: directory } }));
    fs.writeFileSync(path.join(profileDir, 'Network', 'Cookies'), `cookies-${directory}`);
  }

  await assert.rejects(
    BrowserProviderService.discover('chrome_existing', {}),
    /ngừng hỗ trợ/
  );
  assert.throws(
    () => BrowserService.importDiscoveredProfiles([{
      provider: 'chrome_existing',
      provider_profile_id: 'old-system-profile',
    }]),
    /ngừng hỗ trợ/
  );

  const retainedClone = path.join(config.CHROME_PROFILES_DIR, 'retained-old-clone');
  fs.mkdirSync(retainedClone, { recursive: true });
  fs.writeFileSync(path.join(retainedClone, 'keep.txt'), 'preserve');
  const result = db.prepare(`
    INSERT INTO browsers (
      name, profile_dir, provider, provider_profile_id, connection_mode,
      external_user_data_dir, external_executable_path, provider_metadata
    ) VALUES (?, ?, 'chrome_existing', ?, 'direct', ?, ?, ?)
  `).run(
    'Chrome cũ',
    'retained-old-clone',
    'old-system-profile',
    chromeRoot,
    executable,
    JSON.stringify({
      source_user_data_dir: chromeRoot,
      profile_directory: 'Profile 1',
      clone_owned: true,
      clone_user_data_dir: retainedClone,
    })
  );
  db.prepare('INSERT INTO browser_platforms (browser_id, platform) VALUES (?, ?)').run(
    result.lastInsertRowid,
    'facebook'
  );
  assert.equal(BrowserService.retireExistingChromeProfiles().retired, 1);
  assert.equal(db.prepare('SELECT id FROM browsers WHERE id = ?').get(result.lastInsertRowid), undefined);
  assert.equal(fs.existsSync(path.join(chromeRoot, 'Profile 1')), true);
  assert.equal(fs.readFileSync(path.join(retainedClone, 'keep.txt'), 'utf8'), 'preserve');
});

test('managed Chrome profiles use separate child directories under one shared parent', async () => {
  await db.waitReady();
  const BrowserService = require('../src/services/browser.service');
  const config = require('../config');
  const first = BrowserService.create({ name: 'Managed one' });
  const second = BrowserService.create({ name: 'Managed two' });
  assert.equal(path.dirname(first.profile_path), config.CHROME_PROFILES_DIR);
  assert.equal(path.dirname(second.profile_path), config.CHROME_PROFILES_DIR);
  assert.notEqual(first.profile_path, second.profile_path);
  assert.equal(fs.existsSync(first.profile_path), true);
  assert.equal(fs.existsSync(second.profile_path), true);
  await BrowserService.delete(first.id);
  await BrowserService.delete(second.id);
});

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
  assert.equal(imported.displayNameChanged, 2);
  assert.equal(BrowserService.getAll('facebook')[0].provider, 'gologin');
  assert.equal(BrowserService.getAll('tiktok')[0].external_user_data_dir, original);

  const displaySync = BrowserProviderService.syncBrowserDisplayName(BrowserService.getAll('facebook')[0]);
  assert.equal(displaySync.changed, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(original, 'Local State'), 'utf8')).profile.info_cache.Default.name, 'Tên GoLogin thật');
  assert.equal(JSON.parse(fs.readFileSync(path.join(original, 'Local State'), 'utf8')).profile.info_cache.Default.shortcut_name, 'Tên GoLogin thật');
  assert.equal(JSON.parse(fs.readFileSync(path.join(original, 'Local State'), 'utf8')).profile.info_cache.Default.is_using_default_name, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(original, 'Default', 'Preferences'), 'utf8')).profile.name, 'Tên GoLogin thật');

  const id = imported.ids[0];
  assert.equal((await BrowserService.unlinkPlatform(id, 'facebook')).deletedPhysicalProfile, false);
  await BrowserService.delete(id);
  assert.equal(fs.existsSync(original), true);
});

test('GemLogin offline discovery reads real names from its local database and bulk unlink keeps provider data', async () => {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const BrowserProviderService = require('../src/services/browser-provider.service');
  const BrowserService = require('../src/services/browser.service');
  const gemRoot = path.join(testRoot, '.gemlogin');
  const profilesRoot = path.join(gemRoot, 'profile', 'profiles');
  const executable = path.join(gemRoot, 'browser', '999', 'Chrome-bin', 'chrome.exe');
  const profileNames = new Map([
    ['17', 'Gem profile thật 17'],
    ['22', 'Gem profile thật 22'],
  ]);

  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, 'test');
  for (const id of profileNames.keys()) {
    const profileDir = path.join(profilesRoot, id);
    fs.mkdirSync(path.join(profileDir, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'Default', 'Preferences'), JSON.stringify({
      profile: { name: 'Your Gemlogin' },
    }));
    fs.writeFileSync(path.join(profileDir, 'Local State'), JSON.stringify({
      profile: { info_cache: { Default: { name: 'Your Gemlogin' } } },
    }));
    const webData = new SQL.Database();
    webData.run('CREATE TABLE keywords (short_name TEXT, safe_for_autoreplace INTEGER, prepopulate_id INTEGER, keyword TEXT)');
    webData.run(
      "INSERT INTO keywords (short_name, safe_for_autoreplace, prepopulate_id, keyword) VALUES ('Your Gemlogin', 1, 1, 'google.com')"
    );
    fs.writeFileSync(path.join(profileDir, 'Default', 'Web Data'), Buffer.from(webData.export()));
    webData.close();
  }
  fs.mkdirSync(path.join(profilesRoot, '999', 'Default'), { recursive: true });
  fs.writeFileSync(path.join(profilesRoot, '999', 'Local State'), JSON.stringify({
    profile: { info_cache: { Default: { name: 'Deleted GemLogin profile' } } },
  }));

  const gemDb = new SQL.Database();
  gemDb.run('CREATE TABLE profiles (id INTEGER PRIMARY KEY, name TEXT)');
  for (const [id, name] of profileNames) {
    gemDb.run('INSERT INTO profiles (id, name) VALUES (?, ?)', [Number(id), name]);
  }
  fs.writeFileSync(path.join(gemRoot, 'db.db'), Buffer.from(gemDb.export()));
  gemDb.close();

  const discovered = await BrowserProviderService.discover('gemlogin', {
    gemlogin_api_url: 'http://127.0.0.1:1/api',
    gemlogin_profiles_dir: profilesRoot,
    gemlogin_executable_path: executable,
    gemlogin_extension_path: '',
  });
  assert.deepEqual(
    discovered.map(item => item.name).sort(),
    [...profileNames.values()].sort()
  );

  const imported = BrowserService.importProfiles(discovered, ['facebook', 'tiktok']);
  assert.equal(imported.created, 2);
  assert.equal(imported.displayNameChanged, 4);
  assert.deepEqual(
    BrowserService.getAll('facebook').filter(item => item.provider === 'gemlogin').map(item => item.name).sort(),
    [...profileNames.values()].sort()
  );
  assert.deepEqual(
    BrowserService.getAll('tiktok').filter(item => item.provider === 'gemlogin').map(item => item.name).sort(),
    [...profileNames.values()].sort()
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(profilesRoot, '17', 'Default', 'Preferences'), 'utf8')).profile.name,
    profileNames.get('17')
  );
  const searchSync = await BrowserProviderService.syncSearchEngineName(
    path.join(profilesRoot, '17'),
    profileNames.get('17')
  );
  assert.equal(searchSync.changed, 1);
  const syncedWebData = new SQL.Database(
    fs.readFileSync(path.join(profilesRoot, '17', 'Default', 'Web Data'))
  );
  assert.equal(
    syncedWebData.exec('SELECT short_name FROM keywords LIMIT 1')[0].values[0][0],
    profileNames.get('17')
  );
  syncedWebData.close();

  const firstPass = await BrowserService.unlinkPlatforms(imported.ids, 'facebook');
  assert.equal(firstPass.successCount, 2);
  assert.equal(firstPass.results.every(item => item.deletedPhysicalProfile === false), true);
  const secondPass = await BrowserService.unlinkPlatforms(imported.ids, 'tiktok');
  assert.equal(secondPass.successCount, 2);
  assert.equal(secondPass.results.every(item => item.deletedPhysicalProfile === false), true);
  for (const id of imported.ids) await BrowserService.delete(id);
  assert.equal(fs.existsSync(path.join(profilesRoot, '17')), true);
  assert.equal(fs.existsSync(path.join(profilesRoot, '22')), true);
});

test('GemLogin discovery imports all 200 profiles across API pages', async () => {
  const BrowserProviderService = require('../src/services/browser-provider.service');
  const allProfiles = Array.from({ length: 200 }, (_, index) => ({
    id: `paged-${index + 1}`,
    name: `Paged profile ${index + 1}`,
    browser_version: 999,
  }));
  const requestedPages = [];
  const server = await listen((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    requestedPages.push(page);
    const start = (page - 1) * 50;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      success: true,
      data: allProfiles.slice(start, start + 50),
    }));
  });
  const port = server.address().port;
  const executable = path.join(testRoot, 'gem-paged-chrome.exe');
  fs.writeFileSync(executable, 'test');

  try {
    const discovered = await BrowserProviderService.discover('gemlogin', {
      gemlogin_api_url: `http://127.0.0.1:${port}/api`,
      gemlogin_profiles_dir: path.join(testRoot, 'gem-paged-missing'),
      gemlogin_executable_path: executable,
      gemlogin_extension_path: '',
    });
    assert.equal(discovered.length, 200);
    assert.equal(new Set(discovered.map(item => item.provider_profile_id)).size, 200);
    assert.deepEqual(requestedPages, [1, 2, 3, 4, 5]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('GemLogin discovery merges the local database when its API repeats only 50 profiles', async () => {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const BrowserProviderService = require('../src/services/browser-provider.service');
  const gemRoot = path.join(testRoot, 'gemlogin-200-fallback');
  const profilesRoot = path.join(gemRoot, 'profile', 'profiles');
  const executable = path.join(gemRoot, 'browser', '999', 'Chrome-bin', 'chrome.exe');
  fs.mkdirSync(profilesRoot, { recursive: true });
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, 'test');

  const gemDb = new SQL.Database();
  gemDb.run('CREATE TABLE profiles (id INTEGER PRIMARY KEY, name TEXT)');
  for (let id = 1; id <= 200; id++) {
    gemDb.run('INSERT INTO profiles (id, name) VALUES (?, ?)', [id, `Database profile ${id}`]);
  }
  fs.writeFileSync(path.join(gemRoot, 'db.db'), Buffer.from(gemDb.export()));
  gemDb.close();

  let requests = 0;
  const firstPage = Array.from({ length: 50 }, (_, index) => ({
    id: index + 1,
    name: `API profile ${index + 1}`,
    browser_version: 999,
  }));
  const server = await listen((req, res) => {
    requests++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, data: firstPage }));
  });
  const port = server.address().port;

  try {
    const discovered = await BrowserProviderService.discover('gemlogin', {
      gemlogin_api_url: `http://127.0.0.1:${port}/api`,
      gemlogin_profiles_dir: profilesRoot,
      gemlogin_executable_path: executable,
      gemlogin_extension_path: '',
    });
    assert.equal(discovered.length, 200);
    assert.equal(new Set(discovered.map(item => item.provider_profile_id)).size, 200);
    assert.equal(discovered.find(item => item.provider_profile_id === '1').name, 'Database profile 1');
    assert.equal(discovered.find(item => item.provider_profile_id === '200').name, 'Database profile 200');
    assert.equal(requests, 2);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
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
      gemlogin_profiles_dir: path.join(testRoot, 'gem-api-no-local-profiles'),
      gemlogin_executable_path: gemExecutable,
      gemlogin_extension_path: '',
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
