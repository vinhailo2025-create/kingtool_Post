/**
 * Adds a visible per-profile identity without modifying the Chromium binary.
 * The active tab title also becomes the Windows taskbar/Alt-Tab window title.
 */

function cleanName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
}

function installTitlePrefix(profileName) {
  const prefix = `${profileName} • `;
  const observerKey = '__covergemProfileTitleObserver';

  const apply = () => {
    const current = String(document.title || '').trim();
    if (current.startsWith(prefix)) return;
    document.title = `${prefix}${current || 'Trang mới'}`;
  };

  const start = () => {
    apply();
    const target = document.head || document.documentElement;
    if (!target || typeof MutationObserver !== 'function') return;
    try { window[observerKey]?.disconnect(); } catch (_) {}
    const observer = new MutationObserver(apply);
    observer.observe(target, { subtree: true, childList: true, characterData: true });
    window[observerKey] = observer;
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}

async function attachPage(page, name) {
  try { await page.evaluateOnNewDocument(installTitlePrefix, name); } catch (_) {}
  try { await page.evaluate(installTitlePrefix, name); } catch (_) {}
}

async function bind(browser, value) {
  const name = cleanName(value);
  if (!browser || !name) return { name, pages: 0, skipped: true };

  const seen = new WeakSet();
  const attach = async page => {
    if (!page || seen.has(page)) return;
    seen.add(page);
    await attachPage(page, name);
  };

  browser.on('targetcreated', async target => {
    try { await attach(await target.page()); } catch (_) {}
  });

  const pages = await browser.pages();
  await Promise.allSettled(pages.map(attach));
  return { name, pages: pages.length, skipped: false };
}

module.exports = { bind, cleanName, installTitlePrefix };
