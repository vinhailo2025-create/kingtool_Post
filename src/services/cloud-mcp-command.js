'use strict';

function normalizeCloudCommand(value) {
  const command = Array.isArray(value) ? value[0] : value;
  if (!command) return null;

  const commandId = String(command.command_id || command.id || '').trim();
  const toolName = String(command.tool_name || '').trim();
  if (!commandId || !toolName) {
    const error = new Error('Cloud MCP returned a command without command_id or tool_name');
    error.code = 'CLOUD_MCP_INVALID_COMMAND';
    throw error;
  }

  return {
    ...command,
    command_id: commandId,
    tool_name: toolName,
    arguments: command.arguments && typeof command.arguments === 'object'
      ? command.arguments
      : {},
  };
}

module.exports = {
  normalizeCloudCommand,
};
