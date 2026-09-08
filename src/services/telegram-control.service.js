const fs = require('fs');
const path = require('path');
const config = require('../../config');
const db = require('../database/init');
const DataService = require('./data.service');
const BrowserService = require('./browser.service');
const RunnerManager = require('./runner-manager.service');
const SchedulerService = require('./scheduler.service');
const LicenseService = require('./license.service');
const AiContentService = require('./ai-content.service');
const ManagedTargetsService = require('./managed-targets.service');
const Telegram = require('./telegram-notification.service');
const { PLATFORMS, normalizePlatform } = require('../platforms/platform.utils');

const PLATFORM_LABELS = {
  facebook: 'Facebook',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  instagram: 'Instagram',
  threads: 'Threads',
  x: 'X',
  zalovideo: 'Zalo Video',
};
const PAGE_SIZE = 8;
const sessions = new Map();

function sessionFor(chatId) {
  const key = String(chatId);
  if (!sessions.has(key)) sessions.set(key, { step: 'home', platforms: [], profileIds: [], filters: { groups: [], providers: [], name: '' } });
  return sessions.get(key);
}

function clearSession(chatId) {
  sessions.delete(String(chatId));
}

function isResetCommand(text) {
  const value = String(text || '').trim();
  return /^\/(?:start|reset)(?:@[A-Za-z0-9_]+)?(?:\s+.*)?$/i.test(value);
}

function keyboard(rows) {
  return { inline_keyboard: rows.map(row => row.map(item => (
    typeof item === 'string' ? { text: item, callback_data: item } : item
  ))) };
}

async function send(chatId, text, rows = [], extra = {}) {
  const session = sessionFor(chatId);
  const markup = rows.length ? keyboard(rows) : { inline_keyboard: [] };
  if (!session.preserveMessages && session.activeMessageId) {
    try {
      return await Telegram.sendBotRequest('editMessageText', {
        chat_id: chatId,
        message_id: session.activeMessageId,
        text: String(text).slice(0, 4096),
        reply_markup: markup,
        ...extra,
      });
    } catch (_) {
      session.activeMessageId = null;
    }
  }
  const result = await Telegram.sendBotRequest('sendMessage', {
    chat_id: chatId,
    text: String(text).slice(0, 4096),
    ...(rows.length ? { reply_markup: keyboard(rows) } : {}),
    ...extra,
  });
  if (!session.preserveMessages && result?.message_id) session.activeMessageId = result.message_id;
  return result;
}

async function sendResult(chatId, text, rows = [], extra = {}) {
  const session = sessionFor(chatId);
  const previousPreserve = session.preserveMessages;
  const previousMessageId = session.activeMessageId;
  session.preserveMessages = true;
  session.activeMessageId = null;
  try {
    return await send(chatId, text, rows, extra);
  } finally {
    session.preserveMessages = previousPreserve;
    session.activeMessageId = previousMessageId;
  }
}

async function answer(queryId) {
  if (!queryId) return;
  try { await Telegram.sendBotRequest('answerCallbackQuery', { callback_query_id: queryId }); } catch (_) {}
}

function profileRows(session) {
  let profiles = BrowserService.getAll('all');
  const filters = session.filters || {};
  if (filters.name) {
    const needle = String(filters.name).toLocaleLowerCase('vi');
    profiles = profiles.filter(profile => String(profile.name || '').toLocaleLowerCase('vi').includes(needle));
  }
  if (filters.providers?.length) {
    profiles = profiles.filter(profile => filters.providers.includes(String(profile.provider || 'chrome')));
  }
  if (filters.groups?.length) {
    profiles = profiles.filter(profile => (profile.groups || []).some(group => filters.groups.includes(Number(group.id))));
  }
  return profiles;
}

function renderHome() {
  return {
    text: 'Super Post - King',
    rows: [
      [{ text: 'Đăng bài', callback_data: 'ctl:post' }, { text: 'Báo cáo', callback_data: 'ctl:report' }],
      [{ text: 'Trạng thái', callback_data: 'ctl:status' }, { text: 'Hướng dẫn', callback_data: 'ctl:help' }],
    ],
  };
}

async function showHome(chatId) {
  clearSession(chatId);
  const menu = renderHome();
  await send(chatId, menu.text, menu.rows);
}

async function showPostMode(chatId) {
  const session = sessionFor(chatId);
  session.platforms = [];
  session.profileIds = [];
  session.filters = { groups: [], providers: [], name: '' };
  session.extra = {};
  session.extraIndex = 0;
  session.extraSteps = [];
  session.dataSource = 'new';
  session.step = 'mode';
  await send(chatId, 'Đăng bài', [
    [{ text: 'Đăng ngay', callback_data: 'ctl:mode:now' }, { text: 'Hẹn giờ', callback_data: 'ctl:mode:schedule' }],
    [{ text: 'Quay lại', callback_data: 'ctl:home' }],
  ]);
}

async function showPlatforms(chatId) {
  const session = sessionFor(chatId);
  session.step = 'platforms';
  const rows = [];
  for (let index = 0; index < PLATFORMS.length; index += 2) {
    rows.push(PLATFORMS.slice(index, index + 2).map(platform => ({
      text: session.platformMode === 'many' && session.platforms.includes(platform)
        ? `✅ ${PLATFORM_LABELS[platform]}`
        : `○ ${PLATFORM_LABELS[platform]}`,
      callback_data: `ctl:platform:${platform}`,
    })));
  }
  rows.push(session.platformMode === 'many'
    ? [{ text: 'Tiếp tục', callback_data: 'ctl:platforms:done' }, { text: 'Quay lại', callback_data: 'ctl:platforms:choice' }]
    : [{ text: 'Quay lại', callback_data: 'ctl:platforms:choice' }]);
  await send(chatId, session.platformMode === 'many' ? 'Chọn nhiều nền tảng' : 'Chọn một nền tảng', rows);
}

async function showPlatformChoice(chatId) {
  const session = sessionFor(chatId);
  session.step = 'platform_choice';
  await send(chatId, 'Nền tảng đăng bài', [
    [{ text: 'Một nền tảng', callback_data: 'ctl:platforms:one' }, { text: 'Nhiều nền tảng', callback_data: 'ctl:platforms:many' }],
    [{ text: 'Quay lại', callback_data: 'ctl:post' }],
  ]);
}

async function showProfileFilters(chatId) {
  const session = sessionFor(chatId);
  session.step = 'profile_filters';
  await send(chatId, 'Lọc profile', [
    [{ text: 'Theo nhóm', callback_data: 'ctl:filter:groups' }, { text: 'Theo loại', callback_data: 'ctl:filter:providers' }],
    [{ text: 'Tìm tên', callback_data: 'ctl:filter:name' }, { text: 'Xóa lọc', callback_data: 'ctl:filter:clear' }],
    [{ text: 'Xem danh sách', callback_data: 'ctl:profiles' }],
  ]);
}

async function showGroups(chatId) {
  const session = sessionFor(chatId);
  const groups = BrowserService.getGroups('all');
  session.step = 'groups';
  const rows = groups.map(group => [{
    text: `${session.filters.groups.includes(Number(group.id)) ? '✅' : '○'} ${group.name} · ${group.profile_count || 0}`,
    callback_data: `ctl:group:${group.id}`,
  }]);
  rows.push([{ text: 'Xong', callback_data: 'ctl:profiles' }]);
  await send(chatId, 'Chọn nhóm profile', rows.length > 1 ? rows : [[{ text: 'Chưa có nhóm', callback_data: 'ctl:profiles' }]]);
}

async function showProviders(chatId) {
  const session = sessionFor(chatId);
  const providers = [...new Set(BrowserService.getAll('all').map(profile => String(profile.provider || 'chrome')))].sort();
  session.step = 'providers';
  const rows = providers.map(provider => [{
    text: `${session.filters.providers.includes(provider) ? '✅' : '○'} ${provider}`,
    callback_data: `ctl:provider:${provider}`,
  }]);
  rows.push([{ text: 'Xong', callback_data: 'ctl:profiles' }]);
  await send(chatId, 'Chọn loại trình duyệt', rows.length > 1 ? rows : [[{ text: 'Chưa có dữ liệu', callback_data: 'ctl:profiles' }]]);
}

async function showProfiles(chatId, page = 0) {
  const session = sessionFor(chatId);
  const profiles = profileRows(session);
  const totalPages = Math.max(1, Math.ceil(profiles.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, Number(page) || 0), totalPages - 1);
  session.step = 'profiles';
  session.profilePage = currentPage;
  const rows = [];
  for (const profile of profiles.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)) {
    const selected = session.profileIds.includes(Number(profile.id));
    const groupText = (profile.groups || []).map(group => group.name).slice(0, 1).join(', ');
    rows.push([{
      text: `${selected ? '✅' : '○'} ${String(profile.name || `Profile ${profile.id}`).slice(0, 28)} · ${profile.provider || 'chrome'}${groupText ? ` · ${groupText}` : ''}`,
      callback_data: `ctl:profile:${profile.id}`,
    }]);
  }
  rows.push([{ text: 'Chọn tất cả kết quả', callback_data: 'ctl:profiles:all' }]);
  rows.push([
    { text: 'Lọc', callback_data: 'ctl:profile:filters' },
    { text: `${currentPage + 1}/${totalPages}`, callback_data: 'ctl:profiles:noop' },
    { text: 'Tiếp', callback_data: `ctl:profiles:page:${Math.min(totalPages - 1, currentPage + 1)}` },
  ]);
  rows.push([{ text: `Xác nhận (${session.profileIds.length}/${profiles.length})`, callback_data: 'ctl:profiles:done' }]);
  await send(chatId, `Chọn profile · ${profiles.length} kết quả`, rows);
}

function parseScheduleTime(value) {
  const text = String(value || '').trim();
  let date;
  if (/^\d{1,2}:\d{2}$/.test(text)) {
    const [hour, minute] = text.split(':').map(Number);
    date = new Date();
    date.setHours(hour, minute, 0, 0);
    if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1);
  } else {
    date = new Date(text.replace(' ', 'T'));
  }
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) return null;
  return date.toISOString();
}

function reportData(days = 7, question = '') {
  const value = String(question || '').toLocaleLowerCase('vi');
  const safeDays = Math.min(365, Math.max(1, Number(days) || 7));
  const platform = PLATFORMS.find(item => value.includes(item)) || 'all';
  const status = /thành công|thanh cong|success/.test(value)
    ? 'success'
    : /lỗi|loi|error/.test(value) ? 'error' : 'all';
  const profileMatch = value.match(/profile\s+([a-z0-9._-]+)/i);
  const profile = profileMatch ? profileMatch[1] : '';
  const params = [`-${safeDays - 1} days`];
  const conditions = [
    `a.type = 'post'`,
    `date(a.created_at, 'localtime') >= date('now', 'localtime', ?)`,
  ];
  if (platform !== 'all') {
    conditions.push('a.platform = ?');
    params.push(platform);
  }
  if (status !== 'all') {
    conditions.push('a.status = ?');
    params.push(status);
  }
  if (profile) {
    conditions.push('LOWER(COALESCE(b.name, \'\')) LIKE ?');
    params.push(`%${profile.toLocaleLowerCase('vi')}%`);
  }
  const rows = db.prepare(`
    SELECT a.platform, a.status, COALESCE(b.name, '') AS profile, COUNT(*) AS count
    FROM activity_logs a
    LEFT JOIN browsers b ON b.id = a.profile_id
    WHERE ${conditions.join(' AND ')}
    GROUP BY a.platform, a.status, b.name
    ORDER BY count DESC
    LIMIT 200
  `).all(...params);
  return { days: safeDays, platform, status, profile, rows };
}

async function analyzeReport(chatId, question) {
  const request = String(question || '').trim();
  const value = request.toLocaleLowerCase('vi');
  const days = /hôm nay|hom nay|today/.test(value) ? 1 : /30|tháng|thang/.test(value) ? 30 : 7;
  const data = reportData(days, request);
  try {
    const aiSettings = AiContentService.getSettings('facebook');
    const provider = aiSettings.activeProvider;
    const providerConfig = AiContentService._private.getProviderConfig(provider);
    const prompt = [
      'Bạn là trợ lý phân tích số liệu của Super Post - King.',
      'Chỉ dùng số liệu JSON được cung cấp, không tự đoán và không bịa số.',
      'Trả lời tiếng Việt ngắn gọn, có tiêu đề và các dòng chính.',
      `Câu hỏi: ${request}`,
      `Dữ liệu: ${JSON.stringify(data)}`,
    ].join('\n');
    const answer = await AiContentService._private.generateText(provider, providerConfig, prompt);
    if (answer) {
      return sendResult(chatId, `📊 ${answer.slice(0, 3500)}`, [[{ text: 'Báo cáo khác', callback_data: 'ctl:report:custom' }, { text: 'Trang chủ', callback_data: 'ctl:home' }]]);
    }
  } catch (_) {}
  return report(chatId, days);
}

function mediaFromMessage(message) {
  if (message?.photo?.length) return { fileId: message.photo[message.photo.length - 1].file_id, name: 'telegram-photo.jpg' };
  if (message?.video) return { fileId: message.video.file_id, name: message.video.file_name || 'telegram-video.mp4' };
  if (message?.document) return { fileId: message.document.file_id, name: message.document.file_name || 'telegram-file' };
  return null;
}

async function downloadMedia(media) {
  const file = await Telegram.sendBotRequest('getFile', { file_id: media.fileId });
  const state = Telegram.internalState();
  const response = await fetch(`https://api.telegram.org/file/bot${state.token}/${file.file_path}`);
  if (!response.ok) throw new Error('Không tải được media từ Telegram.');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 50 * 1024 * 1024) throw new Error('Media Telegram tối đa 50 MB.');
  const extension = path.extname(media.name || file.file_path || '') || '.bin';
  const safeName = `telegram_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${extension.toLowerCase()}`;
  fs.mkdirSync(config.UPLOADS_DIR, { recursive: true });
  const target = path.join(config.UPLOADS_DIR, safeName);
  fs.writeFileSync(target, buffer);
  return target;
}

async function askContent(chatId) {
  const session = sessionFor(chatId);
  session.step = 'content_manual';
  await send(chatId, 'Gửi nội dung bài đăng.', [
    [{ text: 'Quay lại', callback_data: 'ctl:content:menu' }, { text: 'Hủy', callback_data: 'ctl:home' }],
  ]);
}

async function askMedia(chatId) {
  const session = sessionFor(chatId);
  session.step = 'media_upload';
  await send(chatId, 'Gửi ảnh hoặc video.', [
    [{ text: 'Quay lại', callback_data: 'ctl:content:menu' }, { text: 'Hủy', callback_data: 'ctl:home' }],
  ]);
}

async function askAiContent(chatId) {
  const session = sessionFor(chatId);
  session.step = 'content_ai_prompt';
  await send(chatId, 'Nhập ý chính hoặc nội dung gốc để AI viết.', [
    [{ text: 'Quay lại', callback_data: 'ctl:content:menu' }, { text: 'Hủy', callback_data: 'ctl:home' }],
  ]);
}

async function askAiImage(chatId) {
  const session = sessionFor(chatId);
  session.step = 'image_ai_prompt';
  await send(chatId, 'Mô tả hình ảnh muốn tạo.', [
    [{ text: 'Quay lại', callback_data: 'ctl:content:menu' }, { text: 'Hủy', callback_data: 'ctl:home' }],
  ]);
}

async function showContentMenu(chatId) {
  const session = sessionFor(chatId);
  session.step = 'content_menu';
  const contentState = String(session.content || '').trim()
    ? `Nội dung: ${String(session.content).trim().slice(0, 120)}${String(session.content).trim().length > 120 ? '…' : ''}`
    : 'Nội dung: Chưa có';
  const mediaState = session.mediaPath ? 'Media: Đã có' : 'Media: Chưa có';
  await send(chatId, `${contentState}\n${mediaState}`, [
    [
      { text: 'Nhập nội dung', callback_data: 'ctl:content:manual' },
      { text: 'AI viết nội dung', callback_data: 'ctl:content:ai' },
      { text: 'Dữ liệu bảng', callback_data: 'ctl:content:table' },
    ],
    [
      { text: 'Gửi ảnh/video', callback_data: 'ctl:media:upload' },
      { text: 'AI tạo ảnh', callback_data: 'ctl:media:ai' },
    ],
    [
      { text: 'Tiếp tục', callback_data: 'ctl:content:done' },
      { text: 'Hủy', callback_data: 'ctl:home' },
    ],
  ]);
}

function tableRowsForSession(session, platform) {
  const selectedProfiles = new Set(
    BrowserService.getAll('all')
      .filter(profile => session.profileIds.includes(Number(profile.id)))
      .map(profile => String(profile.name || '').trim())
      .filter(Boolean)
  );
  if (!selectedProfiles.size) return [];

  DataService.ensurePlatformDefaultColumns(platform);
  const columns = DataService.getCustomColumns(platform);
  const profileColumn = columns.find(column => column.var_key === 'name_profile');
  if (!profileColumn) return [];

  const pendingRows = DataService.getAll(platform).filter(row => {
    const status = String(row.status || '').trim().toLowerCase();
    return status === 'pending' || status === 'chờ' || status === 'cho';
  });
  if (!pendingRows.length) return [];

  const ids = pendingRows.map(row => row.id);
  const values = db.prepare(
    `SELECT post_id, value FROM post_custom_data
     WHERE column_id = ? AND post_id IN (${ids.map(() => '?').join(',')})`
  ).all(profileColumn.id, ...ids);
  const profileByPost = new Map(values.map(item => [
    Number(item.post_id),
    String(item.value || '').trim(),
  ]));
  return pendingRows.filter(row => selectedProfiles.has(profileByPost.get(Number(row.id)) || ''));
}

async function showTableDataMenu(chatId) {
  const session = sessionFor(chatId);
  const summary = session.platforms.map(platform => ({
    platform,
    count: tableRowsForSession(session, platform).length,
  }));
  const total = summary.reduce((sum, item) => sum + item.count, 0);
  if (!total) {
    return send(chatId, 'Không có hàng Chờ phù hợp với profile đã chọn.', [
      [{ text: 'Quay lại', callback_data: 'ctl:content:menu' }, { text: 'Hủy', callback_data: 'ctl:home' }],
    ]);
  }

  session.dataSource = 'table';
  session.step = 'table_preview';
  const lines = [
    'Chạy dữ liệu bảng',
    '',
    ...summary
      .filter(item => item.count > 0)
      .map(item => `${PLATFORM_LABELS[item.platform]} · ${item.count} hàng Chờ`),
    '',
    'Tool sẽ bỏ qua hàng đã hoàn tất, hàng lỗi và hàng không đúng profile.',
  ];
  await send(chatId, lines.join('\n'), [
    [{ text: session.mode === 'schedule' ? 'Lưu lịch' : 'Chạy ngay', callback_data: 'ctl:post:confirm' }],
    [{ text: 'Quay lại', callback_data: 'ctl:content:menu' }, { text: 'Hủy', callback_data: 'ctl:home' }],
  ]);
}

async function generateAiContent(chatId, input) {
  const session = sessionFor(chatId);
  const source = String(input || '').trim();
  if (!source) return askAiContent(chatId);
  const settings = AiContentService.getSettings('facebook');
  const provider = settings.activeProvider;
  const providerConfig = AiContentService._private.getProviderConfig(provider);
  const platformNames = session.platforms.map(platform => PLATFORM_LABELS[platform]).join(', ');
  await send(chatId, `AI ${provider} đang viết nội dung...`);
  try {
    session.content = await AiContentService._private.generateText(
      provider,
      providerConfig,
      AiContentService._private.preparePrompt(settings.prompt, source, platformNames)
    );
    return showContentMenu(chatId);
  } catch (error) {
    session.step = 'content_ai_prompt';
    return send(chatId, `Không thể viết nội dung: ${String(error?.message || error).slice(0, 500)}`, [
      [{ text: 'Thử lại', callback_data: 'ctl:content:ai' }, { text: 'Quay lại', callback_data: 'ctl:content:menu' }],
    ]);
  }
}

async function generateAiImage(chatId, input) {
  const session = sessionFor(chatId);
  const prompt = String(input || '').trim();
  if (!prompt) return askAiImage(chatId);
  const settings = AiContentService.getSettings('facebook');
  const provider = settings.activeImageProvider;
  await send(chatId, `AI ${provider} đang tạo ảnh...`);
  try {
    const generated = await AiContentService.generateStandaloneImage({
      platform: session.platforms[0] || 'facebook',
      provider,
      prompt,
    });
    session.mediaPath = generated.imagePath;
    return showContentMenu(chatId);
  } catch (error) {
    session.step = 'image_ai_prompt';
    return send(chatId, `Không thể tạo ảnh: ${String(error?.message || error).slice(0, 500)}`, [
      [{ text: 'Thử lại', callback_data: 'ctl:media:ai' }, { text: 'Quay lại', callback_data: 'ctl:content:menu' }],
    ]);
  }
}

async function previewPost(chatId) {
  const session = sessionFor(chatId);
  session.step = 'preview';
  session.preserveMessages = true;
  session.activeMessageId = null;
  const media = session.mediaPath ? 'Có media' : 'Không có media';
  const fanpageCount = session.extra?.facebook?.fanpageMappings?.length || 0;
  const profileNames = BrowserService.getAll('all')
    .filter(profile => session.profileIds.includes(Number(profile.id)))
    .map(profile => profile.name)
    .slice(0, 8);
  const lines = [
    'Xác nhận nhiệm vụ đăng bài',
    `Nền tảng: ${session.platforms.map(platform => PLATFORM_LABELS[platform]).join(', ')}`,
    `Profile: ${profileNames.join(', ') || 'Chưa chọn'}${session.profileIds.length > 8 ? ` +${session.profileIds.length - 8}` : ''}`,
    `Media: ${media}`,
    ...(fanpageCount ? [`Fanpage: ${fanpageCount} đã ghép theo profile`] : []),
    `Chế độ: ${session.mode === 'schedule' ? `Hẹn ${new Date(session.scheduleTime).toLocaleString('vi-VN')}` : 'Đăng ngay'}`,
    '',
    String(session.content || '').slice(0, 900) || '(Không có caption)',
  ];
  await send(chatId, lines.join('\n'), [
    [{ text: session.mode === 'schedule' ? 'Lưu lịch' : 'Đăng bài', callback_data: 'ctl:post:confirm' }],
    [{ text: 'Sửa nội dung', callback_data: 'ctl:post:edit' }, { text: 'Hủy', callback_data: 'ctl:home' }],
  ]);
}

function extraFieldsFor(platform) {
  if (platform === 'facebook') return [{ key: 'link_fanpage', label: 'Link Fanpage (mỗi dòng một link)' }];
  if (platform === 'tiktok') return [{ key: 'product_id', label: 'ID sản phẩm TikTok (có thể bỏ qua)' }];
  if (platform === 'youtube') return [
    { key: 'channel_name', label: 'Tên kênh YouTube (có thể bỏ qua)' },
    { key: 'playlist', label: 'Tên danh sách phát (có thể bỏ qua)' },
  ];
  if (platform === 'zalovideo') return [{ key: 'playlist', label: 'Tên danh sách phát (có thể bỏ qua)' }];
  return [];
}

function splitTargetLinks(value) {
  return [...new Set(String(value || '')
    .split(/[\n,;]+/)
    .map(item => item.trim())
    .filter(Boolean))];
}

function targetMatchSummary(matches) {
  const matched = matches.filter(item => item.status === 'matched');
  const ambiguous = matches.filter(item => item.status === 'ambiguous');
  const unmatched = matches.filter(item => item.status === 'unmatched');
  return { matched, ambiguous, unmatched };
}

async function mapTelegramFanpages(chatId, value) {
  const session = sessionFor(chatId);
  const links = splitTargetLinks(value);
  if (!links.length) return send(chatId, 'Hãy gửi ít nhất 1 link Fanpage.');
  const matches = ManagedTargetsService.matchTargets('facebook', links, session.profileIds);
  const summary = targetMatchSummary(matches);
  if (summary.ambiguous.length || summary.unmatched.length) {
    session.step = 'fanpage_match_review';
    session.pendingTargetMatches = matches;
    const lines = [
      `Đã ghép ${summary.matched.length}/${matches.length} link.`,
      summary.ambiguous.length ? `Cần chọn profile: ${summary.ambiguous.map(item => item.input).join(', ')}` : '',
      summary.unmatched.length ? `Chưa có dữ liệu: ${summary.unmatched.map(item => item.input).join(', ')}` : '',
      '',
      'Hãy cập nhật Danh sách trên máy tính rồi gửi lại link chưa ghép.',
    ].filter(Boolean);
    return send(chatId, lines.join('\n'), [
      [{ text: 'Dùng link đã ghép', callback_data: 'ctl:fanpage:accept-matched' }],
      [{ text: 'Quay lại', callback_data: 'ctl:content:menu' }, { text: 'Hủy', callback_data: 'ctl:home' }],
    ]);
  }
  session.extra = session.extra || {};
  session.extra.facebook = {
    ...(session.extra.facebook || {}),
    link_fanpage: links.join('\n'),
    fanpageMappings: summary.matched.map(item => item.matches[0]),
  };
  session.extraIndex += 1;
  return askPlatformExtra(chatId);
}

async function mapTelegramChannels(chatId, value) {
  const session = sessionFor(chatId);
  const names = splitTargetLinks(value);
  if (!names.length) return send(chatId, 'Hãy gửi ít nhất 1 tên kênh YouTube.');
  const catalog = ManagedTargetsService.all('youtube').filter(item =>
    !session.profileIds.length || session.profileIds.includes(Number(item.profile_id))
  );
  const matches = names.map(input => {
    const key = String(input).trim().toLocaleLowerCase('vi');
    const found = catalog.filter(item =>
      String(item.name || '').trim().toLocaleLowerCase('vi') === key
      || String(item.id || '').trim() === input
      || String(item.url || '').trim() === input
    );
    return { input, matches, status: found.length === 1 ? 'matched' : found.length > 1 ? 'ambiguous' : 'unmatched' };
  });
  const summary = targetMatchSummary(matches);
  if (summary.ambiguous.length || summary.unmatched.length) {
    session.step = 'channel_match_review';
    session.pendingChannelMatches = matches;
    return send(chatId, `Đã ghép ${summary.matched.length}/${matches.length} kênh.\n` +
      (summary.ambiguous.length ? `Cần chọn profile: ${summary.ambiguous.map(item => item.input).join(', ')}\n` : '') +
      (summary.unmatched.length ? `Chưa có dữ liệu: ${summary.unmatched.map(item => item.input).join(', ')}` : ''), [
      [{ text: 'Dùng kênh đã ghép', callback_data: 'ctl:channel:accept-matched' }],
      [{ text: 'Quay lại', callback_data: 'ctl:content:menu' }, { text: 'Hủy', callback_data: 'ctl:home' }],
    ]);
  }
  session.extra = session.extra || {};
  session.extra.youtube = {
    ...(session.extra.youtube || {}),
    channel_name: names.join('\n'),
    channelMappings: summary.matched.map(item => item.matches[0]),
  };
  session.extraIndex += 1;
  return askPlatformExtra(chatId);
}

async function askPlatformExtra(chatId) {
  const session = sessionFor(chatId);
  while (session.extraIndex < (session.extraSteps || []).length) {
    const step = session.extraSteps[session.extraIndex];
    const platform = step.platform;
    session.step = 'platform_extra';
    session.extraPlatform = platform;
    session.extraKey = step.key;
    return send(chatId, `${PLATFORM_LABELS[platform]}\n${step.label}`, [
      [{ text: 'Bỏ qua', callback_data: 'ctl:extra:skip' }],
      [{ text: 'Hủy', callback_data: 'ctl:home' }],
    ]);
  }
  return previewPost(chatId);
}

async function finishContent(chatId) {
  const session = sessionFor(chatId);
  session.extraSteps = session.platforms.flatMap(platform =>
    extraFieldsFor(platform).map(field => ({ platform, ...field }))
  );
  session.extraIndex = 0;
  session.extra = session.extra || {};
  return askPlatformExtra(chatId);
}

async function createRows(session) {
  const rowsByPlatform = {};
  const selectedProfiles = BrowserService.getAll('all')
    .filter(profile => session.profileIds.includes(Number(profile.id)));
  if (!selectedProfiles.length) throw new Error('Không tìm thấy profile đã chọn.');

  for (const platform of session.platforms) {
    const extra = session.extra?.[platform] || {};
    DataService.ensurePlatformDefaultColumns(platform);
    const columns = DataService.getCustomColumns(platform);
    const rows = [];
    const mappedTargets = platform === 'facebook'
      ? extra.fanpageMappings
      : platform === 'youtube' ? extra.channelMappings : null;
    const targets = Array.isArray(mappedTargets) && mappedTargets.length
      ? mappedTargets.map(target => ({
          profileName: target.profile_name,
          fanpage: platform === 'facebook' ? (target.url || target.id) : '',
          channel: platform === 'youtube' ? (target.name || target.id) : '',
        }))
      : selectedProfiles.map(profile => ({
          profileName: profile.name,
          fanpage: platform === 'facebook' ? (extra.link_fanpage || '') : '',
          channel: platform === 'youtube' ? (extra.channel_name || '') : '',
        }));
    for (const target of targets) {
      const row = DataService.create({
        content: session.content || '',
        image_path: session.mediaPath || '',
        link: platform === 'facebook' ? target.fanpage : '',
        product_id: platform === 'tiktok' ? (extra.product_id || '') : '',
        status: 'pending',
        note: 'Tạo từ Telegram',
      }, platform);
      const values = {
        name_profile: target.profileName,
        playlist: extra.playlist,
        channel_name: target.channel || extra.channel_name,
        link_fanpage: target.fanpage,
      };
      for (const [key, value] of Object.entries(values)) {
        if (!value) continue;
        const column = columns.find(item => item.var_key === key);
        if (column) DataService.setCustomData(row.id, column.id, value, platform);
      }
      rows.push(row.id);
    }
    rowsByPlatform[platform] = rows;
  }
  return rowsByPlatform;
}

async function activatePost(chatId) {
  const session = sessionFor(chatId);
  if (session.mode !== 'schedule') {
    const busyPlatforms = session.platforms.filter(platform => RunnerManager.get(platform).isRunning);
    if (busyPlatforms.length) {
      return send(
        chatId,
        `Chưa thể đăng ngay vì đang có tác vụ chạy: ${busyPlatforms.map(platform => PLATFORM_LABELS[platform]).join(', ')}.`,
        [[{ text: 'Xem trạng thái', callback_data: 'ctl:status' }, { text: 'Quay lại', callback_data: 'ctl:content:menu' }]]
      );
    }
  }

  const rowsByPlatform = session.dataSource === 'table'
    ? Object.fromEntries(
      session.platforms.map(platform => [
        platform,
        tableRowsForSession(session, platform).map(row => Number(row.id)),
      ])
    )
    : await createRows(session);
  const output = [];
  for (const platform of session.platforms) {
    const dataIds = rowsByPlatform[platform];
    if (!dataIds.length) {
      output.push(`${PLATFORM_LABELS[platform]} · không có hàng Chờ phù hợp`);
      continue;
    }
    if (session.mode === 'schedule') {
      const schedule = SchedulerService.create({
        name: `Telegram · ${PLATFORM_LABELS[platform]}`,
        schedule_time: session.scheduleTime,
        schedule_type: 'once',
        profile_ids: session.profileIds,
        data_ids: dataIds,
        platform,
      });
      output.push(`${PLATFORM_LABELS[platform]} · đã hẹn #${schedule.id}`);
      continue;
    }
    const runner = RunnerManager.get(platform);
    LicenseService.assertPlatform(platform);
    const runConfig = {
      profileIds: session.profileIds,
      dataIds,
    };
    if (session.dataSource !== 'table') runConfig.maxPostsPerProfile = 1;
    const runPromise = runner.start(runConfig);
    await new Promise(resolve => setImmediate(resolve));
    if (!runner.isRunning || Number(runner.progress?.total || 0) === 0) {
      await runPromise.catch(() => {});
      for (const postId of dataIds) {
        DataService.update(postId, {
          status: 'error',
          note: 'Không khởi động được tác vụ từ Telegram.',
          link: 'Lỗi: Không khởi động được tác vụ từ Telegram.',
        }, platform);
      }
      output.push(`${PLATFORM_LABELS[platform]} · không khởi động được`);
      continue;
    }
    for (const postId of dataIds) {
      DataService.update(postId, {
        status: 'running',
        note: 'Đang chạy từ Telegram',
      }, platform);
    }
    runPromise.catch(() => {});
    output.push(`${PLATFORM_LABELS[platform]} · đang chạy ${dataIds.length} bài`);
  }
  await sendResult(chatId, `${session.mode === 'schedule' ? 'Đã lưu lịch' : 'Đã kích hoạt đăng bài'}\n\n${output.join('\n')}`);
  clearSession(chatId);
}

async function report(chatId, days = 1) {
  const safeDays = Math.min(365, Math.max(1, Number(days) || 1));
  const rows = db.prepare(`
    SELECT platform, status, COUNT(*) AS count
    FROM activity_logs
    WHERE type = 'post'
      AND date(created_at, 'localtime') >= date('now', 'localtime', ?)
    GROUP BY platform, status
  `).all(`-${safeDays - 1} days`);
  const totals = { success: 0, error: 0, other: 0 };
  const byPlatform = new Map();
  for (const row of rows) {
    const count = Number(row.count) || 0;
    if (row.status === 'success') totals.success += count;
    else if (row.status === 'error') totals.error += count;
    else totals.other += count;
    if (!byPlatform.has(row.platform)) byPlatform.set(row.platform, { success: 0, error: 0, other: 0 });
    const target = byPlatform.get(row.platform);
    if (row.status === 'success') target.success += count;
    else if (row.status === 'error') target.error += count;
    else target.other += count;
  }
  const total = totals.success + totals.error + totals.other;
  const lines = [
    `📊 Tổng kết ${safeDays === 1 ? 'hôm nay' : `${safeDays} ngày qua`}`,
    '',
    `Tổng: ${total}`,
    `✅ Thành công: ${totals.success}`,
    `❌ Lỗi: ${totals.error}`,
  ];
  if (totals.other) lines.push(`⏳ Khác: ${totals.other}`);
  for (const [platform, value] of byPlatform) {
    lines.push(`\n${PLATFORM_LABELS[platform] || platform}: ${value.success} thành công · ${value.error} lỗi`);
  }
  await sendResult(chatId, lines.join('\n'), [
    [{ text: '7 ngày', callback_data: 'ctl:report:7' }, { text: '30 ngày', callback_data: 'ctl:report:30' }],
    [{ text: 'Theo yêu cầu', callback_data: 'ctl:report:custom' }, { text: 'Trang chủ', callback_data: 'ctl:home' }],
  ]);
}

async function showStatus(chatId) {
  const status = RunnerManager.getStatus();
  const running = Object.entries(status).filter(([, value]) => value.isRunning);
  await sendResult(chatId, running.length
    ? `🔄 Đang chạy\n${running.map(([platform, value]) => `${PLATFORM_LABELS[platform] || platform} · ${value.progress?.completed || 0}/${value.progress?.total || 0}`).join('\n')}`
    : 'Không có tác vụ đang chạy.', [[{ text: 'Báo cáo', callback_data: 'ctl:report' }, { text: 'Trang chủ', callback_data: 'ctl:home' }]]);
}

async function handleText(chatId, message) {
  const session = sessionFor(chatId);
  const text = String(message.text || message.caption || '').trim();
  if (session.step === 'schedule_time') {
    const scheduleTime = parseScheduleTime(text);
    if (!scheduleTime) return send(chatId, 'Thời gian chưa hợp lệ. Ví dụ: 20:30 hoặc 2026-08-20 20:30');
    session.scheduleTime = scheduleTime;
    return showPlatformChoice(chatId);
  }
  if (session.step === 'content' || session.step === 'content_manual') {
    if (text) session.content = text;
    const media = mediaFromMessage(message);
    if (media) {
      try { session.mediaPath = await downloadMedia(media); } catch (error) { return send(chatId, error.message); }
    }
    return showContentMenu(chatId);
  }
  if (session.step === 'media_upload') {
    const media = mediaFromMessage(message);
    if (!media) return send(chatId, 'Hãy gửi một ảnh hoặc video.', [
      [{ text: 'Quay lại', callback_data: 'ctl:content:menu' }],
    ]);
    try {
      session.mediaPath = await downloadMedia(media);
      return showContentMenu(chatId);
    } catch (error) {
      return send(chatId, String(error?.message || error), [
        [{ text: 'Thử lại', callback_data: 'ctl:media:upload' }, { text: 'Quay lại', callback_data: 'ctl:content:menu' }],
      ]);
    }
  }
  if (session.step === 'content_ai_prompt') return generateAiContent(chatId, text);
  if (session.step === 'image_ai_prompt') return generateAiImage(chatId, text);
  if (session.step === 'fanpage_match_review') return mapTelegramFanpages(chatId, text);
  if (session.step === 'channel_match_review') return mapTelegramChannels(chatId, text);
  if (session.step === 'platform_extra') {
    const platform = session.extraPlatform || session.platforms[session.extraIndex];
    if (platform === 'facebook' && session.extraKey === 'link_fanpage') {
      return mapTelegramFanpages(chatId, text);
    }
    if (platform === 'youtube' && session.extraKey === 'channel_name') {
      return mapTelegramChannels(chatId, text);
    }
    session.extra = session.extra || {};
    session.extra[platform] = { ...(session.extra[platform] || {}), [session.extraKey]: text };
    session.extraIndex += 1;
    return askPlatformExtra(chatId);
  }
  if (session.step === 'report_custom') {
    session.step = 'home';
    return analyzeReport(chatId, text);
  }
  if (session.step === 'filter_name') {
    session.filters.name = text;
    return showProfiles(chatId);
  }
  return handleNaturalLanguage(chatId, text);
}

async function handleNaturalLanguage(chatId, text) {
  const value = String(text || '').toLocaleLowerCase('vi');
  if (/^(?:\/)?(?:start|reset|menu)(?:\s|$)/i.test(value)) return showHome(chatId);
  if (/^(?:\/)?post(?:\s|$)/i.test(value)) return showPostMode(chatId);
  if (/^(?:\/)?status(?:\s|$)/i.test(value)) return showStatus(chatId);
  if (/^(?:\/)?report(?:\s|$)/i.test(value)) return report(chatId, 1);
  if (/^(?:\/)?(?:help|trợ giúp)(?:\s|$)/i.test(value)) {
    return send(chatId, 'Chọn chức năng bên dưới.', [
      [{ text: 'Đăng bài', callback_data: 'ctl:post' }, { text: 'Báo cáo', callback_data: 'ctl:report' }],
      [{ text: 'Trạng thái', callback_data: 'ctl:status' }, { text: 'Trang chủ', callback_data: 'ctl:home' }],
    ]);
  }
  if (/báo cáo|tổng kết|thống kê/.test(value)) {
    const days = /30|tháng/.test(value) ? 30 : /7|tuần/.test(value) ? 7 : 1;
    return report(chatId, days);
  }
  if (/trạng thái|đang chạy/.test(value)) return showStatus(chatId);
  const control = Telegram.settings().controlAiEnabled;
  if (control) {
    try {
      const aiSettings = AiContentService.getSettings('facebook');
      const provider = aiSettings.activeProvider;
      const providerConfig = AiContentService._private.getProviderConfig(provider);
      const generated = await AiContentService._private.generateText(provider, providerConfig, [
        'Chuyển yêu cầu tiếng Việt sau thành JSON, chỉ dùng action report, status hoặc menu.',
        'JSON mẫu: {"action":"report","days":7}',
        `Yêu cầu: ${text}`,
      ].join('\n'));
      const parsed = JSON.parse(generated.replace(/^```json\s*|\s*```$/gi, '').trim());
      if (parsed.action === 'report') return report(chatId, parsed.days || 1);
      if (parsed.action === 'status') return showStatus(chatId);
    } catch (_) {}
  }
  return send(chatId, 'Chọn một chức năng để bắt đầu.', [[{ text: 'Đăng bài', callback_data: 'ctl:post' }, { text: 'Báo cáo', callback_data: 'ctl:report' }]]);
}

async function handleCallback(chatId, data) {
  const session = sessionFor(chatId);
  if (data === 'ctl:home') return showHome(chatId);
  if (data === 'ctl:help') return send(chatId, 'Chọn chức năng bên dưới.', [[{ text: 'Đăng bài', callback_data: 'ctl:post' }, { text: 'Báo cáo', callback_data: 'ctl:report' }]]);
  if (data === 'ctl:post') return showPostMode(chatId);
  if (data === 'ctl:mode:now') { session.mode = 'now'; return showPlatformChoice(chatId); }
  if (data === 'ctl:mode:schedule') { session.mode = 'schedule'; session.step = 'schedule_time'; return send(chatId, 'Nhập thời gian hẹn\nVí dụ: 20:30 hoặc 2026-08-20 20:30'); }
  if (data === 'ctl:platforms:choice') return showPlatformChoice(chatId);
  if (data === 'ctl:platforms:one' || data === 'ctl:platforms:many') {
    session.platformMode = data.endsWith(':one') ? 'one' : 'many';
    session.platforms = [];
    return showPlatforms(chatId);
  }
  if (data.startsWith('ctl:platform:')) {
    const platform = normalizePlatform(data.slice('ctl:platform:'.length));
    if (PLATFORMS.includes(platform)) {
      if (session.platformMode === 'one') {
        session.platforms = [platform];
        return showProfileFilters(chatId);
      }
      session.platforms = session.platforms.includes(platform)
        ? session.platforms.filter(item => item !== platform)
        : [...session.platforms, platform];
    }
    return showPlatforms(chatId);
  }
  if (data === 'ctl:platforms:done') {
    if (!session.platforms.length) return send(chatId, 'Chọn ít nhất một nền tảng.');
    return showProfileFilters(chatId);
  }
  if (data === 'ctl:profile:filters') return showProfileFilters(chatId);
  if (data === 'ctl:filter:groups') return showGroups(chatId);
  if (data === 'ctl:filter:providers') return showProviders(chatId);
  if (data === 'ctl:filter:name') { session.step = 'filter_name'; return send(chatId, 'Nhập tên profile cần tìm.'); }
  if (data === 'ctl:filter:clear') { session.filters = { groups: [], providers: [], name: '' }; return showProfiles(chatId); }
  if (data.startsWith('ctl:group:')) {
    const id = Number(data.slice('ctl:group:'.length));
    session.filters.groups = session.filters.groups.includes(id) ? session.filters.groups.filter(item => item !== id) : [...session.filters.groups, id];
    return showGroups(chatId);
  }
  if (data.startsWith('ctl:provider:')) {
    const provider = data.slice('ctl:provider:'.length);
    session.filters.providers = session.filters.providers.includes(provider) ? session.filters.providers.filter(item => item !== provider) : [...session.filters.providers, provider];
    return showProviders(chatId);
  }
  if (data === 'ctl:profiles') return showProfiles(chatId);
  if (data.startsWith('ctl:profiles:page:')) return showProfiles(chatId, Number(data.split(':').pop()));
  if (data === 'ctl:profiles:all') {
    session.profileIds = profileRows(session).map(profile => Number(profile.id));
    return showProfiles(chatId, session.profilePage || 0);
  }
  if (data.startsWith('ctl:profile:')) {
    const id = Number(data.slice('ctl:profile:'.length));
    session.profileIds = session.profileIds.includes(id) ? session.profileIds.filter(item => item !== id) : [...session.profileIds, id];
    return showProfiles(chatId, session.profilePage || 0);
  }
  if (data === 'ctl:profiles:done') {
    if (!session.profileIds.length) return send(chatId, 'Chọn ít nhất một profile.');
    if (session.mode === 'schedule' && !session.scheduleTime) return send(chatId, 'Nhập thời gian hẹn trước.');
    return showContentMenu(chatId);
  }
  if (data === 'ctl:content:menu') return showContentMenu(chatId);
  if (data === 'ctl:content:manual') { session.dataSource = 'new'; return askContent(chatId); }
  if (data === 'ctl:content:ai') { session.dataSource = 'new'; return askAiContent(chatId); }
  if (data === 'ctl:content:table') return showTableDataMenu(chatId);
  if (data === 'ctl:media:upload') { session.dataSource = 'new'; return askMedia(chatId); }
  if (data === 'ctl:media:ai') { session.dataSource = 'new'; return askAiImage(chatId); }
  if (data === 'ctl:content:done') return finishContent(chatId);
  if (data === 'ctl:content:empty') { session.content = ''; return showContentMenu(chatId); }
  if (data === 'ctl:extra:skip') {
    session.extraIndex = (session.extraIndex || 0) + 1;
    return askPlatformExtra(chatId);
  }
  if (data === 'ctl:fanpage:accept-matched') {
    const matched = (session.pendingTargetMatches || [])
      .filter(item => item.status === 'matched')
      .map(item => item.matches[0])
      .filter(Boolean);
    if (!matched.length) return send(chatId, 'Chưa có link Fanpage nào ghép được.', [
      [{ text: 'Quay lại', callback_data: 'ctl:content:menu' }, { text: 'Hủy', callback_data: 'ctl:home' }],
    ]);
    session.extra = session.extra || {};
    session.extra.facebook = {
      ...(session.extra.facebook || {}),
      fanpageMappings: matched,
      link_fanpage: matched.map(item => item.url || item.id).join('\n'),
    };
    session.pendingTargetMatches = null;
    session.extraIndex = (session.extraIndex || 0) + 1;
    return askPlatformExtra(chatId);
  }
  if (data === 'ctl:channel:accept-matched') {
    const matched = (session.pendingChannelMatches || [])
      .filter(item => item.status === 'matched')
      .map(item => item.matches[0])
      .filter(Boolean);
    if (!matched.length) return send(chatId, 'Chưa có kênh YouTube nào ghép được.', [
      [{ text: 'Quay lại', callback_data: 'ctl:content:menu' }, { text: 'Hủy', callback_data: 'ctl:home' }],
    ]);
    session.extra = session.extra || {};
    session.extra.youtube = {
      ...(session.extra.youtube || {}),
      channel_name: matched.map(item => item.name || item.id).join('\n'),
      channelMappings: matched,
    };
    session.pendingChannelMatches = null;
    session.extraIndex = (session.extraIndex || 0) + 1;
    return askPlatformExtra(chatId);
  }
  if (data === 'ctl:post:edit') return showContentMenu(chatId);
  if (data === 'ctl:post:confirm') return activatePost(chatId);
  if (data === 'ctl:report:custom') {
    session.step = 'report_custom';
    return send(chatId, 'Nhập yêu cầu tổng kết\nVí dụ: 7 ngày qua TikTok profile super-1 đăng được bao nhiêu bài?');
  }
  if (data === 'ctl:report') return report(chatId, 1);
  if (data.startsWith('ctl:report:')) return report(chatId, Number(data.split(':').pop()));
  if (data === 'ctl:status') return showStatus(chatId);
  return send(chatId, 'Lựa chọn không còn hiệu lực.', [[{ text: 'Trang chủ', callback_data: 'ctl:home' }]]);
}

async function handleUpdate(update) {
  const callback = update.callback_query;
  const message = update.message || update.channel_post;
  const chatId = callback?.message?.chat?.id || message?.chat?.id;
  if (chatId == null) return;
  if (!Telegram.settings().controlEnabled) return;
  if (callback) {
    await answer(callback.id);
    sessionFor(chatId).activeMessageId = callback.message?.message_id || sessionFor(chatId).activeMessageId;
    return handleCallback(chatId, String(callback.data || ''));
  }
  const text = String(message?.text || message?.caption || '').trim();
  if (isResetCommand(text)) return showHome(chatId);
  if (/^\/(?:post|status|report|help|menu)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)) {
    return handleNaturalLanguage(chatId, text);
  }
  return handleText(chatId, message || {});
}

module.exports = {
  handleUpdate,
  _private: {
    sessions,
    isResetCommand,
    parseScheduleTime,
    normalizePlatform,
    report,
    profileRows,
  },
};
