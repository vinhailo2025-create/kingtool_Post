const fs = require('fs');
const { resolveMediaPath } = require('../services/media-path.utils');
const path = require('path');
const { inputCaptionText } = require('./caption-input.utils');

const UPLOAD_URL = 'https://www.tiktok.com/tiktokstudio/upload?from=webapp&tab=video';
const CONTENT_URL = 'https://www.tiktok.com/tiktokstudio/content?from=webapp';
const VIDEO_PATTERN = /\.(?:mp4|mov|m4v|avi|mkv|webm|wmv|mpeg|mpg|3gp)$/i;
const RESTRICTED_MESSAGES = [
  'Nội dung có thể sẽ bị hạn chế',
  'Content may be restricted',
];

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function getConfig(options = {}) {
  return {
    navigationTimeout: Number(options.navigationTimeout) || 90000,
    editorTimeout: Number(options.editorTimeout) || 120000,
    uploadTimeout: Number(options.uploadTimeout) || 600000,
    productTimeout: Number(options.productTimeout) || 45000,
    publishTimeout: Number(options.publishTimeout) || 90000,
    linkTimeout: Number(options.linkTimeout) || 120000,
    settleMs: Number.isFinite(Number(options.settleMs)) ? Number(options.settleMs) : 1200,
    continueOnRestricted: options.continueOnRestricted !== false,
  };
}

async function delay(ms) {
  if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms));
}

async function bodyText(page) {
  return page.evaluate(() => document.body?.innerText || '').catch(() => '');
}

async function assertNotRestricted(page, config = {}, log = () => {}) {
  const text = normalizeText(await bodyText(page));
  const restricted = RESTRICTED_MESSAGES.some(message => text.includes(normalizeText(message)));
  if (restricted) {
    if (config.continueOnRestricted !== false) {
      if (!page.__covergemTikTokRestrictionLogged) {
        page.__covergemTikTokRestrictionLogged = true;
        log(
          'TikTok cảnh báo nội dung có thể bị hạn chế; nút Đăng vẫn khả dụng nên tool tiếp tục.',
          'warning'
        );
      }
      return true;
    }
    throw codedError(
      'TIKTOK_CONTENT_RESTRICTED',
      'Đăng TikTok thất bại: kiểm tra nội dung nhanh báo “Nội dung có thể sẽ bị hạn chế”.'
    );
  }
  return false;
}

async function contentCheckState(page) {
  return page.evaluate(() => {
    const norm = value => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[đĐ]/g, 'd')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none'
        && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const all = Array.from(document.querySelectorAll('body *')).filter(visible);
    const headings = all.filter(element => {
      const text = norm(element.innerText || element.textContent || '');
      return text.includes('kiem tra noi dung nhanh')
        || text.includes('quick content check')
        || text.includes('content check lite');
    }).sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
    const heading = headings[0];
    if (!heading) return 'missing';

    const headingRect = heading.getBoundingClientRect();
    const statuses = all.map(element => ({
      element,
      text: norm(element.innerText || element.textContent || ''),
      rect: element.getBoundingClientRect(),
    })).filter(item => {
      if (item.text.includes('kiem tra noi dung nhanh')
        || item.text.includes('quick content check')
        || item.text.includes('content check lite')) return false;
      const isSafe = item.text.includes('khong phat hien van de nao')
        || item.text.includes('no issues detected')
        || item.text.includes('no issues found');
      const isRestricted = item.text.includes('noi dung co the se bi han che') || item.text.includes('content may be restricted');
      if (!isSafe && !isRestricted) return false;
      const verticalDistance = item.rect.top - headingRect.bottom;
      return verticalDistance >= -20 && verticalDistance <= 180;
    }).sort((a, b) => {
      const distanceA = Math.abs(a.rect.top - headingRect.bottom);
      const distanceB = Math.abs(b.rect.top - headingRect.bottom);
      return distanceA - distanceB || a.text.length - b.text.length;
    });

    if (!statuses.length) return 'pending';
    const status = statuses[0].text;
    if (status.includes('noi dung co the se bi han che') || status.includes('content may be restricted')) {
      return 'restricted';
    }
    return 'safe';
  }).catch(() => 'missing');
}

async function clickVisibleText(page, labels, { exact = false, scopeDialog = false } = {}) {
  const wanted = labels.map(normalizeText);
  return page.evaluate(({ wanted, exact, scopeDialog }) => {
    const norm = value => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[đĐ]/g, 'd')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const visible = element => {
      if (!element || !(element instanceof Element)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none'
        && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).filter(visible);
    const root = scopeDialog && dialogs.length ? dialogs[dialogs.length - 1] : document;
    const selector = 'button, [role="button"], a, label, [tabindex]:not([tabindex="-1"])';
    const candidates = Array.from(root.querySelectorAll(selector)).filter(visible);
    const match = candidates
      .map(element => ({
        element,
        text: norm(element.innerText || element.textContent || element.getAttribute('aria-label') || ''),
      }))
      .filter(item => wanted.some(value => exact ? item.text === value : item.text.includes(value)))
      .sort((a, b) => a.text.length - b.text.length)[0];
    if (!match) return false;
    match.element.scrollIntoView({ block: 'center', inline: 'center' });
    match.element.click();
    return true;
  }, { wanted, exact, scopeDialog }).catch(() => false);
}

async function findCaptionEditor(page) {
  const handle = await page.evaluateHandle(() => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 30 && rect.height > 15 && style.display !== 'none'
        && style.visibility !== 'hidden';
    };
    const selectors = [
      '[data-e2e="video-caption"] [contenteditable="true"]',
      '[data-e2e="caption-editor"] [contenteditable="true"]',
      '[data-lexical-editor="true"][contenteditable="true"]',
      '.public-DraftEditor-content[contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
      'textarea[placeholder*="description" i]',
      'textarea[placeholder*="caption" i]',
      'textarea',
      '[contenteditable="true"]',
    ];
    for (const selector of selectors) {
      const candidates = Array.from(document.querySelectorAll(selector)).filter(visible);
      if (candidates.length) return candidates[0];
    }
    return null;
  });
  return handle && handle.asElement ? handle.asElement() : null;
}

async function replaceEditorText(page, editor, content, options = {}) {
  await editor.click({ clickCount: 3 }).catch(() => editor.click());
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  if (content) await inputCaptionText(page, editor, content, options);

  const correct = await page.evaluate((element, expected) => {
    const value = element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
      ? element.value
      : element.innerText;
    return String(value || '').replace(/\r\n/g, '\n') === String(expected || '').replace(/\r\n/g, '\n');
  }, editor, content).catch(() => false);
  if (correct) return;

  await page.evaluate((element, value) => {
    element.focus();
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(element, value);
      else element.value = value;
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
      if (!document.execCommand('insertText', false, value)) element.textContent = value;
      selection.removeAllRanges();
    }
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: value,
    }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, editor, content);
}

async function continueUnsavedEditorPrompt(page, config) {
  const clicked = await page.evaluate(() => {
    const norm = value => String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd')
      .replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = element => {
      if (!element || !(element instanceof Element)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none'
        && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const text = norm(document.body?.innerText || '');
    const hasPrompt = text.includes('video ban dang chinh sua chua duoc luu')
      || text.includes('video you are editing has not been saved');
    if (!hasPrompt) return false;
    const button = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(visible)
      .find(element => ['tiep tuc', 'continue'].includes(
        norm(element.innerText || element.textContent || element.getAttribute('aria-label') || '')
      ));
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
    button.click();
    return true;
  }).catch(() => false);
  if (clicked) await delay(config.settleMs);
  return clicked;
}

async function findProductSearchInput(page) {
  const handle = await page.evaluateHandle(() => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 30 && rect.height > 15 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).filter(visible);
    const root = dialogs.length ? dialogs[dialogs.length - 1] : document;
    const inputs = Array.from(root.querySelectorAll('input:not([type="file"]):not([type="hidden"])')).filter(visible);
    return inputs.find(input => /search|product|san pham|tim kiem/i.test(
      `${input.placeholder || ''} ${input.getAttribute('aria-label') || ''}`
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    )) || inputs[0] || null;
  });
  return handle && handle.asElement ? handle.asElement() : null;
}

function parseProductIds(value) {
  const seen = new Set();
  return String(value || '')
    .split(/[,，\r\n]+/)
    .map(item => item.trim())
    .filter(item => {
      if (!item || seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

async function clickProductOption(page) {
  const clickedRowAction = await page.evaluate(() => {
    const norm = value => String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd')
      .replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = element => {
      if (!element || !(element instanceof Element)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none'
        && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).filter(visible);
    const root = dialogs.length ? dialogs[dialogs.length - 1] : document;
    const containers = Array.from(root.querySelectorAll(
      'tr, li, [role="row"], [data-e2e*="product"], section, div'
    )).filter(element => {
      if (!visible(element)) return false;
      const text = norm(element.innerText || element.textContent || '');
      return text.includes('san pham') || text.includes('product');
    }).sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);

    for (const container of containers) {
      const buttons = Array.from(container.querySelectorAll('button, [role="button"]')).filter(visible);
      const add = buttons.find(button => {
        const text = norm(
          button.innerText || button.textContent || button.getAttribute('aria-label') || ''
        );
        return ['them', 'add', 'tiep', 'next'].includes(text);
      });
      if (add) {
        add.click();
        return true;
      }
    }
    return false;
  }).catch(() => false);
  if (clickedRowAction) return true;

  let clicked = await clickVisibleText(page, ['Sản phẩm', 'Product'], {
    exact: false,
    scopeDialog: true,
  });
  if (!clicked) clicked = await clickVisibleText(page, ['Sản phẩm', 'Product'], { exact: false });
  return clicked;
}

async function clickAddLinkAction(page) {
  return page.evaluate(() => {
    const norm = value => String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd')
      .replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = element => {
      if (!element || !(element instanceof Element)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none'
        && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const headings = Array.from(document.querySelectorAll('body *')).filter(element => {
      if (!visible(element)) return false;
      return ['them lien ket', 'add link'].includes(norm(element.innerText || element.textContent || ''));
    }).sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);

    for (const heading of headings) {
      let container = heading.closest('[data-e2e="anchor_container"]') || heading.parentElement;
      for (let depth = 0; container && depth < 5; depth++, container = container.parentElement) {
        const actions = Array.from(container.querySelectorAll('button, [role="button"]'))
          .filter(element => {
            if (!visible(element) || element.disabled || element.getAttribute('aria-disabled') === 'true') {
              return false;
            }
            const text = norm(element.innerText || element.textContent || element.getAttribute('aria-label') || '');
            return ['them', 'add'].includes(text);
          });
        if (!actions.length) continue;
        const headingRect = heading.getBoundingClientRect();
        actions.sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return Math.abs(ar.top - headingRect.bottom) - Math.abs(br.top - headingRect.bottom);
        });
        actions[0].scrollIntoView({ block: 'center', inline: 'center' });
        actions[0].click();
        return true;
      }
    }
    return false;
  }).catch(() => false);
}

async function openProductPicker(page, config) {
  let clicked = await clickAddLinkAction(page);
  if (!clicked) {
    clicked = await clickVisibleText(page, ['Thêm liên kết', 'Add link'], { exact: false });
  }
  if (!clicked) {
    throw codedError('TIKTOK_ADD_LINK_NOT_FOUND', 'Không tìm thấy mục “Thêm liên kết” trên trang đăng TikTok.');
  }
  await delay(config.settleMs);

  let input = await findProductSearchInput(page);
  if (!input) {
    clicked = await clickProductOption(page);
    if (!clicked) {
      throw codedError('TIKTOK_PRODUCT_OPTION_NOT_FOUND', 'Không tìm thấy lựa chọn “Sản phẩm” trong mục Thêm liên kết.');
    }
    await delay(config.settleMs);
  }

  const started = Date.now();
  while (!input && Date.now() - started < config.productTimeout) {
    await delay(250);
    input = await findProductSearchInput(page);
  }
  if (!input) {
    throw codedError('TIKTOK_PRODUCT_SEARCH_NOT_FOUND', 'Không mở được hộp tìm kiếm sản phẩm TikTok.');
  }
  return input;
}

async function replaceProductSearchText(page, input, productId) {
  await input.click({ clickCount: 3 });
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.keyboard.sendCharacter(productId);
}

async function triggerProductSearch(page, input) {
  const clicked = await page.evaluate(element => {
    const norm = value => String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd')
      .replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = candidate => {
      if (!candidate || !(candidate instanceof Element)) return false;
      const rect = candidate.getBoundingClientRect();
      const style = getComputedStyle(candidate);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none'
        && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).filter(visible);
    const root = dialogs.length ? dialogs[dialogs.length - 1] : document;
    const inputRect = element.getBoundingClientRect();
    const actions = Array.from(root.querySelectorAll(
      'button, [role="button"], [class*="search-icon" i], [data-icon*="search" i]'
    )).filter(visible);
    const explicit = actions.filter(button => {
      const text = norm([
        button.innerText,
        button.textContent,
        button.getAttribute('aria-label'),
        button.getAttribute('title'),
        button.getAttribute('data-e2e'),
      ].filter(Boolean).join(' '));
      return text.includes('tim kiem') || text.includes('search')
        || Boolean(button.querySelector('[data-icon*="search" i], [class*="search" i], svg'));
    }).sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const ad = Math.abs(ar.left - inputRect.right) + Math.abs(ar.top - inputRect.top);
      const bd = Math.abs(br.left - inputRect.right) + Math.abs(br.top - inputRect.top);
      return ad - bd;
    })[0];
    if (!explicit) return false;
    explicit.click();
    return true;
  }, input).catch(() => false);
  if (!clicked) await input.press('Enter');
  return true;
}

async function inspectAndSelectProductRow(page, productId) {
  return page.evaluate(productIdValue => {
    const norm = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const normStatus = value => norm(value)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd');
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const needle = norm(productIdValue);
    const containsExactId = textValue => {
      const text = norm(textValue);
      let offset = text.indexOf(needle);
      const numeric = /^\d+$/.test(needle);
      while (offset >= 0) {
        const before = offset > 0 ? text[offset - 1] : '';
        const after = offset + needle.length < text.length ? text[offset + needle.length] : '';
        const boundaryPattern = numeric ? /\d/ : /[a-z0-9]/i;
        if (!boundaryPattern.test(before) && !boundaryPattern.test(after)) return true;
        offset = text.indexOf(needle, offset + 1);
      }
      return false;
    };
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).filter(visible);
    const root = dialogs.length ? dialogs[dialogs.length - 1] : document;
    const candidates = Array.from(root.querySelectorAll(
      'tr, li, [role="row"], [role="option"], [data-e2e*="product"], [class*="product" i]'
    )).filter(element => visible(element) && containsExactId(element.innerText || element.textContent || ''))
      .sort((a, b) => {
        const semanticA = a.matches('tr, li, [role="row"], [role="option"], [data-e2e*="product"]') ? 0 : 1;
        const semanticB = b.matches('tr, li, [role="row"], [role="option"], [data-e2e*="product"]') ? 0 : 1;
        return semanticA - semanticB || (a.innerText || '').length - (b.innerText || '').length;
      });
    const row = candidates[0];
    if (!row) return { state: 'pending' };

    const rowText = normStatus(row.innerText || row.textContent || '');
    const unavailableTerms = [
      'khong kha dung', 'het hang', 'da het hang', 'ngung ban', 'khong the them',
      'bi dinh chi', 'vi pham', 'unavailable', 'not available', 'out of stock',
      'sold out', 'disabled', 'suspended',
    ];
    let reason = unavailableTerms.find(term => rowText.includes(term)) || '';
    if (!reason) {
      const redStatus = Array.from(row.querySelectorAll('*')).find(element => {
        if (!visible(element)) return false;
        const text = normStatus(element.innerText || element.textContent || '');
        if (!text || text.length > 100 || text.includes(needle)) return false;
        if (/^[\d.,\s₫$€£¥-]+$/.test(text)) return false;
        const color = getComputedStyle(element).color.match(/\d+(?:\.\d+)?/g);
        if (!color || color.length < 3) return false;
        const [red, green, blue] = color.map(Number);
        return red >= 170 && red > green * 1.35 && red > blue * 1.35;
      });
      if (redStatus) reason = normStatus(redStatus.innerText || redStatus.textContent || 'trang thai do');
    }
    if (reason) return { state: 'unavailable', reason };

    const nativeCheckbox = Array.from(row.querySelectorAll('input[type="checkbox"], input[type="radio"]'))
      .find(visible);
    if (nativeCheckbox) {
      if (nativeCheckbox.disabled) return { state: 'unavailable', reason: 'disabled' };
      if (!nativeCheckbox.checked) {
        const label = nativeCheckbox.id
          ? row.querySelector(`label[for="${CSS.escape(nativeCheckbox.id)}"]`)
          : nativeCheckbox.closest('label');
        (label || nativeCheckbox).click();
      }
      return { state: 'selected' };
    }

    const roleCheckbox = Array.from(row.querySelectorAll('[role="checkbox"], [role="radio"]')).find(visible);
    if (roleCheckbox) {
      if (roleCheckbox.getAttribute('aria-disabled') === 'true') {
        return { state: 'unavailable', reason: 'disabled' };
      }
      if (roleCheckbox.getAttribute('aria-checked') !== 'true') roleCheckbox.click();
      return { state: 'selected' };
    }

    const buttons = Array.from(row.querySelectorAll('button, [role="button"]')).filter(visible);
    const action = buttons.find(button => {
      if (button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
      return /^(add|them|select|chon)$/i.test(
        normStatus(button.innerText || button.getAttribute('aria-label') || '')
      );
    });
    (action || row).click();
    return { state: action ? 'action-clicked' : 'selected' };
  }, productId).catch(() => ({ state: 'pending' }));
}

async function searchAndSelectProduct(page, input, productId, config) {
  await replaceProductSearchText(page, input, productId);
  await triggerProductSearch(page, input);
  const started = Date.now();
  while (Date.now() - started < config.productTimeout) {
    const result = await inspectAndSelectProductRow(page, productId);
    if (result.state !== 'pending') return result;
    await delay(300);
  }
  return { state: 'not-found', reason: 'Không tìm thấy kết quả đúng ID' };
}

async function confirmSelectedProduct(page, config, selectionState) {
  await delay(config.settleMs);

  if (selectionState !== 'action-clicked') {
    const next = await clickVisibleText(page, ['Tiếp', 'Next'], { exact: true, scopeDialog: true });
    if (!next) {
      const input = await findProductSearchInput(page);
      if (!input) return true;
    } else {
      await delay(config.settleMs);
    }
  }

  let added = await clickVisibleText(page, ['Thêm', 'Add'], { exact: true, scopeDialog: true });
  if (!added) {
    added = await clickVisibleText(page, ['Thêm sản phẩm', 'Add product'], {
      exact: false,
      scopeDialog: true,
    });
  }
  if (!added) {
    const input = await findProductSearchInput(page);
    if (input) {
      throw codedError('TIKTOK_PRODUCT_CONFIRM_NOT_FOUND', 'Đã chọn sản phẩm nhưng không tìm thấy nút “Tiếp/Thêm”.');
    }
  }
  await delay(config.settleMs);
  return true;
}

async function cancelProductPicker(page, config) {
  let cancelled = await clickVisibleText(page, ['Hủy', 'Cancel'], {
    exact: true,
    scopeDialog: true,
  });
  if (!cancelled) {
    cancelled = await page.evaluate(() => {
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 1 && rect.height > 1 && style.display !== 'none'
          && style.visibility !== 'hidden';
      };
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).filter(visible);
      const root = dialogs[dialogs.length - 1];
      if (!root) return false;
      const close = Array.from(root.querySelectorAll('button, [role="button"]')).find(button => {
        const label = `${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''}`.toLowerCase();
        return visible(button) && (label.includes('close') || label.includes('dong'));
      });
      if (!close) return false;
      close.click();
      return true;
    }).catch(() => false);
  }
  if (cancelled) await delay(config.settleMs);
  return cancelled;
}

async function attachProducts(page, productIds, config, log = () => {}) {
  const added = [];
  const skipped = [];
  let index = 0;

  while (index < productIds.length) {
    let input = await openProductPicker(page, config);
    let pickerOpen = true;

    while (pickerOpen && index < productIds.length) {
      const productId = productIds[index];
      log(`Đang tìm sản phẩm TikTok ID ${productId}...`, 'info');
      const result = await searchAndSelectProduct(page, input, productId, config);

      if (result.state === 'unavailable' || result.state === 'not-found') {
        skipped.push({ id: productId, reason: result.reason || result.state });
        log(
          `Bỏ qua sản phẩm ${productId}: ${result.reason || 'không khả dụng hoặc không tìm thấy'}.`,
          'warning'
        );
        index++;
        if (index >= productIds.length) {
          await cancelProductPicker(page, config);
          pickerOpen = false;
        } else {
          input = await findProductSearchInput(page);
          if (!input) {
            throw codedError(
              'TIKTOK_PRODUCT_SEARCH_CLOSED',
              'Hộp tìm kiếm sản phẩm đã đóng trước khi xử lý hết danh sách ID.'
            );
          }
        }
        continue;
      }

      await confirmSelectedProduct(page, config, result.state);
      added.push(productId);
      log(`Đã gắn sản phẩm TikTok ID ${productId}.`, 'success');
      index++;
      pickerOpen = false;
    }
  }

  return { added, skipped };
}

async function publishButtonState(page) {
  return page.evaluate(() => {
    const norm = value => String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd')
      .replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
    const button = buttons.find(element => {
      const text = norm(element.innerText || element.getAttribute('aria-label') || '');
      return ['dang', 'post', 'publish'].includes(text);
    });
    if (!button) return { found: false, enabled: false };
    const enabled = !button.disabled && button.getAttribute('aria-disabled') !== 'true'
      && !button.matches('[disabled]');
    return { found: true, enabled };
  }).catch(() => ({ found: false, enabled: false }));
}

async function uploadReadyState(page) {
  return page.evaluate(() => {
    const norm = value => String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd')
      .replace(/\s+/g, ' ').trim().toLowerCase();
    const text = norm(document.body?.innerText || '');
    const uploaded = text.includes('uploaded')
      || text.includes('da tai len')
      || text.includes('tai len thanh cong')
      || text.includes('upload complete');
    const stillUploading = text.includes('uploading')
      || text.includes('dang tai len')
      || text.includes('processing upload');
    return uploaded && !stillUploading;
  }).catch(() => false);
}

async function waitUntilReadyToPublish(page, config, log = () => {}) {
  const started = Date.now();
  while (Date.now() - started < config.uploadTimeout) {
    await assertNotRestricted(page, config, log);
    const state = await publishButtonState(page);
    // Do not wait for the optional content check. Only require the video upload
    // itself to finish and the Post button to be enabled.
    if (state.found && state.enabled && await uploadReadyState(page)) return;
    await delay(500);
  }
  throw codedError(
    'TIKTOK_PUBLISH_BUTTON_TIMEOUT',
    'Video chưa tải xong hoặc nút Đăng TikTok chưa sẵn sàng.'
  );
}

async function clickPublish(page) {
  return page.evaluate(() => {
    const norm = value => String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd')
      .replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const button = Array.from(document.querySelectorAll('button, [role="button"]')).find(element => {
      if (!visible(element)) return false;
      if (element.closest('[aria-hidden="true"], [inert], [data-floating-ui-inert]')) return false;
      const text = norm(element.innerText || element.getAttribute('aria-label') || '');
      return ['dang', 'post', 'publish'].includes(text);
    });
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
    button.scrollIntoView({ block: 'center', inline: 'center' });
    button.click();
    return true;
  }).catch(() => false);
}

async function confirmPendingCheckPublishPrompt(page) {
  return page.evaluate(() => {
    const norm = value => String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
      .replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 120 && rect.height > 80
        && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const dialogs = Array.from(document.querySelectorAll(
      '[role="dialog"], [aria-modal="true"], [data-e2e*="modal"], [class*="modal"]'
    )).filter(visible);
    const dialog = dialogs.find(element => {
      const text = norm(element.innerText || element.textContent || '');
      const pendingCheck = text.includes('continue to post')
        || text.includes('still checking your video')
        || text.includes('checking your video for potential issues')
        || text.includes('tiep tuc dang')
        || text.includes('van dang kiem tra video')
        || text.includes('kiem tra video chua hoan tat');
      const action = text.includes('post now')
        || text.includes('dang ngay')
        || text.includes('continue posting');
      return pendingCheck && action;
    });
    if (!dialog) return false;

    const labels = new Set([
      'post now', 'dang ngay', 'continue posting', 'continue to post', 'tiep tuc dang',
    ]);
    const button = Array.from(dialog.querySelectorAll('button, [role="button"]')).find(element => {
      const text = norm(
        element.innerText || element.textContent || element.getAttribute('aria-label') || ''
      );
      return labels.has(text);
    });
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
    button.click();
    return true;
  }).catch(() => false);
}

async function confirmRestrictedPublishPrompt(page) {
  return page.evaluate(() => {
    const norm = value => String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
      .replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 120 && rect.height > 80
        && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const dialogs = Array.from(document.querySelectorAll(
      '[role="dialog"], [data-e2e*="modal"], [class*="modal"]'
    )).filter(visible);
    const dialog = dialogs.find(element => {
      const text = norm(element.innerText || element.textContent || '');
      const restricted = text.includes('noi dung co the se bi han che')
        || text.includes('content may be restricted');
      const canPost = text.includes('van co the dang')
        || text.includes('you can still post')
        || text.includes('still post');
      return restricted && canPost;
    });
    if (!dialog) return false;

    const exactLabels = new Set([
      'van dang', 'dang', 'dang ngay', 'tiep tuc dang',
      'post anyway', 'post', 'continue posting', 'continue to post',
    ]);
    const button = Array.from(dialog.querySelectorAll(
      'button, [role="button"], [tabindex]'
    )).find(element => {
      const text = norm(
        element.innerText || element.textContent || element.getAttribute('aria-label') || ''
      );
      return exactLabels.has(text);
    });
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') {
      // TikTok currently opens a details-only warning after the first Post
      // click. Closing it acknowledges the warning; Post must then be retried.
      const closeControl = Array.from(dialog.querySelectorAll(
        'button, [role="button"], [aria-label], [class*="modal-close"]'
      )).find(element => {
        const text = norm(
          element.innerText || element.textContent || element.getAttribute('aria-label') || ''
        );
        const className = String(element.className || '').toLowerCase();
        return ['dong', 'close'].includes(text)
          || className.includes('common-modal-close');
      });
      if (!closeControl) return false;
      closeControl.click();
      return 'dismissed-details';
    }
    button.click();
    return 'confirmed';
  }).catch(() => false);
}

async function waitForPublishSuccess(page, previousUrl, config, log = () => {}) {
  const successMessages = [
    'Video đã được tải lên', 'Video đã được đăng', 'Đã đăng video',
    'Your video has been uploaded', 'Video uploaded', 'Video published',
    'Upload another video', 'Tải video khác', 'Manage your posts', 'Quản lý bài đăng',
  ].map(normalizeText);
  const started = Date.now();
  let restrictionRetries = 0;
  while (Date.now() - started < config.publishTimeout) {
    if (await confirmPendingCheckPublishPrompt(page)) {
      if (!page.__covergemTikTokPendingCheckLogged) {
        page.__covergemTikTokPendingCheckLogged = true;
        log('TikTok vẫn đang kiểm tra video; đã bấm Đăng ngay theo yêu cầu.', 'warning');
      }
      await delay(500);
    }
    const restrictionAction = await confirmRestrictedPublishPrompt(page);
    if (restrictionAction) {
      if (!page.__covergemTikTokConfirmLogged) {
        page.__covergemTikTokConfirmLogged = true;
        log('Đã xác nhận tiếp tục đăng video theo cảnh báo của TikTok.', 'warning');
      }
      await delay(500);
      if (restrictionAction === 'dismissed-details' && restrictionRetries < 2) {
        restrictionRetries++;
        const modalClosed = await page.waitForFunction(() => {
          const dialogs = Array.from(document.querySelectorAll(
            '[role="dialog"], [data-e2e*="modal"], [class*="modal"]'
          ));
          return !dialogs.some(element => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const text = String(element.innerText || element.textContent || '')
              .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
              .replace(/[\u0111\u0110]/g, 'd').toLowerCase();
            return rect.width > 120 && rect.height > 80
              && style.display !== 'none' && style.visibility !== 'hidden'
              && (text.includes('noi dung co the se bi han che')
                || text.includes('content may be restricted'));
          });
        }, { timeout: 5000 }).then(() => true).catch(() => false);
        if (modalClosed && await clickPublish(page)) {
          log('Đã đóng chi tiết cảnh báo và bấm Đăng TikTok lần hai.', 'warning');
        }
      }
    }
    await assertNotRestricted(page, config, log);
    const state = await page.evaluate(() => ({
      url: location.href,
      text: document.body?.innerText || '',
      explicit: !!document.querySelector('[data-e2e="upload-success"], [data-e2e="post-success"]'),
    })).catch(() => ({ url: '', text: '', explicit: false }));
    const currentText = normalizeText(state.text);
    const leftUploadPage = state.url && state.url !== previousUrl && !/\/tiktokstudio\/upload/i.test(state.url);
    if (state.explicit || leftUploadPage || successMessages.some(message => currentText.includes(message))) return true;
    await delay(500);
  }
  throw codedError(
    'TIKTOK_PUBLISH_NOT_CONFIRMED',
    'Đã bấm Đăng nhưng TikTok chưa xác nhận đăng video thành công.'
  );
}

async function readStudioVideoLinks(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('a[href*="/video/"]')).map(anchor => {
    const match = String(anchor.href || '').match(/https?:\/\/(?:www\.)?tiktok\.com\/@[^/?#]+\/video\/\d+/i);
    if (!match) return null;
    return {
      url: match[0],
      caption: (anchor.innerText || anchor.textContent || anchor.parentElement?.innerText || '')
        .replace(/\s+/g, ' ').trim(),
    };
  }).filter(Boolean).filter((item, index, all) =>
    all.findIndex(other => other.url === item.url) === index
  )).catch(() => []);
}

async function snapshotStudioVideoLinks(page, config) {
  await page.goto(CONTENT_URL, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeout });
  const started = Date.now();
  const emptySettleMs = Math.min(5000, Math.max(1500, Math.floor(config.linkTimeout / 10)));
  let emptyReadySince = 0;
  let links = [];
  while (Date.now() - started < Math.min(config.linkTimeout, 30000)) {
    links = await readStudioVideoLinks(page);
    const pageReady = await page.evaluate(() => {
      const bodyText = String(document.body?.innerText || '').trim();
      return /tiktokstudio\/content/i.test(location.href)
        && ['interactive', 'complete'].includes(document.readyState)
        && !!document.body
        && document.body.childElementCount > 0
        && bodyText.length > 0;
    }).catch(() => false);

    if (links.length) return { loaded: true, links };
    if (pageReady) {
      if (!emptyReadySince) emptyReadySince = Date.now();
      // TikTok Studio can legitimately have no videos. Give its async list time
      // to hydrate first, then accept the stable empty state.
      if (Date.now() - emptyReadySince >= emptySettleMs) {
        return { loaded: true, links: [] };
      }
    } else {
      emptyReadySince = 0;
    }
    await delay(500);
  }
  return { loaded: false, links };
}

async function captureJustPublishedLink(page, beforeSnapshot, content, config) {
  const before = new Set((beforeSnapshot?.links || []).map(item => item.url));
  const needle = normalizeText(content).slice(0, 100);
  const started = Date.now();
  let lastNewLinks = [];

  while (Date.now() - started < config.linkTimeout) {
    if (!/\/tiktokstudio\/content/i.test(page.url())) {
      await page.goto(CONTENT_URL, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeout });
    }
    await delay(1200);
    const links = await readStudioVideoLinks(page);
    const newLinks = links.filter(item => !before.has(item.url));
    lastNewLinks = newLinks;
    if (newLinks.length === 1) return newLinks[0].url;
    if (newLinks.length > 1) {
      const matching = needle
        ? newLinks.filter(item => normalizeText(item.caption).includes(needle)
          || needle.includes(normalizeText(item.caption).slice(0, 100)))
        : newLinks;
      if (matching.length === 1) return matching[0].url;
      // Studio is sorted newest first. This profile's action queue guarantees
      // only one Covergem post at a time, so the first matching new item is it.
      if (matching.length > 1) return matching[0].url;
    }
    await page.reload({ waitUntil: 'domcontentloaded', timeout: config.navigationTimeout }).catch(() => {});
  }

  const error = codedError(
    'TIKTOK_POST_LINK_NOT_FOUND',
    `TikTok đã đăng video nhưng chưa xác định được permalink mới (phát hiện ${lastNewLinks.length} link mới).`
  );
  error.submitted = true;
  throw error;
}

const TikTokAdapter = {
  async publish(page, post, options = {}) {
    if (!page) throw codedError('TIKTOK_PAGE_MISSING', 'Không có tab trình duyệt TikTok.');

    const config = getConfig(options);
    const log = options.log || (() => {});
    const map = options.buildVarMap ? options.buildVarMap(post) : {
      ...post,
      media: post?.media ?? post?.image_path ?? '',
    };
    const render = options.renderTemplate || ((template, values) => String(template || '').replace(
      /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
      (_, key) => values[key] == null ? '' : String(values[key])
    ));
    const content = render('{{content}}', map);
    const mediaRaw = render('{{media}}', map).trim();
    const productIds = parseProductIds(render('{{product_id}}', map));

    if (!mediaRaw) throw codedError('TIKTOK_MEDIA_REQUIRED', 'Cột media chưa có video để đăng TikTok.');
    const mediaPaths = mediaRaw.split(',').map(value => value.trim()).filter(Boolean);
    if (mediaPaths.length !== 1) {
      throw codedError('TIKTOK_SINGLE_VIDEO_REQUIRED', 'TikTok chỉ hỗ trợ 1 video trong mỗi dòng dữ liệu.');
    }
    if (!VIDEO_PATTERN.test(mediaPaths[0])) {
      throw codedError('TIKTOK_INVALID_VIDEO', `Media không phải định dạng video được hỗ trợ: ${mediaPaths[0]}`);
    }
    // Đường dẫn tiếng Việt có dấu phải quy về đúng tên file trên ổ đĩa trước khi dùng
    const mediaPath = resolveMediaPath(mediaPaths[0]);
    if (!mediaPath) {
      throw codedError('TIKTOK_MEDIA_NOT_FOUND', `Không tìm thấy video: ${mediaPaths[0]}`);
    }

    if (!await this.validateSession(page)) {
      throw codedError('TIKTOK_SESSION_INVALID', 'Profile TikTok chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.');
    }

    // Record every existing video ID before uploading. Captions are not unique,
    // so the exact permalink is identified by the new ID after publication.
    const beforeLinks = await snapshotStudioVideoLinks(page, config);
    if (!beforeLinks.loaded) {
      throw codedError('TIKTOK_CONTENT_LIST_NOT_READY', 'Không đọc được danh sách video TikTok trước khi đăng.');
    }

    await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeout });
    const currentUrl = page.url();
    if (/\/login(?:\?|\/|$)/i.test(currentUrl)) {
      throw codedError('TIKTOK_SESSION_INVALID', 'TikTok chuyển về trang đăng nhập; hãy đăng nhập lại profile.');
    }

    await continueUnsavedEditorPrompt(page, config);
    const input = await page.waitForSelector('input[type="file"]', { timeout: config.editorTimeout });
    await delay(Math.min(config.settleMs, 1000));
    await continueUnsavedEditorPrompt(page, config);
    if (!input) throw codedError('TIKTOK_UPLOAD_INPUT_NOT_FOUND', 'Không tìm thấy nút Chọn video của TikTok Studio.');
    await input.uploadFile(mediaPath);
    await options.interactionPacer?.afterMedia();

    let editor = null;
    const editorStarted = Date.now();
    while (!editor && Date.now() - editorStarted < config.editorTimeout) {
      if (await continueUnsavedEditorPrompt(page, config)) {
        // A late unsaved-editor prompt can swallow the first file change.
        await input.uploadFile();
        await input.uploadFile(mediaPath);
        await options.interactionPacer?.afterMedia();
      }
      await assertNotRestricted(page, config, log);
      editor = await findCaptionEditor(page);
      if (!editor) await delay(300);
    }
    if (!editor) throw codedError('TIKTOK_CAPTION_NOT_FOUND', 'Video đã chọn nhưng không tìm thấy ô mô tả.');
    await replaceEditorText(page, editor, content, options);
    await delay(config.settleMs);

    let productResult = { added: [], skipped: [] };
    if (productIds.length) {
      productResult = await attachProducts(
        page,
        productIds,
        config,
        log
      );
    }
    await waitUntilReadyToPublish(page, config, log);
    await assertNotRestricted(page, config, log);

    const beforePublishUrl = page.url();
    await options.interactionPacer?.beforePublish();
    if (!await clickPublish(page)) {
      throw codedError('TIKTOK_PUBLISH_BUTTON_NOT_FOUND', 'Không tìm thấy hoặc chưa thể bấm nút Đăng TikTok.');
    }
    await waitForPublishSuccess(page, beforePublishUrl, config, log);

    const publishedAtMs = Date.now();
    const postLink = await captureJustPublishedLink(page, beforeLinks, content, config);
    return {
      success: true,
      postedAt: new Date(publishedAtMs).toLocaleString('vi-VN'),
      publishedAtMs,
      postLink,
      linkedProductIds: productResult.added,
      skippedProductIds: productResult.skipped,
    };
  },

  async comment() {
    throw codedError('TIKTOK_COMMENT_NOT_CONFIGURED', 'Script TikTok bình luận chưa được cấu hình.');
  },

  async hasExistingComment() {
    return false;
  },

  async validateSession(page) {
    const cookies = await page.cookies('https://www.tiktok.com').catch(() => []);
    return cookies.some(cookie =>
      ['sessionid', 'sessionid_ss', 'sid_tt'].includes(cookie.name) && cookie.value
    );
  },

  _private: {
    assertNotRestricted,
    contentCheckState,
    readStudioVideoLinks,
    snapshotStudioVideoLinks,
    captureJustPublishedLink,
    normalizeText,
    publishButtonState,
    uploadReadyState,
    parseProductIds,
    continueUnsavedEditorPrompt,
    confirmPendingCheckPublishPrompt,
    confirmRestrictedPublishPrompt,
    clickVisibleText,
    clickAddLinkAction,
    attachProducts,
  },
};

module.exports = TikTokAdapter;
