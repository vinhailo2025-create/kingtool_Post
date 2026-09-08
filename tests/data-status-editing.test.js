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

test('status column uses a one-click native control and persists changes immediately', () => {
  const columns = section('function buildColumnDefs()', 'function imagePathRenderer(');
  const renderer = section('function statusCellRenderer(', 'function commentStatusCellRenderer(');
  const saveHandler = section('async function onCellValueChanged(', 'async function onRowDragEnd(');

  assert.match(columns, /field:\s*'status'[\s\S]*editable:\s*false[\s\S]*cellRenderer:\s*statusCellRenderer/);
  assert.match(renderer, /document\.createElement\('select'\)/);
  assert.match(renderer, /params\.node\.setDataValue\('status',\s*select\.value\)/);
  assert.match(renderer, /\['mousedown',\s*'click',\s*'keydown'\]/);
  assert.match(saveHandler, /apiSilent\(`\/api\/data\/\$\{data\.id\}`[\s\S]*body:\s*\{\s*\[field\]:\s*valueToSave\s*\}/);
});

test('save all skips system-managed comment status values', () => {
  const commentRenderer = section('function commentStatusCellRenderer(', 'function initGrid(');
  const saveAll = section('async function saveData()', 'function showDeleteColumnModal(');

  assert.match(commentRenderer, /\[currentValue,\s*'waiting',\s*'success',\s*'error',\s*'skipped'\]/);
  assert.match(saveAll, /parsedCommentField\?\.base === 'comment_status'[\s\S]*continue/);
});
