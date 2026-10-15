const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  inputCaptionText,
  normalizeCaptionInputMode,
} = require('../src/platforms/caption-input.utils');

const root = path.join(__dirname, '..');

test('input nhanh chèn caption một lần và gõ từng chữ dùng keyboard.type', async () => {
  const events = [];
  const editor = {
    async evaluate() {
      events.push('focus');
    },
  };
  const keyboard = {
    async insertText(value) {
      events.push(`insert:${value}`);
    },
    async type(value, options) {
      events.push(`type:${value}:${options.delay}`);
    },
  };

  assert.equal(normalizeCaptionInputMode('unknown'), 'fast');
  await inputCaptionText({ keyboard }, editor, 'Nội dung nhanh', {
    captionInputMode: 'fast',
  });
  await inputCaptionText({ keyboard }, editor, 'Nội dung gõ', {
    captionInputMode: 'typing',
    captionTypingDelayMs: 45,
  });

  assert.deepEqual(events, [
    'focus',
    'insert:Nội dung nhanh',
    'focus',
    'type:Nội dung gõ:45',
  ]);
});

test('input nhanh bỏ qua wrapper gõ chậm khi pacer đã cài', async () => {
  const events = [];
  const keyboard = {
    async sendCharacter(value) {
      events.push(`slow:${value}`);
    },
    async __covergemFastInputText(value) {
      events.push(`fast:${value}`);
    },
  };
  await inputCaptionText({ keyboard }, null, 'Một lần', {
    captionInputMode: 'fast',
  });
  assert.deepEqual(events, ['fast:Một lần']);
});

test('cài đặt chung lưu chế độ caption và runner chuyển xuống mọi adapter', () => {
  const settings = fs.readFileSync(path.join(root, 'public', 'js', 'settings.js'), 'utf8');
  const runner = fs.readFileSync(path.join(root, 'src', 'services', 'runner.service.js'), 'utf8');
  const pacing = fs.readFileSync(
    path.join(root, 'src', 'services', 'interaction-pacing.service.js'),
    'utf8'
  );

  assert.match(settings, /id="setting-caption-input-mode"/);
  assert.match(settings, /Input nhanh - chèn toàn bộ nội dung một lần/);
  assert.match(settings, /Gõ từng chữ - hiển thị từng ký tự/);
  assert.match(settings, /caption_input_mode:/);
  assert.match(pacing, /captionInputMode:\s*rows\.caption_input_mode/);
  assert.match(runner, /captionInputMode:\s*interactionConfig\.captionInputMode/);
});

test('bảy adapter đăng bài cùng dùng bộ nhập caption chung', () => {
  const names = ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'];
  for (const name of names) {
    const source = fs.readFileSync(
      path.join(root, 'src', 'platforms', `${name}.adapter.js`),
      'utf8'
    );
    assert.match(source, /inputCaptionText/, `${name} chưa dùng inputCaptionText`);
  }
});
