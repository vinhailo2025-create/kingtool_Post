const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('Facebook add-column dialog exposes an optional Post_group preset with exact var_key', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'data-manager.js'),
    'utf8'
  );

  assert.match(source, /value=["']post_group_preset["']/);
  assert.match(source, /var_key:\s*['"]post_group['"]/);
  assert.match(source, /name:\s*['"]Post_group['"]/);
  assert.doesNotMatch(
    source.match(/async function ensureRequiredColumns\(\)[\s\S]*?\n  \}/)?.[0] || '',
    /post_group/
  );
});
