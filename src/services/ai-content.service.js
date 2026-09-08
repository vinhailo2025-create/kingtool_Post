const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../../config');
const db = require('../database/init');
const DataService = require('./data.service');
const ChatGptLocalService = require('./chatgpt-local.service');
const { resolveMediaPath } = require('./media-path.utils');
const { normalizePlatform, scopedSettingKey } = require('../platforms/platform.utils');

const PROVIDERS = Object.freeze(['gemini', 'openai', '9router', 'kira', 'chatgpt']);
const DEFAULT_PROMPT = 'Viết lại nội dung sau tự nhiên, thu hút và rõ ràng. Giữ nguyên đường link, hashtag, tên sản phẩm và thông tin quan trọng. Không giải thích, chỉ trả về nội dung hoàn chỉnh để đăng bài: {{content}}';
const DEFAULT_IMAGE_PROMPT = 'Tạo ảnh minh họa chuyên nghiệp cho bài đăng {{platform}} dựa trên nội dung sau: {{content}}. Bố cục rõ ràng, thu hút, không chữ, không watermark.';
const PROVIDER_DEFAULTS = Object.freeze({
  gemini: {
    model: 'gemini-2.5-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  },
  openai: {
    model: 'gpt-4.1-mini',
    baseUrl: 'https://api.openai.com/v1',
  },
  '9router': {
    model: '',
    baseUrl: 'http://127.0.0.1:20128/v1',
  },
  kira: {
    model: 'kira-3.5-flash',
    imageModel: 'kira-3.0-image',
    aspectRatio: '1:1',
    baseUrl: 'https://kiraai.vn/api/v1',
  },
  chatgpt: {
    model: 'Tự động theo ChatGPT',
    baseUrl: '',
  },
});

let fetchImpl = (...args) => fetch(...args);
let secretsPath = config.AI_SECRETS_PATH;
let secretsKeyPath = config.AI_SECRETS_KEY_PATH;
const imageJobs = new Map();
const REFERENCE_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']);
const KIRA_ASPECT_RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4']);

function assertProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  if (!PROVIDERS.includes(provider)) {
    throw new Error('Nhà cung cấp AI không hợp lệ.');
  }
  return provider;
}

function settingValue(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row && row.value != null ? String(row.value) : fallback;
}

function setSettings(values) {
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const save = db.transaction(entries => {
    for (const [key, value] of entries) stmt.run(key, String(value ?? ''));
  });
  save(Object.entries(values));
}

function ensureSecretDirectory() {
  fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
}

function readEncryptionKey() {
  ensureSecretDirectory();
  if (!fs.existsSync(secretsKeyPath)) {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(secretsKeyPath, key, { mode: 0o600 });
    return key;
  }
  const key = fs.readFileSync(secretsKeyPath);
  if (key.length !== 32) throw new Error('Khóa bảo vệ API key không hợp lệ.');
  return key;
}

function readSecrets() {
  if (!fs.existsSync(secretsPath)) return {};
  try {
    const payload = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
    const key = readEncryptionKey();
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(payload.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(payload.data, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString('utf8'));
  } catch (error) {
    throw new Error('Không đọc được API key đã lưu. Hãy nhập và lưu lại API key.');
  }
}

function writeSecrets(secrets) {
  ensureSecretDirectory();
  const key = readEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(secrets), 'utf8'),
    cipher.final(),
  ]);
  const payload = JSON.stringify({
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  });
  const tempPath = `${secretsPath}.tmp`;
  fs.writeFileSync(tempPath, payload, { mode: 0o600 });
  fs.renameSync(tempPath, secretsPath);
}

function apiKeyHint(apiKey) {
  const value = String(apiKey || '');
  if (!value) return '';
  return value.length <= 4 ? value : value.slice(-4);
}

function providerSettingKey(provider, field) {
  return `ai_${provider}_${field}`;
}

function normalizeBaseUrl(value, fallback) {
  const candidate = String(value || fallback || '').trim().replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch (_) {
    throw new Error('Base URL không hợp lệ.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Base URL phải dùng http hoặc https.');
  }
  return candidate;
}

function normalizeAspectRatio(value, fallback = '1:1') {
  const ratio = String(value || fallback).trim();
  if (!KIRA_ASPECT_RATIOS.has(ratio)) {
    throw new Error('Tỷ lệ ảnh Kira phải là 1:1, 16:9, 9:16, 4:3 hoặc 3:4.');
  }
  return ratio;
}

function getProviderConfig(provider, overrides = {}) {
  provider = assertProvider(provider);
  const defaults = PROVIDER_DEFAULTS[provider];
  if (provider === 'chatgpt') {
    return {
      provider,
      apiKey: '',
      model: defaults.model,
      baseUrl: '',
      authMode: 'chatgpt',
      cliPath: String(
        overrides.cliPath
        || settingValue(providerSettingKey(provider, 'cli_path'), '')
      ).trim(),
    };
  }
  const secrets = readSecrets();
  const configValue = {
    provider,
    apiKey: String(overrides.apiKey || secrets[provider] || '').trim(),
    model: String(
      overrides.model
      || settingValue(providerSettingKey(provider, 'model'), defaults.model)
      || defaults.model
    ).trim(),
    baseUrl: normalizeBaseUrl(
      overrides.baseUrl
      || settingValue(providerSettingKey(provider, 'base_url'), defaults.baseUrl),
      defaults.baseUrl
    ),
  };
  if (provider === 'kira') {
    configValue.imageModel = String(
      overrides.imageModel
      || settingValue(providerSettingKey(provider, 'image_model'), defaults.imageModel)
      || defaults.imageModel
    ).trim();
    configValue.aspectRatio = normalizeAspectRatio(
      overrides.aspectRatio
      || settingValue(providerSettingKey(provider, 'aspect_ratio'), defaults.aspectRatio),
      defaults.aspectRatio
    );
  }
  return configValue;
}

function publicProviderConfig(provider) {
  const configValue = getProviderConfig(provider);
  if (provider === 'chatgpt') {
    return {
      provider,
      model: configValue.model,
      baseUrl: '',
      hasApiKey: false,
      apiKeyHint: '',
      configured: true,
      authMode: 'chatgpt',
      cliPath: configValue.cliPath,
    };
  }
  const publicValue = {
    provider,
    model: configValue.model,
    baseUrl: configValue.baseUrl,
    hasApiKey: Boolean(configValue.apiKey),
    apiKeyHint: apiKeyHint(configValue.apiKey),
  };
  if (provider === 'kira') {
    publicValue.imageModel = configValue.imageModel;
    publicValue.aspectRatio = configValue.aspectRatio;
  }
  return publicValue;
}

function getSettings(platform = 'facebook') {
  platform = normalizePlatform(platform);
  const activeProvider = settingValue(scopedSettingKey(platform, 'ai_last_provider'), 'gemini');
  return {
    activeProvider: PROVIDERS.includes(activeProvider) ? activeProvider : 'gemini',
    activeImageProvider: ['chatgpt', 'kira'].includes(
      settingValue(scopedSettingKey(platform, 'ai_last_image_provider'), 'chatgpt')
    )
      ? settingValue(scopedSettingKey(platform, 'ai_last_image_provider'), 'chatgpt')
      : 'chatgpt',
    prompt: settingValue(scopedSettingKey(platform, 'ai_rewrite_prompt'), DEFAULT_PROMPT),
    defaultPrompt: DEFAULT_PROMPT,
    imagePrompt: settingValue(scopedSettingKey(platform, 'ai_image_prompt'), DEFAULT_IMAGE_PROMPT),
    defaultImagePrompt: DEFAULT_IMAGE_PROMPT,
    providers: Object.fromEntries(PROVIDERS.map(provider => [
      provider,
      publicProviderConfig(provider),
    ])),
  };
}

function saveSettings(input = {}, platform = 'facebook') {
  platform = normalizePlatform(platform);
  const providers = input.providers && typeof input.providers === 'object'
    ? input.providers
    : {};
  const publicValues = {};
  const secrets = readSecrets();

  for (const provider of PROVIDERS) {
    const update = providers[provider];
    if (!update || typeof update !== 'object') continue;
    if (provider === 'chatgpt') {
      publicValues[providerSettingKey(provider, 'cli_path')] = String(update.cliPath || '').trim();
      continue;
    }
    const current = getProviderConfig(provider);
    const model = String(update.model ?? current.model).trim();
    const incomingApiKey = typeof update.apiKey === 'string' ? update.apiKey.trim() : '';
    if (!model && (incomingApiKey || secrets[provider])) {
      throw new Error(`Hãy nhập model cho ${provider}.`);
    }
    const baseUrl = normalizeBaseUrl(update.baseUrl ?? current.baseUrl, current.baseUrl);
    if (model) publicValues[providerSettingKey(provider, 'model')] = model;
    publicValues[providerSettingKey(provider, 'base_url')] = baseUrl;
    if (provider === 'kira') {
      const imageModel = String(update.imageModel ?? current.imageModel).trim();
      if (!imageModel && (incomingApiKey || secrets[provider])) {
        throw new Error('Hãy nhập model tạo ảnh cho Kira.');
      }
      if (imageModel) publicValues[providerSettingKey(provider, 'image_model')] = imageModel;
      publicValues[providerSettingKey(provider, 'aspect_ratio')] = normalizeAspectRatio(
        update.aspectRatio ?? current.aspectRatio,
        current.aspectRatio
      );
    }
    if (incomingApiKey) secrets[provider] = incomingApiKey;
  }

  if (input.activeProvider) {
    const activeProvider = assertProvider(input.activeProvider);
    publicValues[scopedSettingKey(platform, 'ai_last_provider')] = activeProvider;
  }
  if (Object.keys(publicValues).length) setSettings(publicValues);
  writeSecrets(secrets);
  return getSettings(platform);
}

function savePrompt(platform, provider, prompt) {
  platform = normalizePlatform(platform);
  provider = assertProvider(provider);
  const cleanedPrompt = String(prompt || '').trim();
  if (!cleanedPrompt) throw new Error('Prompt viết lại nội dung không được để trống.');
  if (cleanedPrompt.length > 12000) throw new Error('Prompt dài tối đa 12.000 ký tự.');
  setSettings({
    [scopedSettingKey(platform, 'ai_last_provider')]: provider,
    [scopedSettingKey(platform, 'ai_rewrite_prompt')]: cleanedPrompt,
  });
  return cleanedPrompt;
}

async function requestJson(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const raw = await response.text();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch (_) { payload = { raw }; }
    if (!response.ok) {
      const detail = payload.error?.message || payload.message || payload.error || raw;
      const safeDetail = String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      throw new Error(safeDetail || `HTTP ${response.status}`);
    }
    return payload;
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error('Kết nối API quá thời gian chờ.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

function requireConfigured(configValue) {
  if (configValue.provider === 'chatgpt') return;
  if (!configValue.apiKey) {
    throw new Error(`Chưa nhập API key cho ${configValue.provider}.`);
  }
  if (!configValue.model) {
    throw new Error(`Chưa chọn model cho ${configValue.provider}.`);
  }
}

async function listModels(provider, overrides = {}) {
  const configValue = getProviderConfig(provider, overrides);
  requireConfigured(configValue);
  if (provider === 'chatgpt') return [configValue.model];
  let payload;
  if (provider === 'gemini') {
    payload = await requestJson(
      `${configValue.baseUrl}/models?key=${encodeURIComponent(configValue.apiKey)}`,
      { method: 'GET' }
    );
    return (payload.models || []).map(item => String(item.name || '').replace(/^models\//, '')).filter(Boolean);
  }
  payload = await requestJson(`${configValue.baseUrl}/models`, {
    method: 'GET',
    headers: authHeaders(configValue.apiKey),
  });
  return (payload.data || payload.models || []).map(item =>
    typeof item === 'string' ? item : String(item.id || item.name || '')
  ).filter(Boolean);
}

async function testConnection(provider, overrides = {}) {
  provider = assertProvider(provider);
  if (provider === 'chatgpt') {
    const configValue = getProviderConfig(provider, overrides);
    const status = await ChatGptLocalService.getStatus({ executable: configValue.cliPath });
    if (!status.ready) throw new Error(status.message);
    return {
      provider,
      model: PROVIDER_DEFAULTS.chatgpt.model,
      modelCount: 1,
      checkedAt: new Date().toISOString(),
      version: status.version,
      message: status.message,
    };
  }
  const configValue = getProviderConfig(provider, overrides);
  requireConfigured(configValue);
  const models = await listModels(provider, overrides);
  const normalizedModel = configValue.model.replace(/^models\//, '');
  const modelFound = models.some(model =>
    model === normalizedModel || model.replace(/^models\//, '') === normalizedModel
  );
  if (models.length && !modelFound) {
    throw new Error(`Kết nối được API nhưng không tìm thấy model "${configValue.model}".`);
  }
  if (provider === 'kira') {
    const imageModelFound = models.some(model => model === configValue.imageModel);
    if (models.length && !imageModelFound) {
      throw new Error(`Kết nối được Kira API nhưng không tìm thấy model ảnh "${configValue.imageModel}".`);
    }
  }
  return {
    provider,
    model: configValue.model,
    ...(provider === 'kira' ? {
      imageModel: configValue.imageModel,
      aspectRatio: configValue.aspectRatio,
    } : {}),
    modelCount: models.length,
    checkedAt: new Date().toISOString(),
    message: 'Kết nối API thành công.',
  };
}

function preparePrompt(prompt, content, platform) {
  const source = String(content || '').trim();
  const template = String(prompt || DEFAULT_PROMPT);
  let result = template
    .replace(/\{\{\s*platform\s*\}\}/gi, platform)
    .replace(/\{\{\s*content\s*\}\}/gi, source);
  if (!/\{\{\s*content\s*\}\}/i.test(template)) {
    result += `\n\nNội dung gốc:\n${source}`;
  }
  return result;
}

function cleanGeneratedText(value) {
  let text = String(value || '').trim();
  const fenced = text.match(/^```(?:\w+)?\s*([\s\S]*?)\s*```$/);
  if (fenced) text = fenced[1].trim();
  if (!text) throw new Error('API không trả về nội dung viết lại.');
  if (text.length > 20000) throw new Error('Nội dung AI trả về vượt quá 20.000 ký tự.');
  return text;
}

async function generateText(provider, configValue, promptText) {
  requireConfigured(configValue);
  if (provider === 'chatgpt') {
    return cleanGeneratedText(await ChatGptLocalService.generateText(promptText, {
      cwd: config.DATA_ROOT,
      executable: configValue.cliPath,
    }));
  }
  if (provider === 'gemini') {
    const payload = await requestJson(
      `${configValue.baseUrl}/models/${encodeURIComponent(configValue.model.replace(/^models\//, ''))}:generateContent?key=${encodeURIComponent(configValue.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: promptText }] }],
          generationConfig: { temperature: 0.8 },
        }),
      },
      90000
    );
    return cleanGeneratedText(
      (payload.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('')
    );
  }

  if (provider === 'openai') {
    const payload = await requestJson(`${configValue.baseUrl}/responses`, {
      method: 'POST',
      headers: authHeaders(configValue.apiKey),
      body: JSON.stringify({
        model: configValue.model,
        instructions: 'Bạn viết lại nội dung mạng xã hội. Chỉ trả về nội dung hoàn chỉnh, không giải thích, không đặt trong dấu ngoặc hoặc code block.',
        input: promptText,
      }),
    }, 90000);
    const nestedText = (payload.output || []).flatMap(item => item.content || [])
      .map(item => item.text || '').join('');
    return cleanGeneratedText(payload.output_text || nestedText);
  }

  const payload = await requestJson(`${configValue.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(configValue.apiKey),
    body: JSON.stringify({
      model: configValue.model,
      stream: false,
      messages: [
        {
          role: 'system',
          content: 'Bạn viết lại nội dung mạng xã hội. Chỉ trả về nội dung hoàn chỉnh, không giải thích, không đặt trong dấu ngoặc hoặc code block.',
        },
        { role: 'user', content: promptText },
      ],
    }),
  }, 90000);
  return cleanGeneratedText(payload.choices?.[0]?.message?.content);
}

function detectImageFormat(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  )) {
    return { extension: '.png', mimeType: 'image/png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: '.jpg', mimeType: 'image/jpeg' };
  }
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { extension: '.webp', mimeType: 'image/webp' };
  }
  throw new Error('Kira API trả về dữ liệu không phải ảnh PNG, JPG hoặc WEBP hợp lệ.');
}

function referenceDataUri(referencePath) {
  const extension = path.extname(referencePath).toLowerCase();
  const mimeTypes = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.avif': 'image/avif',
  };
  const mimeType = mimeTypes[extension];
  if (!mimeType) throw new Error('Định dạng ảnh tham chiếu chưa được Kira hỗ trợ.');
  const stats = fs.statSync(referencePath);
  if (!stats.isFile()) throw new Error('Đường dẫn ảnh tham chiếu không phải file.');
  if (stats.size > 20 * 1024 * 1024) {
    throw new Error('Ảnh tham chiếu Kira tối đa 20 MB.');
  }
  const encoded = fs.readFileSync(referencePath).toString('base64');
  return `data:${mimeType};base64,${encoded}`;
}

async function prepareKiraReferencePrompt(referencePath, prompt, configValue) {
  const payload = await requestJson(`${configValue.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(configValue.apiKey),
    body: JSON.stringify({
      model: configValue.model,
      stream: false,
      messages: [
        {
          role: 'system',
          content: 'Bạn là chuyên gia art direction. Hãy phân tích ảnh tham chiếu và viết một prompt tạo ảnh mới thật chi tiết. Chỉ trả về prompt cuối cùng, không giải thích.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Yêu cầu cho ảnh mới:\n${String(prompt || '').trim()}\n\nGiữ các đặc điểm quan trọng của chủ thể trong ảnh tham chiếu khi phù hợp.`,
            },
            {
              type: 'image_url',
              image_url: { url: referenceDataUri(referencePath) },
            },
          ],
        },
      ],
    }),
  }, 90000);
  return cleanGeneratedText(payload.choices?.[0]?.message?.content);
}

async function generateKiraImage(prompt, outputPath, configValue) {
  requireConfigured(configValue);
  if (!configValue.imageModel) throw new Error('Chưa chọn model tạo ảnh Kira.');
  const payload = await requestJson(`${configValue.baseUrl}/images/generations`, {
    method: 'POST',
    headers: authHeaders(configValue.apiKey),
    body: JSON.stringify({
      model: configValue.imageModel,
      prompt: String(prompt || '').trim(),
      aspect_ratio: normalizeAspectRatio(configValue.aspectRatio),
    }),
  }, 120000);
  const imageInfo = payload.data?.[0] || {};
  let encoded = String(imageInfo.b64_json || '').trim();
  if (!encoded) throw new Error('Kira API không trả về dữ liệu ảnh Base64.');
  const dataUri = encoded.match(/^data:([^;,]+);base64,(.+)$/s);
  if (dataUri) encoded = dataUri[2];

  let buffer;
  try {
    buffer = Buffer.from(encoded.replace(/\s+/g, ''), 'base64');
  } catch (_) {
    throw new Error('Không giải mã được ảnh Base64 do Kira API trả về.');
  }
  if (buffer.length < 1024) throw new Error('Ảnh Kira trả về không hợp lệ hoặc quá nhỏ.');
  const format = detectImageFormat(buffer);
  const requested = path.resolve(outputPath);
  const target = requested.replace(/\.[^.\\/]+$/, '') + format.extension;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tempPath = `${target}.tmp`;
  fs.writeFileSync(tempPath, buffer);
  fs.renameSync(tempPath, target);
  return {
    outputPath: target,
    size: buffer.length,
    mimeType: format.mimeType,
    model: configValue.imageModel,
  };
}

async function rewritePosts({ platform, provider, prompt, postIds }) {
  platform = normalizePlatform(platform);
  provider = assertProvider(provider);
  const ids = [...new Set((postIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) throw new Error('Hãy chọn ít nhất một hàng để viết lại.');
  if (ids.length > 200) throw new Error('Mỗi lượt AI hỗ trợ tối đa 200 hàng.');
  const savedPrompt = savePrompt(platform, provider, prompt);
  const configValue = getProviderConfig(provider);
  requireConfigured(configValue);
  const rowsById = new Map(DataService.getAllWithCustomData(platform).map(row => [Number(row.id), row]));
  const results = new Array(ids.length);
  let cursor = 0;

  async function worker() {
    while (cursor < ids.length) {
      const index = cursor++;
      const id = ids[index];
      const row = rowsById.get(id);
      if (!row) {
        results[index] = { id, success: false, error: 'Không tìm thấy hàng dữ liệu.' };
        continue;
      }
      if (String(row.status || '') === 'running') {
        results[index] = { id, success: false, error: 'Hàng đang đăng bài nên chưa thể thay đổi nội dung.' };
        continue;
      }
      const oldContent = String(row.content || '');
      if (!oldContent.trim()) {
        results[index] = { id, success: false, error: 'Nội dung gốc đang trống.' };
        continue;
      }
      try {
        const generated = await generateText(
          provider,
          configValue,
          preparePrompt(savedPrompt, oldContent, platform)
        );
        DataService.update(id, { content: generated }, platform);
        results[index] = { id, success: true, oldContent, content: generated };
      } catch (error) {
        results[index] = {
          id,
          success: false,
          error: String(error?.message || error || 'Lỗi API').slice(0, 500),
        };
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(2, ids.length) },
    () => worker()
  ));
  const successCount = results.filter(result => result.success).length;
  return {
    provider,
    total: results.length,
    successCount,
    failureCount: results.length - successCount,
    results,
  };
}

function prepareImagePrompt(prompt, row, platform) {
  const template = String(prompt || DEFAULT_IMAGE_PROMPT).trim();
  const content = String(row?.content || '').trim();
  let result = template
    .replace(/\{\{\s*platform\s*\}\}/gi, platform)
    .replace(/\{\{\s*content\s*\}\}/gi, content);
  if (!/\{\{\s*content\s*\}\}/i.test(template) && content) {
    result += `\n\nNội dung bài đăng:\n${content}`;
  }
  return result;
}

function publicImageJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    platform: job.platform,
    provider: job.provider,
    useReference: job.useReference,
    total: job.total,
    completed: job.completed,
    successCount: job.successCount,
    failureCount: job.failureCount,
    skippedCount: job.skippedCount,
    results: job.results.map(result => ({ ...result })),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function cleanupImageJobs() {
  const cutoff = Date.now() - (6 * 60 * 60 * 1000);
  for (const [id, job] of imageJobs) {
    if (new Date(job.updatedAt).getTime() < cutoff) imageJobs.delete(id);
  }
  while (imageJobs.size > 50) imageJobs.delete(imageJobs.keys().next().value);
}

function resolveReferenceImage(mediaValue) {
  const raw = String(mediaValue || '').trim();
  if (!raw) {
    throw new Error('Hàng chưa có Media để dùng làm ảnh tham chiếu.');
  }
  const candidates = raw.split(',').map(value => value.trim()).filter(Boolean);
  for (const candidate of candidates) {
    const resolved = resolveMediaPath(candidate);
    if (!resolved) continue;
    if (REFERENCE_IMAGE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) return resolved;
  }
  const resolvedAny = candidates.map(resolveMediaPath).find(Boolean);
  if (resolvedAny) {
    throw new Error('Media hiện tại không phải file ảnh được hỗ trợ (JPG, PNG, WEBP, GIF, BMP hoặc AVIF).');
  }
  throw new Error('Không tìm thấy file ảnh tham chiếu theo đường dẫn trong cột Media.');
}

async function processImageJob(job, rowsById, prompt, overwrite, useReference, imageProviderConfig) {
  job.status = 'running';
  job.updatedAt = new Date().toISOString();

  for (const postId of job.postIds) {
    const row = rowsById.get(postId);
    let result;
    if (!row) {
      result = { id: postId, success: false, error: 'Không tìm thấy hàng dữ liệu.' };
      job.failureCount++;
    } else if (String(row.status || '') === 'running') {
      result = { id: postId, success: false, error: 'Hàng đang đăng bài nên chưa thể đổi Media.' };
      job.failureCount++;
    } else if (String(row.image_path || '').trim() && !overwrite && !useReference) {
      result = {
        id: postId,
        success: false,
        skipped: true,
        imagePath: String(row.image_path),
        error: 'Media đã có dữ liệu; bật Ghi đè nếu muốn thay ảnh.',
      };
      job.skippedCount++;
    } else {
      const oldImagePath = String(row.image_path || '');
      const fileName = `${job.platform}-${postId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.png`;
      const outputPath = path.join(config.AI_GENERATED_IMAGES_DIR, job.platform, fileName);
      try {
        const referencePaths = useReference ? [resolveReferenceImage(oldImagePath)] : [];
        let preparedPrompt = prepareImagePrompt(prompt, row, job.platform);
        if (job.provider === 'kira' && referencePaths.length) {
          preparedPrompt = await prepareKiraReferencePrompt(
            referencePaths[0],
            preparedPrompt,
            imageProviderConfig
          );
        }
        const generated = job.provider === 'kira'
          ? await generateKiraImage(preparedPrompt, outputPath, imageProviderConfig)
          : await ChatGptLocalService.generateImage(
            preparedPrompt,
            outputPath,
            {
              cwd: config.DATA_ROOT,
              executable: imageProviderConfig.cliPath,
              referencePaths,
            }
          );
        const updated = DataService.update(postId, { image_path: generated.outputPath }, job.platform);
        if (!updated) throw new Error('Không cập nhật được hàng dữ liệu sau khi tạo ảnh.');
        result = {
          id: postId,
          success: true,
          oldImagePath,
          imagePath: updated.image_path,
          size: generated.size,
        };
        job.successCount++;
      } catch (error) {
        result = {
          id: postId,
          success: false,
          error: String(error?.message || error || 'Lỗi tạo ảnh').slice(0, 500),
        };
        job.failureCount++;
      }
    }
    job.results.push(result);
    job.completed++;
    job.updatedAt = new Date().toISOString();
  }

  job.status = job.failureCount || job.skippedCount ? 'partial' : 'completed';
  if (!job.successCount && job.failureCount && !job.skippedCount) job.status = 'failed';
  job.updatedAt = new Date().toISOString();
}

async function startImageJob({
  platform,
  provider = 'chatgpt',
  prompt,
  postIds,
  overwrite = false,
  useReference = false,
}) {
  platform = normalizePlatform(platform);
  provider = assertProvider(provider);
  if (!['chatgpt', 'kira'].includes(provider)) {
    throw new Error('Tạo ảnh hiện hỗ trợ ChatGPT hoặc Kira API.');
  }
  const ids = [...new Set((postIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) throw new Error('Hãy chọn ít nhất một hàng để tạo ảnh.');
  if (ids.length > 20) throw new Error('Mỗi lượt ChatGPT hỗ trợ tối đa 20 hàng tạo ảnh.');
  const cleanedPrompt = String(prompt || '').trim();
  if (!cleanedPrompt) throw new Error('Prompt tạo ảnh không được để trống.');
  if (cleanedPrompt.length > 12000) throw new Error('Prompt dài tối đa 12.000 ký tự.');

  const imageProviderConfig = getProviderConfig(provider);
  if (provider === 'chatgpt') {
    await ChatGptLocalService.requireChatGptLogin({ executable: imageProviderConfig.cliPath });
  } else {
    requireConfigured(imageProviderConfig);
    if (!imageProviderConfig.imageModel) throw new Error('Chưa chọn model tạo ảnh Kira.');
  }
  setSettings({
    [scopedSettingKey(platform, 'ai_image_prompt')]: cleanedPrompt,
    [scopedSettingKey(platform, 'ai_last_image_provider')]: provider,
  });

  cleanupImageJobs();
  const rowsById = new Map(DataService.getAllWithCustomData(platform).map(row => [Number(row.id), row]));
  const now = new Date().toISOString();
  const job = {
    id: crypto.randomUUID(),
    status: 'queued',
    platform,
    provider,
    useReference: Boolean(useReference),
    postIds: ids,
    total: ids.length,
    completed: 0,
    successCount: 0,
    failureCount: 0,
    skippedCount: 0,
    results: [],
    createdAt: now,
    updatedAt: now,
  };
  imageJobs.set(job.id, job);
  setImmediate(() => {
    processImageJob(
      job,
      rowsById,
      cleanedPrompt,
      Boolean(overwrite),
      Boolean(useReference),
      imageProviderConfig
    ).catch(error => {
      job.status = 'failed';
      job.failureCount = Math.max(job.failureCount, job.total - job.completed);
      job.updatedAt = new Date().toISOString();
      job.results.push({
        id: 0,
        success: false,
        error: String(error?.message || error || 'Lỗi job tạo ảnh').slice(0, 500),
      });
    });
  });
  return publicImageJob(job);
}

async function generateStandaloneImage({
  platform = 'facebook',
  provider = 'chatgpt',
  prompt,
}) {
  platform = normalizePlatform(platform);
  provider = assertProvider(provider);
  if (!['chatgpt', 'kira'].includes(provider)) {
    throw new Error('Tạo ảnh hiện hỗ trợ ChatGPT hoặc Kira API.');
  }
  const cleanedPrompt = String(prompt || '').trim();
  if (!cleanedPrompt) throw new Error('Prompt tạo ảnh không được để trống.');
  if (cleanedPrompt.length > 12000) throw new Error('Prompt dài tối đa 12.000 ký tự.');

  const imageProviderConfig = getProviderConfig(provider);
  if (provider === 'chatgpt') {
    await ChatGptLocalService.requireChatGptLogin({ executable: imageProviderConfig.cliPath });
  } else {
    requireConfigured(imageProviderConfig);
    if (!imageProviderConfig.imageModel) throw new Error('Chưa chọn model tạo ảnh Kira.');
  }

  setSettings({
    [scopedSettingKey(platform, 'ai_image_prompt')]: cleanedPrompt,
    [scopedSettingKey(platform, 'ai_last_image_provider')]: provider,
  });

  const outputPath = path.join(
    config.AI_GENERATED_IMAGES_DIR,
    'telegram',
    `${platform}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.png`
  );
  const generated = provider === 'kira'
    ? await generateKiraImage(cleanedPrompt, outputPath, imageProviderConfig)
    : await ChatGptLocalService.generateImage(cleanedPrompt, outputPath, {
      cwd: config.DATA_ROOT,
      executable: imageProviderConfig.cliPath,
      referencePaths: [],
    });

  return {
    provider,
    platform,
    prompt: cleanedPrompt,
    imagePath: generated.outputPath,
    size: generated.size,
  };
}

function getImageJob(jobId) {
  const job = imageJobs.get(String(jobId || ''));
  if (!job) throw new Error('Không tìm thấy job tạo ảnh.');
  return publicImageJob(job);
}

const AiContentService = {
  PROVIDERS,
  DEFAULT_PROMPT,
  DEFAULT_IMAGE_PROMPT,
  getSettings,
  saveSettings,
  testConnection,
  rewritePosts,
  startImageJob,
  generateStandaloneImage,
  getImageJob,
  _private: {
    cleanGeneratedText,
    generateText,
    generateKiraImage,
    prepareKiraReferencePrompt,
    referenceDataUri,
    detectImageFormat,
    getProviderConfig,
    listModels,
    preparePrompt,
    prepareImagePrompt,
    processImageJob,
    publicImageJob,
    resolveReferenceImage,
    readSecrets,
    setFetchImpl(value) {
      fetchImpl = value || ((...args) => fetch(...args));
    },
    setSecretsPaths(dataPath, keyPath) {
      secretsPath = dataPath || config.AI_SECRETS_PATH;
      secretsKeyPath = keyPath || config.AI_SECRETS_KEY_PATH;
    },
  },
};

module.exports = AiContentService;
