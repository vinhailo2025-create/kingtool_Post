function sanitizeMediaPath(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/"/g, '');
}

module.exports = { sanitizeMediaPath };
