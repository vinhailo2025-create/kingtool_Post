const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'data-manager.js'), 'utf8');

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `Missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('data-cell clicks select cells without selecting their rows', () => {
  const gridOptions = section('const gridOptions = {', 'gridApi = agGrid.createGrid');
  const rangeMove = section('function updateRangeEnd(', 'function startAutoScroll(');
  const rangeMouseUp = section('function onRangeMouseUp(', 'async function clearRangeCells(');

  assert.match(gridOptions, /rowSelection:\s*'multiple',[\s\S]*suppressRowClickSelection:\s*true/);
  assert.doesNotMatch(rangeMove, /setSelected|syncRangeRowSelection/);
  assert.doesNotMatch(source, /function\s+syncRangeRowSelection/);
  assert.match(rangeMouseUp, /rangeState\.active\s*=\s*true/);
  assert.match(rangeMouseUp, /highlightRange\(\)/);
});

test('one selected cell supports copy and paste while checkboxes own row selection', () => {
  const columns = section('function buildColumnDefs()', 'function imagePathRenderer(');
  const keyboard = section('function handleKeyDown(', 'async function clearSelectedCells(');

  assert.match(columns, /headerCheckboxSelection:\s*true,\s*checkboxSelection:\s*true/);
  assert.match(keyboard, /e\.key\s*===\s*'c'[\s\S]*rangeState\.active[\s\S]*copyRange\(\)/);
  assert.match(keyboard, /e\.key\s*===\s*'v'[\s\S]*rangeState\.active[\s\S]*pasteRange\(\)/);
});
