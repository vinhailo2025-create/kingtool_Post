'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeCloudCommand } = require('../src/services/cloud-mcp-command');

test('normalizes object and composite RPC cloud commands', () => {
  const command = {
    command_id: 'command-1',
    tool_name: 'super_post_list_profiles',
    arguments: { platform: 'facebook' },
  };

  assert.deepEqual(normalizeCloudCommand(command), command);
  assert.deepEqual(normalizeCloudCommand([command]), command);
  assert.equal(normalizeCloudCommand(null), null);
  assert.equal(normalizeCloudCommand([]), null);
});

test('rejects cloud commands without an id or tool name', () => {
  assert.throws(
    () => normalizeCloudCommand({ arguments: {} }),
    (error) => error.code === 'CLOUD_MCP_INVALID_COMMAND',
  );
  assert.throws(
    () => normalizeCloudCommand({ command_id: 'command-1' }),
    (error) => error.code === 'CLOUD_MCP_INVALID_COMMAND',
  );
});
