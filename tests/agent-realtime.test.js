const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spk-agent-events-'));
process.env.COVERGEMAUTO_DATA_DIR = tempRoot;

const db = require('../src/database/init');
const AgentEvents = require('../src/services/agent-event.service');
const AgentKitService = require('../src/services/agent-kit.service');

test.before(async () => {
  await db.waitReady();
  AgentEvents.init();
});

test.after(() => {
  AgentEvents.stop();
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('agent events preserve ordered status changes and support reconnect cursor', async () => {
  db.prepare(`
    INSERT INTO agent_jobs (
      job_id, request_id, platform, profile_id, profile_name, post_id, status
    ) VALUES (?, ?, 'facebook', 1, 'profile-a', 99, 'queued')
  `).run('job-realtime-1', 'request-realtime-1');
  db.prepare(`
    UPDATE agent_jobs
    SET status = 'running', started_at = CURRENT_TIMESTAMP
    WHERE job_id = ?
  `).run('job-realtime-1');

  const first = AgentEvents.list({ after_event_id: 0 });
  assert.deepEqual(first.events.map(event => event.type), ['job.queued', 'job.running']);
  assert.ok(first.events[1].event_id > first.events[0].event_id);

  const afterRunning = first.last_event_id;
  const waiting = AgentEvents.wait({
    after_event_id: afterRunning,
    job_id: 'job-realtime-1',
    wait_seconds: 2,
  });
  setTimeout(() => {
    db.prepare(`
      UPDATE agent_jobs
      SET status = 'success', completed_at = CURRENT_TIMESTAMP
      WHERE job_id = ?
    `).run('job-realtime-1');
  }, 100);

  const resumed = await waiting;
  assert.equal(resumed.timed_out, false);
  assert.equal(resumed.events.length, 1);
  assert.equal(resumed.events[0].type, 'job.success');
  assert.ok(resumed.events[0].event_id > afterRunning);
});

test('explicit progress and link recovery events are durable', () => {
  const progress = AgentEvents.record('job.progress', {
    job_id: 'job-realtime-1',
    platform: 'facebook',
    profile: 'profile-a',
    post_id: 99,
    status: 'running',
    payload: { progress: { completed: 1, total: 2 } },
  });
  const recovery = AgentEvents.record('link_recovery.updated', {
    job_id: 'job-realtime-1',
    platform: 'facebook',
    post_id: 99,
    status: 'success',
    payload: { link_post: 'https://www.facebook.com/example/posts/1' },
  });
  const replay = AgentEvents.list({ after_event_id: progress.event_id - 1 });

  assert.equal(replay.events[0].payload.progress.total, 2);
  assert.equal(replay.events[1].event_id, recovery.event_id);
  assert.equal(replay.events[1].payload.link_post, 'https://www.facebook.com/example/posts/1');
  assert.equal(AgentEvents.status().last_event_id, recovery.event_id);
});

test('Agent Kit status matches TOML-escaped Windows paths', () => {
  const normalize = AgentKitService._private.normalizedPath;
  assert.equal(
    normalize('C:\\\\Users\\\\Customer\\\\Super Post Agent Kit\\\\mcp'),
    normalize('C:\\Users\\Customer\\Super Post Agent Kit\\mcp')
  );
});
