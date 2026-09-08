const crypto = require('crypto');
const db = require('../database/init');
const BrowserService = require('./browser.service');
const { PLATFORMS } = require('../platforms/platform.utils');

const FACEBOOK_TARGETS = new Set(['profile', 'fanpage', 'group']);
const OTHER_TARGETS = new Set(['profile', 'default']);
let initialized = false;

function errorWithCode(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requirePlatform(value, fallback = 'facebook') {
  const platform = String(value || fallback).trim().toLowerCase();
  if (!PLATFORMS.includes(platform)) {
    throw errorWithCode(`Nền tảng không được hỗ trợ: ${platform}`, 'PUBLISH_GROUP_PLATFORM_INVALID');
  }
  return platform;
}

function init() {
  if (initialized) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS publish_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_publish_groups_platform_name
      ON publish_groups(platform, name COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS publish_group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      publish_group_id INTEGER NOT NULL,
      member_order INTEGER NOT NULL DEFAULT 0,
      target_type TEXT NOT NULL,
      profile_id INTEGER NOT NULL,
      profile_name TEXT NOT NULL,
      target_url TEXT NOT NULL DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (publish_group_id) REFERENCES publish_groups(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_publish_group_members_group
      ON publish_group_members(publish_group_id, member_order, id);
  `);
  initialized = true;
}

function normalizeName(value) {
  const name = String(value || '').trim();
  if (!name) throw errorWithCode('Nhóm đăng cần có tên.', 'PUBLISH_GROUP_NAME_REQUIRED');
  if (name.length > 120) throw errorWithCode('Tên Nhóm đăng tối đa 120 ký tự.', 'PUBLISH_GROUP_NAME_INVALID');
  return name;
}

function normalizeGroupKey(value) {
  const key = String(value || '').trim() || `publish-group-${crypto.randomUUID()}`;
  if (key.length > 128 || !/^[a-zA-Z0-9._:-]+$/.test(key)) {
    throw errorWithCode(
      'group_key chỉ gồm chữ, số, dấu chấm, gạch dưới, gạch ngang hoặc dấu hai chấm; tối đa 128 ký tự.',
      'PUBLISH_GROUP_KEY_INVALID'
    );
  }
  return key;
}

function resolveProfile(member, platform, index) {
  const profiles = BrowserService.getAll(platform);
  const rawId = member && (member.profile_id ?? member.profileId);
  if (rawId !== undefined && rawId !== null && rawId !== '') {
    const id = Number(rawId);
    const profile = profiles.find(item => Number(item.id) === id);
    if (!profile) {
      throw errorWithCode(`Thành viên ${index + 1}: không tìm thấy profile_id ${rawId}.`, 'PUBLISH_GROUP_PROFILE_NOT_FOUND');
    }
    return profile;
  }
  const name = String(member && member.profile || '').trim();
  if (!name) {
    throw errorWithCode(`Thành viên ${index + 1}: cần profile hoặc profile_id.`, 'PUBLISH_GROUP_PROFILE_REQUIRED');
  }
  const matches = profiles.filter(item => String(item.name || '').trim().toLowerCase() === name.toLowerCase());
  if (!matches.length) {
    throw errorWithCode(`Thành viên ${index + 1}: không tìm thấy profile "${name}".`, 'PUBLISH_GROUP_PROFILE_NOT_FOUND');
  }
  if (matches.length > 1) {
    throw errorWithCode(`Thành viên ${index + 1}: profile "${name}" bị trùng tên; hãy dùng profile_id.`, 'PUBLISH_GROUP_PROFILE_AMBIGUOUS');
  }
  return matches[0];
}

function normalizeFacebookUrl(value, index, targetType) {
  const raw = String(value || '').trim();
  if (!raw) {
    throw errorWithCode(`Thành viên ${index + 1}: ${targetType} cần target_url.`, 'PUBLISH_GROUP_TARGET_REQUIRED');
  }
  let url;
  try { url = new URL(raw); } catch (_) {
    throw errorWithCode(`Thành viên ${index + 1}: target_url không hợp lệ.`, 'PUBLISH_GROUP_TARGET_INVALID');
  }
  if (!/(^|\.)facebook\.com$/i.test(url.hostname)) {
    throw errorWithCode(`Thành viên ${index + 1}: target_url phải thuộc facebook.com.`, 'PUBLISH_GROUP_TARGET_INVALID');
  }
  url.hash = '';
  return url.toString();
}

function normalizeMembers(members, platform) {
  if (!Array.isArray(members) || !members.length) {
    throw errorWithCode('Nhóm đăng cần ít nhất một thành viên.', 'PUBLISH_GROUP_MEMBERS_REQUIRED');
  }
  if (members.length > 500) {
    throw errorWithCode('Một Nhóm đăng tối đa 500 thành viên.', 'PUBLISH_GROUP_MEMBERS_TOO_LARGE');
  }
  const allowed = platform === 'facebook' ? FACEBOOK_TARGETS : OTHER_TARGETS;
  const seen = new Set();
  return members.map((member, index) => {
    const profile = resolveProfile(member, platform, index);
    const fallbackType = platform === 'facebook' ? 'profile' : 'default';
    const targetType = String(member && (member.target_type || member.type) || fallbackType).trim().toLowerCase();
    if (!allowed.has(targetType)) {
      throw errorWithCode(
        `Thành viên ${index + 1}: target_type "${targetType}" không hợp lệ cho ${platform}.`,
        'PUBLISH_GROUP_TARGET_TYPE_INVALID'
      );
    }
    const targetUrl = targetType === 'fanpage' || targetType === 'group'
      ? normalizeFacebookUrl(member.target_url || member.url, index, targetType)
      : '';
    const key = `${Number(profile.id)}|${targetType}|${targetUrl.toLowerCase()}`;
    if (seen.has(key)) {
      throw errorWithCode(`Thành viên ${index + 1} bị trùng trong Nhóm đăng.`, 'PUBLISH_GROUP_MEMBER_DUPLICATE');
    }
    seen.add(key);
    return {
      member_order: index,
      target_type: targetType,
      profile_id: Number(profile.id),
      profile_name: profile.name,
      target_url: targetUrl,
    };
  });
}

function rowToPublic(row) {
  const members = db.prepare(`
    SELECT id, member_order, target_type, profile_id, profile_name, target_url
    FROM publish_group_members
    WHERE publish_group_id = ?
    ORDER BY member_order ASC, id ASC
  `).all(row.id).map(member => ({
    id: Number(member.id),
    order: Number(member.member_order),
    target_type: member.target_type,
    profile_id: Number(member.profile_id),
    profile: member.profile_name,
    target_url: member.target_url || '',
  }));
  return {
    id: Number(row.id),
    group_key: row.group_key,
    name: row.name,
    platform: row.platform,
    member_count: members.length,
    members,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function findRow(identifier, platform = '') {
  init();
  const value = String(identifier || '').trim();
  if (!value) throw errorWithCode('Cần truyền ID, group_key hoặc tên Nhóm đăng.', 'PUBLISH_GROUP_ID_REQUIRED');
  const normalizedPlatform = platform ? requirePlatform(platform) : '';
  let row = null;
  if (/^\d+$/.test(value)) {
    row = db.prepare(`SELECT * FROM publish_groups WHERE id = ?${normalizedPlatform ? ' AND platform = ?' : ''}`)
      .get(...(normalizedPlatform ? [Number(value), normalizedPlatform] : [Number(value)]));
  }
  if (!row) {
    row = db.prepare(`SELECT * FROM publish_groups WHERE group_key = ?${normalizedPlatform ? ' AND platform = ?' : ''}`)
      .get(...(normalizedPlatform ? [value, normalizedPlatform] : [value]));
  }
  if (!row) {
    const rows = db.prepare(`SELECT * FROM publish_groups WHERE name = ? COLLATE NOCASE${normalizedPlatform ? ' AND platform = ?' : ''}`)
      .all(...(normalizedPlatform ? [value, normalizedPlatform] : [value]));
    if (rows.length > 1) {
      throw errorWithCode(`Có nhiều Nhóm đăng tên "${value}"; hãy dùng group_key hoặc thêm platform.`, 'PUBLISH_GROUP_AMBIGUOUS');
    }
    row = rows[0] || null;
  }
  if (!row) throw errorWithCode('Không tìm thấy Nhóm đăng.', 'PUBLISH_GROUP_NOT_FOUND');
  return row;
}

function list({ platform } = {}) {
  init();
  const rows = platform
    ? db.prepare('SELECT * FROM publish_groups WHERE platform = ? ORDER BY name COLLATE NOCASE, id').all(requirePlatform(platform))
    : db.prepare('SELECT * FROM publish_groups ORDER BY platform, name COLLATE NOCASE, id').all();
  return rows.map(rowToPublic);
}

function get(identifier, platform = '') {
  return rowToPublic(findRow(identifier, platform));
}

function insertMembers(groupId, members) {
  const statement = db.prepare(`
    INSERT INTO publish_group_members (
      publish_group_id, member_order, target_type, profile_id, profile_name, target_url
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const member of members) {
    statement.run(
      groupId,
      member.member_order,
      member.target_type,
      member.profile_id,
      member.profile_name,
      member.target_url
    );
  }
}

function create(payload = {}) {
  init();
  const platform = requirePlatform(payload.platform);
  const name = normalizeName(payload.name);
  const groupKey = normalizeGroupKey(payload.group_key || payload.key);
  const members = normalizeMembers(payload.members, platform);
  try {
    const row = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO publish_groups (group_key, name, platform, created_at, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(groupKey, name, platform);
      insertMembers(Number(result.lastInsertRowid), members);
      return db.prepare('SELECT * FROM publish_groups WHERE id = ?').get(result.lastInsertRowid);
    })();
    return rowToPublic(row);
  } catch (error) {
    if (/UNIQUE constraint failed: publish_groups\.group_key/i.test(error.message)) {
      throw errorWithCode(`group_key "${groupKey}" đã tồn tại.`, 'PUBLISH_GROUP_KEY_EXISTS');
    }
    if (/UNIQUE constraint failed: publish_groups\.platform, publish_groups\.name/i.test(error.message)) {
      throw errorWithCode(`Tên Nhóm đăng "${name}" đã tồn tại trên ${platform}.`, 'PUBLISH_GROUP_NAME_EXISTS');
    }
    throw error;
  }
}

function update(identifier, payload = {}) {
  init();
  const current = findRow(identifier, payload.platform || '');
  if (payload.platform && requirePlatform(payload.platform) !== current.platform) {
    throw errorWithCode('Không thể đổi nền tảng của Nhóm đăng; hãy tạo nhóm mới.', 'PUBLISH_GROUP_PLATFORM_IMMUTABLE');
  }
  const name = payload.name === undefined ? current.name : normalizeName(payload.name);
  const members = payload.members === undefined
    ? rowToPublic(current).members.map((member, index) => ({
      member_order: index,
      target_type: member.target_type,
      profile_id: member.profile_id,
      profile_name: member.profile,
      target_url: member.target_url,
    }))
    : normalizeMembers(payload.members, current.platform);
  try {
    db.transaction(() => {
      db.prepare(`UPDATE publish_groups SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(name, current.id);
      if (payload.members !== undefined) {
        db.prepare('DELETE FROM publish_group_members WHERE publish_group_id = ?').run(current.id);
        insertMembers(current.id, members);
      }
    })();
  } catch (error) {
    if (/UNIQUE constraint failed: publish_groups\.platform, publish_groups\.name/i.test(error.message)) {
      throw errorWithCode(`Tên Nhóm đăng "${name}" đã tồn tại trên ${current.platform}.`, 'PUBLISH_GROUP_NAME_EXISTS');
    }
    throw error;
  }
  return get(current.id);
}

function remove(identifier, platform = '') {
  init();
  const current = findRow(identifier, platform);
  db.transaction(() => {
    db.prepare('DELETE FROM publish_group_members WHERE publish_group_id = ?').run(current.id);
    db.prepare('DELETE FROM publish_groups WHERE id = ?').run(current.id);
  })();
  return { deleted: true, id: Number(current.id), group_key: current.group_key, name: current.name, platform: current.platform };
}

module.exports = {
  init,
  list,
  get,
  create,
  update,
  remove,
  _private: { normalizeMembers, findRow },
};
