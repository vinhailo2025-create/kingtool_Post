const CP1252_SPECIAL = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
  [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

function mojibakeScore(value) {
  const matches = String(value || '').match(
    /[\u00c2\u00c3\u00c4\u00c6\u00e2\u00f0\u0192\u20ac\u2122\u0153\u0161\u017e\ufffd]/g
  );
  return matches ? matches.length : 0;
}

function encodeWindows1252(value) {
  const bytes = [];
  for (const char of String(value || '')) {
    const code = char.codePointAt(0);
    if (code <= 0xff) {
      bytes.push(code);
    } else if (CP1252_SPECIAL.has(code)) {
      bytes.push(CP1252_SPECIAL.get(code));
    } else {
      return null;
    }
  }
  return Buffer.from(bytes);
}

function repairMojibake(value) {
  const whole = repairWhole(value);
  if (mojibakeScore(whole) === 0) return whole;
  // Chuoi tron phan da hong voi phan tieng Viet dung (vd. "LÃƒÂ¡Ã‚Â»Ã¢â‚¬â€i bÃƒÆ’Ã‚Â i #1: Không thấy nút").
  // Khoang trang khong bi bien dang qua cac lop ma hoa nen sua tung tu la an toan.
  return whole
    .split(/(\s+)/)
    .map(token => (mojibakeScore(token) > 0 ? repairWhole(token) : token))
    .join('');
}

function repairWhole(value) {
  let current = String(value == null ? '' : value);
  let currentScore = mojibakeScore(current);
  if (currentScore === 0) return current;

  for (let pass = 0; pass < 6; pass += 1) {
    const bytes = encodeWindows1252(current);
    if (!bytes) break;
    const candidate = bytes.toString('utf8');
    if (!candidate || candidate.includes('\ufffd')) break;
    const candidateScore = mojibakeScore(candidate);
    if (candidateScore >= currentScore) break;
    current = candidate;
    currentScore = candidateScore;
    if (currentScore === 0) break;
  }
  return current;
}

module.exports = { repairMojibake, mojibakeScore };
