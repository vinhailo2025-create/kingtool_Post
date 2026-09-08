const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  normalizeEditorText,
  normalizeEditorTextForComparison,
  editorCaptionMatches,
  describeCaptionMismatch,
  replaceFacebookEditorText,
} = require('../src/platforms/facebook.adapter')._private;

function createEditorHarness({ reverseFirstInsert = false } = {}) {
  const state = { value: '', inserts: 0 };
  const editor = {
    async click() {},
    async evaluate(fn, ...args) {
      const source = String(fn);
      if (source.includes('String(element.innerText')) return state.value;
      if (source.includes("execCommand('insertText'")) {
        state.value = args[0];
        return;
      }
      if (source.includes("execCommand('delete'")) state.value = '';
    },
  };
  const keyboard = {
    async down() {},
    async up() {},
    async press(key) {
      if (key === 'Backspace') state.value = '';
    },
    async insertText(value) {
      state.inserts += 1;
      state.value = reverseFirstInsert && state.inserts === 1
        ? [...value].reverse().join('')
        : value;
    },
    async sendCharacter(value) {
      state.value = value;
    },
  };
  return { state, editor, page: { keyboard } };
}

test('caption Facebook giữ đúng Unicode và xuống dòng khi chèn nguyên khối', async () => {
  const harness = createEditorHarness();
  const caption = 'Vừa hoàn thiện xong Super Post King\nMời anh em trải nghiệm!';
  const result = await replaceFacebookEditorText(
    harness.page,
    harness.editor,
    caption
  );
  assert.equal(result, caption);
  assert.equal(harness.state.value, caption);
});

test('caption bị đảo được xóa và nhập lại trước khi đăng', async () => {
  const harness = createEditorHarness({ reverseFirstInsert: true });
  const caption = 'Tiếng Việt phải hiển thị đúng thứ tự.';
  const result = await replaceFacebookEditorText(
    harness.page,
    harness.editor,
    caption
  );
  assert.equal(result, caption);
  assert.equal(harness.state.value, caption);
});

test('luồng đăng Facebook không còn gõ caption từng ký tự', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'platforms', 'facebook.adapter.js'),
    'utf8'
  );
  assert.doesNotMatch(source, /keyboard\.type\(content/);
  assert.match(source, /FACEBOOK_CONTENT_MISMATCH/);
  assert.equal(
    normalizeEditorText('  Nội\u00a0dung\r\nđúng  '),
    'Nội dung\nđúng'
  );
});

test('xác minh caption chấp nhận cách Facebook biểu diễn xuống dòng trong DOM', () => {
  const expected = 'Tốt nghiệp khóa K2\nRất nhiều kết quả\nA.e cho feedback';
  const actual = 'Tốt nghiệp khóa K2\n\nRất nhiều kết quả\u00a0\n\nA.e cho feedback';

  assert.equal(editorCaptionMatches(expected, actual), true);
  assert.equal(
    normalizeEditorTextForComparison(actual),
    'Tốt nghiệp khóa K2 Rất nhiều kết quả A.e cho feedback'
  );
});

test('xác minh caption vẫn chặn khi Facebook làm mất ký tự', () => {
  const expected = 'Tốt nghiệp khóa K2\nA.e cho ít feedback nhé';
  const actual = 'Tốt nghiệp khóa K2\nA.e cho feedback nhé';

  assert.equal(editorCaptionMatches(expected, actual), false);
  assert.match(describeCaptionMismatch(expected, actual), /first_diff=\d+/);
});

test('caption được nhập lại trên editor mới khi Facebook dựng lại composer', async () => {
  const first = createEditorHarness({ reverseFirstInsert: true });
  const second = createEditorHarness();
  let resolveCount = 0;
  let active = first;
  const page = {
    keyboard: {
      async down() {},
      async up() {},
      async press(key) {
        if (key === 'Backspace') active.state.value = '';
      },
      async insertText(value) {
        active.state.value = [...value].reverse().join('');
      },
      async sendCharacter(value) {
        active.state.value = value;
      },
    },
  };

  const caption = 'Nội dung Group\nĐược Facebook giữ đúng';
  const result = await replaceFacebookEditorText(
    page,
    first.editor,
    caption,
    {
      verificationTimeoutMs: 500,
      async resolveEditor() {
        resolveCount += 1;
        active = resolveCount === 1 ? first : second;
        return active.editor;
      },
    }
  );

  assert.equal(result, caption);
  assert.equal(second.state.value, caption);
  assert.ok(resolveCount >= 2);
});
