#!/usr/bin/env node
'use strict';

// Dependency-free MCP stdio bridge for Super Post - King.
// It keeps credentials local and forwards tool calls to /api/agent/v1.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const BASE_URL_OVERRIDE = String(process.env.SUPER_POST_BASE_URL || '').replace(/\/$/, '');
const TERMINAL = new Set(['success', 'error', 'cancelled']);
const DEFAULT_BASE_URLS = [
  'http://127.0.0.1:3004',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:3002',
  'http://127.0.0.1:3003',
  'http://127.0.0.1:3005',
];
let resolvedConnection = null;
let notificationPumpStarted = false;
let notificationPumpStopped = false;
let notificationCursor = null;

function endpointRegistryCandidates() {
  const candidates = [];
  if (process.env.SUPER_POST_ENDPOINT_FILE) candidates.push(process.env.SUPER_POST_ENDPOINT_FILE);
  if (process.env.COVERGEMAUTO_DATA_DIR) {
    candidates.push(path.join(process.env.COVERGEMAUTO_DATA_DIR, 'agent-api-endpoint.json'));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(
      process.env.LOCALAPPDATA,
      'King Automation AI',
      'Super Post King',
      'agent-api-endpoint.json'
    ));
  }
  candidates.push(path.join(__dirname, '..', 'agent-api-endpoint.json'));
  return [...new Set(candidates.map(value => path.resolve(value)))];
}

function normalizeLoopbackBaseUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)) return '';
    if (!parsed.port || parsed.username || parsed.password) return '';
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) return '';
    return `${parsed.protocol}//${parsed.hostname}:${parsed.port}`;
  } catch (_) {
    return '';
  }
}

function registeredBaseUrls() {
  const values = [];
  for (const candidate of endpointRegistryCandidates()) {
    try {
      const registry = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (registry.service !== 'super-post-king-agent-api') continue;
      const baseUrl = normalizeLoopbackBaseUrl(registry.base_url);
      if (baseUrl) values.push(baseUrl);
    } catch (_) {}
  }
  return [...new Set(values)];
}

function keyCandidates() {
  const candidates = [];
  if (process.env.SUPER_POST_AGENT_KEY_FILE) candidates.push(process.env.SUPER_POST_AGENT_KEY_FILE);
  if (process.env.COVERGEMAUTO_DATA_DIR) {
    candidates.push(path.join(process.env.COVERGEMAUTO_DATA_DIR, 'src', 'database', 'agent-api-key.txt'));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(
      process.env.LOCALAPPDATA,
      'King Automation AI',
      'Super Post King',
      'src',
      'database',
      'agent-api-key.txt'
    ));
  }
  candidates.push(path.join(__dirname, '..', 'src', 'database', 'agent-api-key.txt'));
  return [...new Set(candidates.map(value => path.resolve(value)))];
}

function readKeyFile(candidate) {
  if (!candidate) return '';
  try {
    const value = fs.readFileSync(candidate, 'utf8').trim();
    return /^[a-f0-9]{64}$/i.test(value) ? value : '';
  } catch (_) {
    return '';
  }
}

function readApiKey(connection = {}) {
  const direct = String(process.env.SUPER_POST_AGENT_API_KEY || '').trim();
  if (direct) return direct;

  // Pair the key with the server that advertised it. Multiple local instances
  // can use different data roots and therefore different keys.
  const candidates = [
    connection.keyFile,
    process.env.SUPER_POST_AGENT_KEY_FILE,
    ...keyCandidates(),
  ];
  const uniqueCandidates = [...new Set(
    candidates.filter(Boolean).map(value => path.resolve(value))
  )];
  for (const candidate of uniqueCandidates) {
    const value = readKeyFile(candidate);
    if (value) return value;
  }
  throw new Error(
    `Không tìm thấy Agent API key hợp lệ. Hãy mở Super Post - King trước hoặc đặt SUPER_POST_AGENT_KEY_FILE. Đã kiểm tra: ${uniqueCandidates.join(', ')}`
  );
}

async function probeConnection(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/api/agent/v1/health`, {
      signal: AbortSignal.timeout(1200),
    });
    const payload = await response.json();
    const health = payload && payload.data;
    if (!response.ok || !payload.success || !health || health.service !== 'super-post-king-agent-api') {
      return null;
    }
    const connection = {
      baseUrl,
      keyFile: String(health.key_file || '').trim(),
      mode: String(health.mode || '').trim().toLowerCase(),
    };
    readApiKey(connection);
    return connection;
  } catch (_) {
    return null;
  }
}

function connectionPriority(connection, index) {
  if (connection.mode === 'desktop') return index;
  const localDataRoot = process.env.LOCALAPPDATA
    ? path.resolve(process.env.LOCALAPPDATA, 'King Automation AI', 'Super Post King')
    : '';
  if (localDataRoot && connection.keyFile) {
    const relative = path.relative(localDataRoot, path.resolve(connection.keyFile));
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return 100 + index;
  }
  return 200 + index;
}

async function resolveConnection(force = false) {
  // Keep a healthy in-process choice stable. A second/older instance may rewrite
  // the registry, but that must not move an active MCP session between servers.
  if (resolvedConnection && !force) return resolvedConnection;
  resolvedConnection = null;
  const registered = registeredBaseUrls();

  if (BASE_URL_OVERRIDE) {
    const overridden = await probeConnection(BASE_URL_OVERRIDE);
    if (overridden) {
      resolvedConnection = overridden;
      return overridden;
    }
  }

  const candidates = [...new Set([
    ...registered,
    ...DEFAULT_BASE_URLS,
  ].filter(value => value !== BASE_URL_OVERRIDE))];
  const probed = await Promise.all(candidates.map(probeConnection));
  const available = probed
    .map((connection, index) => ({
      connection,
      priority: connection ? connectionPriority(connection, index) : Infinity,
    }))
    .filter(item => item.connection)
    .sort((left, right) => left.priority - right.priority);
  if (available.length) {
    resolvedConnection = available[0].connection;
    return resolvedConnection;
  }

  const checked = [...new Set([BASE_URL_OVERRIDE, ...registered, ...DEFAULT_BASE_URLS].filter(Boolean))];
  const error = new Error(`Không tìm thấy Agent API Super Post King. Đã kiểm tra: ${checked.join(', ')}`);
  error.code = 'SUPER_POST_TOOL_UNAVAILABLE';
  throw error;
}

async function refreshConnectionWithBackoff() {
  const delays = [0, 100, 250, 500, 1000, 1500];
  let lastError = null;
  for (const delay of delays) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try {
      return await resolveConnection(true);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function api(endpoint, options = {}, retried = false) {
  const retrySafe = options.retrySafe === true;
  const { retrySafe: _retrySafe, ...fetchOptions } = options;
  let connection = await resolveConnection();
  let apiKey;
  try {
    apiKey = readApiKey(connection);
  } catch (error) {
    if (retried) throw error;
    connection = await refreshConnectionWithBackoff();
    apiKey = readApiKey(connection);
  }
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    ...(fetchOptions.headers || {}),
  };
  let response;
  try {
    response = await fetch(`${connection.baseUrl}${endpoint}`, {
      ...fetchOptions,
      headers,
      body: fetchOptions.body === undefined ? undefined : JSON.stringify(fetchOptions.body),
    });
  } catch (error) {
    const method = String(fetchOptions.method || 'GET').toUpperCase();
    const canRetry = method === 'GET' || method === 'HEAD' || retrySafe;
    if (!retried && canRetry) {
      await refreshConnectionWithBackoff();
      return api(endpoint, options, true);
    }
    if (!canRetry) {
      error.code = 'SUPER_POST_REQUEST_RESULT_UNKNOWN';
      error.message = `Mất kết nối khi gửi ${method}; không tự gửi lại để tránh tạo dữ liệu trùng. ${error.message}`;
    }
    throw error;
  }
  let payload;
  try { payload = await response.json(); } catch (_) { payload = null; }
  if (!retried && response.status === 401 && payload && payload.code === 'AGENT_API_UNAUTHORIZED') {
    await refreshConnectionWithBackoff();
    return api(endpoint, options, true);
  }
  if (!retried && !payload && retrySafe) {
    await refreshConnectionWithBackoff();
    return api(endpoint, options, true);
  }
  if (!response.ok || !payload || payload.success === false) {
    const error = new Error(payload && payload.error ? payload.error : `Super Post API trả HTTP ${response.status}`);
    error.code = payload && payload.code;
    throw error;
  }
  return payload.data;
}

async function publish(args) {
  const waitSeconds = Math.min(300, Math.max(0, Number(args.wait_seconds) || 0));
  const requestId = String(args.request_id || '').trim() || `spk:mcp:${crypto.randomUUID()}`;
  const job = await api('/api/agent/v1/publish', {
    method: 'POST',
    body: { ...args, request_id: requestId, wait_seconds: 0 },
    retrySafe: true,
  });
  if (!waitSeconds || TERMINAL.has(job.status)) return job;
  const deadline = Date.now() + waitSeconds * 1000;
  let current = job;
  while (!TERMINAL.has(current.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    current = await api(`/api/agent/v1/jobs/${encodeURIComponent(job.job_id)}`);
  }
  return { ...current, timed_out: !TERMINAL.has(current.status) };
}

async function publishData(args) {
  const waitSeconds = Math.min(300, Math.max(0, Number(args.wait_seconds) || 0));
  const requestId = String(args.request_id || '').trim() || `spk:data:${crypto.randomUUID()}`;
  const job = await api('/api/agent/v1/publish-data', {
    method: 'POST',
    body: { ...args, request_id: requestId, wait_seconds: 0 },
    retrySafe: true,
  });
  if (!waitSeconds || TERMINAL.has(job.status)) return job;
  const deadline = Date.now() + waitSeconds * 1000;
  let current = job;
  while (!TERMINAL.has(current.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    current = await api(`/api/agent/v1/jobs/${encodeURIComponent(job.job_id)}`);
  }
  return { ...current, timed_out: !TERMINAL.has(current.status) };
}

async function publishDataBatch(args) {
  const waitSeconds = Math.min(300, Math.max(0, Number(args.wait_seconds) || 0));
  const batch = await api('/api/agent/v1/publish-data-batch', {
    method: 'POST',
    body: { ...args, wait_seconds: 0 },
    retrySafe: true,
  });
  if (!waitSeconds || !batch.batch_id || !['queued', 'running'].includes(batch.status)) return batch;
  const deadline = Date.now() + waitSeconds * 1000;
  let current = batch;
  while (['queued', 'running'].includes(current.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    current = await api(`/api/agent/v1/batches/${encodeURIComponent(batch.batch_id)}`);
  }
  return { ...current, timed_out: ['queued', 'running'].includes(current.status) };
}

function asList(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return values.map(item => String(item || '').trim()).filter(Boolean);
}

function uniqueStrings(values) {
  const seen = new Set();
  return values.filter(value => {
    const key = String(value).trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeFacebookUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let parsed;
  try { parsed = new URL(raw); } catch (_) {
    const error = new Error(`Link Facebook không hợp lệ: ${raw}`);
    error.code = 'BATCH_TARGET_INVALID';
    throw error;
  }
  if (!/(^|\.)facebook\.com$/i.test(parsed.hostname)) {
    const error = new Error(`Link không thuộc facebook.com: ${raw}`);
    error.code = 'BATCH_TARGET_INVALID';
    throw error;
  }
  parsed.hash = '';
  return parsed.toString();
}

function resolveProfiles(available, ids, names, label) {
  const selected = [];
  const selectedIds = asList(ids).map(value => Number(value));
  if (selectedIds.length) {
    for (const id of selectedIds) {
      if (!Number.isInteger(id) || id <= 0) {
        const error = new Error(`${label}: profile_id không hợp lệ: ${id}`);
        error.code = 'BATCH_PROFILE_INVALID';
        throw error;
      }
      const profile = available.find(item => Number(item.id) === id);
      if (!profile) {
        const error = new Error(`${label}: không tìm thấy profile_id ${id} trên nền tảng đã chọn.`);
        error.code = 'BATCH_PROFILE_NOT_FOUND';
        throw error;
      }
      selected.push(profile);
    }
  } else {
    for (const name of uniqueStrings(asList(names))) {
      const matches = available.filter(item => String(item.name || '').trim().toLowerCase() === name.toLowerCase());
      if (!matches.length) {
        const error = new Error(`${label}: không tìm thấy profile "${name}" trên nền tảng đã chọn.`);
        error.code = 'BATCH_PROFILE_NOT_FOUND';
        throw error;
      }
      if (matches.length > 1) {
        const error = new Error(`${label}: có nhiều profile tên "${name}"; hãy dùng profile_id.`);
        error.code = 'BATCH_PROFILE_AMBIGUOUS';
        throw error;
      }
      selected.push(matches[0]);
    }
  }
  return [...new Map(selected.map(profile => [Number(profile.id), profile])).values()];
}

function validateLocalMedia(item, label) {
  const paths = [
    ...asList(item.media),
    ...asList(item.thumbnail),
    ...(Array.isArray(item.comments) ? item.comments.flatMap(comment => (
      comment && typeof comment === 'object' ? asList(comment.media) : []
    )) : []),
  ];
  for (const mediaPath of paths) {
    if (mediaPath.includes(',')) {
      const error = new Error(`${label}: đường dẫn media không được chứa dấu phẩy: ${mediaPath}`);
      error.code = 'BATCH_MEDIA_INVALID';
      throw error;
    }
    if (!path.isAbsolute(mediaPath) || !fs.existsSync(mediaPath)) {
      const error = new Error(`${label}: không tìm thấy media trên máy: ${mediaPath}`);
      error.code = 'BATCH_MEDIA_NOT_FOUND';
      throw error;
    }
  }
}

function requestIdFor(batchKey, item, platform, profileId, target) {
  const itemKey = String(item.item_key || '').trim();
  const seed = [batchKey, itemKey, platform, profileId, target.type, target.url].join('|');
  const digest = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16);
  const explicit = String(item.request_id || '').trim();
  if (explicit) return `${explicit.slice(0, 111)}:${digest}`;
  const clean = value => String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-');
  return `spk:${clean(batchKey).slice(0, 40)}:${clean(itemKey).slice(0, 40)}:${digest}`.slice(0, 128);
}

function aggregateBatchStatus(entries) {
  const statuses = entries.map(entry => entry.status);
  if (statuses.some(status => status === 'running')) return 'running';
  if (statuses.some(status => status === 'queued')) return 'queued';
  const successes = statuses.filter(status => status === 'success').length;
  const errors = statuses.filter(status => status === 'error' || status === 'cancelled').length;
  if (successes === statuses.length && statuses.length) return 'success';
  if (successes && errors) return 'partial_success';
  if (errors === statuses.length && statuses.length) return 'error';
  return 'queued';
}

async function publishBatch(args) {
  const platform = String(args.platform || '').trim().toLowerCase();
  const batchKey = String(args.batch_key || '').trim();
  const items = Array.isArray(args.items) ? args.items : [];
  const distribution = String(args.distribution || 'mapped').trim().toLowerCase();
  if (!batchKey) throw Object.assign(new Error('Cần truyền batch_key ổn định.'), { code: 'BATCH_KEY_REQUIRED' });
  if (!items.length) throw Object.assign(new Error('Cần truyền ít nhất một item.'), { code: 'BATCH_ITEMS_REQUIRED' });
  if (!['mapped', 'all_profiles'].includes(distribution)) {
    throw Object.assign(new Error('distribution chỉ nhận mapped hoặc all_profiles.'), { code: 'BATCH_DISTRIBUTION_INVALID' });
  }

  const available = await api(`/api/agent/v1/profiles?platform=${encodeURIComponent(platform)}`);
  const batchProfiles = resolveProfiles(available, args.profile_ids, args.profiles, 'Batch');
  const plan = [];

  items.forEach((item, index) => {
    const label = `Item ${index + 1}`;
    const itemKey = String(item && item.item_key || '').trim();
    if (!itemKey) throw Object.assign(new Error(`${label}: cần item_key ổn định.`), { code: 'BATCH_ITEM_KEY_REQUIRED' });
    validateLocalMedia(item, label);

    const explicitProfile = item.profile_id != null || String(item.profile || '').trim();
    const selected = explicitProfile
      ? resolveProfiles(available, item.profile_id, item.profile, label)
      : batchProfiles;
    if (!selected.length) {
      throw Object.assign(new Error(`${label}: cần profile/profile_id hoặc danh sách profile ở cấp batch.`), {
        code: 'BATCH_PROFILE_REQUIRED',
      });
    }
    if (!explicitProfile && selected.length > 1 && distribution !== 'all_profiles') {
      throw Object.assign(new Error(`${label}: có nhiều profile nhưng chưa mapping. Gắn profile cho item hoặc dùng distribution=all_profiles.`), {
        code: 'BATCH_PROFILE_MAPPING_REQUIRED',
      });
    }

    let targets = [{ type: platform === 'facebook' ? 'profile' : 'default', url: '' }];
    if (platform === 'facebook') {
      const fanpages = uniqueStrings([...asList(item.fanpage), ...asList(item.fanpages)])
        .map(normalizeFacebookUrl);
      const groups = uniqueStrings([...asList(item.group), ...asList(item.groups)])
        .map(normalizeFacebookUrl);
      if (fanpages.length && groups.length) {
        throw Object.assign(new Error(`${label}: không trộn Fanpage và Group trong cùng item.`), {
          code: 'BATCH_TARGET_MAPPING_REQUIRED',
        });
      }
      if (fanpages.length) targets = fanpages.map(url => ({ type: 'fanpage', url }));
      if (groups.length) targets = groups.map(url => ({ type: 'group', url }));
    } else if (asList(item.fanpage).length || asList(item.fanpages).length || asList(item.group).length || asList(item.groups).length) {
      throw Object.assign(new Error(`${label}: fanpage/group chỉ dùng cho Facebook.`), {
        code: 'BATCH_TARGET_PLATFORM_INVALID',
      });
    }

    for (const profile of selected) {
      for (const target of targets) {
        const requestId = requestIdFor(batchKey, item, platform, profile.id, target);
        plan.push({
          item_key: itemKey,
          profile_id: Number(profile.id),
          profile: profile.name,
          target_type: target.type,
          target_url: target.url,
          request_id: requestId,
          payload: {
            ...item,
            item_key: undefined,
            fanpages: undefined,
            groups: undefined,
            request_id: requestId,
            platform,
            profile_id: Number(profile.id),
            profile: undefined,
            fanpage: target.type === 'fanpage' ? target.url : '',
            group: target.type === 'group' ? target.url : '',
            wait_seconds: 0,
          },
        });
      }
    }
  });

  let batch = await api('/api/agent/v1/publish-batch', {
    method: 'POST',
    retrySafe: true,
    body: {
      platform,
      wait_seconds: 0,
      items: plan.map(item => item.payload),
    },
  });

  const waitSeconds = Math.min(300, Math.max(0, Number(args.wait_seconds) || 0));
  const deadline = Date.now() + waitSeconds * 1000;
  while (waitSeconds && batch.batch_id && (batch.status === 'queued' || batch.status === 'running') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    batch = await api(`/api/agent/v1/batches/${encodeURIComponent(batch.batch_id)}`);
  }

  const metadata = new Map(plan.map(item => [item.request_id, {
    item_key: item.item_key,
    target_type: item.target_type,
    target_url: item.target_url,
  }]));
  const jobs = (batch.jobs || []).map(job => ({ ...metadata.get(job.request_id), ...job }));
  const timedOut = batch.status === 'queued' || batch.status === 'running';
  return {
    ...batch,
    batch_key: batchKey,
    timed_out: timedOut,
    jobs,
  };
}

async function publishGroup(args) {
  const identifier = String(args.identifier || '').trim();
  if (!identifier) {
    throw Object.assign(new Error('Cần truyền identifier của Nhóm đăng.'), { code: 'PUBLISH_GROUP_ID_REQUIRED' });
  }
  const groupQuery = new URLSearchParams();
  if (args.platform) groupQuery.set('platform', args.platform);
  const group = await api(
    `/api/agent/v1/publish-groups/${encodeURIComponent(identifier)}${groupQuery.size ? `?${groupQuery}` : ''}`
  );
  if (!Array.isArray(group.members) || !group.members.length) {
    throw Object.assign(new Error('Nhóm đăng không có thành viên.'), { code: 'PUBLISH_GROUP_MEMBERS_REQUIRED' });
  }

  const shared = { ...args };
  for (const key of ['identifier', 'platform', 'batch_key', 'wait_seconds']) delete shared[key];
  const items = group.members.map(member => ({
    ...shared,
    item_key: `publish-group:${group.group_key}:member:${member.id}`,
    profile_id: Number(member.profile_id),
    fanpage: member.target_type === 'fanpage' ? member.target_url : '',
    group: member.target_type === 'group' ? member.target_url : '',
  }));
  const batch = await publishBatch({
    batch_key: args.batch_key,
    platform: group.platform,
    distribution: 'mapped',
    items,
    wait_seconds: args.wait_seconds,
  });
  return {
    ...batch,
    publish_group: {
      id: group.id,
      group_key: group.group_key,
      name: group.name,
      platform: group.platform,
      member_count: group.member_count,
    },
  };
}

async function publishCampaign(args) {
  const identifier = String(args.identifier || '').trim();
  const campaignKey = String(args.campaign_key || '').trim();
  if (!identifier) {
    throw Object.assign(new Error('Cần truyền identifier của Chiến dịch đăng.'), { code: 'PUBLISH_CAMPAIGN_ID_REQUIRED' });
  }
  if (!campaignKey) {
    throw Object.assign(new Error('Cần truyền campaign_key ổn định.'), { code: 'PUBLISH_CAMPAIGN_RUN_KEY_REQUIRED' });
  }
  const campaign = await api(`/api/agent/v1/publish-campaigns/${encodeURIComponent(identifier)}`);
  if (!Array.isArray(campaign.publish_groups) || !campaign.publish_groups.length) {
    throw Object.assign(new Error('Chiến dịch đăng không có Nhóm đăng.'), { code: 'PUBLISH_CAMPAIGN_GROUPS_REQUIRED' });
  }

  const common = { ...args };
  for (const key of ['identifier', 'campaign_key', 'platform_overrides', 'wait_seconds']) delete common[key];
  const overrides = args.platform_overrides && typeof args.platform_overrides === 'object'
    ? args.platform_overrides
    : {};
  const groups = await Promise.all(campaign.publish_groups.map(async group => {
    try {
      return await publishGroup({
        ...common,
        ...(overrides[group.platform] || {}),
        identifier: group.group_key,
        platform: group.platform,
        batch_key: `${campaignKey}:${group.group_key}`,
        wait_seconds: args.wait_seconds,
      });
    } catch (error) {
      return {
        status: 'error',
        platform: group.platform,
        total: 0,
        success_count: 0,
        error_count: 1,
        pending_count: 0,
        error: { code: error.code || 'PUBLISH_CAMPAIGN_GROUP_ERROR', message: error.message },
        publish_group: group,
      };
    }
  }));

  const total = groups.reduce((sum, group) => sum + Number(group.total || 0), 0);
  const successCount = groups.reduce((sum, group) => sum + Number(group.success_count || 0), 0);
  const errorCount = groups.reduce((sum, group) => sum + Number(group.error_count || 0), 0);
  const pendingCount = groups.reduce((sum, group) => sum + Number(group.pending_count || 0), 0);
  return {
    campaign: {
      id: campaign.id,
      campaign_key: campaign.campaign_key,
      name: campaign.name,
      group_count: campaign.group_count,
      platforms: campaign.platforms,
    },
    run_key: campaignKey,
    status: aggregateBatchStatus(groups),
    total,
    success_count: successCount,
    error_count: errorCount,
    pending_count: pendingCount,
    timed_out: groups.some(group => group.timed_out === true),
    groups,
  };
}

const commentSchema = {
  oneOf: [
    { type: 'string' },
    {
      type: 'object',
      properties: { text: { type: 'string' }, media: { type: 'string' } },
      additionalProperties: false,
    },
  ],
};

const publishGroupMemberSchema = {
  type: 'object',
  properties: {
    target_type: { type: 'string', enum: ['profile', 'fanpage', 'group', 'default'] },
    profile: { type: 'string' },
    profile_id: { type: 'integer' },
    target_url: { type: 'string' },
  },
  anyOf: [{ required: ['profile'] }, { required: ['profile_id'] }],
  additionalProperties: false,
};

const publishCampaignGroupSchema = {
  oneOf: [
    { type: 'string' },
    { type: 'integer' },
    {
      type: 'object',
      properties: {
        identifier: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        platform: { type: 'string', enum: ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'] },
      },
      required: ['identifier'],
      additionalProperties: false,
    },
  ],
};

const batchItemSchema = {
  type: 'object',
  properties: {
    item_key: { type: 'string', description: 'Khóa ổn định của hàng/bài trong batch.' },
    request_id: { type: 'string', description: 'Tùy chọn; MCP sẽ thêm hash khi item fan-out.' },
    profile: { type: 'string' },
    profile_id: { type: 'integer' },
    content: { type: 'string' },
    media: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
    fanpage: { type: 'string' },
    fanpages: { type: 'array', items: { type: 'string' } },
    group: { type: 'string' },
    groups: { type: 'array', items: { type: 'string' } },
    product_id: { type: 'string' },
    product_ids: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
    link: { type: 'string' },
    target: { type: 'string' },
    description: { type: 'string' },
    channel: { type: 'string' },
    channel_name: { type: 'string' },
    playlist: { type: 'string' },
    privacy_status: { type: 'string' },
    thumbnail: { type: 'string' },
    keywords: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
    comments: { type: 'array', items: commentSchema },
    custom_fields: { type: 'object', additionalProperties: true },
  },
  required: ['item_key'],
  additionalProperties: false,
};

const pendingDataFields = {
  data_key: {
    type: 'string',
    minLength: 3,
    maxLength: 160,
    description: 'Khóa ổn định chống tạo trùng khi client retry.',
  },
  profile: { type: 'string' },
  profile_id: { type: 'integer' },
  content: { type: 'string' },
  media: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
  fanpage: { type: 'string' },
  group: { type: 'string' },
  product_id: { type: 'string' },
  product_ids: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
  link: { type: 'string' },
  target: { type: 'string' },
  description: { type: 'string' },
  channel: { type: 'string' },
  channel_name: { type: 'string' },
  playlist: { type: 'string' },
  privacy_status: { type: 'string' },
  thumbnail: { type: 'string' },
  keywords: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
  comments: { type: 'array', items: commentSchema },
  custom_fields: { type: 'object', additionalProperties: true },
};

const pendingDataItemSchema = {
  type: 'object',
  properties: pendingDataFields,
  required: ['data_key'],
  anyOf: [{ required: ['content'] }, { required: ['media'] }],
  additionalProperties: false,
};

const tools = [
  {
    name: 'super_post_get_capabilities',
    description: 'Lấy nền tảng, trường dữ liệu, logic target/profile và chính sách cài đặt mà MCP hỗ trợ.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'super_post_get_runtime_config',
    description: 'Đọc cấu hình runner hiệu lực từ Super Post King; agent chỉ đọc và không được ghi đè.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'] },
      },
      required: ['platform'],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_get_data_schema',
    description: 'Đọc các cột dữ liệu hệ thống và custom hiện có trong Super Post King theo nền tảng.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'] },
      },
      required: ['platform'],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_list_profiles',
    description: 'Liệt kê profile Super Post - King có thể dùng trên một nền tảng.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'] },
      },
      required: ['platform'],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_list_profile_groups',
    description: 'Liệt kê nhóm profile và đúng các profile thành viên trong Super Post King.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'] },
      },
      required: ['platform'],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_list_targets',
    description: 'Liệt kê Fanpage/kênh đã quét và Group Facebook đã lưu trong dữ liệu tool, có thể lọc theo profile.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'] },
        profile_ids: { type: 'array', items: { type: 'integer' } },
      },
      required: ['platform'],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_list_platform_data',
    description: 'Đọc các hàng dữ liệu và custom field hiện có trong Super Post King theo nền tảng; không đăng bài.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'] },
        status: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 1000 },
      },
      required: ['platform'],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_create_data',
    description: 'Thêm một hàng dữ liệu vào trạng thái Đợi trong Super Post King. Không tạo job, không chạy đăng.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'] },
        ...pendingDataFields,
        allow_scheduled_consumption: { type: 'boolean' },
      },
      required: ['platform', 'data_key'],
      anyOf: [{ required: ['content'] }, { required: ['media'] }],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_create_data_batch',
    description: 'Thêm atomically nhiều hàng dữ liệu vào trạng thái Đợi. Không tạo job, không chạy đăng.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'] },
        allow_scheduled_consumption: { type: 'boolean' },
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 500,
          items: pendingDataItemSchema,
        },
      },
      required: ['platform', 'items'],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_assign_profiles',
    description: 'Đổi profile được gán cho các hàng dữ liệu trong tool. Chỉ sửa mapping cục bộ, không đăng bài.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'] },
        allow_scheduled_consumption: { type: 'boolean' },
        assignments: {
          type: 'array',
          minItems: 1,
          maxItems: 1000,
          items: {
            type: 'object',
            properties: {
              post_id: { type: 'integer' },
              profile: { type: 'string' },
              profile_id: { type: 'integer' },
            },
            required: ['post_id'],
            anyOf: [{ required: ['profile'] }, { required: ['profile_id'] }],
            additionalProperties: false,
          },
        },
      },
      required: ['platform', 'assignments'],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_list_publish_groups',
    description: 'Liệt kê các Nhóm đăng đã lưu, gồm profile timeline, Fanpage và Facebook Group.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_get_publish_group',
    description: 'Lấy một Nhóm đăng bằng ID, group_key hoặc tên chính xác.',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        platform: { type: 'string', enum: ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'] },
      },
      required: ['identifier'],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_create_publish_group',
    description: 'Tạo Nhóm đăng cục bộ từ một/nhiều profile, Fanpage hoặc Facebook Group; không đăng bài.',
    inputSchema: {
      type: 'object',
      properties: {
        group_key: { type: 'string' },
        name: { type: 'string' },
        platform: { type: 'string', enum: ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'] },
        members: { type: 'array', minItems: 1, maxItems: 500, items: publishGroupMemberSchema },
      },
      required: ['name', 'platform', 'members'],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_update_publish_group',
    description: 'Đổi tên hoặc thay toàn bộ thành viên của một Nhóm đăng; không đăng bài.',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        platform: { type: 'string', enum: ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'] },
        name: { type: 'string' },
        members: { type: 'array', minItems: 1, maxItems: 500, items: publishGroupMemberSchema },
      },
      required: ['identifier'],
      anyOf: [{ required: ['name'] }, { required: ['members'] }],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_delete_publish_group',
    description: 'Xóa một Nhóm đăng cục bộ; không xóa profile, Fanpage, Group hoặc bài đăng.',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        platform: { type: 'string', enum: ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'] },
      },
      required: ['identifier'],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_publish_group',
    description: 'Đăng cùng một nội dung lên mọi thành viên của Nhóm đăng và trả kết quả riêng từng đích.',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        platform: { type: 'string', enum: ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'] },
        batch_key: { type: 'string' },
        content: { type: 'string' },
        media: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        product_id: { type: 'string' },
        product_ids: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        link: { type: 'string' },
        target: { type: 'string' },
        description: { type: 'string' },
        channel: { type: 'string' },
        channel_name: { type: 'string' },
        playlist: { type: 'string' },
        privacy_status: { type: 'string' },
        thumbnail: { type: 'string' },
        keywords: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        comments: { type: 'array', items: commentSchema },
        custom_fields: { type: 'object', additionalProperties: true },
        wait_seconds: { type: 'number', minimum: 0, maximum: 300 },
      },
      required: ['identifier', 'batch_key'],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_list_publish_campaigns',
    description: 'Liệt kê các Chiến dịch đăng đa nền tảng đã lưu; không đăng bài.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'super_post_get_publish_campaign',
    description: 'Lấy một Chiến dịch đăng bằng ID, campaign_key hoặc tên chính xác.',
    inputSchema: {
      type: 'object',
      properties: { identifier: { oneOf: [{ type: 'string' }, { type: 'integer' }] } },
      required: ['identifier'],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_create_publish_campaign',
    description: 'Tạo Chiến dịch đa nền tảng từ các Nhóm đăng đã lưu; không đăng bài.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_key: { type: 'string' },
        name: { type: 'string' },
        publish_groups: { type: 'array', minItems: 1, maxItems: 100, items: publishCampaignGroupSchema },
      },
      required: ['name', 'publish_groups'],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_update_publish_campaign',
    description: 'Đổi tên hoặc thay danh sách Nhóm đăng của Chiến dịch; không đăng bài.',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        name: { type: 'string' },
        publish_groups: { type: 'array', minItems: 1, maxItems: 100, items: publishCampaignGroupSchema },
      },
      required: ['identifier'],
      anyOf: [{ required: ['name'] }, { required: ['publish_groups'] }],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_delete_publish_campaign',
    description: 'Xóa Chiến dịch cục bộ; không xóa các Nhóm đăng, profile hoặc bài đăng.',
    inputSchema: {
      type: 'object',
      properties: { identifier: { oneOf: [{ type: 'string' }, { type: 'integer' }] } },
      required: ['identifier'],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_list_schedules',
    description: 'Liệt kê lịch hẹn bền vững trong Super Post King; không tạo hoặc chạy bài mới.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: ['all', 'facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'] },
        status: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_get_schedule',
    description: 'Đọc một lịch bằng schedule_id hoặc schedule_key.',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        platform: { type: 'string', enum: ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'] },
      },
      required: ['identifier'],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_create_schedule',
    description: 'Tạo lịch đăng bền vững cho các hàng đang Chờ. schedule_key chống tạo trùng khi MCP retry; không đăng ngay.',
    inputSchema: {
      type: 'object',
      properties: {
        schedule_key: { type: 'string', minLength: 3, maxLength: 160 },
        name: { type: 'string', minLength: 1, maxLength: 200 },
        platform: { type: 'string', enum: ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'] },
        schedule_type: { type: 'string', enum: ['once', 'daily', 'custom'] },
        schedule_time: { type: 'string', description: 'once: ISO 8601; daily: HH:mm theo Asia/Ho_Chi_Minh.' },
        cron_expr: { type: 'string', description: 'Bắt buộc khi schedule_type=custom.' },
        profile_ids: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 1 } },
        profiles: { type: 'array', minItems: 1, items: { type: 'string' } },
        data_ids: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 1 } },
        all_pending: { type: 'boolean', description: 'Chạy mọi hàng đang Chờ; phù hợp lịch daily/custom.' },
        enabled: { type: 'boolean', default: true },
      },
      required: ['schedule_key', 'name', 'platform', 'schedule_type'],
      anyOf: [{ required: ['profile_ids'] }, { required: ['profiles'] }],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_update_schedule',
    description: 'Cập nhật lịch đã có; không đổi schedule_key và không chạy ngay.',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        platform: { type: 'string', enum: ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'] },
        name: { type: 'string', minLength: 1, maxLength: 200 },
        schedule_type: { type: 'string', enum: ['once', 'daily', 'custom'] },
        schedule_time: { type: 'string' },
        cron_expr: { type: 'string' },
        profile_ids: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 1 } },
        profiles: { type: 'array', minItems: 1, items: { type: 'string' } },
        data_ids: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 1 } },
        all_pending: { type: 'boolean' },
        enabled: { type: 'boolean' },
      },
      required: ['identifier'],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_set_schedule_enabled',
    description: 'Bật hoặc tắt lịch theo trạng thái mong muốn; gọi lại cùng giá trị không đảo trạng thái.',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        platform: { type: 'string', enum: ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'] },
        enabled: { type: 'boolean' },
      },
      required: ['identifier', 'enabled'],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_delete_schedule',
    description: 'Xóa đúng một lịch hẹn; không xóa profile hoặc dữ liệu bài.',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        platform: { type: 'string', enum: ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'] },
      },
      required: ['identifier'],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_publish_campaign',
    description: 'Một lệnh đăng nội dung qua mọi Nhóm đăng/nền tảng trong Chiến dịch và gom kết quả từng batch.',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        campaign_key: { type: 'string', description: 'Khóa lần chạy ổn định để chống tạo bài trùng khi gọi lại.' },
        content: { type: 'string' },
        media: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        comments: { type: 'array', items: commentSchema },
        custom_fields: { type: 'object', additionalProperties: true },
        platform_overrides: {
          type: 'object',
          properties: {
            facebook: { type: 'object', additionalProperties: true },
            tiktok: { type: 'object', additionalProperties: true },
            youtube: { type: 'object', additionalProperties: true },
            threads: { type: 'object', additionalProperties: true },
            instagram: { type: 'object', additionalProperties: true },
            x: { type: 'object', additionalProperties: true },
            zalovideo: { type: 'object', additionalProperties: true },
          },
          additionalProperties: false,
        },
        wait_seconds: { type: 'number', minimum: 0, maximum: 300 },
      },
      required: ['identifier', 'campaign_key'],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_publish_data',
    description: 'Publish one existing pending row by post_id without creating a duplicate data row.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'] },
        post_id: { type: 'integer', minimum: 1 },
        request_id: { type: 'string', maxLength: 128 },
        wait_seconds: { type: 'number', minimum: 0, maximum: 300 },
      },
      required: ['platform', 'post_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_publish_data_batch',
    description: 'Publish multiple existing pending rows without creating duplicate data rows.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'] },
        batch_key: { type: 'string', minLength: 3, maxLength: 160 },
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 500,
          items: {
            type: 'object',
            properties: {
              item_key: { type: 'string' },
              post_id: { type: 'integer', minimum: 1 },
              request_id: { type: 'string', maxLength: 128 },
            },
            required: ['item_key', 'post_id'],
            additionalProperties: false,
          },
        },
        wait_seconds: { type: 'number', minimum: 0, maximum: 300 },
      },
      required: ['platform', 'batch_key', 'items'],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_publish',
    description: 'Gửi dữ liệu từ agent sang Super Post - King để đăng. Trả job_id ngay hoặc chờ và trả link/thời gian/lỗi.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', description: 'Mã chống tạo bài trùng khi agent gọi lại.' },
        platform: { type: 'string', enum: ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'] },
        profile: { type: 'string', description: 'Tên profile đúng như trong mục Trình duyệt.' },
        profile_id: { type: 'integer' },
        content: { type: 'string' },
        media: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        fanpage: { type: 'string' },
        group: { type: 'string' },
        product_id: { type: 'string' },
        product_ids: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        link: { type: 'string' },
        target: { type: 'string' },
        channel: { type: 'string' },
        channel_name: { type: 'string' },
        description: { type: 'string' },
        playlist: { type: 'string' },
        privacy_status: { type: 'string' },
        thumbnail: { type: 'string' },
        keywords: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        custom_fields: { type: 'object', additionalProperties: true },
        comments: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: { text: { type: 'string' }, media: { type: 'string' } },
                additionalProperties: false,
              },
            ],
          },
        },
        wait_seconds: { type: 'number', minimum: 0, maximum: 300, description: '0 trả job ngay; 1-300 chờ kết quả đăng.' },
      },
      required: ['platform'],
      anyOf: [{ required: ['profile'] }, { required: ['profile_id'] }],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_publish_batch',
    description: 'Đăng batch một/nhiều profile và target bằng runner đa luồng; concurrency/delay lấy từ Cài đặt trong Super Post King.',
    inputSchema: {
      type: 'object',
      properties: {
        batch_key: { type: 'string', description: 'Khóa ổn định để sinh request_id chống trùng.' },
        platform: { type: 'string', enum: ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'] },
        profiles: { type: 'array', items: { type: 'string' } },
        profile_ids: { type: 'array', items: { type: 'integer' } },
        distribution: { type: 'string', enum: ['mapped', 'all_profiles'], default: 'mapped' },
        items: { type: 'array', minItems: 1, maxItems: 500, items: batchItemSchema },
        wait_seconds: { type: 'number', minimum: 0, maximum: 300 },
      },
      required: ['batch_key', 'platform', 'items'],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_get_job',
    description: 'Lấy kết quả một job: trạng thái, link_post, link_pending, time_post và lỗi. Không publish lại khi link_pending=true.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_wait_job',
    description: 'Cho mot request cho den khi job ket thuc hoac het thoi gian; khong can goi get_job lien tuc.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        wait_seconds: { type: 'number', minimum: 1, maximum: 300, default: 30 },
      },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_wait_events',
    description: 'Cho su kien realtime moi sau event_id; dung khi client khong ho tro MCP notification.',
    inputSchema: {
      type: 'object',
      properties: {
        after_event_id: { type: 'integer', minimum: 0, default: 0 },
        job_id: { type: 'string' },
        batch_id: { type: 'string' },
        platform: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
        wait_seconds: { type: 'number', minimum: 1, maximum: 300, default: 30 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_get_batch',
    description: 'Lấy toàn bộ trạng thái và kết quả/link của một batch đa profile.',
    inputSchema: {
      type: 'object',
      properties: { batch_id: { type: 'string' } },
      required: ['batch_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_list_jobs',
    description: 'Liệt kê các job gần nhất do agent gửi sang Super Post - King.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string' },
        status: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'super_post_cancel_job',
    description: 'Hủy một job Agent API khi job vẫn đang chờ.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
];

async function callTool(name, args) {
  switch (name) {
    case 'super_post_get_capabilities':
      return api('/api/agent/v1/capabilities');
    case 'super_post_get_runtime_config':
      return api(`/api/agent/v1/runtime-config?platform=${encodeURIComponent(args.platform)}`);
    case 'super_post_get_data_schema':
      return api(`/api/agent/v1/data-schema?platform=${encodeURIComponent(args.platform)}`);
    case 'super_post_list_profiles':
      return api(`/api/agent/v1/profiles?platform=${encodeURIComponent(args.platform)}`);
    case 'super_post_list_profile_groups':
      return api(`/api/agent/v1/profile-groups?platform=${encodeURIComponent(args.platform)}`);
    case 'super_post_list_targets': {
      const query = new URLSearchParams({ platform: args.platform });
      if (Array.isArray(args.profile_ids) && args.profile_ids.length) {
        query.set('profile_ids', args.profile_ids.join(','));
      }
      return api(`/api/agent/v1/targets?${query}`);
    }
    case 'super_post_list_platform_data': {
      const query = new URLSearchParams({ platform: args.platform });
      if (args.status) query.set('status', args.status);
      if (args.limit) query.set('limit', String(args.limit));
      return api(`/api/agent/v1/platform-data?${query}`);
    }
    case 'super_post_create_data':
      return api('/api/agent/v1/platform-data', { method: 'POST', body: args });
    case 'super_post_create_data_batch':
      return api('/api/agent/v1/platform-data/batch', { method: 'POST', body: args });
    case 'super_post_assign_profiles':
      return api('/api/agent/v1/assign-profiles', { method: 'POST', body: args });
    case 'super_post_list_publish_groups': {
      const query = new URLSearchParams();
      if (args.platform) query.set('platform', args.platform);
      return api(`/api/agent/v1/publish-groups${query.size ? `?${query}` : ''}`);
    }
    case 'super_post_get_publish_group': {
      const query = new URLSearchParams();
      if (args.platform) query.set('platform', args.platform);
      return api(`/api/agent/v1/publish-groups/${encodeURIComponent(args.identifier)}${query.size ? `?${query}` : ''}`);
    }
    case 'super_post_create_publish_group':
      return api('/api/agent/v1/publish-groups', { method: 'POST', body: args });
    case 'super_post_update_publish_group': {
      const { identifier, ...body } = args;
      return api(`/api/agent/v1/publish-groups/${encodeURIComponent(identifier)}`, { method: 'PUT', body });
    }
    case 'super_post_delete_publish_group': {
      const query = new URLSearchParams();
      if (args.platform) query.set('platform', args.platform);
      return api(`/api/agent/v1/publish-groups/${encodeURIComponent(args.identifier)}${query.size ? `?${query}` : ''}`, {
        method: 'DELETE',
      });
    }
    case 'super_post_publish_group':
      return publishGroup(args);
    case 'super_post_list_publish_campaigns':
      return api('/api/agent/v1/publish-campaigns');
    case 'super_post_get_publish_campaign':
      return api(`/api/agent/v1/publish-campaigns/${encodeURIComponent(args.identifier)}`);
    case 'super_post_create_publish_campaign':
      return api('/api/agent/v1/publish-campaigns', { method: 'POST', body: args });
    case 'super_post_update_publish_campaign': {
      const { identifier, ...body } = args;
      return api(`/api/agent/v1/publish-campaigns/${encodeURIComponent(identifier)}`, { method: 'PUT', body });
    }
    case 'super_post_delete_publish_campaign':
      return api(`/api/agent/v1/publish-campaigns/${encodeURIComponent(args.identifier)}`, { method: 'DELETE' });
    case 'super_post_list_schedules': {
      const query = new URLSearchParams();
      if (args.platform) query.set('platform', args.platform);
      if (args.status) query.set('status', args.status);
      if (args.enabled !== undefined) query.set('enabled', String(args.enabled));
      return api(`/api/agent/v1/schedules${query.size ? `?${query}` : ''}`);
    }
    case 'super_post_get_schedule': {
      const query = new URLSearchParams();
      if (args.platform) query.set('platform', args.platform);
      return api(`/api/agent/v1/schedules/${encodeURIComponent(args.identifier)}${query.size ? `?${query}` : ''}`);
    }
    case 'super_post_create_schedule':
      return api('/api/agent/v1/schedules', { method: 'POST', body: args });
    case 'super_post_update_schedule': {
      const { identifier, ...body } = args;
      return api(`/api/agent/v1/schedules/${encodeURIComponent(identifier)}`, {
        method: 'PUT',
        body,
      });
    }
    case 'super_post_set_schedule_enabled': {
      const { identifier, ...body } = args;
      return api(`/api/agent/v1/schedules/${encodeURIComponent(identifier)}/enabled`, {
        method: 'PATCH',
        body,
      });
    }
    case 'super_post_delete_schedule': {
      const query = new URLSearchParams();
      if (args.platform) query.set('platform', args.platform);
      return api(`/api/agent/v1/schedules/${encodeURIComponent(args.identifier)}${query.size ? `?${query}` : ''}`, {
        method: 'DELETE',
      });
    }
    case 'super_post_publish_campaign':
      return publishCampaign(args);
    case 'super_post_publish_data':
      return publishData(args);
    case 'super_post_publish_data_batch':
      return publishDataBatch(args);
    case 'super_post_publish':
      return publish(args);
    case 'super_post_publish_batch':
      return publishBatch(args);
    case 'super_post_get_job':
      return api(`/api/agent/v1/jobs/${encodeURIComponent(args.job_id)}`);
    case 'super_post_wait_job': {
      const query = new URLSearchParams({
        wait_seconds: String(Math.min(300, Math.max(1, Number(args.wait_seconds) || 30))),
      });
      return api(`/api/agent/v1/jobs/${encodeURIComponent(args.job_id)}/wait?${query}`);
    }
    case 'super_post_wait_events': {
      const query = new URLSearchParams({
        after_event_id: String(Math.max(0, Number(args.after_event_id) || 0)),
        wait_seconds: String(Math.min(300, Math.max(1, Number(args.wait_seconds) || 30))),
      });
      if (args.job_id) query.set('job_id', args.job_id);
      if (args.batch_id) query.set('batch_id', args.batch_id);
      if (args.platform) query.set('platform', args.platform);
      if (args.limit) query.set('limit', String(args.limit));
      return api(`/api/agent/v1/events/wait?${query}`);
    }
    case 'super_post_get_batch':
      return api(`/api/agent/v1/batches/${encodeURIComponent(args.batch_id)}`);
    case 'super_post_list_jobs': {
      const query = new URLSearchParams();
      if (args.platform) query.set('platform', args.platform);
      if (args.status) query.set('status', args.status);
      if (args.limit) query.set('limit', String(args.limit));
      return api(`/api/agent/v1/jobs?${query}`);
    }
    case 'super_post_cancel_job':
      return api(`/api/agent/v1/jobs/${encodeURIComponent(args.job_id)}/cancel`, { method: 'POST', body: {} });
    default:
      throw new Error(`MCP tool không tồn tại: ${name}`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) { send({ jsonrpc: '2.0', id, result: value }); }
function rpcError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }
function structuredResult(value) {
  if (Array.isArray(value)) return { items: value, count: value.length };
  if (value && typeof value === 'object') return value;
  return { value };
}

function startNotificationPump() {
  if (notificationPumpStarted) return;
  notificationPumpStarted = true;
  notificationPumpStopped = false;
  (async () => {
    while (!notificationPumpStopped) {
      try {
        if (notificationCursor === null) {
          const status = await api('/api/agent/v1/events/status');
          notificationCursor = Number(status.last_event_id) || 0;
        }
        const query = new URLSearchParams({
          after_event_id: String(notificationCursor),
          wait_seconds: '30',
          limit: '100',
        });
        const response = await api(`/api/agent/v1/events/wait?${query}`);
        for (const event of response.events || []) {
          notificationCursor = Math.max(notificationCursor, Number(event.event_id) || 0);
          send({
            jsonrpc: '2.0',
            method: 'notifications/message',
            params: {
              level: event.type === 'job.error' ? 'error' : 'info',
              logger: 'super-post-king',
              data: event,
            },
          });
        }
        notificationCursor = Math.max(notificationCursor, Number(response.last_event_id) || 0);
      } catch (_) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  })();
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0') return;
  const { id, method, params = {} } = message;
  if (method === 'notifications/initialized') {
    startNotificationPump();
    return;
  }
  if (method === 'notifications/cancelled') return;
  try {
    if (method === 'initialize') {
      return result(id, {
        protocolVersion: params.protocolVersion || '2024-11-05',
        capabilities: { tools: {}, logging: {} },
        serverInfo: { name: 'super-post-king', version: '1.9.0' },
        instructions: 'Dùng create_data để thêm hàng Đợi mà không đăng. Khi hàng đã có post_id, dùng publish_data để đăng đúng hàng đó và không tạo bản sao. all_pending cần xác nhận rõ trước khi cho phép lấy hàng mới. Mọi concurrency và delay lấy từ Cài đặt trong Super Post King; agent không ghi đè.',
      });
    }
    if (method === 'ping') return result(id, {});
    if (method === 'tools/list') return result(id, { tools });
    if (method === 'tools/call') {
      try {
        const data = await callTool(params.name, params.arguments || {});
        return result(id, {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          structuredContent: structuredResult(data),
          isError: false,
        });
      } catch (error) {
        return result(id, {
          content: [{ type: 'text', text: `${error.code ? `${error.code}: ` : ''}${error.message}` }],
          isError: true,
        });
      }
    }
    if (id !== undefined) rpcError(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    if (id !== undefined) rpcError(id, -32603, error.message);
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  const value = line.trim();
  if (!value) return;
  try { handle(JSON.parse(value)); }
  catch (error) { rpcError(null, -32700, error.message); }
});
input.on('close', () => {
  notificationPumpStopped = true;
});
