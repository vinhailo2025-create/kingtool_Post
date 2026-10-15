const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const JavaScriptObfuscator = require('javascript-obfuscator');
const {
  hasRemoteBrowserCallbacks,
  optionsForFile,
} = require('../scripts/obfuscate');

const root = path.join(__dirname, '..');

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return entry.isFile() && entry.name.endsWith('.js') ? [absolute] : [];
  });
}

test('every Node file with remote browser callbacks gets safe obfuscation options', () => {
  const matched = [];
  for (const absolute of sourceFiles(path.join(root, 'src'))) {
    const code = fs.readFileSync(absolute, 'utf8');
    if (!hasRemoteBrowserCallbacks(code)) continue;
    const relative = path.relative(root, absolute);
    const options = optionsForFile(relative, code);
    matched.push(relative.replace(/\\/g, '/'));
    assert.equal(options.controlFlowFlattening, false, relative);
    assert.equal(options.stringArray, false, relative);
    assert.deepEqual(options.stringArrayEncoding, [], relative);
  }

  assert.deepEqual(matched.sort(), [
    'src/platforms/caption-input.utils.js',
    'src/platforms/facebook.adapter.js',
    'src/platforms/instagram.adapter.js',
    'src/platforms/threads.adapter.js',
    'src/platforms/tiktok.adapter.js',
    'src/platforms/x.adapter.js',
    'src/platforms/youtube.adapter.js',
    'src/platforms/zalovideo.adapter.js',
    'src/services/browser-window-name.service.js',
    'src/services/browser.service.js',
    'src/services/interaction-pacing.service.js',
    'src/services/managed-targets.service.js',
  ]);
});

test('protected remote browser callbacks stay self-contained', async () => {
  const source = `
    module.exports = async page => page.evaluate(() => {
      const anchor = document.querySelector('a[href]');
      return anchor ? anchor.href : '';
    });
  `;
  const protectedCode = JavaScriptObfuscator.obfuscate(
    source,
    optionsForFile('src/services/future-browser-feature.service.js', source)
  ).getObfuscatedCode();
  const module = { exports: {} };
  Function('module', 'exports', protectedCode)(module, module.exports);

  const href = await module.exports({
    evaluate: async callback => vm.runInNewContext(
      `(${callback.toString()})()`,
      {
        document: {
          querySelector: selector => selector === 'a[href]'
            ? { href: 'https://www.threads.com/@vinhaiautomation' }
            : null,
        },
      }
    ),
  });

  assert.equal(href, 'https://www.threads.com/@vinhaiautomation');
});
