const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const FacebookAdapter = require('../src/platforms/facebook.adapter');
const { FacebookAutomation } = FacebookAdapter._private;

test('Group media uploads through the existing file input without waiting for FileChooser', async () => {
  const uploaded = [];
  const input = {
    uploadFile: async (...files) => uploaded.push(...files),
  };
  const modal = {
    evaluateHandle: async () => ({ asElement: () => input }),
    evaluate: async () => ({ readyButton: true, processing: false }),
  };
  const page = {
    waitForFileChooser: async () => {
      throw new Error('waitForFileChooser must not run when an input exists');
    },
    evaluateHandle: async () => ({ asElement: () => null }),
  };
  const automation = new FacebookAutomation({ sleep: async () => {} });

  const result = await automation._attachGroupMedia(page, modal, __filename);

  assert.deepEqual(uploaded, [path.resolve(__filename)]);
  assert.deepEqual(result.mediaPaths, [path.resolve(__filename)]);
});

test('Group media waits for Facebook to finish loading the file input', async () => {
  const uploaded = [];
  const input = { uploadFile: async (...files) => uploaded.push(...files) };
  let checks = 0;
  const modal = {
    evaluateHandle: async () => ({
      asElement: () => (++checks >= 3 ? input : null),
    }),
    evaluate: async () => ({ readyButton: true, processing: false }),
  };
  const page = {
    waitForFileChooser: async () => {
      throw new Error('waitForFileChooser must not run after the delayed input appears');
    },
    evaluateHandle: async () => ({ asElement: () => null }),
  };
  const automation = new FacebookAutomation({ sleep: async () => {} });
  automation._getGroupComposer = async () => modal;

  await automation._attachGroupMedia(page, modal, __filename);

  assert.ok(checks >= 3);
  assert.deepEqual(uploaded, [path.resolve(__filename)]);
});
