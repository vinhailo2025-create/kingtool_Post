const fs = require('fs');
const path = require('path');

// Tên file tiếng Việt có dấu hỏng không phải do font, mà do chuỗi đường dẫn khác
// dạng với tên file thật trên ổ đĩa:
//   - Windows lưu tên ở dạng NFC ("ề" là 1 ký tự). Chuỗi copy từ máy Mac, từ web
//     hoặc vài phiên bản Excel lại ở dạng NFD ("e" + dấu rời) -> so tên không khớp,
//     tool báo không tìm thấy file dù mở bằng Explorer vẫn thấy.
//   - Copy từ web/Excel hay dính khoảng trắng không ngắt (U+00A0) hoặc ký tự
//     zero-width nhìn y hệt khoảng trắng thường.
//   - Kéo thả từ Explorer thì đường dẫn bị bọc trong dấu nháy.

const ZERO_WIDTH = /[​-‍﻿]/g;
const NBSP = /[   ]/g;

/** Làm sạch chuỗi đường dẫn trước khi lưu hoặc đem đi tìm file. */
function sanitizeMediaPath(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  text = text.replace(ZERO_WIDTH, '');
  text = text.replace(NBSP, ' ');
  text = text.replace(/["']/g, '');
  text = text.trim();
  if (!text) return '';
  // Đưa về dạng Windows dùng để lưu tên file
  try {
    text = text.normalize('NFC');
  } catch {
    /* chuỗi lạ thì giữ nguyên */
  }
  return text;
}

/** Các biến thể đáng thử của cùng một đường dẫn. */
function pathVariants(value) {
  const cleaned = sanitizeMediaPath(value);
  if (!cleaned) return [];
  const variants = [cleaned];
  for (const form of ['NFD', 'NFKC', 'NFKD']) {
    try {
      const alt = cleaned.normalize(form);
      if (!variants.includes(alt)) variants.push(alt);
    } catch {
      /* bỏ qua dạng không hỗ trợ */
    }
  }
  const raw = String(value || '').trim().replace(/["']/g, '');
  if (raw && !variants.includes(raw)) variants.push(raw);
  return variants;
}

/**
 * Tìm đường dẫn thật sự tồn tại trên ổ đĩa, trả về '' nếu không có.
 * Thử lần lượt các dạng chuẩn hoá; nếu vẫn trượt thì dò trong thư mục cha
 * và so tên đã chuẩn hoá — cách này bắt được mọi biến thể dấu tiếng Việt.
 */
function resolveMediaPath(value) {
  const variants = pathVariants(value);
  if (!variants.length) return '';

  for (const variant of variants) {
    try {
      const resolved = path.resolve(variant);
      if (fs.existsSync(resolved)) return resolved;
    } catch {
      /* đường dẫn không hợp lệ thì thử dạng tiếp theo */
    }
  }

  // Dò trong thư mục cha: so tên file sau khi bỏ khác biệt về dạng chuẩn hoá
  try {
    const target = path.resolve(variants[0]);
    const folder = path.dirname(target);
    if (!fs.existsSync(folder)) return '';
    const wanted = path.basename(target).normalize('NFC').toLowerCase();
    for (const entry of fs.readdirSync(folder)) {
      if (entry.normalize('NFC').toLowerCase() === wanted) {
        return path.join(folder, entry);
      }
    }
  } catch {
    /* không đọc được thư mục thì coi như không tìm thấy */
  }

  return '';
}

/** Đúng/sai file có tồn tại, chấp nhận mọi biến thể dấu. */
function mediaPathExists(value) {
  return Boolean(resolveMediaPath(value));
}

module.exports = { sanitizeMediaPath, resolveMediaPath, mediaPathExists, pathVariants };
