$ErrorActionPreference = 'Stop'

$pluginRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$mcpScript = (Resolve-Path -LiteralPath (Join-Path $pluginRoot 'mcp\super-post-mcp-server.js')).Path
$nodeCandidates = @()

$explicitNode = [string]$env:SUPER_POST_NODE_PATH
if ($explicitNode) {
  $nodeCandidates += $explicitNode
}

if ($env:LOCALAPPDATA) {
  $endpointFile = Join-Path $env:LOCALAPPDATA 'King Automation AI\Super Post King\agent-api-endpoint.json'
  try {
    $endpoint = Get-Content -LiteralPath $endpointFile -Raw | ConvertFrom-Json
    if ($endpoint.service -eq 'super-post-king-agent-api' -and $endpoint.node_path) {
      $nodeCandidates += [string]$endpoint.node_path
    }
  } catch {}

  try {
    $installInfo = Get-ItemProperty `
      -LiteralPath 'HKCU:\Software\King Automation AI\Super Post King' `
      -Name InstallDir `
      -ErrorAction Stop
    if ($installInfo.InstallDir) {
      $nodeCandidates += Join-Path ([string]$installInfo.InstallDir) 'bin\node.exe'
    }
  } catch {}

  $nodeCandidates += Join-Path $env:LOCALAPPDATA 'Programs\King Automation AI\Super Post King\bin\node.exe'
}

$systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
if ($systemNode) {
  $nodeCandidates += $systemNode.Source
}

$nodePath = $nodeCandidates |
  Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
  Select-Object -First 1

if (-not $nodePath) {
  throw 'Không tìm thấy Node.js. Hãy cài Super Post King bản mới hoặc cài Node.js 18 trở lên.'
}

& $nodePath $mcpScript
exit $LASTEXITCODE
