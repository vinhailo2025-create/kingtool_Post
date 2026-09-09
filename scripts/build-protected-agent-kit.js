'use strict';

const fs = require('fs');
const path = require('path');
const bytenode = require('bytenode');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'packaging', 'super-post-agent-kit-marketplace');
const OUTPUT = path.join(ROOT, 'release', 'agent-kit');
const PLUGIN = path.join(OUTPUT, 'plugins', 'super-post-agent-kit');
const MCP_SOURCE = path.join(
  SOURCE,
  'plugins',
  'super-post-agent-kit',
  'mcp',
  'super-post-mcp-server.js'
);

const mapperSkill = `---
name: super-post-profile-mapper
description: Quản lý profile, đích đăng, dữ liệu Đợi, Nhóm đăng và Chiến dịch trong Super Post King qua MCP.
---

# Profile và dữ liệu Super Post King

- Chỉ dùng các MCP tool \`super_post_*\`; không thao tác trực tiếp database hay API.
- Đọc profile, target, schema và dữ liệu hiện có trước khi tạo hoặc sửa mapping.
- Dùng \`super_post_create_data\` hoặc \`super_post_create_data_batch\` để thêm hàng \`pending\`; mỗi hàng phải có \`data_key\` ổn định.
- Việc thêm hàng Đợi không đồng nghĩa với đăng. Chỉ publish hoặc tạo lịch khi người dùng yêu cầu rõ.
- Ưu tiên ID chính xác. Nếu tên trùng hoặc mapping chưa rõ, yêu cầu người dùng xác nhận.
- Không cho lịch \`all_pending\` lấy hàng mới nếu chưa có xác nhận rõ.
- Sau thao tác ghi, đọc lại kết quả và trả về ID, trạng thái cùng lỗi của từng mục.
`;

const publishSkill = `---
name: post-face-super-post
description: Đăng, hẹn giờ và theo dõi bài đã được mapping trong Super Post King qua MCP.
---

# Đăng qua Super Post King

- Chỉ dùng các MCP tool \`super_post_*\`; không thay bằng tự động hóa trình duyệt.
- Chỉ đăng, chạy lại, hủy hoặc tạo lịch khi người dùng đã yêu cầu rõ hành động đó.
- Đọc runtime config và xác minh profile/target trước khi gửi job.
- Với hàng Đợi đã có \`post_id\`, dùng publish-data để đăng đúng hàng; không tạo bản sao.
- Giữ khóa chống trùng ổn định khi gửi lại cùng một yêu cầu.
- Theo dõi job hoặc batch đến trạng thái kết thúc; không đăng lại mục đã thành công.
- Trả về trạng thái và link của từng bài. Nêu rõ mục lỗi, chờ duyệt hoặc chưa lấy được link.
`;

const pluginReadme = `# Super Post Agent Kit

Agent Kit kết nối Codex, Claude và OpenClaw với Super Post King qua MCP cục bộ.

Mở Super Post King, vào **Cài đặt > Agent & MCP**, rồi chọn **Cài kết nối AI**.
Agent sẽ nhận danh sách tool và schema trực tiếp từ MCP khi bắt đầu phiên mới.

Phần thực thi được phân phối dưới dạng V8 bytecode và phải dùng Node.js đi kèm
đúng phiên bản Super Post King. Không sửa, đổi tên hoặc chạy riêng các file trong
thư mục \`mcp\` và \`runtime\`.
`;

const installReadme = `# Cài Super Post Agent Kit

1. Cài và mở Super Post King.
2. Vào **Cài đặt > Agent & MCP**.
3. Chọn **Cài kết nối AI**.
4. Mở phiên Codex, Claude hoặc OpenClaw mới.

Gói này không chứa dữ liệu đăng nhập, database hoặc API key của khách hàng.
`;

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function removeIfPresent(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function buildProtectedAgentKit() {
  removeIfPresent(OUTPUT);
  fs.cpSync(SOURCE, OUTPUT, { recursive: true });

  const mcpDir = path.join(PLUGIN, 'mcp');
  const bytecodePath = path.join(mcpDir, 'super-post-mcp-server.jsc');
  bytenode.compileFile({
    filename: MCP_SOURCE,
    output: bytecodePath,
    compileAsModule: true,
  });
  removeIfPresent(path.join(mcpDir, 'super-post-mcp-server.js'));

  const runtimeDir = path.join(PLUGIN, 'runtime', 'bytenode');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, 'node_modules', 'bytenode', 'lib', 'index.js'),
    path.join(runtimeDir, 'index.js')
  );
  fs.copyFileSync(
    path.join(ROOT, 'node_modules', 'bytenode', 'LICENSE'),
    path.join(runtimeDir, 'LICENSE')
  );

  const mapperRoot = path.join(PLUGIN, 'skills', 'super-post-profile-mapper');
  const publishRoot = path.join(PLUGIN, 'skills', 'post-face-super-post');
  removeIfPresent(path.join(mapperRoot, 'references'));
  removeIfPresent(path.join(publishRoot, 'references'));
  writeText(path.join(mapperRoot, 'SKILL.md'), mapperSkill);
  writeText(path.join(publishRoot, 'SKILL.md'), publishSkill);
  writeText(path.join(PLUGIN, 'README.md'), pluginReadme);
  writeText(path.join(OUTPUT, 'INSTALL.md'), installReadme);

  const exposedSource = fs.readdirSync(mcpDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(?:js|mjs|cjs)$/i.test(entry.name))
    .map(entry => entry.name);
  if (exposedSource.length) {
    throw new Error(`Protected Agent Kit still contains MCP source: ${exposedSource.join(', ')}`);
  }
  if (!fs.existsSync(bytecodePath)) throw new Error('MCP bytecode was not created.');

  console.log(`Protected Agent Kit: ${path.relative(ROOT, OUTPUT)}`);
  console.log(`MCP bytecode: ${path.relative(ROOT, bytecodePath)}`);
}

buildProtectedAgentKit();
