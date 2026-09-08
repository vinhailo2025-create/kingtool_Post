/**
 * Unified browser-provider integration.
 *
 * Provider-owned profiles are never copied or deleted. GoLogin/GemLogin use
 * their installed Chromium and the original user-data directory. GPM and
 * GenLogin are started/stopped through their local APIs, then attached over
 * Chrome DevTools Protocol (CDP).
 */
const db = require('../database/init');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const net = require('net');
const { execFileSync, spawn } = require('child_process');

const PROVIDERS = {
  chrome: { id: 'chrome', label: 'Chrome', mode: 'managed', discover: false },
  // Kept internally so old database rows never fall back to managed Chrome.
  chrome_existing: {
    id: 'chrome_existing', label: 'Chrome có sẵn (không hỗ trợ)', mode: 'direct', discover: false, deprecated: true,
  },
  gologin: { id: 'gologin', label: 'GoLogin', mode: 'direct', discover: true },
  gemlogin: { id: 'gemlogin', label: 'GemLogin', mode: 'provider_api', discover: true },
  gpm: { id: 'gpm', label: 'GPM Login', mode: 'provider_api', discover: true },
  genlogin: { id: 'genlogin', label: 'GenLogin', mode: 'provider_api', discover: true },
};

const DEFAULT_CONFIG = {
  gologin_profiles_dir: path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'GoLogin', 'profiles'),
  gologin_executable_path: path.join(os.homedir(), '.gologin', 'browser', 'orbita-browser-142', 'chrome.exe'),
  gemlogin_profiles_dir: path.join(os.homedir(), '.gemlogin', 'profile', 'profiles'),
  gemlogin_executable_path: path.join(os.homedir(), '.gemlogin', 'browser', '137', 'Chrome-bin', 'chrome.exe'),
  gemlogin_extension_path: path.join(os.homedir(), '.gemlogin', 'extensions', 'chrome_gem_v1'),
  gemlogin_api_url: 'http://127.0.0.1:1010/api',
  gpm_api_url: 'http://127.0.0.1:9495/api/v1',
  gpm_executable_path: path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'Programs', 'GPMLoginGlobal', 'GPMLoginGlobal.exe'
  ),
  genlogin_api_url: 'http://127.0.0.1:55550/backend/profiles',
  genlogin_token: '',
};

const GOLOGIN_ARGS = [
  '--donut-pie=undefined',
  '--webrtc-ip-handling-policy=default_public_interface_only',
  '--component-updater=fast-update,initial-delay=0.1',
  '--disable-features=PrintCompositorLPAC',
  '--font-masking-mode=2',
  '--restore-last-session',
  '--lang=vi-VN',
  '--disable-encryption',
];

const GEMLOGIN_ARGS = [
  '--no-first-run', '--no-crashpad', '--disable-crashpad', '--metrics-recording-only',
  '--no-default-browser-check', '--disable-crash-reporter',
  '--disable-features=FlashDeprecationWarning,EnablePasswordsAccountStorage,CalculateNativeWinOcclusion,AcceleratedVideoDecode,ChromeLabs,ReadLater,ChromeWhatsNewUI,TrackingProtection3pcd,AutofillServerCommunication',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--hide-crash-restore-bubble', '--disable-background-mode',
  '--disable-timer-throttling', '--disable-render-backgrounding',
  '--disable-background-media-suspend', '--disable-external-intent-requests',
  '--disable-ipc-flooding-protection', '--disable-extension-turned-off',
  '--disable-autofill-keyboard-accessory-view', '--disable-component-extensions-with-background-pages',
  '--log-level=3', '--silent-debugger-extension-api', '--force-device-scale-factor=1',
];

function normalizeProvider(provider) {
  const key = String(provider || 'chrome').trim().toLowerCase();
  return PROVIDERS[key] ? key : 'chrome';
}

function getSetting(key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value == null ? '' : value));
}

function getConfig() {
  const config = {};
  for (const [key, fallback] of Object.entries(DEFAULT_CONFIG)) {
    const stored = getSetting(key);
    config[key] = stored == null || stored === '' ? fallback : stored;
  }
  return config;
}

function saveConfig(input = {}) {
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (Object.prototype.hasOwnProperty.call(input, key)) setSetting(key, input[key]);
  }
  return getConfig();
}

function safeConfig(config = getConfig()) {
  return {
    ...config,
    genlogin_token: '',
    genlogin_has_token: !!config.genlogin_token,
  };
}

function versionParts(value) {
  return String(value || '').match(/\d+/g)?.map(Number) || [];
}

function compareVersions(a, b) {
  const aa = versionParts(a);
  const bb = versionParts(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const delta = (aa[i] || 0) - (bb[i] || 0);
    if (delta) return delta;
  }
  return 0;
}

function findLatestExecutable(root, folderPrefix, suffix) {
  try {
    const candidates = fs.readdirSync(root, { withFileTypes: true })
      .filter(item => item.isDirectory() && (!folderPrefix || item.name.startsWith(folderPrefix)))
      .sort((a, b) => compareVersions(b.name, a.name));
    for (const item of candidates) {
      const executable = path.join(root, item.name, ...suffix);
      if (fs.existsSync(executable)) return executable;
    }
  } catch (_) {}
  return '';
}

function readProfileName(userDataDir, fallback) {
  try {
    const localState = JSON.parse(fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf8'));
    const info = localState?.profile?.info_cache?.Default;
    if (info?.name && !/^person\s*\d*$/i.test(info.name)) return info.name;
  } catch (_) {}
  return fallback;
}

function readGoLoginName(userDataDir, fallback) {
  try {
    const preferences = JSON.parse(fs.readFileSync(path.join(userDataDir, 'Default', 'Preferences'), 'utf8'));
    const name = String(preferences?.gologin?.name || '').trim();
    if (name) return name;
  } catch (_) {}
  return readProfileName(userDataDir, fallback);
}

async function readGemLoginDatabaseNames(config) {
  const profilesRoot = String(config?.gemlogin_profiles_dir || '').trim();
  if (!profilesRoot) return new Map();
  const databasePath = path.resolve(profilesRoot, '..', '..', 'db.db');
  if (!fs.existsSync(databasePath)) return new Map();
  let gemDb;
  try {
    const { DatabaseSync } = require('node:sqlite');
    gemDb = new DatabaseSync(databasePath, { readOnly: true });
    const rows = gemDb.prepare(
      "SELECT CAST(id AS TEXT) AS provider_id, TRIM(COALESCE(name, '')) AS profile_name FROM profiles"
    ).all();
    return new Map(rows
      .map(row => [String(row.provider_id), String(row.profile_name || '').trim()])
      .filter(([, name]) => name));
  } catch (_) {
    return new Map();
  } finally {
    try { gemDb?.close(); } catch (_) {}
  }
}

function updateJsonDisplayName(file, update) {
  if (!file || !fs.existsSync(file)) return false;
  const raw = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(raw);
  const changed = update(data);
  if (!changed) return false;
  // Chromium preference files are compact JSON already. Write only when the
  // value differs, immediately before browser launch while the profile is
  // expected to be closed.
  fs.writeFileSync(file, JSON.stringify(data), 'utf8');
  return true;
}

/**
 * Rename the profile's default search engine so the omnibox/new-tab search box
 * shows the profile name instead of the "Orbita" (or "GemLogin") branding baked
 * into the provider's Chromium. Chromium re-syncs prepopulated engine names on
 * startup, so safe_for_autoreplace is cleared to make the custom name persist.
 * Runs against Default/Web Data (SQLite) while the profile is expected closed.
 */
async function syncSearchEngineName(userDataDir, name) {
  const webData = path.join(userDataDir, 'Default', 'Web Data');
  if (!userDataDir || !name || !fs.existsSync(webData)) return { changed: 0, skipped: true };
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  let sdb;
  try {
    sdb = new SQL.Database(fs.readFileSync(webData));
    // prepopulate_id = 1 is the provider default engine (Google-backed, branded
    // as "Orbita"). safe_for_autoreplace = 0 makes Chromium keep this custom name
    // instead of re-syncing it from the built-in prepopulated data on startup.
    sdb.run(
      "UPDATE keywords SET short_name = ?, safe_for_autoreplace = 0 WHERE prepopulate_id = 1 OR keyword = 'google.com'",
      [name]
    );
    const changed = sdb.exec('SELECT changes() AS c')[0]?.values?.[0]?.[0] || 0;
    if (changed) {
      // Atomic replace: Web Data must not be half-written if the profile races.
      const tmp = `${webData}.covergem-tmp`;
      fs.writeFileSync(tmp, Buffer.from(sdb.export()));
      fs.renameSync(tmp, webData);
    }
    return { changed, skipped: false };
  } catch (error) {
    // Most common: the profile is still open and holds a lock on Web Data.
    return { changed: 0, skipped: false, error: error.message };
  } finally {
    try { sdb?.close(); } catch (_) {}
  }
}

function discoverDirectories(provider, config) {
  const isGoLogin = provider === 'gologin';
  const root = isGoLogin ? config.gologin_profiles_dir : config.gemlogin_profiles_dir;
  if (!root || !fs.existsSync(root)) {
    throw new Error(`Không tìm thấy thư mục profile ${PROVIDERS[provider].label}. Hãy kiểm tra đường dẫn.`);
  }

  let executable = isGoLogin ? config.gologin_executable_path : config.gemlogin_executable_path;
  if (!executable) {
    executable = isGoLogin
      ? findLatestExecutable(path.join(os.homedir(), '.gologin', 'browser'), 'orbita-browser-', ['chrome.exe'])
      : findLatestExecutable(path.join(os.homedir(), '.gemlogin', 'browser'), '', ['Chrome-bin', 'chrome.exe']);
  }
  if (!executable || !fs.existsSync(executable)) {
    throw new Error(`Không tìm thấy file chạy ${PROVIDERS[provider].label}. Hãy chọn đúng chrome.exe của ứng dụng.`);
  }

  const extensionPath = isGoLogin ? '' : config.gemlogin_extension_path;
  const baseArgs = isGoLogin ? GOLOGIN_ARGS : GEMLOGIN_ARGS;
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(item => item.isDirectory())
    .map(item => {
      const userDataDir = path.join(root, item.name);
      const hasProfile = fs.existsSync(path.join(userDataDir, 'Default')) || fs.existsSync(path.join(userDataDir, 'Local State'));
      if (!hasProfile) return null;
      const args = [...baseArgs];
      if (extensionPath && fs.existsSync(extensionPath)) args.push(`--load-extension=${extensionPath}`);
      return {
        provider,
        provider_profile_id: item.name,
        name: isGoLogin
          ? readGoLoginName(userDataDir, `${PROVIDERS[provider].label} · ${item.name}`)
          : readProfileName(userDataDir, `${PROVIDERS[provider].label} · ${item.name}`),
        user_data_dir: userDataDir,
        executable_path: executable,
        extension_path: extensionPath,
        launch_args: args,
        connection_mode: 'direct',
        note: `Profile gốc từ ${PROVIDERS[provider].label}`,
        metadata: { source: 'local-folder' },
      };
    })
    .filter(Boolean);
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (_) { return reject(new Error(`API URL không hợp lệ: ${url}`)); }
    const client = parsed.protocol === 'https:' ? https : http;
    const body = options.body == null ? null : JSON.stringify(options.body);
    const req = client.request(parsed, {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.headers || {}),
      },
      timeout: options.timeout || 12000,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = raw ? JSON.parse(raw) : {}; } catch (_) { return reject(new Error(`API trả về dữ liệu không hợp lệ (${res.statusCode})`)); }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(data.message || data.error || `API lỗi HTTP ${res.statusCode}`));
        }
        resolve(data);
      });
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      reject(new Error('Cổng này không phải HTTP API của trình duyệt'));
    });
    req.on('timeout', () => req.destroy(new Error('API trình duyệt không phản hồi')));
    req.on('error', err => reject(new Error(`Không kết nối được API trình duyệt: ${err.message}`)));
    if (body) req.write(body);
    req.end();
  });
}

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

async function resolveGpmApiUrl(config) {
  const configured = trimSlash(config.gpm_api_url);
  try {
    await requestJson(`${configured}/profiles?page=1&page_size=1`, { timeout: 2500 });
    return configured;
  } catch (_) {}
  if (process.platform !== 'win32') return configured;

  const candidates = [];
  try {
    const settingsPath = path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'GPMLoginGlobal',
      'setting.dat'
    );
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const port = Number(settings?.api?.port);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      candidates.push(`http://127.0.0.1:${port}/api/v1`);
    }
  } catch (_) {}

  try {
    const script = [
      "$ids=@(Get-Process -Name 'GPMLoginGlobal' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id);",
      'if($ids.Count){Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |',
      'Where-Object {$ids -contains $_.OwningProcess -and $_.LocalPort -gt 0 -and $_.LocalPort -le 65535} |',
      'Select-Object -ExpandProperty LocalPort -Unique}',
    ].join(' ');
    const output = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', script,
    ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    const ports = [...new Set((output.match(/\d+/g) || []).map(Number))];
    for (const port of ports) {
      candidates.push(`http://127.0.0.1:${port}/api/v1`);
    }
  } catch (_) {}

  for (const candidate of [...new Set(candidates)]) {
    try {
      await requestJson(`${candidate}/profiles?page=1&page_size=1`, { timeout: 2500 });
      if (candidate !== configured) setSetting('gpm_api_url', candidate);
      config.gpm_api_url = candidate;
      return candidate;
    } catch (_) {}
  }
  return configured;
}

function findGpmExecutable(config) {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = [
    config?.gpm_executable_path,
    path.join(localAppData, 'Programs', 'GPMLoginGlobal', 'GPMLoginGlobal.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GPMLoginGlobal', 'GPMLoginGlobal.exe'),
  ];
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) || '';
}

function gpmManagerRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const output = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "(Get-Process -Name 'GPMLoginGlobal' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id)",
    ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    return /\d+/.test(output);
  } catch (_) {
    return false;
  }
}

async function ensureGpmApiUrl(config) {
  let base = await resolveGpmApiUrl(config);
  try {
    await requestJson(`${base}/profiles?page=1&page_size=1`, { timeout: 2500 });
    return base;
  } catch (_) {}
  if (process.platform !== 'win32') {
    throw new Error('GPM Local API is not available');
  }

  const executable = findGpmExecutable(config);
  if (!executable) {
    throw new Error('Không tìm thấy GPMLoginGlobal.exe. Hãy chọn lại file GPM Login trong cấu hình.');
  }
  if (!gpmManagerRunning()) {
    const child = spawn(executable, [], {
      cwd: path.dirname(executable),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
  }

  const deadline = Date.now() + 60000;
  let lastError;
  while (Date.now() < deadline) {
    await delay(750);
    base = await resolveGpmApiUrl(config);
    try {
      await requestJson(`${base}/profiles?page=1&page_size=1`, { timeout: 2500 });
      config.gpm_api_url = base;
      if (config.gpm_executable_path !== executable) {
        config.gpm_executable_path = executable;
        setSetting('gpm_executable_path', executable);
      }
      return base;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Không khởi động được GPM Local API: ${lastError?.message || 'timeout'}`);
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function usesProviderApi(profile) {
  const provider = normalizeProvider(profile?.provider);
  if (profile?.provider_endpoint || provider === 'gpm' || provider === 'genlogin') return true;
  if (provider !== 'gemlogin') return false;
  // Imported GemLogin profiles already contain the provider Chromium and the
  // original user-data directory. Launching these directly keeps the browser
  // independent from the GemLogin desktop application's lifetime.
  if (profile?.external_executable_path && profile?.external_user_data_dir
      && fs.existsSync(profile.external_executable_path)
      && fs.existsSync(profile.external_user_data_dir)) {
    return false;
  }
  if (profile?.connection_mode === 'provider_api') return true;
  return parseJsonObject(profile?.provider_metadata).source === 'gemlogin-local-api';
}

async function findRunningGpmSession(profile, config = null) {
  if (process.platform !== 'win32') return null;
  const profileId = String(profile?.provider_profile_id || '').replace(/[^a-z0-9._-]/gi, '');
  if (!profileId) return null;
  try {
    const script = [
      "$item=Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe'\" |",
      `Where-Object { $_.CommandLine -like '*${profileId}*' -and $_.CommandLine -notlike '*--type=*' } |`,
      'Select-Object -First 1 ProcessId,ParentProcessId,ExecutablePath,CommandLine;',
      'if($item){$item|ConvertTo-Json -Compress}',
    ].join(' ');
    const raw = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', script,
    ], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
    if (!raw) return null;
    const processInfo = JSON.parse(raw);
    const port = String(processInfo.CommandLine || '').match(/--remote-debugging-port(?:=|\s+)(\d+)/i)?.[1];
    if (!port) return null;
    const endpoint = `http://127.0.0.1:${port}`;
    await requestJson(`${endpoint}/json/version`, { timeout: 2500 });
    const launchArgs = splitWindowsCommandLine(processInfo.CommandLine).slice(1);
    const parent = readWindowsProcess(Number(processInfo.ParentProcessId));
    if (config && /^GPMLoginGlobal\.exe$/i.test(String(parent?.Name || ''))) {
      return handoffGpmBrowser(profile, {
        data: { addition_info: { process_id: Number(processInfo.ProcessId) } },
      }, endpoint, config);
    }
    saveGpmSnapshot(profile, processInfo.ExecutablePath, launchArgs);
    return {
      endpoint,
      providerOwned: false,
      startedByTool: false,
      processId: Number(processInfo.ProcessId) || null,
      reattached: true,
      independent: true,
    };
  } catch (_) {
    return null;
  }
}

function ensureUserDataDirArg(args, userDataDir) {
  const clean = [];
  let skipNext = false;
  for (const raw of Array.isArray(args) ? args : []) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const arg = String(raw);
    if (arg === '--user-data-dir') {
      skipNext = true;
      continue;
    }
    if (arg.startsWith('--user-data-dir=')) continue;
    clean.push(arg);
  }
  if (userDataDir) clean.push(`--user-data-dir=${path.resolve(userDataDir)}`);
  return clean;
}

function splitWindowsCommandLine(commandLine) {
  const value = String(commandLine || '');
  const args = [];
  let index = 0;
  while (index < value.length) {
    while (/\s/.test(value[index] || '')) index++;
    if (index >= value.length) break;
    let current = '';
    let quoted = false;
    while (index < value.length) {
      if (!quoted && /\s/.test(value[index])) break;
      if (value[index] === '"') {
        quoted = !quoted;
        index++;
        continue;
      }
      if (value[index] === '\\') {
        let count = 0;
        while (value[index + count] === '\\') count++;
        if (value[index + count] === '"') {
          current += '\\'.repeat(Math.floor(count / 2));
          if (count % 2) current += '"';
          else quoted = !quoted;
          index += count + 1;
          continue;
        }
        current += '\\'.repeat(count);
        index += count;
        continue;
      }
      current += value[index++];
    }
    args.push(current);
    while (/\s/.test(value[index] || '')) index++;
  }
  return args;
}

function readWindowsProcess(processId) {
  if (process.platform !== 'win32' || !Number.isInteger(Number(processId))) return null;
  try {
    const script = [
      `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(processId)}';`,
      'if($p){$p|Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine|ConvertTo-Json -Compress}',
    ].join(' ');
    const raw = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', script,
    ], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function processExists(processId) {
  if (!Number.isInteger(Number(processId))) return false;
  try {
    process.kill(Number(processId), 0);
    return true;
  } catch (_) {
    return false;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function freeLocalPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForProcessExit(processId, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (processExists(processId) && Date.now() < deadline) await delay(150);
  return !processExists(processId);
}

async function waitForCdp(endpoint, timeout = 15000) {
  const base = String(endpoint || '').replace(/\/$/, '');
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await requestJson(`${base}/json/version`, { timeout: 1500 });
      return true;
    } catch (error) {
      lastError = error;
      await delay(200);
    }
  }
  throw new Error(`GPM browser độc lập không mở được cổng CDP: ${lastError?.message || 'timeout'}`);
}

function gpmSnapshot(profile) {
  const metadata = parseJsonObject(profile?.provider_metadata);
  const snapshot = metadata.independent_launch;
  if (!snapshot?.executable_path || !Array.isArray(snapshot.launch_args)) return null;
  return fs.existsSync(snapshot.executable_path) ? snapshot : null;
}

function saveGpmSnapshot(profile, executablePath, launchArgs) {
  const metadata = parseJsonObject(profile?.provider_metadata);
  const userDataArg = launchArgs.find(arg => /^--user-data-dir(?:=|$)/i.test(String(arg)));
  const userDataDir = String(userDataArg || '').replace(/^--user-data-dir=/i, '');
  metadata.independent_launch = {
    executable_path: executablePath,
    user_data_dir: userDataDir,
    launch_args: launchArgs,
    captured_at: new Date().toISOString(),
  };
  db.prepare(`
    UPDATE browsers
    SET external_executable_path = ?, external_user_data_dir = ?,
        external_launch_args = ?, provider_metadata = ?, connection_mode = 'direct'
    WHERE provider = 'gpm' AND provider_profile_id = ?
  `).run(
    executablePath,
    userDataDir || profile.external_user_data_dir || '',
    JSON.stringify(launchArgs),
    JSON.stringify(metadata),
    String(profile.provider_profile_id)
  );
}

async function launchStoredGpm(profile, layout = {}) {
  const snapshot = gpmSnapshot(profile);
  if (!snapshot) return null;
  const port = await freeLocalPort();
  const args = snapshot.launch_args.filter(arg => !/^(?:--remote-debugging-port=|--window-size=|--window-position=)/i.test(String(arg)));
  args.push(`--remote-debugging-port=${port}`);
  if (layout.width && layout.height) args.push(`--window-size=${layout.width},${layout.height}`);
  if (layout.left != null && layout.top != null) args.push(`--window-position=${layout.left},${layout.top}`);
  const child = spawn(snapshot.executable_path, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.on('error', () => {});
  child.unref();
  const endpoint = `http://127.0.0.1:${port}`;
  await waitForCdp(endpoint);
  return {
    endpoint,
    providerOwned: false,
    startedByTool: true,
    processId: child.pid,
    independent: true,
    offline: true,
  };
}

async function handoffGpmBrowser(profile, response, endpoint, config) {
  if (process.platform !== 'win32') return null;
  const processId = Number(response?.data?.addition_info?.process_id);
  if (!Number.isInteger(processId)) return null;
  const snapshot = readWindowsProcess(processId);
  if (!snapshot?.ExecutablePath || !snapshot?.CommandLine || !fs.existsSync(snapshot.ExecutablePath)) return null;
  const parsed = splitWindowsCommandLine(snapshot.CommandLine);
  if (parsed.length < 2) return null;
  const args = parsed.slice(1);
  const id = encodeURIComponent(profile.provider_profile_id || '');

  // Remove the provider's ownership first. If GPM still owns this PID, its
  // normal Exit command will close the profile browser as well.
  await requestJson(`${trimSlash(config.gpm_api_url)}/profiles/stop/${id}`, { timeout: 30000 });
  if (!await waitForProcessExit(processId)) {
    throw new Error('GPM không giải phóng tiến trình profile để chuyển sang chế độ độc lập');
  }

  const child = spawn(snapshot.ExecutablePath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.on('error', () => {});
  child.unref();
  await waitForCdp(endpoint);
  saveGpmSnapshot(profile, snapshot.ExecutablePath, args);
  return {
    endpoint,
    providerOwned: false,
    startedByTool: true,
    processId: child.pid,
    independent: true,
  };
}

function gemExecutableForVersion(version, config) {
  const versionPath = version
    ? path.join(os.homedir(), '.gemlogin', 'browser', String(version), 'Chrome-bin', 'chrome.exe')
    : '';
  if (versionPath && fs.existsSync(versionPath)) return versionPath;
  if (config.gemlogin_executable_path && fs.existsSync(config.gemlogin_executable_path)) return config.gemlogin_executable_path;
  return findLatestExecutable(path.join(os.homedir(), '.gemlogin', 'browser'), '', ['Chrome-bin', 'chrome.exe']);
}

function gemLoginResponseItems(response) {
  const candidates = [
    response?.data?.data,
    response?.data?.items,
    response?.data?.profiles,
    response?.data,
    response?.items,
    response?.profiles,
    response,
  ];
  return candidates.find(Array.isArray) || [];
}

function gemLoginPageInfo(response) {
  const containers = [
    response?.data && !Array.isArray(response.data) ? response.data : null,
    response?.pagination,
    response?.meta,
    response,
  ].filter(Boolean);
  const numberFrom = keys => {
    for (const container of containers) {
      for (const key of keys) {
        const value = Number(container?.[key]);
        if (Number.isFinite(value) && value >= 0) return value;
      }
    }
    return 0;
  };
  return {
    lastPage: numberFrom(['last_page', 'lastPage', 'page_count', 'pageCount', 'total_pages', 'totalPages']),
    total: numberFrom(['total', 'total_count', 'totalCount']),
  };
}

async function readAllGemLoginApiProfiles(config) {
  const endpoint = `${trimSlash(config.gemlogin_api_url)}/profiles`;
  const profiles = new Map();

  // GemLogin releases commonly cap one response at 50 records. Keep paging
  // until the API returns no new IDs, including APIs without page metadata.
  for (let page = 1; page <= 1000; page++) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const response = await requestJson(
      `${endpoint}${separator}page=${page}&page_size=100`,
      { timeout: 10000 }
    );
    if (response?.success === false) {
      throw new Error(response.message || 'GemLogin API rejected profile discovery');
    }

    const items = gemLoginResponseItems(response);
    let added = 0;
    for (const item of items) {
      const providerId = String(item?.id ?? item?.profile_id ?? item?.profileId ?? '').trim();
      if (!providerId || profiles.has(providerId)) continue;
      profiles.set(providerId, item);
      added++;
    }

    const pageInfo = gemLoginPageInfo(response);
    if (!items.length || !added) break;
    if (pageInfo.lastPage && page >= pageInfo.lastPage) break;
    if (pageInfo.total && profiles.size >= pageInfo.total) break;
  }

  return [...profiles.values()];
}

function gemLoginProfileFromApi(item, config, localNames) {
  const providerId = String(item?.id ?? item?.profile_id ?? item?.profileId ?? '').trim();
  if (!providerId) return null;
  const userDataDir = item.profile_path || item.profilePath || path.join(config.gemlogin_profiles_dir, providerId);
  const extensionPath = config.gemlogin_extension_path;
  const args = [...GEMLOGIN_ARGS];
  if (extensionPath && fs.existsSync(extensionPath)) args.push(`--load-extension=${extensionPath}`);
  return {
    provider: 'gemlogin',
    provider_profile_id: providerId,
    name: localNames.get(providerId)
      || String(item.name || item.title || item.profile_name || '').trim()
      || `GemLogin - ${providerId}`,
    user_data_dir: userDataDir,
    executable_path: gemExecutableForVersion(item.browser_version || item.browserVersion, config),
    extension_path: extensionPath,
    launch_args: args,
    connection_mode: 'provider_api',
    note: item.note || 'Profile from GemLogin',
    metadata: { ...item, source: 'gemlogin-local-api' },
  };
}

function gemLoginProfileFromDatabase(providerId, name, config) {
  const extensionPath = config.gemlogin_extension_path;
  const args = [...GEMLOGIN_ARGS];
  if (extensionPath && fs.existsSync(extensionPath)) args.push(`--load-extension=${extensionPath}`);
  return {
    provider: 'gemlogin',
    provider_profile_id: providerId,
    name: name || `GemLogin - ${providerId}`,
    user_data_dir: path.join(config.gemlogin_profiles_dir, providerId),
    executable_path: gemExecutableForVersion('', config),
    extension_path: extensionPath,
    launch_args: args,
    connection_mode: 'provider_api',
    note: 'Profile from GemLogin',
    metadata: { source: 'gemlogin-local-db' },
  };
}

async function discoverGemLogin(config) {
  const localNames = await readGemLoginDatabaseNames(config);
  const profiles = new Map();
  let apiError = null;
  try {
    const apiItems = await readAllGemLoginApiProfiles(config);
    for (const item of apiItems) {
      const profile = gemLoginProfileFromApi(item, config, localNames);
      if (profile) profiles.set(profile.provider_profile_id, profile);
    }
  } catch (error) {
    apiError = error;
  }

  try {
    for (const folderProfile of discoverDirectories('gemlogin', config)) {
      const providerId = String(folderProfile.provider_profile_id);
      const authoritativeName = localNames.get(providerId);
      const existing = profiles.get(providerId);
      if (existing) {
        profiles.set(providerId, {
          ...folderProfile,
          ...existing,
          name: authoritativeName || existing.name || folderProfile.name,
          metadata: { ...folderProfile.metadata, ...existing.metadata },
        });
      } else {
        // When the database is readable it is the authoritative catalog.
        // Ignore leftover profile folders that GemLogin has already removed.
        if (localNames.size && !authoritativeName) continue;
        profiles.set(providerId, {
          ...folderProfile,
          name: authoritativeName || folderProfile.name,
          metadata: {
            ...folderProfile.metadata,
            source: authoritativeName ? 'gemlogin-local-db' : folderProfile.metadata?.source,
          },
        });
      }
    }
  } catch (folderError) {
    if (!profiles.size && !localNames.size && apiError) throw apiError;
    if (!profiles.size && !localNames.size) throw folderError;
  }

  // The local database remains the complete catalog when an older API keeps
  // returning only its first page.
  for (const [providerId, name] of localNames) {
    const existing = profiles.get(providerId);
    if (existing) {
      profiles.set(providerId, { ...existing, name });
    } else {
      profiles.set(providerId, gemLoginProfileFromDatabase(providerId, name, config));
    }
  }

  if (!profiles.size) {
    if (apiError) throw apiError;
    throw new Error('GemLogin has no profiles');
  }
  const result = [...profiles.values()];
  return result;
}

async function discoverGpm(config) {
  try {
    const base = await resolveGpmApiUrl(config);
    let page = 1;
    let lastPage = 1;
    const profiles = [];
    do {
      const response = await requestJson(`${base}/profiles?page=${page}&page_size=100&sort=2`);
      if (response.success === false) throw new Error(response.message || 'GPM Login từ chối yêu cầu');
      const pagination = response.data || {};
      const items = Array.isArray(pagination.data) ? pagination.data : (Array.isArray(pagination) ? pagination : []);
      profiles.push(...items);
      lastPage = Number(pagination.last_page || 1);
      page++;
    } while (page <= lastPage);

    return profiles.map(item => ({
      provider: 'gpm',
      provider_profile_id: String(item.id),
      name: item.name || `GPM · ${item.id}`,
      user_data_dir: item.storage_path || '',
      executable_path: '',
      extension_path: '',
      launch_args: [],
      connection_mode: 'provider_api',
      note: item.note || 'Profile từ GPM Login',
      metadata: item,
    }));
  } catch (apiError) {
    const rows = db.prepare("SELECT * FROM browsers WHERE provider = 'gpm' ORDER BY name").all();
    if (!rows.length) {
      throw new Error(`Không kết nối được GPM Login: ${apiError.message}`);
    }
    return rows.map(row => {
      const metadata = parseJsonObject(row.provider_metadata);
      const snapshot = metadata.independent_launch || {};
      return {
        provider: 'gpm',
        provider_profile_id: String(row.provider_profile_id),
        name: row.name || `GPM · ${row.provider_profile_id}`,
        user_data_dir: snapshot.user_data_dir || row.external_user_data_dir || '',
        executable_path: snapshot.executable_path || row.external_executable_path || '',
        extension_path: row.external_extension_path || '',
        launch_args: Array.isArray(snapshot.launch_args) ? snapshot.launch_args : [],
        connection_mode: snapshot.executable_path ? 'direct' : 'provider_api',
        note: row.note || 'Profile từ GPM Login',
        metadata: { ...metadata, offline: true, api_error: apiError.message },
      };
    });
  }
}

function authHeaders(config) {
  return config.genlogin_token ? { Authorization: `Bearer ${config.genlogin_token}` } : {};
}

async function discoverGenLogin(config) {
  const base = trimSlash(config.genlogin_api_url);
  const separator = base.includes('?') ? '&' : '?';
  const response = await requestJson(`${base}${separator}offset=0&limit=100`, { headers: authHeaders(config) });
  const data = response.data || response;
  const items = data.items || data.profiles || response.profiles || [];
  if (!Array.isArray(items)) throw new Error(response.message || 'Không đọc được danh sách profile GenLogin');
  return items.map(item => ({
    provider: 'genlogin',
    provider_profile_id: String(item.id || item._id),
    name: item.name || item.title || `GenLogin · ${item.id || item._id}`,
    user_data_dir: item.storage_path || item.profile_path || '',
    executable_path: '',
    extension_path: '',
    launch_args: [],
    connection_mode: 'provider_api',
    note: item.note || 'Profile từ GenLogin',
    metadata: item,
  }));
}

function extractEndpoint(payload) {
  const data = payload?.data || payload || {};
  const endpoint = data.wsEndpoint || data.wsUrl || data.websocketDebuggerUrl
    || data.websocket_debugging_url || data.websocket_url || data.ws_endpoint;
  if (endpoint) return endpoint;
  const address = String(data.remote_debugging_address || '').trim();
  if (address) return /^(?:https?|wss?):\/\//i.test(address) ? address : `http://${address}`;
  const port = data.remote_debugging_port || data.port;
  return port ? `http://127.0.0.1:${port}` : '';
}

const BrowserProviderService = {
  PROVIDERS,
  normalizeProvider,
  getConfig,
  saveConfig,
  usesProviderApi,
  ensureUserDataDirArg,
  splitWindowsCommandLine,
  _private: {
    resolveGpmApiUrl,
    ensureGpmApiUrl,
    findGpmExecutable,
  },

  /**
   * Keep Chromium's own profile label aligned with the provider display name.
   * This changes only UI metadata; cookies, fingerprint and proxy stay intact.
   */
  syncBrowserDisplayName(profile) {
    const provider = normalizeProvider(profile?.provider);
    const userDataDir = String(profile?.external_user_data_dir || '').trim();
    const name = String(profile?.name || '').trim();
    const isFallbackName = /^(?:GoLogin|GemLogin)\s*·/i.test(name);
    if (!['gologin', 'gemlogin'].includes(provider) || !userDataDir || !name || isFallbackName) {
      return { changed: 0, skipped: true };
    }
    let changed = 0;
    const files = [];

    try {
      const localState = path.join(userDataDir, 'Local State');
      if (updateJsonDisplayName(localState, data => {
        const entry = data?.profile?.info_cache?.Default;
        if (!entry) return false;
        let changed = false;
        if (entry.name !== name) {
          entry.name = name;
          changed = true;
        }
        // Chromium only exposes a custom label when the name is not marked as
        // automatically generated. Windows/browser surfaces may additionally
        // use shortcut_name when identifying a profile.
        if (entry.shortcut_name !== name) {
          entry.shortcut_name = name;
          changed = true;
        }
        if (entry.is_using_default_name !== false) {
          entry.is_using_default_name = false;
          changed = true;
        }
        return changed;
      })) {
        changed++;
        files.push('Local State');
      }

      const preferences = path.join(userDataDir, 'Default', 'Preferences');
      if (updateJsonDisplayName(preferences, data => {
        if (!data.profile || typeof data.profile !== 'object') data.profile = {};
        if (data.profile.name === name) return false;
        data.profile.name = name;
        return true;
      })) {
        changed++;
        files.push('Default/Preferences');
      }
      return { changed, files, skipped: false };
    } catch (error) {
      return { changed, files, skipped: false, error: error.message };
    }
  },

  syncSearchEngineName,
  readGemLoginDatabaseNames,

  getOverview() {
    return {
      providers: Object.values(PROVIDERS).filter(provider => !provider.deprecated),
      config: safeConfig(),
    };
  },

  async discover(provider, inputConfig = {}) {
    if (String(provider || '').trim().toLowerCase() === 'chrome_existing') {
      throw new Error('Chrome có sẵn đã ngừng hỗ trợ để bảo vệ cookie và dữ liệu Chrome gốc.');
    }
    provider = normalizeProvider(provider);
    if (provider === 'chrome') return [];
    const config = saveConfig(inputConfig);
    if (provider === 'gologin') return discoverDirectories(provider, config);
    if (provider === 'gemlogin') return discoverGemLogin(config);
    if (provider === 'gpm') return discoverGpm(config);
    if (provider === 'genlogin') return discoverGenLogin(config);
    return [];
  },

  async start(profile, layout = {}) {
    const provider = normalizeProvider(profile.provider);
    if (provider === 'chrome_existing') {
      throw new Error('Chrome có sẵn đã ngừng hỗ trợ. Hãy dùng Chrome mới hoặc trình duyệt Anti-detect.');
    }
    const config = getConfig();
    if (profile.provider_endpoint) return { endpoint: profile.provider_endpoint, providerOwned: true, startedByTool: false };

    if (provider === 'gemlogin') {
      const id = encodeURIComponent(profile.provider_profile_id || '');
      if (!id) throw new Error('Profile GemLogin khong co ID goc');
      const response = await requestJson(`${trimSlash(config.gemlogin_api_url)}/profiles/start/${id}`, { timeout: 60000 });
      if (response.success === false || response.data?.success === false) {
        throw new Error(response.message || response.data?.message || 'GemLogin tu choi mo profile');
      }
      const endpoint = extractEndpoint(response);
      if (!endpoint) throw new Error('GemLogin khong tra ve dia chi CDP');
      return { endpoint, providerOwned: true, startedByTool: true };
    }

    if (provider === 'gpm') {
      // The GPM Chromium process and its CDP port can remain alive after the
      // GPM desktop manager is closed. Reattach first so Super Post - King does not
      // unnecessarily depend on the local API being available afterwards.
      const running = await findRunningGpmSession(profile, config);
      if (running) return running;
      const stored = await launchStoredGpm(profile, layout);
      if (stored) return stored;
      const gpmBase = await ensureGpmApiUrl(config);
      config.gpm_api_url = gpmBase;
      const query = new URLSearchParams();
      if (layout.left != null && layout.top != null) query.set('window_pos', `${layout.left},${layout.top}`);
      if (layout.width && layout.height) query.set('window_size', `${layout.width},${layout.height}`);
      const response = await requestJson(`${gpmBase}/profiles/start/${encodeURIComponent(profile.provider_profile_id)}?${query}`);
      if (response.success === false) throw new Error(response.message || 'Không mở được profile GPM Login');
      const debugPort = Number(response.data?.remote_debugging_port);
      const endpoint = debugPort
        ? `http://127.0.0.1:${debugPort}`
        : extractEndpoint(response);
      if (!endpoint) throw new Error('GPM Login không trả về cổng kết nối tự động hoá');
      const independent = await handoffGpmBrowser(profile, response, endpoint, config);
      if (independent) return independent;
      return {
        endpoint,
        providerOwned: true,
        startedByTool: true,
        processId: Number(response.data?.addition_info?.process_id) || null,
      };
    }

    if (provider === 'genlogin') {
      const base = trimSlash(config.genlogin_api_url);
      const id = encodeURIComponent(profile.provider_profile_id);
      let endpoint = '';
      try {
        endpoint = extractEndpoint(await requestJson(`${base}/${id}/ws-endpoint`, { headers: authHeaders(config) }));
      } catch (_) {}
      if (!endpoint) {
        const response = await requestJson(`${base}/${id}/start`, { method: 'PUT', headers: authHeaders(config) });
        endpoint = extractEndpoint(response);
        if (!endpoint) throw new Error(response.message || 'GenLogin không trả về wsEndpoint');
      }
      return { endpoint, providerOwned: true, startedByTool: true };
    }

    return null;
  },

  async stop(profile) {
    const provider = normalizeProvider(profile.provider);
    const config = getConfig();
    const id = encodeURIComponent(profile.provider_profile_id || '');
    if (provider === 'gemlogin') {
      await requestJson(`${trimSlash(config.gemlogin_api_url)}/profiles/close/${id}`, { timeout: 30000 });
      return;
    }
    if (provider === 'gpm') {
      await requestJson(`${trimSlash(config.gpm_api_url)}/profiles/stop/${id}`);
      return;
    }
    if (provider === 'genlogin') {
      await requestJson(`${trimSlash(config.genlogin_api_url)}/${id}/stop`, { method: 'PUT', headers: authHeaders(config) });
    }
  },
};

module.exports = BrowserProviderService;
