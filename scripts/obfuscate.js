/**
 * Obfuscate các file license trọng yếu để chống patch/bypass khi phát hành.
 * - Đọc từ source, ghi bản rối vào release/<đường-dẫn-tương-đối>.
 * - Khi phát hành: copy đè các file trong release/ vào dist/desktop_launcher.dist/.
 *
 * Chạy: node scripts/obfuscate.js
 */
const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'release');
const EXCLUDED_SOURCE_DIRS = new Set([
  path.normalize(path.join('src', 'backups')),
  path.normalize(path.join('src', 'chrome-profiles')),
]);

function collectJavaScriptFiles(relativeDir) {
  if (EXCLUDED_SOURCE_DIRS.has(path.normalize(relativeDir))) return [];
  const absoluteDir = path.join(ROOT, relativeDir);
  if (!fs.existsSync(absoluteDir)) return [];
  return fs.readdirSync(absoluteDir, { withFileTypes: true }).flatMap(entry => {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) return collectJavaScriptFiles(relativePath);
    return entry.isFile() && entry.name.endsWith('.js') ? [relativePath] : [];
  });
}

// Bảo vệ toàn bộ JavaScript do dự án viết trước khi giao cho khách.
const FILES = [
  'server.js',
  'config.js',
  'scripts/super-post-mcp-server.js',
  ...collectJavaScriptFiles('src'),
  ...collectJavaScriptFiles(path.join('public', 'js')),
];

// Cấu hình chung — đủ mạnh nhưng không phá logic/require
const baseOptions = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.6,
  deadCodeInjection: false,
  identifierNamesGenerator: 'hexadecimal',
  numbersToExpressions: true,
  simplify: true,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
};

function obfuscateFile(rel) {
  const src = path.join(ROOT, rel);
  const code = fs.readFileSync(src, 'utf8');
  const isBrowser = rel.replace(/\\/g, '/').startsWith('public/');
  const options = {
    ...baseOptions,
    // Bản chạy trên trình duyệt: bật tự vệ chống chỉnh sửa
    selfDefending: isBrowser,
    target: isBrowser ? 'browser' : 'node',
  };
  const result = JavaScriptObfuscator.obfuscate(code, options).getObfuscatedCode();
  const dest = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, result);
  const kb = (Buffer.byteLength(result) / 1024).toFixed(1);
  console.log(`  ✓ ${rel}  →  release/${rel}  (${kb} KB)`);
}

for (const target of [
  path.join(OUT, 'src'),
  path.join(OUT, 'public', 'js'),
  path.join(OUT, 'scripts'),
  path.join(OUT, 'server.js'),
  path.join(OUT, 'config.js'),
]) {
  fs.rmSync(target, { recursive: true, force: true });
}

console.log('Obfuscating production JavaScript...');
for (const f of FILES) obfuscateFile(f);
// public.pem cũng cần đi kèm bản release
const pem = 'src/license/public.pem';
fs.mkdirSync(path.join(OUT, 'src/license'), { recursive: true });
fs.copyFileSync(path.join(ROOT, pem), path.join(OUT, pem));
console.log(`  ✓ ${pem} (copy)`);
console.log('Xong. Copy đè thư mục release/ vào dist/desktop_launcher.dist/ khi phát hành.');
