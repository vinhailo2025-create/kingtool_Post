/**
 * Cau hinh binh luan dung chung cho runner (dang bai + binh luan) va core
 * scheduleCommentOnLink. Tach ra file rieng de tranh vong phu thuoc:
 * runner.service require comment-job.service, nen comment-job khong duoc
 * require nguoc lai runner.service.
 */

const db = require('../database/init');
const { normalizePlatform } = require('../platforms/platform.utils');

// Doc cau hinh tu dong binh luan sau khi dang bai (tu bang settings)
function getCommentSettings(platform = 'facebook') {
  try {
    const normalized = normalizePlatform(platform);
    const prefix = normalized === 'facebook' ? '' : `${normalized}_`;
    const rows = db.prepare(
      'SELECT key, value FROM settings WHERE key IN (?, ?, ?, ?, ?, ?)'
    ).all(
      `${prefix}auto_comment_enabled`,
      `${prefix}comment_delay_unit`,
      `${prefix}comment_delay_min`,
      `${prefix}comment_delay_max`,
      `${prefix}comment_intervals`,
      `${prefix}comment_continue_on_error`
    );
    const m = {};
    for (const r of rows) m[r.key.replace(prefix, '')] = r.value;
    let intervals = {};
    try { intervals = m.comment_intervals ? JSON.parse(m.comment_intervals) : {}; } catch (_) {}
    return {
      enabled: m.auto_comment_enabled === '1',
      unit: m.comment_delay_unit === 'min' ? 'min' : 'sec',
      min: parseFloat(m.comment_delay_min) || 0,
      max: parseFloat(m.comment_delay_max) || 0,
      intervals,
      continueOnError: m.comment_continue_on_error !== '0',
    };
  } catch (e) {
    return {
      enabled: false,
      unit: 'sec',
      min: 0,
      max: 0,
      intervals: {},
      continueOnError: true,
    };
  }
}

function randomDelayMs(range, fallback = { min: 60, max: 120, unit: 'sec' }) {
  const source = range && typeof range === 'object' ? range : fallback;
  const unitMs = source.unit === 'min' ? 60000 : 1000;
  const min = Math.max(0, Number(source.min) || 0) * unitMs;
  const max = Math.max(min, Math.max(0, Number(source.max) || 0) * unitMs);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

module.exports = { getCommentSettings, randomDelayMs };
