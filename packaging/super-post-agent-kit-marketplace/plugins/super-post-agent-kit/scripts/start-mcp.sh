#!/usr/bin/env bash
set -euo pipefail

# macOS/Linux equivalent of start-mcp.ps1: resolve the plugin root relative to
# this script, prefer the .jsc bytecode + bytenode loader when both exist,
# otherwise fall back to the plain .js, then locate a Node executable and exec it.

scriptDir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pluginRoot="$(cd "$scriptDir/.." && pwd)"

mcpBytecodePath="$pluginRoot/mcp/super-post-mcp-server.jsc"
mcpScriptPath="$pluginRoot/mcp/super-post-mcp-server.js"
bytecodeLoaderPath="$pluginRoot/runtime/bytenode/index.js"

mcpArguments=()
if [ -f "$mcpBytecodePath" ] && [ -f "$bytecodeLoaderPath" ]; then
  mcpArguments=('-r' "$bytecodeLoaderPath" "$mcpBytecodePath")
elif [ -f "$mcpScriptPath" ]; then
  mcpArguments=("$mcpScriptPath")
else
  echo 'Agent Kit không có MCP bytecode hợp lệ.' >&2
  exit 1
fi

nodePath=''

add_candidate() {
  # Accept the first candidate that points to an existing regular file.
  if [ -z "$nodePath" ] && [ -n "${1:-}" ] && [ -f "$1" ]; then
    nodePath="$1"
  fi
}

# 1) Explicit override via environment variable.
add_candidate "${SUPER_POST_NODE_PATH:-}"

# 2) Node path advertised by the running app's endpoint file, or the app's
#    bundled Node under the mac Application Support tree. Parse the JSON with
#    grep/sed so this does not depend on a Node interpreter being found first.
appSupport="$HOME/Library/Application Support/King Automation AI/Super Post King"
endpointFile="$appSupport/agent-api-endpoint.json"
if [ -z "$nodePath" ] && [ -f "$endpointFile" ]; then
  endpointService="$(grep -oE '"service"[[:space:]]*:[[:space:]]*"[^"]*"' "$endpointFile" 2>/dev/null | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/' || true)"
  if [ "$endpointService" = 'super-post-king-agent-api' ]; then
    endpointNode="$(grep -oE '"node_path"[[:space:]]*:[[:space:]]*"[^"]*"' "$endpointFile" 2>/dev/null | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/' || true)"
    add_candidate "$endpointNode"
  fi
fi
add_candidate "$appSupport/bin/node"

# 3) Node on PATH.
if [ -z "$nodePath" ]; then
  systemNode="$(command -v node 2>/dev/null || true)"
  add_candidate "$systemNode"
fi

if [ -z "$nodePath" ]; then
  echo 'Không tìm thấy Node.js. Hãy cài Super Post King bản mới hoặc cài Node.js 18 trở lên.' >&2
  exit 1
fi

exec "$nodePath" "${mcpArguments[@]}"
