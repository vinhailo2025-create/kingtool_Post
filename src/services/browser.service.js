/**
 * Browser Service - Chrome Profile Management
 * Manages Chrome profiles with proxy support via puppeteer-core
 */

const db = require('../database/init');
const config = require('../../config');
const path = require('path');
const fs = require('fs');
const { execFileSync, spawn } = require('child_process');
const puppeteer = require('puppeteer-core');
const initSqlJs = require('sql.js');
const BrowserProviderService = require('./browser-provider.service');
const BrowserWindowNameService = require('./browser-window-name.service');
const { PLATFORMS, normalizePlatform } = require('../platforms/platform.utils');

// Doc offline file Cookies cua tung profile de biet da dang nhap nen tang nao,
// khong can mo trinh duyet. Ten cookie plaintext + host_key du de nhan biet.
let cookieSqlPromise = null;
function getCookieSql() {
  if (!cookieSqlPromise) cookieSqlPromise = initSqlJs();
  return cookieSqlPromise;
}

const PLATFORM_COOKIE_SPECS = Object.freeze({
  facebook: { any: new Set(['c_user']), domains: ['facebook.com'] },
  tiktok: { any: new Set(['sessionid', 'sessionid_ss']), domains: ['tiktok.com'] },
  youtube: {
    any: new Set(['SAPISID', '__Secure-1PAPISID', '__Secure-3PAPISID']),
    domains: ['google.com', 'youtube.com'],
  },
  threads: { all: new Set(['sessionid', 'ds_user_id']), domains: ['threads.com', 'threads.net'] },
  instagram: { all: new Set(['sessionid', 'ds_user_id']), domains: ['instagram.com'] },
  x: { any: new Set(['auth_token']), domains: ['x.com', 'twitter.com'] },
  zalovideo: { any: new Set(['zpsid', 'zpw_sek', 'zalo_session']), domains: ['zalo.me'] },
});

// Cookies co the nam o vai vi tri tuy phien ban Chrome/profile.
const COOKIE_FILE_CANDIDATES = Object.freeze([
  ['Default', 'Network', 'Cookies'],
  ['Network', 'Cookies'],
  ['Default', 'Cookies'],
  ['Cookies'],
]);

function findCookiesFile(baseDir) {
  if (!baseDir) return '';
  for (const parts of COOKIE_FILE_CANDIDATES) {
    const candidate = path.join(baseDir, ...parts);
    try { if (fs.existsSync(candidate)) return candidate; } catch (_) {}
  }
  return '';
}

function cookieHostMatches(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

const CHROME_EPOCH_MICROS = 11644473600000000;

function cookieIsUsable(cookie, now = Date.now()) {
  if (!cookie || !cookie.name || !cookie.host || !cookie.hasValue) return false;
  const expires = Number(cookie.expires || 0);
  if (!Number.isFinite(expires) || expires <= 0) return true;
  // Chrome SQLite uses microseconds since 1601; Puppeteer uses Unix seconds.
  const expiresAt = expires > 1000000000000
    ? (expires - CHROME_EPOCH_MICROS) / 1000
    : expires * 1000;
  return expiresAt > now;
}

function detectPlatformLogins(cookies, now = Date.now()) {
  const usable = (cookies || []).filter(cookie => cookieIsUsable(cookie, now));
  const logins = [];
  for (const platform of PLATFORMS) {
    const spec = PLATFORM_COOKIE_SPECS[platform];
    if (!spec) continue;
    const matches = usable.filter(cookie =>
      spec.domains.some(domain => cookieHostMatches(cookie.host, domain))
    );
    const names = new Set(matches.map(cookie => cookie.name));
    const matched = spec.all
      ? [...spec.all].every(name => names.has(name))
      : [...(spec.any || [])].some(name => names.has(name));
    if (matched) logins.push(platform);
  }
  return logins;
}

// Tra ve mang nen tang dang nhap, hoac null neu khong doc duoc file Cookies.
async function readProfileLogins(baseDir) {
  const cookiesFile = findCookiesFile(baseDir);
  if (!cookiesFile) return null;
  let buffer;
  try { buffer = fs.readFileSync(cookiesFile); } catch (_) { return null; }
  const SQL = await getCookieSql();
  let cdb = null;
  const cookies = [];
  try {
    cdb = new SQL.Database(buffer);
    const res = cdb.exec('SELECT name, host_key, value, encrypted_value, expires_utc FROM cookies');
    if (res && res[0]) {
      const nameIdx = res[0].columns.indexOf('name');
      const hostIdx = res[0].columns.indexOf('host_key');
      const valueIdx = res[0].columns.indexOf('value');
      const encryptedIdx = res[0].columns.indexOf('encrypted_value');
      const expiresIdx = res[0].columns.indexOf('expires_utc');
      for (const row of res[0].values) {
        const encrypted = row[encryptedIdx];
        cookies.push({
          name: String(row[nameIdx] == null ? '' : row[nameIdx]),
          host: String(row[hostIdx] == null ? '' : row[hostIdx]).toLowerCase(),
          hasValue: Boolean(String(row[valueIdx] || '').length || encrypted?.length),
          expires: Number(row[expiresIdx] || 0),
        });
      }
    }
  } catch (_) {
    return null;
  } finally {
    try { cdb && cdb.close(); } catch (_) {}
  }
  return detectPlatformLogins(cookies);
}

// Active browser instances: id -> { browser, page }
const activeBrowsers = new Map();
// Chrome sessions opened without CDP/Puppeteer so Google sign-in remains a
// normal first-party browser flow while using the same managed profile data.
const manualLoginBrowsers = new Map();
const manualLoginStarting = new Set();
// Automation owners currently using a physical Chrome profile.
const automationLeases = new Map();
// Reserve a tile before an asynchronous provider launch completes. Without
// this, concurrent launches all see the same activeBrowsers.size and overlap.
const windowSlots = new Map();
let cachedHostWorkArea = null;

const CHROME_SESSION_DEFAULT_ARGS = Object.freeze([
  '--enable-automation',
  '--disable-sync',
  '--disable-extensions',
  '--disable-component-extensions-with-background-pages',
  '--disable-background-networking',
  '--password-store=basic',
  '--use-mock-keychain',
]);

function waitMs(ms) {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

function liveStatus(id) {
  if (manualLoginBrowsers.has(Number(id))) return 'login';
  return activeBrowsers.has(Number(id)) ? 'open' : 'closed';
}

async function closeAnonymizedProxy(proxyServer) {
  if (!proxyServer) return;
  const proxyChain = require('proxy-chain');
  await proxyChain.closeAnonymizedProxy(proxyServer, true).catch(() => {});
}

function finishManualLogin(id, instance) {
  id = Number(id);
  if (manualLoginBrowsers.get(id) !== instance) return;
  manualLoginBrowsers.delete(id);
  windowSlots.delete(id);
  closeAnonymizedProxy(instance.proxyServer).catch(() => {});
  try {
    db.prepare("UPDATE browsers SET status = 'closed' WHERE id = ?").run(id);
  } catch (_) {}
}

function isTikTokUrl(value) {
  try {
    return /(?:^|\.)tiktok\.com$/i.test(new URL(String(value || '')).hostname);
  } catch (_) {
    return false;
  }
}

function hostWorkArea() {
  if (cachedHostWorkArea) return cachedHostWorkArea;
  if (process.platform === 'win32') {
    try {
      const command = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$r=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea;',
        'Write-Output "$($r.X),$($r.Y),$($r.Width),$($r.Height)"',
      ].join(' ');
      const output = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command', command,
      ], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
      const values = output.match(/-?\d+/g)?.slice(-4).map(Number);
      if (values?.length === 4 && values[2] >= 640 && values[3] >= 360) {
        cachedHostWorkArea = {
          left: values[0], top: values[1], width: values[2], height: values[3],
        };
        return cachedHostWorkArea;
      }
    } catch (_) {}
  }
  cachedHostWorkArea = { left: 0, top: 0, width: 1920, height: 1040 };
  return cachedHostWorkArea;
}

function profilePath(row) {
  return row.external_user_data_dir || path.join(config.CHROME_PROFILES_DIR, row.profile_dir);
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (_) {
    return [];
  }
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

function withoutWindowOverrides(args) {
  return (args || []).filter(value => !/^(?:--window-size=|--window-position=|--start-maximized$|--start-fullscreen$|--kiosk$)/i
    .test(String(value || '').trim()));
}

function safeProfileDir(provider, providerProfileId) {
  const key = String(providerProfileId || Date.now()).replace(/[^a-z0-9._-]+/gi, '-').slice(0, 100);
  return `external-${provider}-${key}`;
}

function pathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizeGroupName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Tên nhóm không được để trống');
  if (name.length > 60) throw new Error('Tên nhóm tối đa 60 ký tự');
  return name;
}

function groupNameKey(value) {
  return String(value || '').normalize('NFC').toLocaleLowerCase('vi');
}

function findDuplicateGroupName(name, exceptId = null) {
  const key = groupNameKey(name);
  return db.prepare('SELECT id, name FROM browser_groups').all().find(group =>
    Number(group.id) !== Number(exceptId) && groupNameKey(group.name) === key
  );
}

function uniqueIntegerIds(values) {
  return [...new Set((values || []).map(Number).filter(Number.isInteger))];
}

const BrowserService = {
  /**
   * Get all browser profiles
   */
  getAll(platform = 'facebook') {
    if (String(platform).toLowerCase() === 'all') {
      const rows = db.prepare(`
        SELECT b.*,
               MAX(COALESCE(bp.session_valid, 0)) AS platform_session_valid,
               MAX(bp.last_session_check) AS platform_last_session_check
        FROM browsers b
        LEFT JOIN browser_platforms bp ON bp.browser_id = b.id AND bp.enabled = 1
        GROUP BY b.id
        ORDER BY b.id DESC
      `).all();
      const memberships = db.prepare(`
        SELECT bgm.browser_id, bg.id, bg.name
        FROM browser_group_members bgm
        INNER JOIN browser_groups bg ON bg.id = bgm.group_id
        ORDER BY bg.name COLLATE NOCASE, bg.id
      `).all();
      const groupsByBrowser = new Map();
      for (const membership of memberships) {
        if (!groupsByBrowser.has(membership.browser_id)) groupsByBrowser.set(membership.browser_id, []);
        groupsByBrowser.get(membership.browser_id).push({
          id: Number(membership.id),
          name: membership.name,
        });
      }
      return rows.map(row => ({
        ...row,
        session_valid: row.platform_session_valid,
        last_session_check: row.platform_last_session_check,
        platform: 'all',
        profile_path: profilePath(row),
        provider: BrowserProviderService.normalizeProvider(row.provider),
        status: liveStatus(row.id),
        groups: groupsByBrowser.get(row.id) || [],
      }));
    }
    platform = normalizePlatform(platform);
    const rows = db.prepare(`
      SELECT b.*, bp.session_valid AS platform_session_valid,
             bp.last_session_check AS platform_last_session_check
      FROM browsers b
      INNER JOIN browser_platforms bp ON bp.browser_id = b.id
      WHERE bp.platform = ? AND bp.enabled = 1
      ORDER BY b.id DESC
    `).all(platform);
    const memberships = db.prepare(`
      SELECT bgm.browser_id, bg.id, bg.name
      FROM browser_group_members bgm
      INNER JOIN browser_groups bg ON bg.id = bgm.group_id
      ORDER BY bg.name COLLATE NOCASE, bg.id
    `).all();
    const groupsByBrowser = new Map();
    for (const membership of memberships) {
      if (!groupsByBrowser.has(membership.browser_id)) groupsByBrowser.set(membership.browser_id, []);
      groupsByBrowser.get(membership.browser_id).push({
        id: Number(membership.id),
        name: membership.name,
      });
    }

    // Attach live status and global group membership.
    return rows.map(row => ({
      ...row,
      session_valid: row.platform_session_valid,
      last_session_check: row.platform_last_session_check,
      platform,
      profile_path: profilePath(row),
      provider: BrowserProviderService.normalizeProvider(row.provider),
      status: liveStatus(row.id),
      groups: groupsByBrowser.get(row.id) || [],
    }));
  },

  getGroups(platform = 'facebook') {
    if (String(platform).toLowerCase() === 'all') {
      return db.prepare(`
        SELECT bg.id, bg.name, bg.created_at, bg.updated_at,
               COUNT(DISTINCT bgm.browser_id) AS profile_count
        FROM browser_groups bg
        LEFT JOIN browser_group_members bgm ON bgm.group_id = bg.id
        GROUP BY bg.id, bg.name, bg.created_at, bg.updated_at
        ORDER BY bg.name COLLATE NOCASE, bg.id
      `).all().map(group => ({
        ...group,
        id: Number(group.id),
        profile_count: Number(group.profile_count || 0),
      }));
    }
    platform = normalizePlatform(platform);
    return db.prepare(`
      SELECT bg.id, bg.name, bg.created_at, bg.updated_at,
             COUNT(DISTINCT CASE WHEN bp.platform = ? AND bp.enabled = 1
                                  THEN bgm.browser_id END) AS profile_count
      FROM browser_groups bg
      LEFT JOIN browser_group_members bgm ON bgm.group_id = bg.id
      LEFT JOIN browser_platforms bp ON bp.browser_id = bgm.browser_id
      GROUP BY bg.id, bg.name, bg.created_at, bg.updated_at
      ORDER BY bg.name COLLATE NOCASE, bg.id
    `).all(platform).map(group => ({
      ...group,
      id: Number(group.id),
      profile_count: Number(group.profile_count || 0),
    }));
  },

  createGroup(name, platform = 'facebook') {
    name = normalizeGroupName(name);
    const duplicate = findDuplicateGroupName(name);
    if (duplicate) throw new Error('Tên nhóm đã tồn tại');
    const result = db.prepare(
      'INSERT INTO browser_groups (name) VALUES (?)'
    ).run(name);
    return this.getGroups(platform).find(group => group.id === Number(result.lastInsertRowid));
  },

  renameGroup(id, name, platform = 'facebook') {
    id = Number(id);
    name = normalizeGroupName(name);
    if (!Number.isInteger(id) || !db.prepare('SELECT id FROM browser_groups WHERE id = ?').get(id)) {
      throw new Error('Nhóm không tồn tại');
    }
    const duplicate = findDuplicateGroupName(name, id);
    if (duplicate) throw new Error('Tên nhóm đã tồn tại');
    db.prepare(
      'UPDATE browser_groups SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(name, id);
    return this.getGroups(platform).find(group => group.id === id);
  },

  deleteGroup(id) {
    id = Number(id);
    if (!Number.isInteger(id) || !db.prepare('SELECT id FROM browser_groups WHERE id = ?').get(id)) {
      throw new Error('Nhóm không tồn tại');
    }
    db.transaction(() => {
      db.prepare('DELETE FROM browser_group_members WHERE group_id = ?').run(id);
      db.prepare('DELETE FROM browser_groups WHERE id = ?').run(id);
    })();
    return true;
  },

  assignGroups(profileIds, groupIds, mode = 'replace', platform = 'facebook') {
    const globalScope = String(platform).toLowerCase() === 'all';
    platform = globalScope ? 'all' : normalizePlatform(platform);
    const ids = uniqueIntegerIds(profileIds);
    const groups = uniqueIntegerIds(groupIds);
    if (!ids.length) throw new Error('Hãy chọn ít nhất một profile');
    if (ids.length > 200) throw new Error('Mỗi lượt chỉ cập nhật tối đa 200 profile');
    if (!['add', 'remove', 'replace'].includes(mode)) throw new Error('Thao tác nhóm không hợp lệ');

    const linkedProfile = globalScope
      ? db.prepare('SELECT 1 FROM browsers WHERE id = ?')
      : db.prepare(`
          SELECT 1
          FROM browser_platforms
          WHERE browser_id = ? AND platform = ? AND enabled = 1
        `);
    for (const id of ids) {
      if (!(globalScope ? linkedProfile.get(id) : linkedProfile.get(id, platform))) {
        throw new Error(`Profile ${id} không tồn tại trong nền tảng này`);
      }
    }

    const existingGroup = db.prepare('SELECT 1 FROM browser_groups WHERE id = ?');
    for (const groupId of groups) {
      if (!existingGroup.get(groupId)) throw new Error(`Nhóm ${groupId} không tồn tại`);
    }

    const removeAll = db.prepare('DELETE FROM browser_group_members WHERE browser_id = ?');
    const removeOne = db.prepare(
      'DELETE FROM browser_group_members WHERE browser_id = ? AND group_id = ?'
    );
    const addOne = db.prepare(
      'INSERT OR IGNORE INTO browser_group_members (browser_id, group_id) VALUES (?, ?)'
    );
    db.transaction(() => {
      for (const browserId of ids) {
        if (mode === 'replace') removeAll.run(browserId);
        if (mode === 'remove') {
          for (const groupId of groups) removeOne.run(browserId, groupId);
        } else {
          for (const groupId of groups) addOne.run(browserId, groupId);
        }
      }
    })();

    return {
      mode,
      profileIds: ids,
      groupIds: groups,
      profiles: this.getAll(platform).filter(profile => ids.includes(Number(profile.id))),
    };
  },

  /**
   * Get a single profile by ID
   */
  getById(id, platform = null) {
    const normalized = platform ? normalizePlatform(platform) : null;
    const row = normalized
      ? db.prepare(`
          SELECT b.*, bp.session_valid AS platform_session_valid,
                 bp.last_session_check AS platform_last_session_check
          FROM browsers b
          INNER JOIN browser_platforms bp ON bp.browser_id = b.id
          WHERE b.id = ? AND bp.platform = ? AND bp.enabled = 1
        `).get(id, normalized)
      : db.prepare('SELECT * FROM browsers WHERE id = ?').get(id);
    if (!row) return null;
    return {
      ...row,
      ...(normalized ? {
        session_valid: row.platform_session_valid,
        last_session_check: row.platform_last_session_check,
        platform: normalized,
      } : {}),
      profile_path: profilePath(row),
      provider: BrowserProviderService.normalizeProvider(row.provider),
      status: liveStatus(row.id),
    };
  },

  /**
   * Create a new browser profile
   */
  create({ name, proxy_type = 'none', proxy_host, proxy_port, proxy_user, proxy_pass, note }, platform = 'facebook') {
    if (!name || !name.trim()) {
      throw new Error('Tên profile không được để trống');
    }

    // Generate unique profile directory slug
    const slug = name.trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u00C0-\u024F\u1E00-\u1EFF]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      || 'profile';
    const timestamp = Date.now();
    const profile_dir = `${slug}-${timestamp}`;

    // Create the chrome profile directory
    const profilePath = path.join(config.CHROME_PROFILES_DIR, profile_dir);
    if (!fs.existsSync(profilePath)) {
      fs.mkdirSync(profilePath, { recursive: true });
    }

    const stmt = db.prepare(`
      INSERT INTO browsers (name, profile_dir, proxy_type, proxy_host, proxy_port, proxy_user, proxy_pass, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      name.trim(),
      profile_dir,
      proxy_type || 'none',
      proxy_host || null,
      proxy_port ? parseInt(proxy_port) : null,
      proxy_user || null,
      proxy_pass || null,
      note || null
    );

    const link = db.prepare(`
      INSERT OR IGNORE INTO browser_platforms (browser_id, platform)
      VALUES (?, ?)
    `);
    for (const targetPlatform of PLATFORMS) {
      link.run(result.lastInsertRowid, targetPlatform);
    }

    return this.getById(result.lastInsertRowid);
  },

  /** Prepare provider-owned data that needs a safe local copy before import. */
  importDiscoveredProfiles(items, platforms = ['facebook']) {
    if ((items || []).some(raw =>
      String(raw?.provider || '').trim().toLowerCase() === 'chrome_existing'
    )) {
      throw new Error('Chrome có sẵn đã ngừng hỗ trợ để bảo vệ cookie và dữ liệu Chrome gốc.');
    }
    return this.importProfiles(items, platforms);
  },

  /** Import or refresh profiles discovered from an external provider. */
  importProfiles(items, platforms = ['facebook']) {
    const targetPlatforms = [...PLATFORMS];
    const find = db.prepare('SELECT * FROM browsers WHERE provider = ? AND provider_profile_id = ?');
    const insert = db.prepare(`
      INSERT INTO browsers (
        name, profile_dir, proxy_type, note, provider, provider_profile_id,
        connection_mode, external_user_data_dir, external_executable_path,
        external_launch_args, external_extension_path, provider_endpoint, provider_metadata
      ) VALUES (?, ?, 'none', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const update = db.prepare(`
      UPDATE browsers SET name = ?, note = ?, connection_mode = ?,
        external_user_data_dir = ?, external_executable_path = ?,
        external_launch_args = ?, external_extension_path = ?,
        provider_endpoint = ?, provider_metadata = ?
      WHERE id = ?
    `);
    const link = db.prepare('INSERT OR IGNORE INTO browser_platforms (browser_id, platform) VALUES (?, ?)');
    let created = 0;
    let updated = 0;
    let linked = 0;
    const ids = [];

    db.transaction(() => {
      for (const raw of items || []) {
        if (String(raw?.provider || '').trim().toLowerCase() === 'chrome_existing') {
          throw new Error('Chrome có sẵn đã ngừng hỗ trợ để bảo vệ cookie và dữ liệu Chrome gốc.');
        }
        const provider = BrowserProviderService.normalizeProvider(raw.provider);
        if (provider === 'chrome') continue;
        const providerId = String(raw.provider_profile_id || '').trim();
        if (!providerId) continue;
        const existing = find.get(provider, providerId);
        const serializedArgs = JSON.stringify(Array.isArray(raw.launch_args) ? raw.launch_args : parseJsonArray(raw.launch_args));
        let metadata = raw.metadata || {};
        if (provider === 'gpm' && existing) {
          const oldMetadata = parseJsonObject(existing.provider_metadata);
          if (oldMetadata.independent_launch && !metadata.independent_launch) {
            metadata = { ...metadata, independent_launch: oldMetadata.independent_launch };
          }
        }
        const serializedMetadata = JSON.stringify(metadata);
        const values = [
          String(raw.name || `${provider} · ${providerId}`).trim(),
          raw.note || `Profile từ ${BrowserProviderService.PROVIDERS[provider].label}`,
          raw.connection_mode || BrowserProviderService.PROVIDERS[provider].mode,
          raw.user_data_dir || '', raw.executable_path || '', serializedArgs,
          raw.extension_path || '', raw.endpoint || '', serializedMetadata,
        ];
        let id;
        if (existing) {
          update.run(...values, existing.id);
          id = Number(existing.id);
          updated++;
        } else {
          const result = insert.run(
            values[0], safeProfileDir(provider, providerId), values[1], provider, providerId,
            ...values.slice(2)
          );
          id = Number(result.lastInsertRowid);
          created++;
        }
        ids.push(id);
        for (const platform of targetPlatforms) linked += link.run(id, platform).changes;
      }
    })();

    let displayNameChanged = 0;
    for (const id of ids) {
      const profile = this.getById(id);
      if (!profile) continue;
      displayNameChanged += BrowserProviderService.syncBrowserDisplayName(profile).changed || 0;
    }

    return { created, updated, linked, ids, platforms: targetPlatforms, displayNameChanged };
  },

  /** Remove deprecated references only; never touch original or copied browser data. */
  retireExistingChromeProfiles() {
    const rows = db.prepare("SELECT id FROM browsers WHERE provider = 'chrome_existing'").all();
    if (!rows.length) return { retired: 0 };
    db.transaction(() => {
      for (const row of rows) {
        db.prepare('DELETE FROM browser_platforms WHERE browser_id = ?').run(row.id);
        db.prepare('DELETE FROM browser_group_members WHERE browser_id = ?').run(row.id);
        db.prepare('DELETE FROM browsers WHERE id = ?').run(row.id);
        activeBrowsers.delete(Number(row.id));
        automationLeases.delete(Number(row.id));
        windowSlots.delete(Number(row.id));
      }
    })();
    return { retired: rows.length };
  },

  /** Refresh display names from each provider's authoritative metadata. */
  async refreshProviderNames(provider = null) {
    let providers = provider
      ? [BrowserProviderService.normalizeProvider(provider)]
      : db.prepare("SELECT DISTINCT provider FROM browsers WHERE provider IS NOT NULL AND provider <> 'chrome'")
          .all().map(row => BrowserProviderService.normalizeProvider(row.provider));
    providers = [...new Set(providers.filter(item => item !== 'chrome'))];
    const update = db.prepare('UPDATE browsers SET name = ? WHERE provider = ? AND provider_profile_id = ? AND name <> ?');
    let changed = 0;
    let matched = 0;
    let unmatched = 0;
    const matchedIds = new Set();
    const errors = [];

    const results = await Promise.allSettled(providers.map(async providerId => ({
      provider: providerId,
      profiles: await BrowserProviderService.discover(providerId, {}),
    })));
    db.transaction(() => {
      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        if (result.status === 'rejected') {
          errors.push({ provider: providers[index], message: result.reason?.message || 'Không đọc được tên profile' });
          continue;
        }
        const discoveredIds = new Set(result.value.profiles.map(item => String(item.provider_profile_id)));
        const importedRows = db.prepare('SELECT provider_profile_id FROM browsers WHERE provider = ?')
          .all(result.value.provider);
        unmatched += importedRows.filter(row => !discoveredIds.has(String(row.provider_profile_id))).length;
        for (const item of result.value.profiles) {
          const name = String(item.name || '').trim();
          if (!name) continue;
          const existing = db.prepare('SELECT id FROM browsers WHERE provider = ? AND provider_profile_id = ?')
            .get(result.value.provider, String(item.provider_profile_id));
          if (!existing) continue;
          matched++;
          matchedIds.add(Number(existing.id));
          changed += update.run(name, result.value.provider, String(item.provider_profile_id), name).changes;
        }
      }
    })();
    let displayNameChanged = 0;
    for (const id of matchedIds) {
      const profile = this.getById(id);
      if (!profile) continue;
      displayNameChanged += BrowserProviderService.syncBrowserDisplayName(profile).changed || 0;
    }
    return { changed, matched, unmatched, displayNameChanged, providers, errors };
  },

  /**
   * Update an existing browser profile
   */
  update(id, data) {
    const existing = db.prepare('SELECT * FROM browsers WHERE id = ?').get(id);
    if (!existing) {
      throw new Error('Profile không tồn tại');
    }

    const fields = [];
    const values = [];

    const allowedFields = [
      'name', 'proxy_type', 'proxy_host', 'proxy_port', 'proxy_user', 'proxy_pass', 'note',
      'external_user_data_dir', 'external_executable_path', 'external_launch_args',
      'external_extension_path', 'provider_endpoint', 'connection_mode',
    ];

    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        fields.push(`${field} = ?`);
        if (field === 'proxy_port') {
          values.push(data[field] ? parseInt(data[field]) : null);
        } else {
          values.push(data[field] || null);
        }
      }
    }

    if (fields.length === 0) {
      return this.getById(id);
    }

    values.push(id);
    db.prepare(`UPDATE browsers SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    return this.getById(id);
  },

  /**
   * Link existing physical profiles to another platform.
   */
  syncProfiles(profileIds, targetPlatform) {
    const platform = normalizePlatform(targetPlatform);
    const ids = [...new Set((profileIds || []).map(Number).filter(Number.isInteger))];
    const exists = db.prepare('SELECT id FROM browsers WHERE id = ?');
    const link = db.prepare(`
      INSERT OR IGNORE INTO browser_platforms (browser_id, platform)
      VALUES (?, ?)
    `);
    let linked = 0;

    db.transaction(() => {
      for (const id of ids) {
        if (!exists.get(id)) continue;
        linked += link.run(id, platform).changes;
      }
    })();

    return { linked, platform, profiles: this.getAll(platform) };
  },

  /**
   * Remove only the platform link. Delete the physical profile when no link remains.
   */
  async unlinkPlatform(id, platform = 'facebook') {
    platform = normalizePlatform(platform);
    if (!this.getById(id, platform)) {
      throw new Error('Profile không tồn tại trong nền tảng này');
    }

    const count = db.prepare(
      'SELECT COUNT(*) AS count FROM browser_platforms WHERE browser_id = ? AND enabled = 1'
    ).get(id).count;

    if (count > 1) {
      db.prepare('DELETE FROM browser_platforms WHERE browser_id = ? AND platform = ?').run(id, platform);
      return { deletedPhysicalProfile: false };
    }

    await this.delete(id);
    return { deletedPhysicalProfile: true };
  },

  async unlinkPlatforms(profileIds, platform = 'facebook') {
    platform = normalizePlatform(platform);
    const ids = [...new Set((profileIds || []).map(Number).filter(Number.isInteger))];
    if (!ids.length) throw new Error('Hãy chọn ít nhất một profile để xóa.');
    if (ids.length > 200) throw new Error('Mỗi lượt chỉ xóa tối đa 200 profile.');
    const results = [];
    for (const id of ids) {
      try {
        const value = await this.unlinkPlatform(id, platform);
        results.push({ id, success: true, ...value });
      } catch (error) {
        results.push({ id, success: false, error: error?.message || 'Không xóa được profile' });
      }
    }
    return {
      total: results.length,
      successCount: results.filter(item => item.success).length,
      failureCount: results.filter(item => !item.success).length,
      results,
    };
  },

  /**
   * Delete a browser profile (DB + directory)
   */
  async delete(id) {
    const profile = db.prepare('SELECT * FROM browsers WHERE id = ?').get(id);
    if (!profile) {
      throw new Error('Profile không tồn tại');
    }

    // Close either login-only or automation mode before removing this profile.
    if (activeBrowsers.has(id) || manualLoginBrowsers.has(id)) {
      await this.close(id);
    }

    // Provider-owned data is never deleted. Chrome imports are tool-owned
    // clones, so only their validated clone directory is removed.
    const provider = BrowserProviderService.normalizeProvider(profile.provider);
    if (provider === 'chrome') {
      const localProfilePath = path.join(config.CHROME_PROFILES_DIR, profile.profile_dir);
      if (fs.existsSync(localProfilePath)) {
        fs.rmSync(localProfilePath, { recursive: true, force: true });
      }
    } else if (provider === 'chrome_existing') {
      const metadata = parseJsonObject(profile.provider_metadata);
      const clonePath = String(metadata.clone_user_data_dir || profile.external_user_data_dir || '').trim();
      if (metadata.clone_owned && clonePath && pathInside(config.CHROME_PROFILES_DIR, clonePath)
          && fs.existsSync(clonePath)) {
        fs.rmSync(clonePath, { recursive: true, force: true });
      }
    }

    db.prepare('DELETE FROM browser_platforms WHERE browser_id = ?').run(id);
    db.prepare('DELETE FROM browser_group_members WHERE browser_id = ?').run(id);
    db.prepare('DELETE FROM browsers WHERE id = ?').run(id);
    automationLeases.delete(id);
    return true;
  },

  /**
   * Open a managed Chrome profile without Puppeteer/CDP for interactive login.
   */
  async launchLogin(id, options = {}) {
    id = Number(id);
    if (manualLoginBrowsers.has(id)) {
      return { success: true, reused: true, mode: 'login', message: 'Cửa sổ đăng nhập đang mở' };
    }
    if (manualLoginStarting.has(id)) {
      throw new Error('Cửa sổ đăng nhập đang được mở. Vui lòng chờ.');
    }
    if (activeBrowsers.has(id) || automationLeases.has(id)) {
      throw new Error('Hãy đóng phiên tự động trước khi mở cửa sổ đăng nhập.');
    }

    const profile = db.prepare('SELECT * FROM browsers WHERE id = ?').get(id);
    if (!profile) throw new Error('Profile không tồn tại');
    const provider = BrowserProviderService.normalizeProvider(profile.provider);
    if (provider !== 'chrome') {
      throw new Error('Nút Đăng nhập chỉ dùng cho Chrome mới. Trình duyệt Anti-detect đăng nhập trong ứng dụng gốc.');
    }

    manualLoginStarting.add(id);
    let proxyServer = null;
    let loginInstance = null;
    try {
      const chromePath = await this.findChromePath();
      if (!chromePath || !fs.existsSync(chromePath)) {
        throw new Error('Không tìm thấy Google Chrome. Hãy kiểm tra đường dẫn Chrome trong Cài đặt.');
      }
      const userDataDir = profilePath(profile);
      if (!userDataDir || !fs.existsSync(userDataDir)) {
        throw new Error('Không tìm thấy thư mục dữ liệu của profile');
      }
      const layout = this._getWindowLayout(id);
      const args = [
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--new-window',
        `--window-size=${layout.width},${layout.height}`,
        `--window-position=${layout.left},${layout.top}`,
      ];

      if (profile.proxy_type && profile.proxy_type !== 'none' && profile.proxy_host && profile.proxy_port) {
        if (profile.proxy_user && profile.proxy_pass) {
          const proxyChain = require('proxy-chain');
          const protocol = profile.proxy_type === 'socks5' ? 'socks5' : 'http';
          const sourceUrl = `${protocol}://${profile.proxy_user}:${profile.proxy_pass}@${profile.proxy_host}:${profile.proxy_port}`;
          proxyServer = await proxyChain.anonymizeProxy(sourceUrl);
          args.push(`--proxy-server=${proxyServer}`);
        } else {
          const proxyAddr = `${profile.proxy_host}:${profile.proxy_port}`;
          args.push(profile.proxy_type === 'socks5'
            ? `--proxy-server=socks5://${proxyAddr}`
            : `--proxy-server=${proxyAddr}`);
        }
      }
      // Mo trang New Tab mac dinh cua Chrome; khong ep vao Facebook.
      // Khach tu go URL muon vao. Tool chi tu dieu huong khi chay dang bai.

      const child = this._spawnManualChrome(chromePath, args, {
        detached: false,
        windowsHide: false,
        stdio: 'ignore',
      });
      const instance = { child, processId: Number(child?.pid) || null, proxyServer };
      loginInstance = instance;
      manualLoginBrowsers.set(id, instance);
      await new Promise((resolve, reject) => {
        const onSpawn = () => {
          child.removeListener('error', onError);
          resolve();
        };
        const onError = error => {
          child.removeListener('spawn', onSpawn);
          reject(error);
        };
        child.once('spawn', onSpawn);
        child.once('error', onError);
      }).catch(error => {
        finishManualLogin(id, instance);
        throw new Error(`Không mở được Chrome đăng nhập: ${error.message}`);
      });
      child.once('exit', () => finishManualLogin(id, instance));
      child.once('error', () => finishManualLogin(id, instance));
      db.prepare("UPDATE browsers SET status = 'login' WHERE id = ?").run(id);
      return {
        success: true,
        mode: 'login',
        message: 'Đã mở Chrome để đăng nhập. Đăng nhập xong hãy đóng cửa sổ này.',
      };
    } catch (error) {
      if (loginInstance) finishManualLogin(id, loginInstance);
      else await closeAnonymizedProxy(proxyServer);
      throw error;
    } finally {
      manualLoginStarting.delete(id);
    }
  },

  _spawnManualChrome(executablePath, args, options) {
    return spawn(executablePath, args, options);
  },

  /**
   * Manual Open uses normal Chrome for managed profiles. Provider browsers
   * keep their existing provider/CDP launch flow.
   */
  async open(id, options = {}) {
    id = Number(id);
    if (activeBrowsers.has(id)) return this.launch(id, options);
    const profile = db.prepare('SELECT * FROM browsers WHERE id = ?').get(id);
    if (!profile) throw new Error('Profile không tồn tại');
    return BrowserProviderService.normalizeProvider(profile.provider) === 'chrome'
      ? this.launchLogin(id, options)
      : this.launch(id, options);
  },

  /**
   * Launch Chrome with the given profile
   */
  async launch(id, options = {}) {
    id = Number(id);
    if (manualLoginBrowsers.has(id) || manualLoginStarting.has(id)) {
      throw new Error('Hãy đăng nhập xong và đóng cửa sổ Đăng nhập trước khi chạy tự động.');
    }
    const platform = normalizePlatform(options.platform);
    const requestedLocale = platform === 'tiktok' ? 'en-US' : '';
    if (activeBrowsers.has(id)) {
      const instance = activeBrowsers.get(id);
      if (requestedLocale && instance?.page) {
        await this._applyPlatformLocale(instance.page, platform, { reload: true });
      }
      return { success: true, reused: true, message: 'Trình duyệt đang mở' };
    }

    const profile = db.prepare('SELECT * FROM browsers WHERE id = ?').get(id);
    if (!profile) {
      throw new Error('Profile không tồn tại');
    }

    const provider = BrowserProviderService.normalizeProvider(profile.provider);
    if (provider === 'chrome_existing') {
      throw new Error('Chrome có sẵn đã ngừng hỗ trợ. Hãy dùng Chrome mới hoặc trình duyệt Anti-detect.');
    }
    const displayNameSync = BrowserProviderService.syncBrowserDisplayName(profile);
    const windowLayout = this._getWindowLayout(id);
    const launchLayout = this._maybeHideLayout(windowLayout, provider);
    const windowArgs = [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      `--window-size=${launchLayout.width},${launchLayout.height}`,
      `--window-position=${launchLayout.left},${launchLayout.top}`,
    ];
    let proxyServer = null;
    let browser;
    let providerOwned = false;
    let startedByTool = false;
    let processId = null;
    let independent = false;
    let searchNameSync = null;

    if (provider === 'gologin' || provider === 'gemlogin') {
      searchNameSync = await BrowserProviderService.syncSearchEngineName(
        profilePath(profile),
        profile.name
      );
    }

    if (BrowserProviderService.usesProviderApi(profile)) {
      const session = await BrowserProviderService.start(profile, windowLayout);
      if (!session?.endpoint) throw new Error('Nhà cung cấp không trả về địa chỉ CDP');
      const connectOptions = /^wss?:\/\//i.test(session.endpoint)
        ? { browserWSEndpoint: session.endpoint }
        : { browserURL: session.endpoint };
      browser = await puppeteer.connect({ ...connectOptions, defaultViewport: null, ignoreHTTPSErrors: true });
      providerOwned = !!session.providerOwned;
      startedByTool = !!session.startedByTool;
      processId = Number(session.processId) || null;
      independent = !!session.independent;
    } else {
      const chromePath = provider === 'chrome' ? await this.findChromePath() : profile.external_executable_path;
      if (!chromePath || !fs.existsSync(chromePath)) {
        throw new Error(`Không tìm thấy file chạy ${BrowserProviderService.PROVIDERS[provider].label}. Hãy nhập lại profile.`);
      }
      const userDataDir = profilePath(profile);
      if (!userDataDir || !fs.existsSync(userDataDir)) {
        throw new Error('Không tìm thấy thư mục dữ liệu gốc của profile');
      }
      // Provider profiles sometimes persist maximized/fullscreen flags. Remove
      // only window geometry flags, then apply our real outer-window tile.
      // Orbita treats startup window geometry as the monitor's maximum bounds.
      // That makes its maximize button expand only to the tile. Let GoLogin
      // initialize against the real monitor and tile it natively after startup.
      const startupWindowArgs = provider === 'gologin' ? [] : windowArgs;
      let args = [...withoutWindowOverrides(parseJsonArray(profile.external_launch_args)), ...startupWindowArgs];
      if (requestedLocale) {
        args = args.filter(value => !/^--lang=/i.test(String(value || '')));
        args.push(`--lang=${requestedLocale}`);
      }
      if (provider === 'gologin' || provider === 'chrome') {
        // Keep managed Chrome and GoLogin at a desktop CSS viewport. Without
        // this, Windows DPI scaling can make Facebook switch to a compact,
        // phone-like layout while GemLogin stays on the desktop layout.
        args = args.filter(value => !/^--force-device-scale-factor=/i.test(String(value || '')));
        args.push('--force-device-scale-factor=1');
      }
      // With ignoreDefaultArgs=true Puppeteer does not apply its userDataDir
      // option and silently creates a temporary blank profile. Put the
      // provider-owned directory on Chromium's command line explicitly.
      if (provider !== 'chrome') {
        args = BrowserProviderService.ensureUserDataDirArg(args, userDataDir);
      }

      // Anti-detect profiles keep their provider proxy/fingerprint settings.
      if (provider === 'chrome' && profile.proxy_type && profile.proxy_type !== 'none' && profile.proxy_host && profile.proxy_port) {
        if (profile.proxy_user && profile.proxy_pass) {
          const proxyChain = require('proxy-chain');
          const proxyProtocol = profile.proxy_type === 'socks5' ? 'socks5' : 'http';
          const oldProxyUrl = `${proxyProtocol}://${profile.proxy_user}:${profile.proxy_pass}@${profile.proxy_host}:${profile.proxy_port}`;
          proxyServer = await proxyChain.anonymizeProxy(oldProxyUrl);
          args.push(`--proxy-server=${proxyServer}`);
        } else {
          const proxyAddr = `${profile.proxy_host}:${profile.proxy_port}`;
          args.push(profile.proxy_type === 'socks5' ? `--proxy-server=socks5://${proxyAddr}` : `--proxy-server=${proxyAddr}`);
        }
      }

      browser = await puppeteer.launch({
        executablePath: chromePath,
        userDataDir,
        headless: false,
        defaultViewport: null,
        args,
        // Provider Chromium must keep its own fingerprint/extension flags.
        // Native Chrome retains the established Super Post - King defaults.
        // Keep Chrome account, cookies, extensions and OS credential storage
        // identical to the manual login window for this managed profile.
        ignoreDefaultArgs: provider === 'chrome' ? CHROME_SESSION_DEFAULT_ARGS : true,
      });
      processId = Number(browser.process()?.pid) || null;
    }

    // Get or create the main page
    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();
    if (requestedLocale) {
      await this._applyPlatformLocale(page, platform, {
        reload: isTikTokUrl(page.url()),
      });
    }
    const workArea = this._getHostWorkArea();
    const fittedLayout = this._maybeHideLayout(this._getWindowLayout(id, workArea), provider);
    if (provider !== 'gologin') await this._applyWindowBounds(page, fittedLayout);
    const windowName = await BrowserWindowNameService.bind(browser, profile.name);

    // Store the active browser instance
    activeBrowsers.set(id, {
      browser, page, proxyServer, provider, providerOwned, startedByTool, processId, independent,
    });

    // Provider browsers may restore their previous bounds just after startup.
    // Apply the layout again after those restore hooks settle so a manual Open
    // uses exactly the same geometry as an automation launch.
    await waitMs(provider === 'gologin' ? 800 : 250);
    await this.refitWindow(id);

    // Update DB status
    db.prepare("UPDATE browsers SET status = 'open' WHERE id = ?").run(id);

    // Listen for browser disconnect
    browser.on('disconnected', () => {
      this._handleDisconnect(id);
    });

    return {
      success: true,
      message: 'Đã mở trình duyệt',
      displayNameSync,
      searchNameSync,
      windowName,
      independent,
    };
  },

  /**
   * Handle browser disconnection (user closed Chrome or crash)
   */
  _handleDisconnect(id) {
    const instance = activeBrowsers.get(id);
    if (instance && instance.proxyServer) {
      const proxyChain = require('proxy-chain');
      proxyChain.closeAnonymizedProxy(instance.proxyServer, true).catch(() => {});
    }
    activeBrowsers.delete(id);
    automationLeases.delete(id);
    windowSlots.delete(id);
    try {
      db.prepare("UPDATE browsers SET status = 'closed' WHERE id = ?").run(id);
    } catch (e) {
      // DB might be closed during shutdown
    }
  },

  /**
   * Close a Chrome browser instance
   */
  async close(id) {
    id = Number(id);
    const loginInstance = manualLoginBrowsers.get(id);
    if (loginInstance) {
      const exited = new Promise(resolve => loginInstance.child.once('exit', resolve));
      await this._requestManualChromeClose(loginInstance);
      await Promise.race([exited, waitMs(10000)]);
      if (manualLoginBrowsers.get(id) === loginInstance) {
        try { loginInstance.child.kill('SIGKILL'); } catch (_) {}
        await Promise.race([exited, waitMs(1000)]);
      }
      finishManualLogin(id, loginInstance);
      return { success: true, mode: 'login', message: 'Đã đóng cửa sổ đăng nhập' };
    }

    const instance = activeBrowsers.get(id);
    if (!instance) {
      // Not tracked as active, just update DB
      db.prepare("UPDATE browsers SET status = 'closed' WHERE id = ?").run(id);
      return { success: true, message: 'Trình duyệt đã đóng' };
    }

    try {
      // Close proxy-chain anonymized proxy if exists
      if (instance.proxyServer) {
        await closeAnonymizedProxy(instance.proxyServer);
      }
      // Attached provider sessions are disconnected, not force-closed. When
      // Super Post - King started one through GPM/GenLogin, ask that provider to
      // stop it after releasing the CDP connection.
      activeBrowsers.delete(id);
      if (instance.providerOwned) {
        instance.browser.disconnect();
        if (instance.startedByTool) {
          const profile = db.prepare('SELECT * FROM browsers WHERE id = ?').get(id);
          if (profile) await BrowserProviderService.stop(profile).catch(() => {});
        }
      } else {
        await instance.browser.close();
      }
    } catch (e) {
      // Browser may already be closed
    }

    activeBrowsers.delete(id);
    automationLeases.delete(id);
    windowSlots.delete(id);
    db.prepare("UPDATE browsers SET status = 'closed' WHERE id = ?").run(id);

    return { success: true, message: 'Đã đóng trình duyệt' };
  },

  async _requestManualChromeClose(instance) {
    const processId = Number(instance?.processId || instance?.child?.pid) || 0;
    if (process.platform === 'win32' && processId > 0) {
      try {
        // Without /F, taskkill lets Chrome flush its Cookies database.
        execFileSync('taskkill.exe', ['/PID', String(processId), '/T'], {
          windowsHide: true,
          stdio: 'ignore',
          timeout: 5000,
        });
        return;
      } catch (_) {}
    }
    try { instance?.child?.kill('SIGTERM'); } catch (_) {}
  },

  /**
   * Quet offline toan bo profile: doc file Cookies de biet da dang nhap nen tang
   * nao, luu vao browser_platforms.session_valid cho UI va cac cong cu khac dung.
   * Tra ve { [browserId]: { [platform]: boolean } }; profile dang mo tu dong se
   * doc cookie truc tiep de khong ghi de trang thai session live.
   */
  async scanCookieLogins() {
    const rows = db.prepare('SELECT id, profile_dir, external_user_data_dir FROM browsers').all();
    const result = {};
    const updates = [];
    for (const row of rows) {
      const id = Number(row.id);
      let logins = null;
      let state = 'offline_cookie';
      if (activeBrowsers.has(id)) {
        state = 'live';
        try {
          const instance = activeBrowsers.get(id);
          const pages = await instance.browser.pages();
          const page = pages[0] || instance.page;
          const urls = [...new Set(
            Object.values(PLATFORM_COOKIE_SPECS).flatMap(spec =>
              spec.domains.map(domain => `https://${domain}`)
            )
          )];
          const liveCookies = await page.cookies(...urls);
          logins = detectPlatformLogins(liveCookies.map(cookie => ({
            name: cookie.name,
            host: String(cookie.domain || '').replace(/^\./, '').toLowerCase(),
            hasValue: Boolean(cookie.value),
            expires: Number(cookie.expires || 0),
          })));
        } catch (_) {
          logins = null;
        }
      } else if (manualLoginBrowsers.has(id)) {
        // Chrome đăng nhập tay không có CDP; đợi đóng để Chrome flush SQLite.
        state = 'open_unverified';
      } else {
        try { logins = await readProfileLogins(profilePath(row)); } catch (_) { logins = null; }
      }
      if (!Array.isArray(logins)) {
        result[id] = { _state: state === 'open_unverified' ? state : 'unavailable' };
        continue; // khong doc duoc -> giu nguyen trang thai cu
      }
      const set = new Set(logins);
      const map = { _state: state };
      for (const platform of PLATFORMS) map[platform] = set.has(platform);
      result[id] = map;
      updates.push({ id, set });
    }
    if (updates.length) {
      const insert = db.prepare('INSERT OR IGNORE INTO browser_platforms (browser_id, platform, session_valid, enabled) VALUES (?, ?, 0, 1)');
      const update = db.prepare('UPDATE browser_platforms SET session_valid = ?, last_session_check = CURRENT_TIMESTAMP WHERE browser_id = ? AND platform = ?');
      db.transaction(() => {
        for (const item of updates) {
          for (const platform of PLATFORMS) {
            insert.run(item.id, platform);
            update.run(item.set.has(platform) ? 1 : 0, item.id, platform);
          }
        }
      })();
    }
    return result;
  },

  /**
   * Get status of a browser: isOpen and sessionValid
   */
  async getStatus(id, platform = 'facebook') {
    platform = normalizePlatform(platform);
    const profile = this.getById(id, platform);
    if (!profile) {
      throw new Error('Profile không tồn tại');
    }

    const isAutomationOpen = activeBrowsers.has(id);
    const isLoginOpen = manualLoginBrowsers.has(id);
    const isOpen = isAutomationOpen || isLoginOpen;
    let sessionValid = false;

    if (isAutomationOpen) {
      try {
        const instance = activeBrowsers.get(id);
        const pages = await instance.browser.pages();
        const page = pages[0] || instance.page;

        const sessionConfig = {
          facebook: {
            urls: ['https://www.facebook.com'],
            names: new Set(['c_user']),
          },
          tiktok: {
            urls: ['https://www.tiktok.com'],
            names: new Set(['sessionid', 'sessionid_ss', 'sid_tt']),
          },
          youtube: {
            urls: ['https://www.youtube.com', 'https://studio.youtube.com', 'https://accounts.google.com'],
            names: new Set(['SAPISID', '__Secure-1PAPISID', '__Secure-3PAPISID', 'SID', '__Secure-1PSID', '__Secure-3PSID']),
          },
          threads: {
            urls: ['https://www.threads.com', 'https://www.instagram.com'],
            names: new Set(['sessionid', 'ds_user_id']),
          },
          instagram: {
            urls: ['https://www.instagram.com'],
            names: new Set(['sessionid', 'ds_user_id']),
          },
          x: {
            urls: ['https://x.com', 'https://twitter.com'],
            names: new Set(['auth_token', 'twid', 'ct0']),
          },
          zalovideo: {
            urls: ['https://video.zalo.me', 'https://zalo.me'],
            names: new Set(['zpsid', 'zpw_sek', 'zalo_session']),
          },
        }[platform];
        const cookies = await page.cookies(...sessionConfig.urls);
        const sessionNames = sessionConfig.names;
        sessionValid = cookies.some(cookie => sessionNames.has(cookie.name));
      } catch (e) {
        sessionValid = false;
      }

      db.prepare(`
        UPDATE browser_platforms
        SET session_valid = ?, last_session_check = CURRENT_TIMESTAMP
        WHERE browser_id = ? AND platform = ?
      `).run(sessionValid ? 1 : 0, id, platform);
    } else {
      sessionValid = !!profile.session_valid;
    }

    return {
      isOpen,
      isLoginOpen,
      mode: isLoginOpen ? 'login' : (isAutomationOpen ? 'automation' : 'closed'),
      sessionValid,
      status: isLoginOpen ? 'login' : (isAutomationOpen ? 'open' : 'closed'),
    };
  },

  /**
   * Keep a shared browser open while one or more automation workers use it.
   */
  async acquire(id, options = {}) {
    id = Number(id);
    for (let attempt = 0; manualLoginStarting.has(id) && attempt < 100; attempt++) {
      await waitMs(100);
    }
    if (manualLoginStarting.has(id)) {
      throw new Error('Chrome đang được mở. Vui lòng thử lại sau.');
    }
    // A manual Open is only for account setup/browsing. Transition to the
    // controlled session automatically when a real automation task begins.
    if (manualLoginBrowsers.has(id)) await this.close(id);
    const count = automationLeases.get(id) || 0;
    automationLeases.set(id, count + 1);
    try {
      await this.launch(id, options);
      return this.getInstance(id);
    } catch (error) {
      if (count === 0) automationLeases.delete(id);
      else automationLeases.set(id, count);
      throw error;
    }
  },

  async release(id) {
    const count = automationLeases.get(id) || 0;
    if (count <= 1) {
      automationLeases.delete(id);
      await this.close(id);
      return 0;
    }
    automationLeases.set(id, count - 1);
    return count - 1;
  },

  getLeaseCount(id) {
    return automationLeases.get(id) || 0;
  },

  /**
   * Get list of currently active (open) browser IDs
   */
  getActiveBrowsers() {
    return Array.from(activeBrowsers.keys());
  },

  /**
   * Get a browser instance for the runner to use
   */
  getInstance(id) {
    return activeBrowsers.get(id) || null;
  },

  async _applyPlatformLocale(page, platform, { reload = false } = {}) {
    if (!page || normalizePlatform(platform) !== 'tiktok') return false;
    const locale = 'en-US';
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
    }).catch(() => {});
    await page.evaluateOnNewDocument(language => {
      Object.defineProperty(navigator, 'language', { configurable: true, get: () => language });
      Object.defineProperty(navigator, 'languages', {
        configurable: true,
        get: () => [language, 'en'],
      });
    }, locale).catch(() => {});
    const session = await page.target().createCDPSession().catch(() => null);
    if (session) {
      await session.send('Emulation.setLocaleOverride', { locale }).catch(() => {});
      await session.detach().catch(() => {});
    }
    if (reload && isTikTokUrl(page.url())) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
    }
    return true;
  },

  async refitWindow(id) {
    const instance = activeBrowsers.get(Number(id));
    if (!instance) return null;
    const workArea = this._getHostWorkArea();
    const layout = this._maybeHideLayout(this._getWindowLayout(Number(id), workArea), instance.provider);
    if (instance.provider === 'gologin' && instance.processId) {
      this._applyNativeWindowBounds(instance.processId, layout);
    } else {
      const pages = await instance.browser.pages().catch(() => []);
      const page = pages[0] || instance.page;
      if (page) await this._applyWindowBounds(page, layout);
    }
    return layout;
  },

  /**
   * Restore and tile a native Chromium window without changing its monitor
   * maximize bounds. GoLogin/Orbita locks those bounds when CDP geometry or
   * startup --window-size is used, so Windows APIs are required here.
   */
  _applyNativeWindowBounds(processId, layout) {
    if (process.platform !== 'win32' || !Number.isInteger(Number(processId))) return false;
    const values = ['left', 'top', 'width', 'height'].map(key => Math.trunc(Number(layout[key])));
    if (!values.every(Number.isFinite) || values[2] < 100 || values[3] < 100) return false;
    const [left, top, width, height] = values;
    const nativeType = [
      'using System;',
      'using System.Runtime.InteropServices;',
      'public static class CovergemNativeWindow {',
      '[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd,int nCmdShow);',
      '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd,IntPtr after,int x,int y,int w,int h,uint flags);',
      '}',
    ].join(' ');
    const script = [
      `Add-Type -TypeDefinition '${nativeType}';`,
      `$p=Get-Process -Id ${Number(processId)} -ErrorAction Stop;`,
      '$h=$p.MainWindowHandle;',
      'for($i=0;$i -lt 20 -and $h -eq 0;$i++){Start-Sleep -Milliseconds 100;$p.Refresh();$h=$p.MainWindowHandle}',
      'if($h -eq 0){exit 2};',
      '[CovergemNativeWindow]::ShowWindowAsync($h,9)|Out-Null;',
      'Start-Sleep -Milliseconds 50;',
      `[CovergemNativeWindow]::SetWindowPos($h,[IntPtr]::Zero,${left},${top},${width},${height},0x0040)|Out-Null;`,
    ].join(' ');
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        timeout: 5000,
      });
      return true;
    } catch (_) {
      return false;
    }
  },

  _hiddenRunEnabled() {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'hidden_run_enabled'").get();
    return String(row?.value ?? '0') === '1';
  },

  // Chế độ chạy ẩn: chỉ dời cửa sổ Chrome quản lý ra ngoài màn hình khi bật.
  // Giữ nguyên kích thước cửa sổ; không áp cho trình duyệt Anti-detect và không
  // đụng luồng đăng nhập/mở thủ công (dùng hàm launchLogin riêng).
  _maybeHideLayout(layout, provider) {
    if (provider !== 'chrome' || !this._hiddenRunEnabled()) return layout;
    return { ...layout, left: -32000, top: -32000 };
  },

  _getWindowLayout(id = null, workArea = null) {
    const rowsSetting = db.prepare("SELECT value FROM settings WHERE key = 'browser_layout_rows'").get();
    const columnsSetting = db.prepare("SELECT value FROM settings WHERE key = 'browser_layout_columns'").get();
    const ratioSetting = db.prepare("SELECT value FROM settings WHERE key = 'browser_window_ratio'").get();
    const legacySetting = db.prepare("SELECT value FROM settings WHERE key = 'browser_per_screen'").get();
    const legacyCount = Math.min(Math.max(parseInt(legacySetting?.value || '1', 10) || 1, 1), 12);
    const defaultColumns = legacyCount === 1 ? 1 : Math.min(legacyCount, 4);
    const defaultRows = legacyCount === 1 ? 1 : Math.max(2, Math.ceil(legacyCount / defaultColumns));
    const rows = Math.min(Math.max(parseInt(rowsSetting?.value || defaultRows, 10) || defaultRows, 1), 4);
    const cols = Math.min(Math.max(parseInt(columnsSetting?.value || defaultColumns, 10) || defaultColumns, 1), 6);
    const ratio = Math.min(Math.max(Number(ratioSetting?.value || '1') || 1, 0.25), 1);
    const perScreen = rows * cols;
    workArea = workArea || hostWorkArea();
    const screenLeft = Number(workArea.left) || 0;
    const screenTop = Number(workArea.top) || 0;
    const screenWidth = Math.max(640, Number(workArea.width) || 1920);
    const screenHeight = Math.max(360, Number(workArea.height) || 1040);
    let index = id != null ? windowSlots.get(id) : null;
    if (index == null) {
      const used = new Set(windowSlots.values());
      index = Array.from({ length: perScreen }, (_, value) => value).find(value => !used.has(value));
      if (index == null) index = windowSlots.size % perScreen;
      if (id != null) windowSlots.set(id, index);
    }
    const col = index % cols;
    const row = Math.floor(index / cols);
    const cellWidth = Math.floor(screenWidth / cols);
    const cellHeight = Math.floor(screenHeight / rows);
    const width = Math.min(cellWidth, Math.max(240, Math.floor(cellWidth * ratio)));
    const height = Math.min(cellHeight, Math.max(180, Math.floor(cellHeight * ratio)));
    return {
      width,
      height,
      left: screenLeft + col * cellWidth + Math.floor((cellWidth - width) / 2),
      top: screenTop + row * cellHeight + Math.floor((cellHeight - height) / 2),
    };
  },

  async _getPageWorkArea(page) {
    return page.evaluate(() => ({
      left: Number(screen.availLeft) || 0,
      top: Number(screen.availTop) || 0,
      width: Number(screen.availWidth) || Number(screen.width) || 1920,
      height: Number(screen.availHeight) || Number(screen.height) || 1040,
    })).catch(() => ({ left: 0, top: 0, width: 1920, height: 1040 }));
  },

  _getHostWorkArea() {
    return { ...hostWorkArea() };
  },

  /**
   * Resize/move the native browser window using real outer-window bounds.
   */
  async _applyWindowBounds(page, layout) {
    try {
      const session = page.createCDPSession
        ? await page.createCDPSession()
        : await page.target().createCDPSession();
      const { windowId } = await session.send('Browser.getWindowForTarget');
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'normal' },
      }).catch(() => {});
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: {
          left: layout.left,
          top: layout.top,
          width: layout.width,
          height: layout.height,
        },
      });
      await session.detach().catch(() => {});
      return true;
    } catch (_) {
      return page.evaluate(bounds => {
        window.moveTo(bounds.left, bounds.top);
        window.resizeTo(bounds.width, bounds.height);
        return outerWidth > 0 && outerHeight > 0;
      }, layout).catch(() => false);
    }
  },

  /**
   * Find Chrome executable path
   */
  async findChromePath() {
    // First check the settings table
    const setting = db.prepare("SELECT value FROM settings WHERE key = 'chrome_path'").get();
    if (setting && setting.value && setting.value.trim()) {
      const customPath = setting.value.trim();
      if (fs.existsSync(customPath)) {
        return customPath;
      }
    }

    // Auto-detect from common Windows paths
    for (const chromePath of config.CHROME_PATHS) {
      if (chromePath && fs.existsSync(chromePath)) {
        return chromePath;
      }
    }

    return null;
  },
};

BrowserService._private = {
  cookieIsUsable,
  detectPlatformLogins,
  readProfileLogins,
};

module.exports = BrowserService;
