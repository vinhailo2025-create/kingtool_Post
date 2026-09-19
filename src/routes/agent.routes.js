const express = require('express');
const router = express.Router();
const AgentAuth = require('../services/agent-auth.service');
const AgentData = require('../services/agent-data.service');
const AgentJobs = require('../services/agent-job.service');
const AgentSchedules = require('../services/agent-schedule.service');
const AgentEvents = require('../services/agent-event.service');
const BrowserService = require('../services/browser.service');
const PublishGroups = require('../services/publish-group.service');
const PublishCampaigns = require('../services/publish-campaign.service');
const { PLATFORMS } = require('../platforms/platform.utils');

function statusFor(error) {
  if (error && (
    error.code === 'AGENT_JOB_NOT_FOUND'
    || error.code === 'AGENT_POST_NOT_FOUND'
    || error.code === 'AGENT_BATCH_NOT_FOUND'
    || error.code === 'PUBLISH_GROUP_NOT_FOUND'
    || error.code === 'PUBLISH_CAMPAIGN_NOT_FOUND'
    || error.code === 'AGENT_SCHEDULE_NOT_FOUND'
    || error.code === 'AGENT_DATA_NOT_FOUND'
  )) return 404;
  if (error && (
    error.code === 'AGENT_SCHEDULE_KEY_CONFLICT'
    || error.code === 'AGENT_DATA_KEY_CONFLICT'
    || error.code === 'AGENT_DATA_BATCH_IDEMPOTENCY_CONFLICT'
    || error.code === 'AGENT_REQUEST_ID_CONFLICT'
    || error.code === 'AGENT_POST_JOB_ACTIVE'
    || error.code === 'AGENT_DATA_ACTIVE_ALL_PENDING_SCHEDULE'
  )) return 409;
  if (error && (error.code === 'LICENSE_INVALID' || error.code === 'PLATFORM_NOT_LICENSED')) return 403;
  return 400;
}

function fail(res, error) {
  res.status(statusFor(error)).json({
    success: false,
    error: error.message,
    code: error.code || 'AGENT_API_ERROR',
  });
}

function parseProfileIds(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
    .map(Number)
    .filter(item => Number.isInteger(item) && item > 0);
}

function broadcastSchedule(req, schedule, action) {
  try {
    req.app.locals.broadcastLog({
      type: 'schedule',
      event: `agent_schedule_${action}`,
      message: `${action}: ${schedule.name}`,
      status: action === 'delete' ? 'warning' : 'info',
      time: new Date().toISOString(),
      platform: schedule.platform,
      schedule_id: schedule.schedule_id,
    });
  } catch (_) {}
}

// Health is intentionally unauthenticated and contains no account/post data.
router.get('/health', (_req, res) => {
  AgentAuth.ensureKey();
  res.json({
    success: true,
    data: {
      service: 'super-post-king-agent-api',
      version: 1,
      platforms: PLATFORMS,
      auth_required: true,
      key_file: AgentAuth.keyPath(),
      mode: process.env.COVERGEMAUTO_DESKTOP === '1' ? 'desktop' : 'web',
    },
  });
});

router.use(AgentAuth.middleware);

router.get('/capabilities', (_req, res) => {
  try {
    res.json({ success: true, data: AgentJobs.getCapabilities() });
  } catch (error) { fail(res, error); }
});

router.get('/runtime-config', (req, res) => {
  try {
    res.json({ success: true, data: AgentJobs.getRuntimeConfig(req.query.platform) });
  } catch (error) { fail(res, error); }
});

router.get('/data-schema', (req, res) => {
  try {
    res.json({ success: true, data: AgentJobs.getDataSchema(req.query.platform) });
  } catch (error) { fail(res, error); }
});

router.get('/profiles', async (req, res) => {
  try {
    // Quet offline cookie truoc de trang thai dang nhap chuan giong tab Trinh duyet.
    await BrowserService.scanCookieLogins().catch(() => {});
    res.json({ success: true, data: AgentJobs.listProfiles(req.query.platform) });
  } catch (error) { fail(res, error); }
});

router.get('/profile-groups', (req, res) => {
  try {
    res.json({ success: true, data: AgentJobs.listProfileGroups(req.query.platform) });
  } catch (error) { fail(res, error); }
});

router.get('/targets', (req, res) => {
  try {
    const profileIds = parseProfileIds(req.query.profile_ids);
    res.json({ success: true, data: AgentJobs.listTargets(req.query.platform, profileIds) });
  } catch (error) { fail(res, error); }
});

router.get('/platform-data', (req, res) => {
  try {
    res.json({
      success: true,
      data: AgentJobs.listPlatformData({
        platform: req.query.platform,
        status: req.query.status,
        limit: req.query.limit,
      }),
    });
  } catch (error) { fail(res, error); }
});

router.post('/platform-data', (req, res) => {
  try {
    const item = AgentData.create(req.body || {});
    res.status(item.idempotent_replay ? 200 : 201).json({ success: true, data: item });
  } catch (error) { fail(res, error); }
});

router.post('/platform-data/batch', (req, res) => {
  try {
    const batch = AgentData.createBatch(req.body || {});
    res.status(batch.created_count ? 201 : 200).json({ success: true, data: batch });
  } catch (error) { fail(res, error); }
});

router.delete('/platform-data', (req, res) => {
  try {
    res.json({ success: true, data: AgentJobs.deletePlatformData(req.body || {}) });
  } catch (error) { fail(res, error); }
});

router.post('/comment-links', (req, res) => {
  try {
    const result = AgentData.commentLinks(req.body || {});
    res.status(result.scheduled_count ? 201 : 200).json({ success: true, data: result });
  } catch (error) { fail(res, error); }
});

router.post('/runner/stop', (req, res) => {
  try {
    const result = AgentJobs.stopRunner(req.body || {});
    if (result.was_running) {
      try {
        req.app.locals.broadcastLog({
          type: 'warning',
          event: 'agent_runner_stop',
          message: 'Agent API yêu cầu dừng runner.',
          status: 'warning',
          time: new Date().toISOString(),
          platform: result.platform,
        });
      } catch (_) {}
    }
    res.json({ success: true, data: result });
  } catch (error) { fail(res, error); }
});

router.post('/assign-profiles', (req, res) => {
  try {
    res.json({ success: true, data: AgentJobs.assignProfiles(req.body || {}) });
  } catch (error) { fail(res, error); }
});

router.get('/publish-groups', (req, res) => {
  try {
    res.json({ success: true, data: PublishGroups.list({ platform: req.query.platform }) });
  } catch (error) { fail(res, error); }
});

router.post('/publish-groups', (req, res) => {
  try {
    res.status(201).json({ success: true, data: PublishGroups.create(req.body || {}) });
  } catch (error) { fail(res, error); }
});

router.get('/publish-groups/:identifier', (req, res) => {
  try {
    res.json({
      success: true,
      data: PublishGroups.get(req.params.identifier, req.query.platform || ''),
    });
  } catch (error) { fail(res, error); }
});

router.put('/publish-groups/:identifier', (req, res) => {
  try {
    res.json({ success: true, data: PublishGroups.update(req.params.identifier, req.body || {}) });
  } catch (error) { fail(res, error); }
});

router.delete('/publish-groups/:identifier', (req, res) => {
  try {
    res.json({
      success: true,
      data: PublishGroups.remove(req.params.identifier, req.query.platform || ''),
    });
  } catch (error) { fail(res, error); }
});

router.get('/publish-campaigns', (_req, res) => {
  try {
    res.json({ success: true, data: PublishCampaigns.list() });
  } catch (error) { fail(res, error); }
});

router.post('/publish-campaigns', (req, res) => {
  try {
    res.status(201).json({ success: true, data: PublishCampaigns.create(req.body || {}) });
  } catch (error) { fail(res, error); }
});

router.get('/publish-campaigns/:identifier', (req, res) => {
  try {
    res.json({ success: true, data: PublishCampaigns.get(req.params.identifier) });
  } catch (error) { fail(res, error); }
});

router.put('/publish-campaigns/:identifier', (req, res) => {
  try {
    res.json({ success: true, data: PublishCampaigns.update(req.params.identifier, req.body || {}) });
  } catch (error) { fail(res, error); }
});

router.delete('/publish-campaigns/:identifier', (req, res) => {
  try {
    res.json({ success: true, data: PublishCampaigns.remove(req.params.identifier) });
  } catch (error) { fail(res, error); }
});

router.get('/schedules', (req, res) => {
  try {
    const enabledRaw = req.query.enabled;
    if (enabledRaw !== undefined && !['true', 'false'].includes(String(enabledRaw).toLowerCase())) {
      const error = new Error('enabled phải là true hoặc false.');
      error.code = 'AGENT_SCHEDULE_ENABLED_INVALID';
      throw error;
    }
    const enabled = enabledRaw === undefined
      ? undefined
      : String(enabledRaw).toLowerCase() === 'true';
    res.json({
      success: true,
      data: AgentSchedules.list({
        platform: req.query.platform || 'all',
        status: req.query.status,
        enabled,
      }),
    });
  } catch (error) { fail(res, error); }
});

router.post('/schedules', (req, res) => {
  try {
    const schedule = AgentSchedules.create(req.body || {});
    broadcastSchedule(req, schedule, schedule.idempotent_replay ? 'replay' : 'create');
    res.status(schedule.idempotent_replay ? 200 : 201).json({ success: true, data: schedule });
  } catch (error) { fail(res, error); }
});

router.get('/schedules/:identifier', (req, res) => {
  try {
    res.json({
      success: true,
      data: AgentSchedules.get(req.params.identifier, req.query.platform || ''),
    });
  } catch (error) { fail(res, error); }
});

router.put('/schedules/:identifier', (req, res) => {
  try {
    const schedule = AgentSchedules.update(req.params.identifier, req.body || {});
    broadcastSchedule(req, schedule, 'update');
    res.json({ success: true, data: schedule });
  } catch (error) { fail(res, error); }
});

router.patch('/schedules/:identifier/enabled', (req, res) => {
  try {
    const schedule = AgentSchedules.setEnabled(
      req.params.identifier,
      req.body && req.body.enabled,
      req.body && req.body.platform || ''
    );
    broadcastSchedule(req, schedule, schedule.enabled ? 'enable' : 'disable');
    res.json({ success: true, data: schedule });
  } catch (error) { fail(res, error); }
});

router.delete('/schedules/:identifier', (req, res) => {
  try {
    const schedule = AgentSchedules.remove(req.params.identifier, req.query.platform || '');
    broadcastSchedule(req, schedule, 'delete');
    res.json({ success: true, data: schedule });
  } catch (error) { fail(res, error); }
});

router.post('/publish', async (req, res) => {
  try {
    let job = AgentJobs.createJob(req.body || {});
    const waitSeconds = Number(req.body && req.body.wait_seconds) || 0;
    if (waitSeconds > 0) job = await AgentJobs.waitForJob(job.job_id, waitSeconds);
    res.status(job.status === 'queued' || job.status === 'running' ? 202 : 200)
      .json({ success: true, data: job });
  } catch (error) { fail(res, error); }
});

router.post('/publish-data', async (req, res) => {
  try {
    let job = AgentJobs.createDataJob(req.body || {});
    const waitSeconds = Number(req.body && req.body.wait_seconds) || 0;
    if (waitSeconds > 0) job = await AgentJobs.waitForJob(job.job_id, waitSeconds);
    res.status(job.status === 'queued' || job.status === 'running' ? 202 : 200)
      .json({ success: true, data: job });
  } catch (error) { fail(res, error); }
});

router.post('/publish-data-batch', async (req, res) => {
  try {
    let batch = AgentJobs.createDataBatch(req.body || {});
    const waitSeconds = Number(req.body && req.body.wait_seconds) || 0;
    if (waitSeconds > 0 && batch.batch_id) {
      batch = await AgentJobs.waitForBatch(batch.batch_id, waitSeconds);
    }
    res.status(batch.status === 'queued' || batch.status === 'running' ? 202 : 200)
      .json({ success: true, data: batch });
  } catch (error) { fail(res, error); }
});

router.post('/publish-batch', async (req, res) => {
  try {
    let batch = AgentJobs.createBatch(req.body || {});
    const waitSeconds = Number(req.body && req.body.wait_seconds) || 0;
    if (waitSeconds > 0 && batch.batch_id) {
      batch = await AgentJobs.waitForBatch(batch.batch_id, waitSeconds);
    }
    res.status(batch.status === 'queued' || batch.status === 'running' ? 202 : 200)
      .json({ success: true, data: batch });
  } catch (error) { fail(res, error); }
});

router.get('/jobs', (req, res) => {
  try {
    res.json({ success: true, data: AgentJobs.listJobs(req.query) });
  } catch (error) { fail(res, error); }
});

router.get('/events', (req, res) => {
  try {
    res.json({
      success: true,
      data: AgentEvents.list({
        after_event_id: req.query.after_event_id,
        job_id: req.query.job_id,
        batch_id: req.query.batch_id,
        platform: req.query.platform,
        limit: req.query.limit,
      }),
    });
  } catch (error) { fail(res, error); }
});

router.get('/events/status', (_req, res) => {
  try {
    res.json({ success: true, data: AgentEvents.status() });
  } catch (error) { fail(res, error); }
});

router.get('/events/wait', async (req, res) => {
  try {
    const data = await AgentEvents.wait({
      after_event_id: req.query.after_event_id,
      job_id: req.query.job_id,
      batch_id: req.query.batch_id,
      platform: req.query.platform,
      limit: req.query.limit,
      wait_seconds: req.query.wait_seconds,
    });
    res.json({ success: true, data });
  } catch (error) { fail(res, error); }
});

router.get('/jobs/:jobId/wait', async (req, res) => {
  try {
    const data = await AgentJobs.waitForJob(req.params.jobId, req.query.wait_seconds);
    res.json({ success: true, data });
  } catch (error) { fail(res, error); }
});

router.get('/jobs/:jobId', (req, res) => {
  try {
    res.json({ success: true, data: AgentJobs.getJob(req.params.jobId) });
  } catch (error) { fail(res, error); }
});

router.get('/batches/:batchId', (req, res) => {
  try {
    res.json({ success: true, data: AgentJobs.getBatch(req.params.batchId) });
  } catch (error) { fail(res, error); }
});

router.post('/jobs/:jobId/cancel', (req, res) => {
  try {
    res.json({ success: true, data: AgentJobs.cancelJob(req.params.jobId) });
  } catch (error) { fail(res, error); }
});

module.exports = router;
module.exports._private = { parseProfileIds };
