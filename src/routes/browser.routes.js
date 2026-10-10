/**
 * Browser Routes - Chrome Profile Management API
 */

const express = require('express');
const router = express.Router();
const BrowserService = require('../services/browser.service');
const BrowserProviderService = require('../services/browser-provider.service');
const ManagedTargetsService = require('../services/managed-targets.service');
const db = require('../database/init');
const platformOf = req => req.query.platform || req.body?.platform || 'facebook';

function settingInt(key, fallback, min, max) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const value = parseInt(row?.value, 10);
  return Math.min(Math.max(Number.isFinite(value) ? value : fallback, min), max);
}

function wait(ms) {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

/**
 * GET / - List all browser profiles with status
 */
router.get('/', (req, res) => {
  try {
    const profiles = BrowserService.getAll(platformOf(req));
    res.json({ success: true, data: profiles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /login-scan - Doc offline file Cookies de nhan biet moi profile da dang
 * nhap nen tang nao, luu vao DB va tra ket qua theo tung profile.
 */
router.post('/login-scan', async (req, res) => {
  try {
    const data = await BrowserService.scanCookieLogins();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/groups', (req, res) => {
  try {
    res.json({ success: true, data: BrowserService.getGroups(platformOf(req)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/groups', (req, res) => {
  try {
    const group = BrowserService.createGroup(req.body.name, platformOf(req));
    res.json({ success: true, data: group });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/groups/:id', (req, res) => {
  try {
    const group = BrowserService.renameGroup(
      parseInt(req.params.id, 10),
      req.body.name,
      platformOf(req)
    );
    res.json({ success: true, data: group });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/groups/:id', (req, res) => {
  try {
    BrowserService.deleteGroup(parseInt(req.params.id, 10));
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/groups/members/assign', (req, res) => {
  try {
    const result = BrowserService.assignGroups(
      req.body.profileIds,
      req.body.groupIds,
      req.body.mode,
      platformOf(req)
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Provider catalog and saved local connection settings (token is masked). */
router.get('/providers', (req, res) => {
  try {
    res.json({ success: true, data: BrowserProviderService.getOverview() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Discover profiles without copying provider-owned browser data. */
router.post('/providers/discover', async (req, res) => {
  try {
    const profiles = await BrowserProviderService.discover(req.body.provider, req.body.config || {});
    res.json({ success: true, data: profiles });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Import selected discovered profiles and assign them to one/both platforms. */
router.post('/providers/import', (req, res) => {
  try {
    const result = BrowserService.importDiscoveredProfiles(
      req.body.profiles || [],
      req.body.platforms || [platformOf(req)]
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Re-read authoritative names for already imported provider profiles. */
router.post('/providers/refresh-names', async (req, res) => {
  try {
    const result = await BrowserService.refreshProviderNames(req.body.provider || null);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Shared page/channel catalog used by the data tables and Telegram control. */
router.get('/targets', (req, res) => {
  try {
    const type = String(req.query.type || 'all').toLowerCase();
    const catalog = ManagedTargetsService.read();
    const data = type === 'facebook' || type === 'youtube'
      ? ManagedTargetsService.all(type)
      : {
          facebook: ManagedTargetsService.all('facebook'),
          youtube: ManagedTargetsService.all('youtube'),
        };
    res.json({ success: true, data, file: ManagedTargetsService.FILE_PATH, catalog });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/targets/scan', async (req, res) => {
  try {
    const type = String(req.body.type || 'facebook').toLowerCase();
    const profileIds = req.body.profileIds || [];
    if (!Array.isArray(profileIds) || !profileIds.length) {
      return res.status(400).json({ error: 'Vui lòng chọn ít nhất 1 profile.' });
    }
    // Đóng modal/tab ở giao diện sẽ ngắt request; dừng quét ngay thay vì chạy hết danh sách.
    const controller = new AbortController();
    req.on('close', () => { if (!res.writableEnded) controller.abort(); });
    const result = await ManagedTargetsService.scanProfiles(profileIds, type, null, { signal: controller.signal });
    if (controller.signal.aborted) return;
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/targets/match', (req, res) => {
  try {
    const type = String(req.body.type || 'facebook').toLowerCase();
    const links = Array.isArray(req.body.links) ? req.body.links : [];
    const profileIds = Array.isArray(req.body.profileIds) ? req.body.profileIds : [];
    res.json({ success: true, data: ManagedTargetsService.matchTargets(type, links, profileIds) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Open many different physical profiles in parallel. */
router.post('/bulk/launch', async (req, res) => {
  const ids = [...new Set((req.body.profileIds || []).map(Number).filter(Number.isInteger))];
  const concurrency = settingInt('max_concurrency', 5, 1, 20);
  const openDelayMs = settingInt('profile_open_delay_ms', 0, 0, 600000);
  const retryCount = settingInt('browser_launch_retry_count', 0, 0, 10);
  const results = new Array(ids.length);
  const active = new Set();

  const launchOne = async (id, index) => {
    let lastError = null;
    for (let attempt = 0; attempt <= retryCount; attempt++) {
      try {
        const value = await BrowserService.open(id, { platform: platformOf(req) });
        results[index] = { id, success: true, attempts: attempt + 1, ...value };
        return;
      } catch (error) {
        lastError = error;
        if (attempt < retryCount) await wait(openDelayMs);
      }
    }
    results[index] = {
      id,
      success: false,
      attempts: retryCount + 1,
      error: lastError?.message || 'Could not launch browser',
    };
  };

  for (let index = 0; index < ids.length; index++) {
    while (active.size >= concurrency) await Promise.race(active);
    if (index > 0) await wait(openDelayMs);
    const task = launchOne(ids[index], index).finally(() => active.delete(task));
    active.add(task);
  }
  await Promise.allSettled([...active]);
  /* legacy result mapping removed
  const legacyResults = settled.map((item, index) => item.status === 'fulfilled'
    ? { id: ids[index], success: true, ...item.value }
    : { id: ids[index], success: false, error: item.reason?.message || 'Không mở được trình duyệt' });
  */
  res.json({ success: true, data: results });
});

/** Close/detach many selected profiles in parallel. */
router.post('/bulk/close', async (req, res) => {
  const ids = [...new Set((req.body.profileIds || []).map(Number).filter(Number.isInteger))];
  const settled = await Promise.allSettled(ids.map(id => BrowserService.close(id)));
  const results = settled.map((item, index) => item.status === 'fulfilled'
    ? { id: ids[index], success: true, ...item.value }
    : { id: ids[index], success: false, error: item.reason?.message || 'Không đóng được trình duyệt' });
  res.json({ success: true, data: results });
});

/** Remove many selected profiles from the current platform. */
router.delete('/bulk/delete', async (req, res) => {
  try {
    const ids = [...new Set((req.body.profileIds || []).map(Number).filter(Number.isInteger))];
    const globalScope = String(platformOf(req)).toLowerCase() === 'all';
    const result = globalScope
      ? {
          total: ids.length,
          results: await Promise.all(ids.map(async id => {
            try {
              await BrowserService.delete(id);
              return { id, success: true, deletedPhysicalProfile: true };
            } catch (error) {
              return { id, success: false, error: error?.message || 'Không xóa được profile' };
            }
          })),
        }
      : await BrowserService.unlinkPlatforms(ids, platformOf(req));
    if (globalScope) {
      result.successCount = result.results.filter(item => item.success).length;
      result.failureCount = result.results.filter(item => !item.success).length;
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST / - Create a new browser profile
 */
router.post('/', (req, res) => {
  try {
    const profile = BrowserService.create(req.body, platformOf(req));
    res.json({ success: true, data: profile });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * PUT /:id - Update a browser profile
 */
router.put('/:id', (req, res) => {
  try {
    const profile = BrowserService.update(parseInt(req.params.id), req.body);
    res.json({ success: true, data: profile });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /sync - Link selected physical profiles to another platform
 */
router.post('/sync', (req, res) => {
  try {
    const result = BrowserService.syncProfiles(req.body.profileIds, req.body.targetPlatform);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /:id - Delete a browser profile (close Chrome first if open)
 */
router.delete('/:id', async (req, res) => {
  try {
    if (String(platformOf(req)).toLowerCase() === 'all') {
      await BrowserService.delete(parseInt(req.params.id));
    } else {
      await BrowserService.unlinkPlatform(parseInt(req.params.id), platformOf(req));
    }
    res.json({ success: true, message: 'Đã xóa profile' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /:id/launch - Launch Chrome with this profile
 */
router.post('/:id/launch', async (req, res) => {
  try {
    const result = await BrowserService.open(parseInt(req.params.id), {
      platform: platformOf(req),
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /:id/close - Close Chrome for this profile
 */
router.post('/:id/close', async (req, res) => {
  try {
    const result = await BrowserService.close(parseInt(req.params.id));
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /:id/status - Get browser status and session validity
 */
router.get('/:id/status', async (req, res) => {
  try {
    const status = await BrowserService.getStatus(parseInt(req.params.id), platformOf(req));
    res.json({ success: true, data: status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
