const fs = require('fs');
const path = require('path');
const config = require('../../config');
const BrowserService = require('./browser.service');
const { normalizePlatform } = require('../platforms/platform.utils');

const FILE_PATH = path.join(config.DATA_ROOT, 'managed-targets.json');
const EMPTY = {
  version: 1,
  updated_at: null,
  profiles: {},
};

function readCatalog() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    return {
      ...EMPTY,
      ...parsed,
      profiles: parsed?.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {},
    };
  } catch (_) {
    return { ...EMPTY, profiles: {} };
  }
}

function writeCatalog(catalog) {
  fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
  const tempPath = `${FILE_PATH}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, FILE_PATH);
}

function normalizeUrl(value, platform) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    if (normalizePlatform(platform) === 'facebook') {
      const id = url.searchParams.get('id');
      url.search = id ? `?id=${id}` : '';
    } else {
      url.search = '';
    }
    url.hostname = url.hostname.toLowerCase();
    return url.toString().replace(/\/$/, '');
  } catch (_) {
    return raw;
  }
}

function cleanTarget(target, platform) {
  const type = normalizePlatform(platform) === 'youtube' ? 'youtube_channel' : 'facebook_page';
  const id = String(target.id || target.page_id || target.channel_id || '').trim();
  const name = String(target.name || target.title || target.page_name || target.channel_name || '').trim();
  const url = normalizeUrl(target.url || target.link || target.href, platform);
  if (!id && !url) return null;
  return {
    id: id || url,
    name: name || url,
    url,
    type,
  };
}

function profileSnapshot(profile) {
  return {
    profile_id: Number(profile.id),
    profile_name: String(profile.name || ''),
    provider: String(profile.provider || 'chrome'),
  };
}

function valuesForProfile(profileId, kind, catalog = readCatalog()) {
  const entry = catalog.profiles[String(profileId)];
  return Array.isArray(entry?.[kind]) ? entry[kind] : [];
}

function all(kind) {
  if (kind === 'facebook') kind = 'facebook_pages';
  if (kind === 'youtube') kind = 'youtube_channels';
  const catalog = readCatalog();
  return Object.values(catalog.profiles).flatMap(entry =>
    (Array.isArray(entry?.[kind]) ? entry[kind] : []).map(target => ({
      ...target,
      profile_id: Number(entry.profile_id),
      profile_name: entry.profile_name || '',
      provider: entry.provider || 'chrome',
      checked_at: entry.checked_at || null,
    }))
  );
}

async function collectFromPage(page, type) {
  if (type === 'youtube') {
    await page.goto('https://www.youtube.com/channel_switcher', {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 1200));
    const links = await page.evaluate(() => {
      const result = [];
      const seen = new Set();
      const links = [...document.querySelectorAll('a[href]')];
      for (const link of links) {
        const href = link.href || '';
        if (!/youtube\.com\/(?:channel\/|@)/i.test(href)) continue;
        const id = (href.match(/youtube\.com\/(channel\/[^/?#]+|@[^/?#]+)/i) || [])[1] || href;
        const name = (link.textContent || link.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        const key = `${id}|${href}`;
        if (!seen.has(key)) {
          seen.add(key);
          result.push({ id, name, url: href });
        }
      }
      return result;
    }).catch(() => []);
    if (links.length) return links;
    const accessibility = await page.accessibility?.snapshot({ interestingOnly: false }).catch(() => null);
    const result = [];
    const seen = new Set();
    const walk = node => {
      if (!node) return;
      if (node.role === 'option' && node.name) {
        const handle = (node.name.match(/@([^\s]+)/) || [])[1] || '';
        const name = handle ? node.name.split(`@${handle}`)[0].trim() : node.name.trim();
        const id = handle || name;
        const url = handle ? `https://www.youtube.com/@${handle}` : '';
        const key = `${id}|${url}`;
        if (id && !seen.has(key)) {
          seen.add(key);
          result.push({ id, name, url });
        }
      }
      (node.children || []).forEach(walk);
    };
    walk(accessibility);
    return result;
  }

  await page.goto('https://www.facebook.com/pages/?category=your_pages', {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  }).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 1400));
  return page.evaluate(() => {
    const result = [];
    const seen = new Set();
    const links = [...document.querySelectorAll('a[href]')];
    for (const link of links) {
      const href = link.href || '';
      const isPage = /facebook\.com\/(?:profile\.php\?id=\d+|pages\/[^/?#]+|[^/?#]+$)/i.test(href)
        && !/facebook\.com\/pages(?:[/?#]|$)/i.test(href)
        && !/\/(?:groups|friends|marketplace|watch|reels|notifications|settings|login)(?:[/?#]|$)/i.test(href);
      if (!isPage) continue;
      const id = (href.match(/[?&]id=(\d+)/i) || [])[1]
        || (link.getAttribute('data-page-id') || '')
        || href;
      const name = (link.textContent || link.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      if (!name && !/profile\.php\?id=/i.test(href)) continue;
      if (/^100\d{8,}$/.test(String(id))) continue;
      const key = String(id);
      const existing = result.find(item => item.id === key);
      if (!existing) {
        seen.add(key);
        result.push({ id, name, url: href });
      } else if (/^Ảnh đại diện/i.test(existing.name) && !/^Ảnh đại diện/i.test(name)) {
        existing.name = name;
      }
    }
    return result;
  }).catch(() => []);
}

async function scanProfiles(profileIds, type = 'facebook', onProgress = null) {
  const normalizedType = normalizePlatform(type) === 'youtube' ? 'youtube' : 'facebook';
  const ids = [...new Set((profileIds || []).map(Number).filter(Number.isInteger))];
  const profiles = BrowserService.getAll('all').filter(profile => ids.includes(Number(profile.id)));
  const catalog = readCatalog();
  const kind = normalizedType === 'youtube' ? 'youtube_channels' : 'facebook_pages';
  const results = [];

  for (let index = 0; index < profiles.length; index++) {
    const profile = profiles[index];
    let acquired = false;
    try {
      const instance = await BrowserService.acquire(profile.id, { platform: normalizedType });
      acquired = true;
      const rawTargets = await collectFromPage(instance.page, normalizedType);
      const targets = rawTargets.map(target => cleanTarget(target, normalizedType)).filter(Boolean);
      const previous = catalog.profiles[String(profile.id)] || {};
      catalog.profiles[String(profile.id)] = {
        ...previous,
        ...profileSnapshot(profile),
        [`${kind}`]: targets,
        checked_at: new Date().toISOString(),
        error: null,
      };
      results.push({ profile_id: profile.id, profile_name: profile.name, success: true, count: targets.length });
    } catch (error) {
      const previous = catalog.profiles[String(profile.id)] || {};
      catalog.profiles[String(profile.id)] = {
        ...previous,
        ...profileSnapshot(profile),
        error: String(error?.message || error),
        checked_at: previous.checked_at || null,
      };
      results.push({ profile_id: profile.id, profile_name: profile.name, success: false, count: (previous[kind] || []).length, error: String(error?.message || error) });
    } finally {
      if (acquired) await BrowserService.release(profile.id).catch(() => {});
      if (typeof onProgress === 'function') await onProgress({
        current: index + 1,
        total: profiles.length,
        result: results[results.length - 1],
      });
    }
  }

  catalog.updated_at = new Date().toISOString();
  writeCatalog(catalog);
  return { type: normalizedType, file: FILE_PATH, results, data: all(kind) };
}

function matchTargets(type, links, profileIds = []) {
  const normalizedType = normalizePlatform(type) === 'youtube' ? 'youtube' : 'facebook';
  const kind = normalizedType === 'youtube' ? 'youtube_channels' : 'facebook_pages';
  const allowed = new Set((profileIds || []).map(Number));
  const catalog = all(kind).filter(item => !allowed.size || allowed.has(Number(item.profile_id)));
  const values = [...new Set((links || []).map(value => String(value || '').trim()).filter(Boolean))];
  return values.map(input => {
    const normalized = normalizeUrl(input, normalizedType);
    const matches = catalog.filter(item => item.url === normalized || item.id === input || item.id === normalized);
    return {
      input,
      matches,
      status: matches.length === 1 ? 'matched' : matches.length > 1 ? 'ambiguous' : 'unmatched',
    };
  });
}

module.exports = {
  FILE_PATH,
  read: readCatalog,
  all,
  valuesForProfile,
  scanProfiles,
  matchTargets,
  _private: {
    normalizeUrl,
    cleanTarget,
    collectFromPage,
    writeCatalog,
  },
};
