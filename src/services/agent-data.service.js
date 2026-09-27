const fs = require('fs');
const path = require('path');
const db = require('../database/init');
const { PLATFORMS } = require('../platforms/platform.utils');
const BrowserService = require('./browser.service');
const CommentColumns = require('./comment-columns.service');
const DataService = require('./data.service');

const MAX_ITEMS = 500;
const MAX_MEDIA = 20;
const MAX_COMMENTS = 50;
const MANAGED_CUSTOM_FIELDS = new Set([
  'name_profile',
  'link_fanpage',
  'post_group',
  'description',
  'channel_name',
  'playlist',
  'privacy_status',
  'thumbnail',
  'keywords',
  'link_post',
  'time_post',
  'comment_status',
  'time_comment',
]);

function errorWithCode(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizePlatform(value) {
  const platform = String(value || '').trim().toLowerCase();
  if (!PLATFORMS.includes(platform)) {
    throw errorWithCode(`Nền tảng không được hỗ trợ: ${platform || '(trống)'}`, 'AGENT_PLATFORM_INVALID');
  }
  return platform;
}

function normalizeDataKey(value) {
  const key = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(key)) {
    throw errorWithCode(
      'data_key phải dài 3-160 ký tự và chỉ gồm chữ, số, dấu chấm, gạch, hai chấm.',
      'AGENT_DATA_KEY_INVALID'
    );
  }
  return key;
}

function normalizeFileList(raw, label = 'media', maxItems = MAX_MEDIA) {
  const values = (Array.isArray(raw) ? raw : raw ? [raw] : [])
    .map(value => String(value || '').trim())
    .filter(Boolean);
  if (values.length > maxItems) {
    throw errorWithCode(`${label} tối đa ${maxItems} file.`, 'AGENT_DATA_MEDIA_TOO_LARGE');
  }
  for (const value of values) {
    if (value.includes(',')) {
      throw errorWithCode(`Đường dẫn ${label} không được chứa dấu phẩy.`, 'AGENT_DATA_MEDIA_INVALID');
    }
    if (!path.isAbsolute(value) || !fs.existsSync(value) || !fs.statSync(value).isFile()) {
      throw errorWithCode(`Không tìm thấy ${label} trên máy: ${value}`, 'AGENT_DATA_MEDIA_NOT_FOUND');
    }
  }
  return values;
}

function resolveProfile(payload, platform) {
  const hasId = payload.profile_id !== undefined || payload.profileId !== undefined;
  const requestedName = String(payload.profile || payload.profile_name || '').trim();
  if (!hasId && !requestedName) return null;

  const profiles = BrowserService.getAll(platform);
  if (hasId) {
    const requestedId = Number(payload.profile_id !== undefined ? payload.profile_id : payload.profileId);
    if (!Number.isInteger(requestedId) || requestedId <= 0) {
      throw errorWithCode('profile_id không hợp lệ.', 'AGENT_PROFILE_INVALID');
    }
    const profile = profiles.find(item => Number(item.id) === requestedId);
    if (!profile) {
      throw errorWithCode('Không tìm thấy profile cho nền tảng đã chọn.', 'AGENT_PROFILE_NOT_FOUND');
    }
    if (requestedName && String(profile.name).trim().toLowerCase() !== requestedName.toLowerCase()) {
      throw errorWithCode('profile và profile_id không cùng chỉ một profile.', 'AGENT_PROFILE_MISMATCH');
    }
    return profile;
  }

  const matches = profiles.filter(
    item => String(item.name).trim().toLowerCase() === requestedName.toLowerCase()
  );
  if (!matches.length) {
    throw errorWithCode(`Không tìm thấy profile "${requestedName}".`, 'AGENT_PROFILE_NOT_FOUND');
  }
  if (matches.length > 1) {
    throw errorWithCode(`Có nhiều profile tên "${requestedName}"; hãy dùng profile_id.`, 'AGENT_PROFILE_AMBIGUOUS');
  }
  return matches[0];
}

function normalizeFacebookUrl(value, field) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!['facebook.com', 'fb.com'].includes(host) && !host.endsWith('.facebook.com')) {
      throw new Error('not facebook');
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid protocol');
    return text;
  } catch (_) {
    throw errorWithCode(`${field} phải là URL Facebook hợp lệ.`, 'AGENT_DATA_TARGET_INVALID');
  }
}

function normalizeComments(raw) {
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (values.length > MAX_COMMENTS) {
    throw errorWithCode(`Tối đa ${MAX_COMMENTS} bình luận cho một hàng.`, 'AGENT_DATA_COMMENTS_TOO_LARGE');
  }
  return values.map((item, index) => {
    const text = typeof item === 'string'
      ? item.trim()
      : String(item && (item.text || item.content) || '').trim();
    const mediaRaw = typeof item === 'string' ? '' : item && (item.media || item.image_path);
    const mediaValues = normalizeFileList(mediaRaw, `media bình luận ${index + 1}`, 1);
    if (!text && !mediaValues.length) {
      throw errorWithCode(
        `Bình luận ${index + 1} cần có nội dung hoặc media.`,
        'AGENT_DATA_COMMENT_EMPTY'
      );
    }
    return { text, media: mediaValues[0] || '' };
  });
}

function normalizeCustomFields(raw, columns) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw errorWithCode('custom_fields phải là object.', 'AGENT_DATA_CUSTOM_FIELDS_INVALID');
  }
  const byKey = new Map(columns.map(column => [column.var_key, column]));
  const normalized = {};
  for (const key of Object.keys(raw).sort()) {
    const managedCommentField = CommentColumns.parseVarKey(key);
    if (
      MANAGED_CUSTOM_FIELDS.has(key)
      || (managedCommentField && ['comment', 'comment_media', 'comment_status', 'time_comment'].includes(managedCommentField.base))
    ) {
      throw errorWithCode(
        `Custom field ${key} must use its dedicated MCP field.`,
        'AGENT_DATA_CUSTOM_FIELD_MANAGED'
      );
    }
    const column = byKey.get(key);
    if (!column) {
      throw errorWithCode(`Custom field không tồn tại: ${key}`, 'AGENT_DATA_CUSTOM_FIELD_NOT_FOUND');
    }
    const commentField = CommentColumns.parseVarKey(key);
    if (
      MANAGED_CUSTOM_FIELDS.has(key)
      || (commentField && ['comment', 'comment_media', 'comment_status', 'time_comment'].includes(commentField.base))
    ) {
      throw errorWithCode(
        `Custom field ${key} phải truyền qua trường MCP chuyên dụng.`,
        'AGENT_DATA_CUSTOM_FIELD_MANAGED'
      );
    }
    const value = raw[key] == null ? '' : String(raw[key]).trim();
    if (column.col_type === 'file' && value) normalizeFileList(value, `custom_fields.${key}`);
    normalized[key] = value;
  }
  return normalized;
}

function normalizeProductId(payload, platform) {
  const supplied = payload.product_id !== undefined || payload.product_ids !== undefined;
  if (!supplied) return '';
  if (platform !== 'tiktok') {
    throw errorWithCode('product_id chỉ dùng cho TikTok.', 'AGENT_DATA_FIELD_NOT_SUPPORTED');
  }
  const raw = payload.product_ids !== undefined ? payload.product_ids : payload.product_id;
  return (Array.isArray(raw) ? raw : [raw])
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join(',');
}

function normalizeItem(payload, platform, columns) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw errorWithCode('Mỗi item phải là object.', 'AGENT_DATA_ITEM_INVALID');
  }
  const dataKey = normalizeDataKey(payload.data_key || payload.item_key);
  const profile = resolveProfile(payload, platform);
  const content = String(payload.content || '').trim();
  const media = normalizeFileList(
    payload.media !== undefined ? payload.media : payload.image_path
  );
  if (!content && !media.length) {
    throw errorWithCode('Dữ liệu cần có content hoặc media.', 'AGENT_DATA_EMPTY');
  }

  const fanpage = String(payload.fanpage || payload.link_fanpage || '').trim();
  const group = String(payload.group || payload.post_group || '').trim();
  if (fanpage && group) {
    throw errorWithCode('Một hàng không được trộn Fanpage và Facebook Group.', 'AGENT_DATA_TARGET_CONFLICT');
  }
  if (platform !== 'facebook' && (fanpage || group)) {
    throw errorWithCode('fanpage/group chỉ dùng cho Facebook.', 'AGENT_DATA_FIELD_NOT_SUPPORTED');
  }

  const comments = normalizeComments(payload.comments);
  const thumbnailValues = normalizeFileList(payload.thumbnail, 'thumbnail', 1);
  if (thumbnailValues.length && !['youtube', 'facebook'].includes(platform)) {
    throw errorWithCode('thumbnail chỉ dùng cho YouTube hoặc Facebook.', 'AGENT_DATA_FIELD_NOT_SUPPORTED');
  }
  const playlist = String(payload.playlist || '').trim();
  if (playlist && !['youtube', 'zalovideo'].includes(platform)) {
    throw errorWithCode('playlist chỉ dùng cho YouTube hoặc Zalo Video.', 'AGENT_DATA_FIELD_NOT_SUPPORTED');
  }
  for (const key of ['description', 'channel', 'channel_name', 'privacy_status', 'keywords']) {
    if (payload[key] !== undefined && platform !== 'youtube') {
      throw errorWithCode(`${key} chỉ dùng cho YouTube.`, 'AGENT_DATA_FIELD_NOT_SUPPORTED');
    }
  }

  const customFields = normalizeCustomFields(payload.custom_fields, columns);
  const keywords = (Array.isArray(payload.keywords) ? payload.keywords : [payload.keywords])
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join(',');
  const normalized = {
    version: 1,
    platform,
    content,
    media,
    profile_id: profile ? Number(profile.id) : null,
    profile: profile ? profile.name : '',
    fanpage,
    group,
    link: platform === 'facebook' ? fanpage : String(payload.link || '').trim(),
    target: String(payload.target || '').trim(),
    product_id: normalizeProductId(payload, platform),
    description: String(payload.description || '').trim(),
    channel_name: String(payload.channel || payload.channel_name || '').trim(),
    playlist,
    privacy_status: String(payload.privacy_status || '').trim(),
    thumbnail: thumbnailValues[0] || '',
    keywords,
    comments,
    custom_fields: customFields,
  };
  return {
    dataKey,
    normalized,
    payloadJson: JSON.stringify(normalized),
  };
}

function customValuesFor(prepared) {
  const value = prepared.normalized;
  const custom = {
    ...value.custom_fields,
    name_profile: value.profile,
    link_fanpage: value.fanpage,
    post_group: value.group,
    description: value.description,
    channel_name: value.channel_name,
    playlist: value.playlist,
    privacy_status: value.privacy_status,
    thumbnail: value.thumbnail,
    keywords: value.keywords,
  };
  value.comments.forEach((comment, index) => {
    const sequence = index + 1;
    custom[CommentColumns.varKey('comment', sequence)] = comment.text;
    custom[CommentColumns.varKey('comment_media', sequence)] = comment.media;
  });
  return custom;
}

function insertPrepared(prepared, platform) {
  const value = prepared.normalized;
  const post = DataService.create({
    content: value.content,
    image_path: value.media.join(','),
    link: value.link,
    target: value.target,
    product_id: value.product_id,
    status: 'pending',
    note: 'Tạo từ MCP ở trạng thái Đợi',
    agent_data_key: prepared.dataKey,
    agent_payload_json: prepared.payloadJson,
  }, platform);

  const columns = new Map(DataService.getCustomColumns(platform).map(column => [column.var_key, column]));
  for (const [key, rawValue] of Object.entries(customValuesFor(prepared))) {
    const column = columns.get(key);
    if (!column) continue;
    DataService.setCustomData(
      post.id,
      column.id,
      rawValue == null ? '' : String(rawValue),
      platform,
      { preserveAgentPayload: true }
    );
  }
  return post;
}

function publicRow(row, platform, idempotentReplay) {
  const columns = DataService.getCustomColumns(platform);
  const customRows = db.prepare(
    'SELECT column_id, value FROM post_custom_data WHERE post_id = ?'
  ).all(row.id);
  const byColumn = new Map(customRows.map(item => [Number(item.column_id), item.value || '']));
  const customFields = Object.fromEntries(columns.map(column => [
    column.var_key,
    byColumn.get(Number(column.id)) || '',
  ]));
  const profileName = String(customFields.name_profile || '').trim();
  const profileMatches = BrowserService.getAll(platform).filter(
    profile => String(profile.name || '').trim().toLowerCase() === profileName.toLowerCase()
  );
  const fanpage = String(customFields.link_fanpage || '').trim();
  const group = String(customFields.post_group || '').trim();
  return {
    post_id: Number(row.id),
    data_key: row.agent_data_key,
    platform,
    status: row.status || 'pending',
    content: row.content || '',
    media: row.image_path || '',
    profile_id: profileMatches.length === 1 ? Number(profileMatches[0].id) : null,
    profile: profileName,
    mapping_ready: Boolean(profileName),
    target_type: fanpage
      ? 'fanpage'
      : group
        ? 'group'
        : platform === 'facebook' ? 'profile' : 'default',
    target_url: fanpage || group,
    custom_fields: customFields,
    idempotent_replay: Boolean(idempotentReplay),
    job_created: false,
    runner_started: false,
  };
}

function scheduledConsumption(prepared, platform, allowed) {
  const profileIds = [...new Set(
    prepared.map(item => Number(item.normalized.profile_id)).filter(Number.isInteger)
  )];
  if (!profileIds.length) return { authorized: false, matching_schedules: [] };

  const matches = require('./agent-schedule.service')
    .findEnabledAllPending(platform, profileIds);
  if (matches.length && allowed !== true) {
    throw errorWithCode(
      `There are ${matches.length} enabled all_pending schedules that can consume this data. `
        + 'Pass allow_scheduled_consumption=true only when that behavior is intended.',
      'AGENT_DATA_ACTIVE_ALL_PENDING_SCHEDULE'
    );
  }
  return {
    authorized: matches.length > 0 && allowed === true,
    matching_schedules: matches,
  };
}

function createBatch(payload = {}) {
  const platform = normalizePlatform(payload.platform);
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) {
    throw errorWithCode('Cần truyền ít nhất một item.', 'AGENT_DATA_ITEMS_REQUIRED');
  }
  if (items.length > MAX_ITEMS) {
    throw errorWithCode(`Tối đa ${MAX_ITEMS} item mỗi lần.`, 'AGENT_DATA_ITEMS_TOO_LARGE');
  }

  // Delay schema expansion until every item and idempotency key is valid.
  const commentCounts = items.map(
    item => Array.isArray(item && item.comments) ? item.comments.length : item && item.comments ? 1 : 0
  );
  const maxComments = Math.max(0, ...commentCounts);
  if (maxComments > MAX_COMMENTS) {
    throw errorWithCode(
      `Tối đa ${MAX_COMMENTS} bình luận cho một hàng.`,
      'AGENT_DATA_COMMENTS_TOO_LARGE'
    );
  }
  const columns = DataService.getCustomColumns(platform);
  const prepared = items.map(item => normalizeItem(item, platform, columns));

  const seen = new Set();
  for (const item of prepared) {
    if (seen.has(item.dataKey)) {
      throw errorWithCode(`data_key bị lặp trong batch: ${item.dataKey}`, 'AGENT_DATA_KEY_DUPLICATE');
    }
    seen.add(item.dataKey);
  }

  const existing = prepared.map(item => ({
    prepared: item,
    row: db.prepare(
      'SELECT * FROM posts WHERE platform = ? AND agent_data_key = ?'
    ).get(platform, item.dataKey),
  })).filter(item => item.row);
  for (const item of existing) {
    if (String(item.row.agent_payload_json || '') !== item.prepared.payloadJson) {
      throw errorWithCode(
        `data_key "${item.prepared.dataKey}" đã tồn tại với nội dung khác.`,
        'AGENT_DATA_KEY_CONFLICT'
      );
    }
  }
  if (existing.length && existing.length !== prepared.length) {
    throw errorWithCode(
      'Batch chứa cả data_key đã tồn tại và data_key mới; hãy dùng batch mới chỉ gồm dữ liệu mới.',
      'AGENT_DATA_BATCH_IDEMPOTENCY_CONFLICT'
    );
  }

  let rows;
  let replay = false;
  let consumption = { authorized: false, matching_schedules: [] };
  if (existing.length) {
    rows = existing.map(item => item.row);
    replay = true;
  } else {
    consumption = scheduledConsumption(
      prepared,
      platform,
      payload.allow_scheduled_consumption
    );
    DataService.ensurePlatformDefaultColumns(platform);
    if (platform === 'facebook' && prepared.some(item => item.normalized.group)) {
      DataService.ensureFacebookGroupColumn();
    }
    if (maxComments) DataService.ensureCommentGroupsThrough(maxComments, platform);
    rows = db.transaction(() => prepared.map(item => insertPrepared(item, platform)))();
  }
  return {
    platform,
    status: 'pending',
    total: rows.length,
    created_count: replay ? 0 : rows.length,
    replay_count: replay ? rows.length : 0,
    job_count: 0,
    runner_started: false,
    scheduled_consumption_authorized: consumption.authorized,
    matching_schedules: consumption.matching_schedules,
    items: rows.map(row => publicRow(row, platform, replay)),
  };
}

function create(payload = {}) {
  const result = createBatch({
    platform: payload.platform,
    allow_scheduled_consumption: payload.allow_scheduled_consumption,
    items: [payload],
  });
  return {
    ...result.items[0],
    scheduled_consumption_authorized: result.scheduled_consumption_authorized,
    matching_schedules: result.matching_schedules,
  };
}

// Binh luan hang loat vao link co san (khong dang bai). Moi item mot dong that
// trong bang posts (idempotent theo data_key) + xep chuoi comment jobs.
function commentLinks(payload = {}) {
  const platform = normalizePlatform(payload.platform);
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) {
    throw errorWithCode('Cần truyền ít nhất một item.', 'AGENT_DATA_ITEMS_REQUIRED');
  }
  if (items.length > MAX_ITEMS) {
    throw errorWithCode(`Tối đa ${MAX_ITEMS} item mỗi lần.`, 'AGENT_DATA_ITEMS_TOO_LARGE');
  }

  const CommentJobService = require('./comment-job.service');
  DataService.ensurePlatformDefaultColumns(platform);

  const prepared = items.map((item, index) => {
    const source = item || {};
    const dataKey = normalizeDataKey(source.data_key);
    const linkRaw = String(source.link || source.link_post || '').trim();
    if (!linkRaw) {
      throw errorWithCode(`Item ${index + 1} thiếu link bài để bình luận.`, 'AGENT_DATA_TARGET_INVALID');
    }
    const link = platform === 'facebook'
      ? normalizeFacebookUrl(linkRaw, `link item ${index + 1}`)
      : linkRaw;
    const profile = resolveProfile(source, platform);
    if (!profile) {
      throw errorWithCode(`Item ${index + 1} cần profile hoặc profile_id.`, 'AGENT_PROFILE_REQUIRED');
    }
    const comments = normalizeComments(
      source.comments !== undefined ? source.comments : source.comment
    );
    if (!comments.length) {
      throw errorWithCode(`Item ${index + 1} cần ít nhất một bình luận.`, 'AGENT_DATA_COMMENT_EMPTY');
    }
    const payloadJson = JSON.stringify({ link, profile: profile.name, comments });
    return { dataKey, link, profile, comments, payloadJson };
  });

  const seen = new Set();
  for (const item of prepared) {
    if (seen.has(item.dataKey)) {
      throw errorWithCode(`data_key bị lặp trong batch: ${item.dataKey}`, 'AGENT_DATA_KEY_DUPLICATE');
    }
    seen.add(item.dataKey);
  }

  const maxComments = Math.max(0, ...prepared.map(item => item.comments.length));
  if (maxComments) DataService.ensureCommentGroupsThrough(maxComments, platform);

  const results = [];
  for (const item of prepared) {
    const existing = db.prepare(
      'SELECT * FROM posts WHERE platform = ? AND agent_data_key = ?'
    ).get(platform, item.dataKey);
    if (existing) {
      if (String(existing.agent_payload_json || '') !== item.payloadJson) {
        throw errorWithCode(
          `data_key "${item.dataKey}" đã tồn tại với nội dung khác.`,
          'AGENT_DATA_KEY_CONFLICT'
        );
      }
      results.push({ ...publicRow(existing, platform, true), scheduled: false });
      continue;
    }

    const post = DataService.create({
      content: '',
      link: item.link,
      status: 'Đã xếp bình luận',
      note: 'Bình luận theo link từ MCP',
      agent_data_key: item.dataKey,
      agent_payload_json: item.payloadJson,
      data_mode: 'comment_link',
    }, platform, 'comment_link');

    const columns = new Map(
      DataService.getCustomColumns(platform).map(column => [column.var_key, column])
    );
    const setCustom = (varKey, value) => {
      const column = columns.get(varKey);
      if (column) {
        DataService.setCustomData(post.id, column.id, value, platform, { preserveAgentPayload: true });
      }
    };
    setCustom('name_profile', item.profile.name);
    setCustom('link_post', item.link);

    const jobs = CommentJobService.scheduleCommentOnLink({
      platform,
      postId: post.id,
      profileId: item.profile.id,
      postLink: item.link,
      comments: item.comments,
    });
    results.push({
      ...publicRow(post, platform, false),
      scheduled: Number(jobs.created_count ?? jobs.length) > 0,
      duplicate_blocked: Number(jobs.created_count ?? jobs.length) === 0,
    });
  }

  return {
    platform,
    total: results.length,
    scheduled_count: results.filter(item => item.scheduled).length,
    replay_count: results.filter(item => item.idempotent_replay).length,
    items: results,
  };
}

module.exports = {
  create,
  createBatch,
  commentLinks,
  _private: {
    normalizeDataKey,
    normalizeFileList,
    normalizeItem,
  },
};
