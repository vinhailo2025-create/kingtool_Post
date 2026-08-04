const test = require('node:test');
const assert = require('node:assert/strict');

const { ProfileActionQueue } = require('../src/services/profile-action-queue.service');

test('due comment runs before a queued next post on the same profile', async () => {
  const queue = new ProfileActionQueue();
  const order = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });

  const first = queue.run(1, 'post', async () => {
    order.push('post-1-start');
    await firstGate;
    order.push('post-1-end');
  }, 0);

  const second = queue.run(1, 'post', async () => {
    order.push('post-2');
  }, 0);
  const comment = queue.run(1, 'comment', async () => {
    order.push('comment');
  }, 100);

  releaseFirst();
  await Promise.all([first, second, comment]);
  assert.deepEqual(order, ['post-1-start', 'post-1-end', 'comment', 'post-2']);
});

test('different profiles can run actions concurrently', async () => {
  const queue = new ProfileActionQueue();
  let profileOneActive = false;
  let overlapObserved = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });

  const one = queue.run(1, 'post', async () => {
    profileOneActive = true;
    await gate;
    profileOneActive = false;
  });
  const two = queue.run(2, 'comment', async () => {
    overlapObserved = profileOneActive;
    release();
  }, 100);

  await Promise.all([one, two]);
  assert.equal(overlapObserved, true);
});
