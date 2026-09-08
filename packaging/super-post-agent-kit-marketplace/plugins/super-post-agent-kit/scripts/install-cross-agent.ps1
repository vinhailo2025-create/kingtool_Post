[CmdletBinding()]
param(
  [ValidateSet('Claude', 'Codex', 'OpenClaw', 'All')]
  [string]$Agent = 'All',
  [switch]$ReplaceExisting,
  [string]$UserHome = $env:USERPROFILE,
  [string]$RoamingAppData = $env:APPDATA,
  [string]$LocalAppDataPath = $env:LOCALAPPDATA
)

$ErrorActionPreference = 'Stop'
$sourcePluginRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (-not $LocalAppDataPath) {
  $LocalAppDataPath = Join-Path $UserHome 'AppData\Local'
}
$stablePluginRoot = [IO.Path]::GetFullPath(
  (Join-Path $LocalAppDataPath 'King Automation AI\Super Post Agent Kit')
)

if (-not $sourcePluginRoot.Equals($stablePluginRoot, [StringComparison]::OrdinalIgnoreCase)) {
  New-Item -ItemType Directory -Path $stablePluginRoot -Force | Out-Null
  Get-ChildItem -LiteralPath $sourcePluginRoot -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $stablePluginRoot -Recurse -Force
  }
  Write-Host "Đã cài Agent Kit vào thư mục ổn định: $stablePluginRoot"
}

$pluginRoot = $stablePluginRoot
$mcpScript = (Resolve-Path -LiteralPath (Join-Path $pluginRoot 'mcp\super-post-mcp-server.js')).Path
$runtimeRoot = Join-Path $pluginRoot 'runtime'
$stableNodePath = Join-Path $runtimeRoot 'node.exe'
$skillNames = @('post-face-super-post', 'super-post-profile-mapper')
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Resolve-AgentNodePath {
  $candidates = @()
  if ($env:SUPER_POST_NODE_PATH) {
    $candidates += [string]$env:SUPER_POST_NODE_PATH
  }

  if ($LocalAppDataPath) {
    $endpointFile = Join-Path $LocalAppDataPath 'King Automation AI\Super Post King\agent-api-endpoint.json'
    try {
      $endpoint = Get-Content -LiteralPath $endpointFile -Raw | ConvertFrom-Json
      if ($endpoint.service -eq 'super-post-king-agent-api' -and $endpoint.node_path) {
        $candidates += [string]$endpoint.node_path
      }
    } catch {}

    try {
      $installInfo = Get-ItemProperty `
        -LiteralPath 'HKCU:\Software\King Automation AI\Super Post King' `
        -Name InstallDir `
        -ErrorAction Stop
      if ($installInfo.InstallDir) {
        $candidates += Join-Path ([string]$installInfo.InstallDir) 'bin\node.exe'
      }
    } catch {}

    $candidates += Join-Path $LocalAppDataPath 'Programs\King Automation AI\Super Post King\bin\node.exe'
  }

  $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($systemNode) {
    $candidates += $systemNode.Source
  }

  return $candidates |
    Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
    Select-Object -First 1
}

if (-not (Test-Path -LiteralPath $stableNodePath -PathType Leaf)) {
  $nodeSource = Resolve-AgentNodePath
  if (-not $nodeSource) {
    throw 'Không tìm thấy Node.js. Hãy cài Super Post King bản mới trước khi cài Agent Kit.'
  }
  New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
  Copy-Item -LiteralPath $nodeSource -Destination $stableNodePath -Force
  Write-Host "Đã cài Node.js ổn định cho Agent Kit: $stableNodePath"
}

function Add-MemberProperty {
  param([object]$Object, [string]$Name, [object]$Value)
  if ($Object.PSObject.Properties.Name -contains $Name) {
    $Object.$Name = $Value
  } else {
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
  }
}

function Add-SkillLinks {
  param([string]$DestinationRoot)
  New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null
  foreach ($skillName in $skillNames) {
    $source = Join-Path $pluginRoot "skills\$skillName"
    $destination = Join-Path $DestinationRoot $skillName
    if (Test-Path -LiteralPath $destination) {
      $existing = Get-Item -LiteralPath $destination -Force
      $sameTarget = $existing.LinkType -eq 'Junction' -and
        (($existing.Target | ForEach-Object { [IO.Path]::GetFullPath($_) }) -contains [IO.Path]::GetFullPath($source))
      if ($sameTarget) { continue }
      $managedJunction = $existing.LinkType -eq 'Junction' -and
        (($existing.Target | ForEach-Object { [IO.Path]::GetFullPath($_) }) |
          Where-Object { $_.EndsWith("super-post-agent-kit\skills\$skillName", [StringComparison]::OrdinalIgnoreCase) })
      if ($managedJunction) {
        [IO.Directory]::Delete([IO.Path]::GetFullPath($destination), $false)
        Write-Host "Đã cập nhật liên kết skill cũ: $destination"
      } elseif (-not $ReplaceExisting) {
        Write-Warning "Giữ nguyên skill đã có: $destination"
        continue
      } else {
        $backup = "$destination.backup-$stamp"
        Move-Item -LiteralPath $destination -Destination $backup
        Write-Host "Đã backup skill cũ: $backup"
      }
    }
    New-Item -ItemType Junction -Path $destination -Target $source | Out-Null
    Write-Host "Đã liên kết skill: $destination"
  }
}

function Read-JsonConfig {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return [pscustomobject]@{} }
  $raw = Get-Content -Raw -LiteralPath $Path
  if (-not $raw.Trim()) { return [pscustomobject]@{} }
  return $raw | ConvertFrom-Json
}

function Save-JsonConfig {
  param([string]$Path, [object]$Value)
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  if (Test-Path -LiteralPath $Path) {
    Copy-Item -LiteralPath $Path -Destination "$Path.backup-$stamp" -Force
  }
  $Value | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $Path -Encoding utf8
  Write-Host "Đã cập nhật MCP: $Path"
}

function Install-Claude {
  Add-SkillLinks (Join-Path $UserHome '.claude\skills')
  $desktopConfigPath = Join-Path $RoamingAppData 'Claude\claude_desktop_config.json'
  $desktopConfig = Read-JsonConfig $desktopConfigPath
  if (-not ($desktopConfig.PSObject.Properties.Name -contains 'mcpServers')) {
    Add-MemberProperty $desktopConfig 'mcpServers' ([pscustomobject]@{})
  }
  $desktopServer = [pscustomobject]@{
    command = $stableNodePath
    args = @($mcpScript)
  }
  Add-MemberProperty $desktopConfig.mcpServers 'super-post-king' $desktopServer
  Save-JsonConfig $desktopConfigPath $desktopConfig

  # Claude Code stores user-scoped MCP servers separately from Claude Desktop.
  $codeConfigPath = Join-Path $UserHome '.claude.json'
  $codeConfig = Read-JsonConfig $codeConfigPath
  if (-not ($codeConfig.PSObject.Properties.Name -contains 'mcpServers')) {
    Add-MemberProperty $codeConfig 'mcpServers' ([pscustomobject]@{})
  }
  $codeServer = [pscustomobject]@{
    type = 'stdio'
    command = $stableNodePath
    args = @($mcpScript)
  }
  Add-MemberProperty $codeConfig.mcpServers 'super-post-king' $codeServer
  Save-JsonConfig $codeConfigPath $codeConfig
}

function Install-OpenClaw {
  Add-SkillLinks (Join-Path $UserHome '.openclaw\skills')
  $configPath = Join-Path $UserHome '.openclaw\openclaw.json'
  $config = Read-JsonConfig $configPath
  if (-not ($config.PSObject.Properties.Name -contains 'mcp')) {
    Add-MemberProperty $config 'mcp' ([pscustomobject]@{})
  }
  if (-not ($config.mcp.PSObject.Properties.Name -contains 'servers')) {
    Add-MemberProperty $config.mcp 'servers' ([pscustomobject]@{})
  }
  $server = [pscustomobject]@{
    command = $stableNodePath
    args = @($mcpScript)
  }
  Add-MemberProperty $config.mcp.servers 'super-post-king' $server
  Save-JsonConfig $configPath $config
}

function Install-Codex {
  Add-SkillLinks (Join-Path $UserHome '.codex\skills')
  $configPath = Join-Path $UserHome '.codex\config.toml'
  $configRoot = Split-Path -Parent $configPath
  New-Item -ItemType Directory -Path $configRoot -Force | Out-Null
  $raw = ''
  if (Test-Path -LiteralPath $configPath) {
    Copy-Item -LiteralPath $configPath -Destination "$configPath.backup-$stamp" -Force
    $raw = Get-Content -LiteralPath $configPath -Raw
  }
  $pattern = '(?ms)^\[mcp_servers\.super-post-king(?:\.[^\]]+)?\]\r?\n.*?(?=^\[|\z)'
  $raw = [regex]::Replace($raw, $pattern, '').TrimEnd()
  $nodeToml = $stableNodePath.Replace('\', '\\').Replace('"', '\"')
  $scriptToml = $mcpScript.Replace('\', '\\').Replace('"', '\"')
  $block = @"

[mcp_servers.super-post-king]
command = "$nodeToml"
args = ["$scriptToml"]
startup_timeout_sec = 120
"@
  Set-Content -LiteralPath $configPath -Encoding utf8 -Value ($raw + $block + "`r`n")
  Write-Host 'Da cap nhat MCP: Codex'
}

if ($Agent -in @('Claude', 'All')) { Install-Claude }
if ($Agent -in @('Codex', 'All')) { Install-Codex }
if ($Agent -in @('OpenClaw', 'All')) { Install-OpenClaw }

Write-Host 'Hoàn tất. Hãy khởi động lại agent hoặc mở phiên mới để nạp skill và MCP.'
