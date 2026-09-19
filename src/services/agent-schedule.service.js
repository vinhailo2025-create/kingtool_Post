const cron = require('node-cron');
const db = require('../database/init');
const { normalizePlatform } = require('../platforms/platform.utils');

const SCHEDULE_TYPES = new Set(['once', 'daily', 'custom']);

function schedulerService() {
  return require('./scheduler.service');
}

function agentJobs() {
  return require('./agent-job.service');
}

function assertLicensed(platform) {
  return require('./license.service').assertPlatform(platform);
}

function errorWithCode(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function positiveIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter(id => Number.isInteger(id) && id > 0))];
}

function parseStoredIds(value) {
  if (value === 'all' || value === '*') return 'all';
  try {
    return positiveIds(JSON.parse(value || '[]'));
  } catch (_) {
    return [];
  }
}

function resolveSchedule(identifier, platform = '') {
  const raw = String(identifier == null ? '' : identifier).trim();
  if (!raw) {
    throw errorWithCode('Cần truyền schedule_id hoặc schedule_key.', 'AGENT_SCHEDULE_ID_REQUIRED');
  }
  let schedule = null;
  if (/^\d+$/.test(raw)) schedule = schedulerService().getById(Number(raw));
  if (!schedule) {
    schedule = db.prepare('SELECT * FROM schedules WHERE schedule_key = ?').get(raw);
  }
  if (schedule && platform && platform !== 'all') {
    const expected = normalizePlatform(platform);
    if (schedule.platform !== expected) schedule = null;
  }
  if (!schedule) {
    throw errorWithCode('Không tìm thấy lịch hẹn.', 'AGENT_SCHEDULE_NOT_FOUND');
  }
  return schedule;
}

function publicSchedule(schedule, extra = {}) {
  if (!schedule) return null;
  const dataIds = parseStoredIds(schedule.data_ids);
  return {
    schedule_id: Number(schedule.id),
    schedule_key: schedule.schedule_key || null,
    name: schedule.name,
    platform: schedule.platform,
    schedule_type: schedule.schedule_type,
    schedule_time: schedule.schedule_time || null,
    cron_expr: schedule.cron_expr || null,
    timezone: 'Asia/Ho_Chi_Minh',
    profile_ids: parseStoredIds(schedule.profile_ids),
    data_ids: dataIds === 'all' ? [] : dataIds,
    all_pending: dataIds === 'all',
    enabled: Number(schedule.enabled) === 1,
    status: schedule.status,
    last_run: schedule.last_run || null,
    created_by: schedule.created_by || 'app',
    created_at: schedule.created_at,
    settings_source: 'super-post-king-settings',
    ...extra,
  };
}

function normalizeScheduleKey(value) {
  const key = String(value || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,159}$/.test(key)) {
    throw errorWithCode(
      'schedule_key phải dài 3-160 ký tự và chỉ gồm chữ, số, dấu chấm, gạch, hai chấm.',
      'AGENT_SCHEDULE_KEY_INVALID'
    );
  }
  return key;
}

function normalizeEnabled(value, fallback) {
  if (value === undefined) return Boolean(fallback);
  if (typeof value !== 'boolean') {
    throw errorWithCode('enabled phải là true hoặc false.', 'AGENT_SCHEDULE_ENABLED_INVALID');
  }
  return value;
}

function normalizeTiming(input, existing = null) {
  const scheduleType = String(input.schedule_type || existing?.schedule_type || 'once')
    .trim()
    .toLowerCase();
  if (!SCHEDULE_TYPES.has(scheduleType)) {
    throw errorWithCode('schedule_type phải là once, daily hoặc custom.', 'AGENT_SCHEDULE_TYPE_INVALID');
  }
  let scheduleTime = input.schedule_time !== undefined
    ? String(input.schedule_time || '').trim()
    : String(existing?.schedule_time || '').trim();
  let cronExpr = input.cron_expr !== undefined
    ? String(input.cron_expr || '').trim()
    : String(existing?.cron_expr || '').trim();

  if (scheduleType === 'once') {
    const timestamp = Date.parse(scheduleTime);
    if (!scheduleTime || !Number.isFinite(timestamp)) {
      throw errorWithCode(
        'Lịch once cần schedule_time ISO 8601 hợp lệ.',
        'AGENT_SCHEDULE_TIME_INVALID'
      );
    }
    if (timestamp <= Date.now() + 5000) {
      throw errorWithCode(
        'Lịch once phải nằm trong tương lai ít nhất 5 giây.',
        'AGENT_SCHEDULE_TIME_PAST'
      );
    }
    scheduleTime = new Date(timestamp).toISOString();
    cronExpr = '';
  } else if (scheduleType === 'daily') {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(scheduleTime)) {
      throw errorWithCode(
        'Lịch daily cần schedule_time dạng HH:mm theo giờ Việt Nam.',
        'AGENT_SCHEDULE_TIME_INVALID'
      );
    }
    cronExpr = '';
  } else {
    if (!cronExpr || !cron.validate(cronExpr)) {
      throw errorWithCode('cron_expr không hợp lệ.', 'AGENT_SCHEDULE_CRON_INVALID');
    }
    scheduleTime = '';
  }
  return { schedule_type: scheduleType, schedule_time: scheduleTime, cron_expr: cronExpr };
}

function resolveProfileIds(platform, payload, existing = null) {
  const hasIds = payload.profile_ids !== undefined;
  const hasNames = payload.profiles !== undefined;
  if (!hasIds && !hasNames && existing) return parseStoredIds(existing.profile_ids);

  const available = agentJobs().listProfiles(platform);
  const ids = positiveIds(payload.profile_ids);
  for (const requested of Array.isArray(payload.profiles) ? payload.profiles : []) {
    const name = String(requested || '').trim().toLowerCase();
    if (!name) continue;
    const matches = available.filter(profile => String(profile.name || '').trim().toLowerCase() === name);
    if (matches.length !== 1) {
      throw errorWithCode(
        matches.length ? `Profile "${requested}" bị trùng tên; hãy dùng profile_id.` : `Không tìm thấy profile "${requested}".`,
        matches.length ? 'AGENT_PROFILE_AMBIGUOUS' : 'AGENT_PROFILE_NOT_FOUND'
      );
    }
    ids.push(Number(matches[0].id));
  }

  const unique = [...new Set(ids)];
  if (!unique.length) {
    throw errorWithCode('Cần ít nhất một profile_id hoặc tên profile.', 'AGENT_PROFILE_REQUIRED');
  }
  const allowed = new Set(available.map(profile => Number(profile.id)));
  const missing = unique.filter(id => !allowed.has(id));
  if (missing.length) {
    throw errorWithCode(
      `Profile không tồn tại trên ${platform}: ${missing.join(', ')}`,
      'AGENT_PROFILE_NOT_FOUND'
    );
  }
  return unique;
}

function resolveDataIds(platform, payload, existing = null, profileIds = []) {
  const hasAll = payload.all_pending !== undefined;
  const hasIds = payload.data_ids !== undefined;
  const stored = existing ? parseStoredIds(existing.data_ids) : [];
  const allPending = hasAll ? payload.all_pending === true : stored === 'all';
  const ids = hasIds ? positiveIds(payload.data_ids) : stored === 'all' ? [] : stored;
  if (allPending && ids.length) {
    throw errorWithCode(
      'Chỉ dùng một trong data_ids hoặc all_pending=true.',
      'AGENT_SCHEDULE_DATA_CONFLICT'
    );
  }
  if (allPending) return 'all';
  if (!ids.length) {
    throw errorWithCode('Cần data_ids hoặc all_pending=true.', 'AGENT_SCHEDULE_DATA_REQUIRED');
  }
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT p.id, p.status, COALESCE((
      SELECT pcd.value
      FROM post_custom_data pcd
      JOIN custom_columns cc ON cc.id = pcd.column_id
      WHERE pcd.post_id = p.id
        AND cc.platform = p.platform
        AND cc.var_key = 'name_profile'
      LIMIT 1
    ), '') AS profile_name
    FROM posts p
    WHERE p.platform = ? AND p.id IN (${placeholders})
  `).all(platform, ...ids);
  const found = new Map(rows.map(row => [Number(row.id), row]));
  const missing = ids.filter(id => !found.has(id));
  if (missing.length) {
    throw errorWithCode(
      `Không tìm thấy hàng dữ liệu trên ${platform}: ${missing.join(', ')}`,
      'AGENT_SCHEDULE_DATA_NOT_FOUND'
    );
  }
  const existingIds = new Set(
    existing && parseStoredIds(existing.data_ids) !== 'all'
      ? parseStoredIds(existing.data_ids).map(Number)
      : []
  );
  const notPending = ids.filter(id => {
    const status = String(found.get(id).status || '').toLowerCase();
    return status !== 'pending' && !(status === 'scheduled' && existingIds.has(id));
  });
  if (notPending.length) {
    throw errorWithCode(
      `Chỉ hẹn được hàng đang Chờ; các hàng không hợp lệ: ${notPending.join(', ')}`,
      'AGENT_SCHEDULE_DATA_NOT_PENDING'
    );
  }
  const selectedProfiles = agentJobs().listProfiles(platform)
    .filter(profile => profileIds.includes(Number(profile.id)));
  const selectedNames = new Set(
    selectedProfiles.map(profile => String(profile.name || '').trim())
  );
  const unmapped = ids.filter(id => !String(found.get(id).profile_name || '').trim());
  if (unmapped.length) {
    throw errorWithCode(
      `Scheduled rows require name_profile mapping: ${unmapped.join(', ')}`,
      'AGENT_SCHEDULE_DATA_PROFILE_REQUIRED'
    );
  }
  const mismatched = ids.filter(id => (
    !selectedNames.has(String(found.get(id).profile_name || '').trim())
  ));
  if (mismatched.length) {
    throw errorWithCode(
      `Scheduled rows are not mapped to the selected profiles: ${mismatched.join(', ')}`,
      'AGENT_SCHEDULE_DATA_PROFILE_MISMATCH'
    );
  }
  return ids;
}

function runtimeSettings(platform) {
  return agentJobs().getRuntimeConfig(platform).runner;
}

function comparable(value) {
  const allPending = value.all_pending === true || value.data_ids === 'all';
  return JSON.stringify({
    name: value.name,
    platform: value.platform,
    schedule_type: value.schedule_type,
    schedule_time: value.schedule_time || null,
    cron_expr: value.cron_expr || null,
    profile_ids: value.profile_ids,
    data_ids: allPending ? [] : value.data_ids,
    all_pending: allPending,
  });
}

function findEnabledAllPending(platform, profileIds = []) {
  platform = normalizePlatform(platform);
  const requested = new Set(positiveIds(profileIds));
  if (!requested.size) return [];
  return db.prepare(`
    SELECT * FROM schedules
    WHERE platform = ? AND enabled = 1 AND data_ids IN ('all', '*')
    ORDER BY id ASC
  `).all(platform)
    .filter(schedule => parseStoredIds(schedule.profile_ids).some(id => requested.has(id)))
    .map(publicSchedule);
}

function normalizedCreate(payload = {}) {
  const platform = normalizePlatform(payload.platform);
  const name = String(payload.name || '').trim();
  if (!name) throw errorWithCode('Tên lịch không được để trống.', 'AGENT_SCHEDULE_NAME_REQUIRED');
  if (name.length > 200) {
    throw errorWithCode('Tên lịch không được dài quá 200 ký tự.', 'AGENT_SCHEDULE_NAME_INVALID');
  }
  const timing = normalizeTiming(payload);
  const profileIds = resolveProfileIds(platform, payload);
  const dataIds = resolveDataIds(platform, payload, null, profileIds);
  return {
    schedule_key: normalizeScheduleKey(payload.schedule_key),
    name,
    platform,
    ...timing,
    profile_ids: profileIds,
    data_ids: dataIds,
    all_pending: dataIds === 'all',
    enabled: normalizeEnabled(payload.enabled, true),
  };
}

function list({ platform = 'all', status = '', enabled } = {}) {
  const normalizedPlatform = String(platform || 'all').toLowerCase() === 'all'
    ? 'all'
    : normalizePlatform(platform);
  const normalizedStatus = String(status || '').trim().toLowerCase();
  return schedulerService().getAll(normalizedPlatform)
    .filter(row => !normalizedStatus || String(row.status || '').toLowerCase() === normalizedStatus)
    .filter(row => enabled === undefined || (Number(row.enabled) === 1) === Boolean(enabled))
    .map(publicSchedule);
}

function get(identifier, platform = '') {
  return publicSchedule(resolveSchedule(identifier, platform));
}

function create(payload = {}) {
  const normalized = normalizedCreate(payload);
  assertLicensed(normalized.platform);
  const existing = db.prepare('SELECT * FROM schedules WHERE schedule_key = ?')
    .get(normalized.schedule_key);
  if (existing) {
    const current = publicSchedule(existing);
    if (comparable(current) !== comparable(normalized)) {
      throw errorWithCode(
        'schedule_key đã tồn tại với nội dung khác.',
        'AGENT_SCHEDULE_KEY_CONFLICT'
      );
    }
    return { ...current, idempotent_replay: true };
  }
  const settings = runtimeSettings(normalized.platform);
  const schedule = schedulerService().create({
    ...normalized,
    concurrency: settings.concurrency,
    delay_min: settings.delay_min,
    delay_max: settings.delay_max,
    schedule_key: normalized.schedule_key,
    created_by: 'mcp',
  });
  return publicSchedule(schedule, { idempotent_replay: false });
}

function update(identifier, payload = {}) {
  const existing = resolveSchedule(identifier, payload.platform || '');
  const platform = existing.platform;
  if (payload.schedule_key !== undefined && String(payload.schedule_key) !== String(existing.schedule_key || '')) {
    throw errorWithCode('Không thể đổi schedule_key.', 'AGENT_SCHEDULE_KEY_IMMUTABLE');
  }
  const name = payload.name !== undefined ? String(payload.name || '').trim() : existing.name;
  if (!name) throw errorWithCode('Tên lịch không được để trống.', 'AGENT_SCHEDULE_NAME_REQUIRED');
  if (name.length > 200) {
    throw errorWithCode('Tên lịch không được dài quá 200 ký tự.', 'AGENT_SCHEDULE_NAME_INVALID');
  }
  const timing = normalizeTiming(payload, existing);
  const profileIds = resolveProfileIds(platform, payload, existing);
  const dataIds = resolveDataIds(platform, payload, existing, profileIds);
  const nextEnabled = normalizeEnabled(payload.enabled, Number(existing.enabled) === 1);
  if (nextEnabled) assertLicensed(platform);
  const settings = runtimeSettings(platform);
  const updated = schedulerService().update(existing.id, {
    name,
    ...timing,
    profile_ids: profileIds,
    data_ids: dataIds,
    enabled: nextEnabled,
    concurrency: settings.concurrency,
    delay_min: settings.delay_min,
    delay_max: settings.delay_max,
  }, platform);
  return publicSchedule(updated);
}

function setEnabled(identifier, enabled, platform = '') {
  if (typeof enabled !== 'boolean') {
    throw errorWithCode('enabled phải là true hoặc false.', 'AGENT_SCHEDULE_ENABLED_INVALID');
  }
  let schedule = resolveSchedule(identifier, platform);
  if ((Number(schedule.enabled) === 1) === enabled) {
    return publicSchedule(schedule);
  }
  if (enabled) {
    assertLicensed(schedule.platform);
    const profileIds = parseStoredIds(schedule.profile_ids);
    const dataIds = parseStoredIds(schedule.data_ids);
    resolveDataIds(schedule.platform, {
      all_pending: dataIds === 'all',
      data_ids: dataIds === 'all' ? undefined : dataIds,
    }, null, profileIds);
  }
  schedule = schedulerService().toggle(schedule.id, schedule.platform);
  return publicSchedule(schedule);
}

function remove(identifier, platform = '') {
  const schedule = resolveSchedule(identifier, platform);
  const snapshot = publicSchedule(schedule);
  schedulerService().delete(schedule.id, schedule.platform);
  return { ...snapshot, deleted: true };
}

module.exports = {
  list,
  get,
  create,
  update,
  setEnabled,
  remove,
  findEnabledAllPending,
  _private: {
    normalizeTiming,
    publicSchedule,
    resolveDataIds,
    resolveProfileIds,
  },
};
