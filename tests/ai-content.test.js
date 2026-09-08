const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const db = require('../src/database/init');
const DataService = require('../src/services/data.service');
const AiContentService = require('../src/services/ai-content.service');
const ChatGptLocalService = require('../src/services/chatgpt-local.service');
const config = require('../config');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'super-post-ai-service-'));
const secretsPath = path.join(tempRoot, 'ai-secrets.enc');
const keyPath = path.join(tempRoot, 'ai-secrets.key');
const createdPosts = [];
let originalAiSettings = [];
const originalGeneratedImagesDir = config.AI_GENERATED_IMAGES_DIR;

async function waitForImageJob(jobId, timeoutMs = 5000) {
  let job = AiContentService.getImageJob(jobId);
  const deadline = Date.now() + timeoutMs;
  while (!['completed', 'partial', 'failed'].includes(job.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
    job = AiContentService.getImageJob(jobId);
  }
  return job;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test.before(async () => {
  await db.waitReady();
  originalAiSettings = db.prepare("SELECT key, value FROM settings WHERE key LIKE '%ai_%'").all();
  AiContentService._private.setSecretsPaths(secretsPath, keyPath);
});

test.after(() => {
  try {
    if (createdPosts.length) DataService.deleteMany(createdPosts, 'threads');
    db.exec("DELETE FROM settings WHERE key LIKE '%ai_%'");
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    const restore = db.transaction(rows => rows.forEach(row => stmt.run(row.key, row.value)));
    restore(originalAiSettings);
  } catch (_) {}
  AiContentService._private.setFetchImpl(null);
  AiContentService._private.setSecretsPaths();
  ChatGptLocalService._private.setCommandRunner(null);
  config.AI_GENERATED_IMAGES_DIR = originalGeneratedImagesDir;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('AI settings encrypt API keys and only return masked metadata', () => {
  const saved = AiContentService.saveSettings({
    providers: {
      gemini: { apiKey: 'gemini-secret-1234', model: 'gemini-test' },
      openai: { apiKey: 'openai-secret-5678', model: 'openai-test' },
      '9router': {
        apiKey: 'router-secret-9012',
        model: 'router/test-model',
        baseUrl: 'http://127.0.0.1:20128/v1/',
      },
      kira: {
        apiKey: 'kira-secret-3456',
        model: 'kira-3.5-flash',
        imageModel: 'kira-3.0-image',
        aspectRatio: '16:9',
      },
      chatgpt: { cliPath: 'D:\\Tools\\codex.exe' },
    },
  }, 'facebook');

  assert.equal(saved.providers.gemini.hasApiKey, true);
  assert.equal(saved.providers.gemini.apiKeyHint, '1234');
  assert.equal(saved.providers.openai.apiKeyHint, '5678');
  assert.equal(saved.providers['9router'].baseUrl, 'http://127.0.0.1:20128/v1');
  assert.equal(saved.providers.kira.imageModel, 'kira-3.0-image');
  assert.equal(saved.providers.kira.aspectRatio, '16:9');
  assert.equal(saved.providers.kira.apiKeyHint, '3456');
  assert.equal(saved.providers.chatgpt.cliPath, 'D:\\Tools\\codex.exe');
  assert.equal(JSON.stringify(saved).includes('gemini-secret-1234'), false);
  assert.equal(fs.readFileSync(secretsPath, 'utf8').includes('router-secret-9012'), false);
});

test('connection checks validate the configured model without generating content', async () => {
  let calledUrl = '';
  AiContentService._private.setFetchImpl(async (url, options = {}) => {
    calledUrl = String(url);
    return jsonResponse({ data: [{ id: 'router/test-model' }] });
  });
  const result = await AiContentService.testConnection('9router');
  assert.match(calledUrl, /\/v1\/models$/);
  assert.equal(result.model, 'router/test-model');
  assert.equal(result.modelCount, 1);

  AiContentService._private.setFetchImpl(async () =>
    jsonResponse({ data: [{ id: 'different-model' }] })
  );
  await assert.rejects(
    AiContentService.testConnection('9router'),
    /không tìm thấy model/i
  );
});

test('Gemini, OpenAI, 9Router and Kira response shapes produce clean text', async () => {
  AiContentService._private.setFetchImpl(async (url, options = {}) => {
    if (String(url).includes(':generateContent')) {
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: '```text\nGemini mới\n```' }] } }],
      });
    }
    if (String(url).endsWith('/responses')) {
      return jsonResponse({ output_text: 'OpenAI mới' });
    }
    const request = options.body ? JSON.parse(options.body) : {};
    return jsonResponse({
      choices: [{ message: { content: request.model?.startsWith('kira-') ? 'Kira mới' : '9Router mới' } }],
    });
  });

  assert.equal(await AiContentService._private.generateText('gemini', {
    provider: 'gemini', apiKey: 'key', model: 'gemini-test', baseUrl: 'https://gemini.test/v1beta',
  }, 'prompt'), 'Gemini mới');
  assert.equal(await AiContentService._private.generateText('openai', {
    provider: 'openai', apiKey: 'key', model: 'openai-test', baseUrl: 'https://openai.test/v1',
  }, 'prompt'), 'OpenAI mới');
  assert.equal(await AiContentService._private.generateText('9router', {
    provider: '9router', apiKey: 'key', model: 'router/test-model', baseUrl: 'http://router.test/v1',
  }, 'prompt'), '9Router mới');
  assert.equal(await AiContentService._private.generateText('kira', {
    provider: 'kira',
    apiKey: 'key',
    model: 'kira-3.5-flash',
    imageModel: 'kira-3.0-image',
    aspectRatio: '1:1',
    baseUrl: 'https://kira.test/api/v1',
  }, 'prompt'), 'Kira mới');
});

test('multiple selected rows are rewritten independently and failed rows stay unchanged', async () => {
  const first = DataService.create({ content: 'Nội dung gốc một', status: 'pending' }, 'threads');
  const second = DataService.create({ content: 'Nội dung gốc hai', status: 'pending' }, 'threads');
  const running = DataService.create({ content: 'Đang đăng', status: 'running' }, 'threads');
  createdPosts.push(first.id, second.id, running.id);
  let generationCalls = 0;

  AiContentService._private.setFetchImpl(async (url, options) => {
    if (String(url).endsWith('/chat/completions')) {
      generationCalls++;
      const payload = JSON.parse(options.body);
      const source = payload.messages[1].content.includes('một') ? 'một' : 'hai';
      return jsonResponse({
        choices: [{ message: { content: `Nội dung AI ${source}` } }],
      });
    }
    return jsonResponse({ data: [{ id: 'router/test-model' }] });
  });

  const result = await AiContentService.rewritePosts({
    platform: 'threads',
    provider: '9router',
    prompt: 'Viết lại cho {{platform}}: {{content}}',
    postIds: [first.id, second.id, running.id],
  });

  assert.equal(result.successCount, 2);
  assert.equal(result.failureCount, 1);
  assert.equal(generationCalls, 2);
  const rows = DataService.getAllWithCustomData('threads');
  assert.equal(rows.find(row => row.id === first.id).content, 'Nội dung AI một');
  assert.equal(rows.find(row => row.id === second.id).content, 'Nội dung AI hai');
  assert.equal(rows.find(row => row.id === running.id).content, 'Đang đăng');
  assert.match(result.results[2].error, /đang đăng bài/i);
  assert.equal(AiContentService.getSettings('threads').prompt, 'Viết lại cho {{platform}}: {{content}}');
});

test('prompt without content variable receives the original content automatically', () => {
  const prepared = AiContentService._private.preparePrompt(
    'Hãy viết ngắn gọn',
    'Nội dung gốc cần giữ',
    'facebook'
  );
  assert.match(prepared, /Hãy viết ngắn gọn/);
  assert.match(prepared, /Nội dung gốc cần giữ/);
});

test('Kira connection validates both configured text and image models', async () => {
  AiContentService._private.setFetchImpl(async url => {
    assert.match(String(url), /kiraai\.vn\/api\/v1\/models$/);
    return jsonResponse({
      data: [
        { id: 'kira-3.5-flash', type: 'chat' },
        { id: 'kira-3.0-image', type: 'image' },
      ],
    });
  });

  const result = await AiContentService.testConnection('kira');
  assert.equal(result.provider, 'kira');
  assert.equal(result.model, 'kira-3.5-flash');
  assert.equal(result.imageModel, 'kira-3.0-image');
  assert.equal(result.aspectRatio, '16:9');
});

test('Kira creates images from prompts and Base64 reference images then updates Media', async () => {
  config.AI_GENERATED_IMAGES_DIR = path.join(tempRoot, 'kira-generated-images');
  const referencePath = path.join(tempRoot, 'kira-reference.jpg');
  fs.writeFileSync(referencePath, Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.alloc(2045, 6),
  ]));
  const generatedImage = Buffer.alloc(2048, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(generatedImage);
  const requests = [];

  AiContentService._private.setFetchImpl(async (url, options = {}) => {
    const payload = options.body ? JSON.parse(options.body) : {};
    requests.push({ url: String(url), payload });
    if (String(url).endsWith('/chat/completions')) {
      return jsonResponse({
        choices: [{ message: { content: 'Prompt chi tiết do Kira phân tích ảnh tham chiếu' } }],
      });
    }
    if (String(url).endsWith('/images/generations')) {
      return jsonResponse({
        data: [{
          b64_json: generatedImage.toString('base64'),
          mime_type: 'image/png',
        }],
      });
    }
    return jsonResponse({ data: [] });
  });

  const blank = DataService.create({
    content: 'Sản phẩm Kira không tham chiếu',
    status: 'pending',
  }, 'threads');
  const reference = DataService.create({
    content: 'Sản phẩm Kira có tham chiếu',
    image_path: referencePath,
    status: 'pending',
  }, 'threads');
  createdPosts.push(blank.id, reference.id);

  const plainStarted = await AiContentService.startImageJob({
    platform: 'threads',
    provider: 'kira',
    prompt: 'Ảnh studio {{content}}',
    postIds: [blank.id],
  });
  const plainJob = await waitForImageJob(plainStarted.id);

  const referenceStarted = await AiContentService.startImageJob({
    platform: 'threads',
    provider: 'kira',
    prompt: 'Giữ sản phẩm và đổi nền {{content}}',
    postIds: [reference.id],
    useReference: true,
  });
  const referenceJob = await waitForImageJob(referenceStarted.id);
  const rows = DataService.getAllWithCustomData('threads');
  const blankUpdated = rows.find(row => row.id === blank.id);
  const referenceUpdated = rows.find(row => row.id === reference.id);
  const multimodal = requests.find(request => request.url.endsWith('/chat/completions'));
  const imageRequests = requests.filter(request => request.url.endsWith('/images/generations'));

  assert.equal(plainJob.status, 'completed');
  assert.equal(referenceJob.status, 'completed');
  assert.equal(plainJob.provider, 'kira');
  assert.equal(referenceJob.provider, 'kira');
  assert.equal(imageRequests.length, 2);
  assert.equal(imageRequests[0].payload.model, 'kira-3.0-image');
  assert.equal(imageRequests[0].payload.aspect_ratio, '16:9');
  assert.equal(
    multimodal.payload.messages[1].content[1].image_url.url.startsWith('data:image/jpeg;base64,'),
    true
  );
  assert.equal(imageRequests[1].payload.prompt, 'Prompt chi tiết do Kira phân tích ảnh tham chiếu');
  assert.equal(fs.existsSync(blankUpdated.image_path), true);
  assert.equal(fs.existsSync(referenceUpdated.image_path), true);
  assert.notEqual(referenceUpdated.image_path, referencePath);
  assert.equal(referenceJob.results[0].oldImagePath, referencePath);
});

test('Codex path resolver accepts a manually selected installation directory', () => {
  const cliFolder = path.join(tempRoot, 'custom-codex');
  const cliFile = path.join(cliFolder, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  fs.mkdirSync(cliFolder, { recursive: true });
  fs.writeFileSync(cliFile, '');

  assert.equal(ChatGptLocalService._private.resolveExecutable(cliFolder), cliFile);
  assert.match(ChatGptLocalService.configDirectory(), /\.codex$/i);
});

test('ChatGPT local provider checks shared login and creates images into Media', async () => {
  config.AI_GENERATED_IMAGES_DIR = path.join(tempRoot, 'generated-images');
  ChatGptLocalService._private.setCommandRunner(async (args, input) => {
    if (args[0] === '--version') {
      return { code: 0, stdout: 'codex-cli test', stderr: '' };
    }
    if (args[0] === 'login') {
      return { code: 0, stdout: 'Logged in using ChatGPT', stderr: '' };
    }
    if (args[0] === 'exec' && String(input).includes('$imagegen')) {
      const match = String(input).match(/Lưu ảnh cuối cùng vào đúng đường dẫn:\s*(.+)/);
      assert.ok(match, input);
      const outputPath = match[1].trim();
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      const image = Buffer.alloc(2048, 1);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(image);
      fs.writeFileSync(outputPath, image);
      return { code: 0, stdout: `Đã lưu ${outputPath}`, stderr: '' };
    }
    return { code: 0, stdout: 'Nội dung từ ChatGPT', stderr: '' };
  });

  const connection = await AiContentService.testConnection('chatgpt');
  assert.equal(connection.provider, 'chatgpt');
  assert.equal(connection.version, 'codex-cli test');

  const blank = DataService.create({ content: 'Tạo ảnh sản phẩm A', status: 'pending' }, 'threads');
  const existing = DataService.create({
    content: 'Tạo ảnh sản phẩm B',
    image_path: 'C:\\existing.png',
    status: 'pending',
  }, 'threads');
  createdPosts.push(blank.id, existing.id);

  const started = await AiContentService.startImageJob({
    platform: 'threads',
    prompt: 'Ảnh cho {{content}} trên {{platform}}',
    postIds: [blank.id, existing.id],
    overwrite: false,
  });
  const job = await waitForImageJob(started.id);

  assert.equal(job.status, 'partial');
  assert.equal(job.successCount, 1);
  assert.equal(job.skippedCount, 1);
  const rows = DataService.getAllWithCustomData('threads');
  const generatedPath = rows.find(row => row.id === blank.id).image_path;
  assert.equal(fs.existsSync(generatedPath), true);
  assert.equal(rows.find(row => row.id === existing.id).image_path, 'C:\\existing.png');
});

test('reference mode attaches current Media to Codex and replaces it only after success', async () => {
  config.AI_GENERATED_IMAGES_DIR = path.join(tempRoot, 'reference-generated-images');
  const referencePath = path.join(tempRoot, 'reference-product.jpg');
  fs.writeFileSync(referencePath, Buffer.alloc(2048, 2));
  let imageArgs = [];
  let imagePrompt = '';

  ChatGptLocalService._private.setCommandRunner(async (args, input) => {
    if (args[0] === '--version') return { code: 0, stdout: 'codex-cli test', stderr: '' };
    if (args[0] === 'login') return { code: 0, stdout: 'Logged in using ChatGPT', stderr: '' };
    if (args[0] === 'exec') {
      imageArgs = args;
      imagePrompt = String(input);
      const match = imagePrompt.match(/Lưu ảnh cuối cùng vào đúng đường dẫn:\s*(.+)/);
      assert.ok(match, imagePrompt);
      const outputPath = match[1].trim();
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      const image = Buffer.alloc(2048, 3);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(image);
      fs.writeFileSync(outputPath, image);
      return { code: 0, stdout: `Đã lưu ${outputPath}`, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  });

  const post = DataService.create({
    content: 'Áo thể thao màu xanh',
    image_path: referencePath,
    status: 'pending',
  }, 'threads');
  createdPosts.push(post.id);

  const started = await AiContentService.startImageJob({
    platform: 'threads',
    prompt: 'Giữ sản phẩm, đổi nền studio: {{content}}',
    postIds: [post.id],
    useReference: true,
  });
  const job = await waitForImageJob(started.id);
  const updated = DataService.getAllWithCustomData('threads').find(row => row.id === post.id);

  assert.equal(job.status, 'completed');
  assert.equal(job.useReference, true);
  assert.equal(job.successCount, 1);
  assert.equal(imageArgs[imageArgs.indexOf('--image') + 1], referencePath);
  assert.match(imagePrompt, /Image 1: ảnh tham chiếu/i);
  assert.equal(job.results[0].oldImagePath, referencePath);
  assert.notEqual(updated.image_path, referencePath);
  assert.equal(fs.existsSync(updated.image_path), true);
});

test('invalid reference Media reports each cause and preserves the old paths', async () => {
  config.AI_GENERATED_IMAGES_DIR = path.join(tempRoot, 'invalid-reference-images');
  const missingPath = path.join(tempRoot, 'missing-reference.jpg');
  const videoPath = path.join(tempRoot, 'reference-video.mp4');
  fs.writeFileSync(videoPath, Buffer.alloc(2048, 4));
  let generationCalls = 0;

  ChatGptLocalService._private.setCommandRunner(async args => {
    if (args[0] === '--version') return { code: 0, stdout: 'codex-cli test', stderr: '' };
    if (args[0] === 'login') return { code: 0, stdout: 'Logged in using ChatGPT', stderr: '' };
    if (args[0] === 'exec') generationCalls++;
    return { code: 0, stdout: '', stderr: '' };
  });

  const missing = DataService.create({
    content: 'Thiếu file',
    image_path: missingPath,
    status: 'pending',
  }, 'threads');
  const video = DataService.create({
    content: 'Media là video',
    image_path: videoPath,
    status: 'pending',
  }, 'threads');
  createdPosts.push(missing.id, video.id);

  const started = await AiContentService.startImageJob({
    platform: 'threads',
    prompt: 'Tạo ảnh mới từ Media',
    postIds: [missing.id, video.id],
    useReference: true,
  });
  const job = await waitForImageJob(started.id);
  const rows = DataService.getAllWithCustomData('threads');

  assert.equal(job.status, 'failed');
  assert.equal(job.failureCount, 2);
  assert.equal(generationCalls, 0);
  assert.match(job.results.find(item => item.id === missing.id).error, /không tìm thấy file ảnh/i);
  assert.match(job.results.find(item => item.id === video.id).error, /không phải file ảnh/i);
  assert.equal(rows.find(row => row.id === missing.id).image_path, missingPath);
  assert.equal(rows.find(row => row.id === video.id).image_path, videoPath);
});

test('out-of-credits failure is readable and preserves reference Media', async () => {
  config.AI_GENERATED_IMAGES_DIR = path.join(tempRoot, 'credits-error-images');
  const referencePath = path.join(tempRoot, 'credits-reference.png');
  fs.writeFileSync(referencePath, Buffer.alloc(2048, 5));

  ChatGptLocalService._private.setCommandRunner(async args => {
    if (args[0] === '--version') return { code: 0, stdout: 'codex-cli test', stderr: '' };
    if (args[0] === 'login') return { code: 0, stdout: 'Logged in using ChatGPT', stderr: '' };
    return {
      code: 1,
      stdout: '',
      stderr: `${'diagnostic '.repeat(100)}ERROR: Your workspace is out of credits. Add credits to continue.`,
    };
  });

  const post = DataService.create({
    content: 'Kiểm tra hết credit',
    image_path: referencePath,
    status: 'pending',
  }, 'threads');
  createdPosts.push(post.id);

  const started = await AiContentService.startImageJob({
    platform: 'threads',
    prompt: 'Tạo ảnh mới',
    postIds: [post.id],
    useReference: true,
  });
  const job = await waitForImageJob(started.id);
  const updated = DataService.getAllWithCustomData('threads').find(row => row.id === post.id);

  assert.equal(job.status, 'failed');
  assert.match(job.results[0].error, /hết credit|giới hạn sử dụng/i);
  assert.equal(updated.image_path, referencePath);
});
