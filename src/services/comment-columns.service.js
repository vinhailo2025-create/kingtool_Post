const COMMENT_FIELDS = Object.freeze([
  { base: 'comment', label: 'Bình luận', colType: 'text' },
  { base: 'comment_media', label: 'Media bình luận', colType: 'file' },
  { base: 'time_comment', label: 'Thời gian bình luận', colType: 'text' },
  { base: 'comment_status', label: 'Trạng thái bình luận', colType: 'text' },
]);

function normalizeSequence(sequence) {
  const value = Math.floor(Number(sequence) || 1);
  return Math.max(1, value);
}

function varKey(base, sequence = 1) {
  const normalized = normalizeSequence(sequence);
  return normalized === 1 ? base : `${base}_${normalized}`;
}

function label(base, sequence = 1) {
  const definition = COMMENT_FIELDS.find(field => field.base === base);
  const prefix = definition ? definition.label : base;
  return `${prefix} ${normalizeSequence(sequence)}`;
}

function parseVarKey(value) {
  const key = String(value || '').trim().toLowerCase();
  for (const field of COMMENT_FIELDS) {
    if (key === field.base) return { base: field.base, sequence: 1 };
    const match = key.match(new RegExp(`^${field.base}_(\\d+)$`));
    if (match && Number(match[1]) >= 2) {
      return { base: field.base, sequence: Number(match[1]) };
    }
  }
  return null;
}

function sequencesFromColumns(columns) {
  const sequences = new Set();
  for (const column of columns || []) {
    const parsed = parseVarKey(column && column.var_key);
    if (parsed) sequences.add(parsed.sequence);
  }
  return [...sequences].sort((a, b) => a - b);
}

function definitions(sequence = 1) {
  return COMMENT_FIELDS.map(field => ({
    ...field,
    sequence: normalizeSequence(sequence),
    varKey: varKey(field.base, sequence),
    name: label(field.base, sequence),
  }));
}

function sequenceFromHeader(header) {
  const normalized = String(header || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd');

  const direct = parseVarKey(normalized.replace(/\s+/g, '_'));
  if (direct) return direct.sequence;

  // Tiêu đề không có số (ví dụ "Nội dung bình luận") là nhóm 1.
  const match = normalized.match(
    /^(?:noi dung )?binh luan(?:(?:\s+|_)(\d+))?$|^media binh luan(?:(?:\s+|_)(\d+))?$|^thoi gian binh luan(?:(?:\s+|_)(\d+))?$|^trang thai binh luan(?:(?:\s+|_)(\d+))?$/
  );
  if (!match) return null;
  const sequence = Number(match[1] || match[2] || match[3] || match[4] || 1);
  return sequence >= 1 ? sequence : null;
}

module.exports = {
  COMMENT_FIELDS,
  normalizeSequence,
  varKey,
  label,
  parseVarKey,
  sequencesFromColumns,
  definitions,
  sequenceFromHeader,
};
