const crypto = require('crypto');
const db = require('../database/init');
const PublishGroups = require('./publish-group.service');

let initialized = false;

function errorWithCode(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function init() {
  if (initialized) return;
  PublishGroups.init();
  db.exec(`
    CREATE TABLE IF NOT EXISTS publish_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS publish_campaign_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      publish_campaign_id INTEGER NOT NULL,
      publish_group_id INTEGER NOT NULL,
      group_order INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(publish_campaign_id, publish_group_id),
      FOREIGN KEY (publish_campaign_id) REFERENCES publish_campaigns(id) ON DELETE CASCADE,
      FOREIGN KEY (publish_group_id) REFERENCES publish_groups(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_publish_campaign_groups_campaign
      ON publish_campaign_groups(publish_campaign_id, group_order, id);
  `);
  initialized = true;
}

function normalizeName(value) {
  const name = String(value || '').trim();
  if (!name) throw errorWithCode('Chiến dịch đăng cần có tên.', 'PUBLISH_CAMPAIGN_NAME_REQUIRED');
  if (name.length > 120) throw errorWithCode('Tên Chiến dịch đăng tối đa 120 ký tự.', 'PUBLISH_CAMPAIGN_NAME_INVALID');
  return name;
}

function normalizeCampaignKey(value) {
  const key = String(value || '').trim() || `publish-campaign-${crypto.randomUUID()}`;
  if (key.length > 128 || !/^[a-zA-Z0-9._:-]+$/.test(key)) {
    throw errorWithCode(
      'campaign_key chỉ gồm chữ, số, dấu chấm, gạch dưới, gạch ngang hoặc dấu hai chấm; tối đa 128 ký tự.',
      'PUBLISH_CAMPAIGN_KEY_INVALID'
    );
  }
  return key;
}

function normalizeGroups(groups) {
  if (!Array.isArray(groups) || !groups.length) {
    throw errorWithCode('Chiến dịch đăng cần ít nhất một Nhóm đăng.', 'PUBLISH_CAMPAIGN_GROUPS_REQUIRED');
  }
  if (groups.length > 100) {
    throw errorWithCode('Một Chiến dịch đăng tối đa 100 Nhóm đăng.', 'PUBLISH_CAMPAIGN_GROUPS_TOO_LARGE');
  }
  const seen = new Set();
  return groups.map((entry, index) => {
    const identifier = typeof entry === 'object' && entry !== null
      ? (entry.identifier ?? entry.group_key ?? entry.id ?? entry.name)
      : entry;
    const platform = typeof entry === 'object' && entry !== null ? (entry.platform || '') : '';
    if (identifier === undefined || identifier === null || String(identifier).trim() === '') {
      throw errorWithCode(`Nhóm đăng ${index + 1}: cần identifier.`, 'PUBLISH_CAMPAIGN_GROUP_ID_REQUIRED');
    }
    const group = PublishGroups.get(identifier, platform);
    if (seen.has(group.id)) {
      throw errorWithCode(`Nhóm đăng ${index + 1} bị trùng trong Chiến dịch đăng.`, 'PUBLISH_CAMPAIGN_GROUP_DUPLICATE');
    }
    seen.add(group.id);
    return { group_order: index, publish_group_id: group.id };
  });
}

function findRow(identifier) {
  init();
  const value = String(identifier || '').trim();
  if (!value) throw errorWithCode('Cần truyền ID, campaign_key hoặc tên Chiến dịch đăng.', 'PUBLISH_CAMPAIGN_ID_REQUIRED');
  let row = null;
  if (/^\d+$/.test(value)) row = db.prepare('SELECT * FROM publish_campaigns WHERE id = ?').get(Number(value));
  if (!row) row = db.prepare('SELECT * FROM publish_campaigns WHERE campaign_key = ?').get(value);
  if (!row) row = db.prepare('SELECT * FROM publish_campaigns WHERE name = ? COLLATE NOCASE').get(value);
  if (!row) throw errorWithCode('Không tìm thấy Chiến dịch đăng.', 'PUBLISH_CAMPAIGN_NOT_FOUND');
  return row;
}

function rowToPublic(row) {
  const groups = db.prepare(`
    SELECT pg.id, pg.group_key, pg.name, pg.platform, pcg.group_order
    FROM publish_campaign_groups pcg
    JOIN publish_groups pg ON pg.id = pcg.publish_group_id
    WHERE pcg.publish_campaign_id = ?
    ORDER BY pcg.group_order ASC, pcg.id ASC
  `).all(row.id).map(item => ({
    id: Number(item.id),
    order: Number(item.group_order),
    group_key: item.group_key,
    name: item.name,
    platform: item.platform,
  }));
  return {
    id: Number(row.id),
    campaign_key: row.campaign_key,
    name: row.name,
    group_count: groups.length,
    platforms: [...new Set(groups.map(group => group.platform))],
    publish_groups: groups,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function list() {
  init();
  return db.prepare('SELECT * FROM publish_campaigns ORDER BY name COLLATE NOCASE, id').all().map(rowToPublic);
}

function get(identifier) {
  return rowToPublic(findRow(identifier));
}

function insertGroups(campaignId, groups) {
  const statement = db.prepare(`
    INSERT INTO publish_campaign_groups (publish_campaign_id, publish_group_id, group_order)
    VALUES (?, ?, ?)
  `);
  for (const group of groups) statement.run(campaignId, group.publish_group_id, group.group_order);
}

function create(payload = {}) {
  init();
  const name = normalizeName(payload.name);
  const campaignKey = normalizeCampaignKey(payload.campaign_key || payload.key);
  const groups = normalizeGroups(payload.publish_groups || payload.groups);
  try {
    const id = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO publish_campaigns (campaign_key, name, created_at, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(campaignKey, name);
      insertGroups(Number(result.lastInsertRowid), groups);
      return Number(result.lastInsertRowid);
    })();
    return get(id);
  } catch (error) {
    if (/publish_campaigns\.campaign_key/i.test(error.message)) {
      throw errorWithCode(`campaign_key "${campaignKey}" đã tồn tại.`, 'PUBLISH_CAMPAIGN_KEY_EXISTS');
    }
    if (/publish_campaigns\.name/i.test(error.message)) {
      throw errorWithCode(`Tên Chiến dịch đăng "${name}" đã tồn tại.`, 'PUBLISH_CAMPAIGN_NAME_EXISTS');
    }
    throw error;
  }
}

function update(identifier, payload = {}) {
  init();
  const current = findRow(identifier);
  const name = payload.name === undefined ? current.name : normalizeName(payload.name);
  const groups = payload.publish_groups === undefined && payload.groups === undefined
    ? null
    : normalizeGroups(payload.publish_groups || payload.groups);
  try {
    db.transaction(() => {
      db.prepare('UPDATE publish_campaigns SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(name, current.id);
      if (groups) {
        db.prepare('DELETE FROM publish_campaign_groups WHERE publish_campaign_id = ?').run(current.id);
        insertGroups(current.id, groups);
      }
    })();
  } catch (error) {
    if (/publish_campaigns\.name/i.test(error.message)) {
      throw errorWithCode(`Tên Chiến dịch đăng "${name}" đã tồn tại.`, 'PUBLISH_CAMPAIGN_NAME_EXISTS');
    }
    throw error;
  }
  return get(current.id);
}

function remove(identifier) {
  init();
  const current = findRow(identifier);
  db.transaction(() => {
    db.prepare('DELETE FROM publish_campaign_groups WHERE publish_campaign_id = ?').run(current.id);
    db.prepare('DELETE FROM publish_campaigns WHERE id = ?').run(current.id);
  })();
  return { deleted: true, id: Number(current.id), campaign_key: current.campaign_key, name: current.name };
}

module.exports = { init, list, get, create, update, remove, _private: { findRow, normalizeGroups } };
