const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const JavaScriptObfuscator = require('javascript-obfuscator');
const { optionsForFile } = require('../scripts/obfuscate');

test('protected platform adapters keep page.evaluate callbacks self-contained', async () => {
  const source = `
    module.exports = async page => page.evaluate(() => {
      const anchor = document.querySelector('a[href]');
      return anchor ? anchor.href : '';
    });
  `;
  const protectedCode = JavaScriptObfuscator.obfuscate(
    source,
    optionsForFile('src/platforms/example.adapter.js')
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
