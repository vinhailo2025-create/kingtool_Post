const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 6 * 60 * 1000;
let commandRunner = null;

function candidateExecutables() {
  const values = [];
  if (process.env.CODEX_EXECUTABLE) values.push(process.env.CODEX_EXECUTABLE);

  if (process.platform === 'win32' && process.env.APPDATA) {
    values.push(path.join(
      process.env.APPDATA,
      'npm',
      'node_modules',
      '@openai',
      'codex',
      'node_modules',
      '@openai',
      'codex-win32-x64',
      'vendor',
      'x86_64-pc-windows-msvc',
      'bin',
      'codex.exe'
    ));
    values.push(path.join(process.env.APPDATA, 'npm', 'codex.cmd'));
  }

  values.push(process.platform === 'win32' ? 'codex.cmd' : 'codex');
  return [...new Set(values.filter(Boolean))];
}

function executablesOnPath() {
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(command, ['codex'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  if (result.status !== 0) return [];
  const paths = String(result.stdout || '')
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean);
  if (process.platform !== 'win32') return paths;
  return paths
    .filter(value => /\.(?:exe|cmd)$/i.test(value))
    .sort((left, right) => Number(/\.cmd$/i.test(left)) - Number(/\.cmd$/i.test(right)));
}

function normalizePreferredExecutable(preferred) {
  const value = String(preferred || '').trim().replace(/^["']|["']$/g, '');
  if (!value) return '';
  try {
    if (fs.existsSync(value) && fs.statSync(value).isDirectory()) {
      const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex'];
      for (const name of names) {
        const candidate = path.join(value, name);
        if (fs.existsSync(candidate)) return candidate;
      }
      return '';
    }
  } catch (_) {
    return '';
  }
  return value;
}

function resolveExecutable(preferred = '') {
  const requested = normalizePreferredExecutable(preferred);
  if (requested) {
    if (!path.isAbsolute(requested) || fs.existsSync(requested)) return requested;
    return '';
  }
  for (const candidate of executablesOnPath()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const candidate of candidateExecutables()) {
    if (!path.isAbsolute(candidate) || fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function runProcess(executable, args, input = '', options = {}) {
  return new Promise((resolve, reject) => {
    const isCmd = process.platform === 'win32' && /\.cmd$/i.test(executable);
    const command = isCmd ? (process.env.ComSpec || 'cmd.exe') : executable;
    const commandArgs = isCmd
      ? ['/d', '/s', '/c', `call "${executable}" ${args.map(arg => `"${String(arg).replace(/"/g, '""')}"`).join(' ')}`]
      : args;
    const child = spawn(command, commandArgs, {
      cwd: options.cwd || process.cwd(),
      windowsHide: true,
      shell: false,
      windowsVerbatimArguments: isCmd,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`ChatGPT quá thời gian chờ ${Math.ceil(timeoutMs / 1000)} giây.`));
    }, timeoutMs);

    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });

    if (input) child.stdin.write(input, 'utf8');
    child.stdin.end();
  });
}

async function run(args, input = '', options = {}) {
  if (commandRunner) return commandRunner(args, input, options);
  const executable = resolveExecutable(options.executable);
  if (!executable) {
    throw new Error('Không tìm thấy Codex CLI. Hãy kiểm tra đường dẫn Codex trong Cài đặt.');
  }
  return runProcess(executable, args, input, options);
}

function commandError(result, fallback) {
  const detail = String(result.stderr || result.stdout || '').replace(/\s+/g, ' ').trim();
  if (/workspace is out of credits|out of credits|usage limit/i.test(detail)) {
    return new Error(
      'Tài khoản ChatGPT/Codex đã hết credit hoặc đã chạm giới hạn sử dụng. '
      + 'Hãy bổ sung credit/chờ hạn mức được làm mới rồi thử lại.'
    );
  }
  if (/image_gen.*(?:isn.t|is not|unavailable)|built-in image.*(?:unavailable|not available)/i.test(detail)) {
    return new Error(
      'Phiên Codex hiện tại không có công cụ tạo ảnh. '
      + 'Hãy dùng tài khoản ChatGPT có hỗ trợ tạo ảnh hoặc cấu hình API tạo ảnh riêng.'
    );
  }
  if (/not logged in|login required|unauthorized|authentication required/i.test(detail)) {
    return new Error('Codex CLI chưa đăng nhập ChatGPT hoặc phiên đăng nhập đã hết hạn. Hãy chạy codex login.');
  }
  return new Error(detail ? `${fallback}: ${detail.slice(0, 1500)}` : fallback);
}

async function getStatus(options = {}) {
  let version = '';
  try {
    const versionResult = await run(['--version'], '', { ...options, timeoutMs: 15000 });
    version = versionResult.code === 0 ? versionResult.stdout : '';
  } catch (error) {
    return {
      ready: false,
      installed: false,
      authMode: '',
      version: '',
      message: error.message,
    };
  }

  const loginResult = await run(['login', 'status'], '', { ...options, timeoutMs: 20000 });
  const output = `${loginResult.stdout}\n${loginResult.stderr}`.trim();
  const chatGptAuth = loginResult.code === 0 && /logged in using chatgpt/i.test(output);
  const apiKeyAuth = loginResult.code === 0 && /api key/i.test(output);
  return {
    ready: chatGptAuth,
    installed: true,
    authMode: chatGptAuth ? 'chatgpt' : (apiKeyAuth ? 'api-key' : ''),
    version,
    message: chatGptAuth
      ? 'Đã đăng nhập bằng ChatGPT.'
      : 'Codex CLI chưa đăng nhập bằng ChatGPT. Hãy chạy codex login.',
  };
}

async function requireChatGptLogin(options = {}) {
  const status = await getStatus(options);
  if (!status.ready) throw new Error(status.message);
  return status;
}

function configDirectory() {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}

async function detectInstallation(preferred = '') {
  const executable = resolveExecutable(preferred);
  const codexHome = configDirectory();
  if (!executable) {
    return {
      found: false,
      executable: '',
      codexHome,
      authExists: fs.existsSync(path.join(codexHome, 'auth.json')),
      ready: false,
      message: 'Không tìm thấy Codex CLI trong PATH hoặc đường dẫn đã nhập.',
    };
  }
  const status = await getStatus({ executable });
  return {
    found: true,
    executable: path.isAbsolute(executable) ? path.resolve(executable) : executable,
    codexHome,
    authExists: fs.existsSync(path.join(codexHome, 'auth.json')),
    ...status,
  };
}

function openConfigDirectory() {
  const codexHome = configDirectory();
  if (!fs.existsSync(codexHome)) {
    throw new Error(`Chưa có thư mục ${codexHome}. Hãy chạy codex login trước.`);
  }
  let command;
  let args;
  if (process.platform === 'win32') {
    command = 'explorer.exe';
    args = [codexHome];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [codexHome];
  } else {
    command = 'xdg-open';
    args = [codexHome];
  }
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  return { codexHome };
}

function execArgs(cwd, sandbox, referencePaths = []) {
  const args = [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox',
    sandbox,
    '--cd',
    cwd,
  ];
  for (const referencePath of referencePaths) {
    args.push('--image', referencePath);
  }
  args.push('-');
  return args;
}

async function generateText(prompt, options = {}) {
  const cwd = options.cwd || process.cwd();
  const result = await run(execArgs(cwd, 'read-only'), String(prompt || ''), {
    cwd,
    executable: options.executable,
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
  });
  if (result.code !== 0) throw commandError(result, 'ChatGPT không tạo được nội dung');
  if (!result.stdout) throw new Error('ChatGPT không trả về nội dung.');
  return result.stdout.trim();
}

async function generateImage(prompt, outputPath, options = {}) {
  const target = path.resolve(outputPath);
  const cwd = path.resolve(options.cwd || path.dirname(target));
  const referencePaths = (options.referencePaths || [])
    .map(referencePath => String(referencePath || '').trim())
    .filter(Boolean)
    .map(referencePath => path.resolve(referencePath));
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const fullPrompt = [
    '$imagegen',
    referencePaths.length
      ? 'Image 1: ảnh tham chiếu lấy từ cột Media hiện tại. Hãy dùng ảnh này làm tham chiếu và tạo một ảnh mới theo prompt bên dưới; không chỉnh sửa hoặc ghi đè file tham chiếu.'
      : '',
    String(prompt || '').trim(),
    'Tạo đúng một ảnh PNG.',
    `Lưu ảnh cuối cùng vào đúng đường dẫn: ${target}`,
    'Không chỉ trả lời hướng dẫn. Sau khi tạo xong, hãy bảo đảm file tồn tại tại đường dẫn trên.',
  ].filter(Boolean).join('\n');

  const result = await run(execArgs(cwd, 'workspace-write', referencePaths), fullPrompt, {
    cwd,
    executable: options.executable,
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
  });
  if (result.code !== 0) throw commandError(result, 'ChatGPT không tạo được ảnh');

  let stats;
  try {
    stats = fs.statSync(target);
  } catch (_) {
    throw new Error('ChatGPT đã chạy xong nhưng không tìm thấy file ảnh được tạo.');
  }
  if (!stats.isFile() || stats.size < 1024) {
    throw new Error('File ảnh ChatGPT tạo ra không hợp lệ hoặc quá nhỏ.');
  }
  const handle = fs.openSync(target, 'r');
  const signature = Buffer.alloc(8);
  try {
    fs.readSync(handle, signature, 0, signature.length, 0);
  } finally {
    fs.closeSync(handle);
  }
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!signature.equals(pngSignature)) {
    throw new Error('File ChatGPT tạo ra không phải ảnh PNG hợp lệ.');
  }
  return { outputPath: target, size: stats.size, message: result.stdout };
}

module.exports = {
  getStatus,
  requireChatGptLogin,
  detectInstallation,
  configDirectory,
  openConfigDirectory,
  generateText,
  generateImage,
  _private: {
    candidateExecutables,
    executablesOnPath,
    normalizePreferredExecutable,
    resolveExecutable,
    runProcess,
    commandError,
    execArgs,
    setCommandRunner(value) {
      commandRunner = value || null;
    },
  },
};
