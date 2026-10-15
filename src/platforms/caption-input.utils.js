const CAPTION_INPUT_MODES = Object.freeze({
  FAST: 'fast',
  TYPING: 'typing',
});

function normalizeCaptionInputMode(value) {
  return value === CAPTION_INPUT_MODES.TYPING
    ? CAPTION_INPUT_MODES.TYPING
    : CAPTION_INPUT_MODES.FAST;
}

async function inputCaptionText(page, editor, value, options = {}) {
  const text = String(value == null ? '' : value);
  if (!text) return normalizeCaptionInputMode(options.captionInputMode);

  const mode = normalizeCaptionInputMode(options.captionInputMode);
  const parsedDelay = Number(options.captionTypingDelayMs);
  const delay = Math.min(
    1000,
    Math.max(0, Number.isFinite(parsedDelay) ? parsedDelay : 30)
  );

  if (editor && typeof editor.evaluate === 'function') {
    await editor.evaluate(element => element.focus()).catch(() => {});
  }

  if (mode === CAPTION_INPUT_MODES.TYPING) {
    if (page?.keyboard && typeof page.keyboard.type === 'function') {
      await page.keyboard.type(text, { delay });
      return mode;
    }
    if (editor && typeof editor.type === 'function') {
      await editor.type(text, { delay });
      return mode;
    }
  } else if (page?.keyboard) {
    if (typeof page.keyboard.insertText === 'function') {
      await page.keyboard.insertText(text);
      return mode;
    }
    if (typeof page.keyboard.__covergemFastInputText === 'function') {
      await page.keyboard.__covergemFastInputText(text);
      return mode;
    }
    if (typeof page.keyboard.sendCharacter === 'function') {
      await page.keyboard.sendCharacter(text);
      return mode;
    }
  }

  if (!editor || typeof editor.evaluate !== 'function') {
    throw new Error('Không thể nhập caption vào ô soạn bài.');
  }

  await editor.evaluate((element, input) => {
    element.focus();
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      const prototype = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      const nextValue = `${element.value || ''}${input}`;
      if (setter) setter.call(element, nextValue);
      else element.value = nextValue;
    } else if (!document.execCommand('insertText', false, input)) {
      element.textContent = `${element.textContent || ''}${input}`;
    }
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: input,
    }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, text);
  return mode;
}

module.exports = {
  CAPTION_INPUT_MODES,
  normalizeCaptionInputMode,
  inputCaptionText,
};
