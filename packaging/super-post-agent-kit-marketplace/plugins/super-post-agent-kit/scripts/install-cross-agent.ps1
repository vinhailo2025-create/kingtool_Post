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
$mcpBytecodePath = Join-Path $pluginRoot 'mcp\super-post-mcp-server.jsc'
$mcpScriptPath = Join-Path $pluginRoot 'mcp\super-post-mcp-server.js'
$bytecodeLoaderPath = Join-Path $pluginRoot 'runtime\bytenode\index.js'
if (
  (Test-Path -LiteralPath $mcpBytecodePath -PathType Leaf) -and
  (Test-Path -LiteralPath $bytecodeLoaderPath -PathType Leaf)
) {
  $mcpEntryPath = (Resolve-Path -LiteralPath $mcpBytecodePath).Path
  $bytecodeLoaderPath = (Resolve-Path -LiteralPath $bytecodeLoaderPath).Path
  $mcpUsesBytecode = $true
} elseif (Test-Path -LiteralPath $mcpScriptPath -PathType Leaf) {
  $mcpEntryPath = (Resolve-Path -LiteralPath $mcpScriptPath).Path
  $mcpUsesBytecode = $false
} else {
  throw 'Agent Kit không có MCP bytecode hợp lệ.'
}
if ($mcpUsesBytecode) {
  if (Test-Path -LiteralPath $mcpScriptPath -PathType Leaf) {
    Remove-Item -LiteralPath $mcpScriptPath -Force
  }
  foreach ($legacyReference in @(
    (Join-Path $pluginRoot 'skills\post-face-super-post\references'),
    (Join-Path $pluginRoot 'skills\super-post-profile-mapper\references')
  )) {
    if (Test-Path -LiteralPath $legacyReference) {
      Remove-Item -LiteralPath $legacyReference -Recurse -Force
    }
  }
}
$runtimeRoot = Join-Path $pluginRoot 'runtime'
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

function Get-Sha256Hash {
  param([string]$Path)
  $stream = [IO.File]::OpenRead($Path)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '')
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

$nodeSource = Resolve-AgentNodePath
if (-not $nodeSource) {
  throw 'Không tìm thấy Node.js. Hãy cài Super Post King bản mới trước khi cài Agent Kit.'
}
$nodeHash = (Get-Sha256Hash $nodeSource).ToLowerInvariant()
$stableNodePath = Join-Path $runtimeRoot "node-$($nodeHash.Substring(0, 16)).exe"
if (-not (Test-Path -LiteralPath $stableNodePath -PathType Leaf)) {
  New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
  Copy-Item -LiteralPath $nodeSource -Destination $stableNodePath -Force
  Write-Host "Đã cài Node.js ổn định cho Agent Kit: $stableNodePath"
}

$mcpArguments = if ($mcpUsesBytecode) {
  @('-r', $bytecodeLoaderPath, $mcpEntryPath)
} else {
  @($mcpEntryPath)
}

function Find-DictionaryKey {
  param([System.Collections.IDictionary]$Object, [string]$Name)
  foreach ($key in $Object.Keys) {
    if ([string]::Equals([string]$key, $Name, [StringComparison]::Ordinal)) {
      return $key
    }
  }
  return $null
}

function Test-MemberProperty {
  param([object]$Object, [string]$Name)
  if ($Object -is [System.Collections.IDictionary]) {
    return $null -ne (Find-DictionaryKey $Object $Name)
  }
  return $Object.PSObject.Properties.Name -contains $Name
}

function Get-MemberProperty {
  param([object]$Object, [string]$Name)
  if ($Object -is [System.Collections.IDictionary]) {
    $key = Find-DictionaryKey $Object $Name
    if ($null -eq $key) { return $null }
    return $Object[$key]
  }
  return $Object.$Name
}

function Add-MemberProperty {
  param([object]$Object, [string]$Name, [object]$Value)
  if ($Object -is [System.Collections.IDictionary]) {
    $key = Find-DictionaryKey $Object $Name
    if ($null -eq $key) { $key = $Name }
    $Object[$key] = $Value
  } elseif ($Object.PSObject.Properties.Name -contains $Name) {
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

function New-CaseSensitiveJsonSerializer {
  Add-Type -AssemblyName System.Web.Extensions
  $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
  $serializer.MaxJsonLength = [int]::MaxValue
  $serializer.RecursionLimit = 1024
  return $serializer
}

function Remove-MemberProperty {
  param([object]$Object, [string]$Name)
  if ($Object -is [System.Collections.IDictionary]) {
    $key = Find-DictionaryKey $Object $Name
    if ($null -ne $key) { [void]$Object.Remove($key) }
  } elseif ($Object.PSObject.Properties.Name -contains $Name) {
    $Object.PSObject.Properties.Remove($Name)
  }
}

function ConvertTo-CaseSensitiveJsonTree {
  param([object]$Value)
  if ($Value -is [System.Collections.IDictionary]) {
    $result = New-Object 'System.Collections.Generic.Dictionary[string,object]' `
      -ArgumentList ([StringComparer]::Ordinal)
    foreach ($key in $Value.Keys) {
      $result.Add(
        [string]$key,
        (ConvertTo-CaseSensitiveJsonTree $Value[$key])
      )
    }
    return $result
  }
  if ($Value -is [System.Management.Automation.PSCustomObject]) {
    $result = New-Object 'System.Collections.Generic.Dictionary[string,object]' `
      -ArgumentList ([StringComparer]::Ordinal)
    foreach ($property in $Value.PSObject.Properties) {
      $result.Add(
        $property.Name,
        (ConvertTo-CaseSensitiveJsonTree $property.Value)
      )
    }
    return $result
  }
  if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
    $items = New-Object System.Collections.ArrayList
    foreach ($item in $Value) {
      [void]$items.Add((ConvertTo-CaseSensitiveJsonTree $item))
    }
    return ,$items.ToArray()
  }
  return $Value
}

function Get-FileFingerprint {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '<missing>' }
  return Get-Sha256Hash $Path
}

$script:jsonConfigFingerprints = @{}

function Read-JsonConfig {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    $script:jsonConfigFingerprints[$Path] = '<missing>'
    return [pscustomobject]@{}
  }
  $raw = Get-Content -Raw -LiteralPath $Path
  $script:jsonConfigFingerprints[$Path] = Get-FileFingerprint $Path
  if (-not $raw.Trim()) { return [pscustomobject]@{} }
  try {
    return $raw | ConvertFrom-Json
  } catch {
    # ConvertFrom-Json cua Windows PowerShell 5.1 khong phan biet hoa thuong khi so khoa,
    # nen .claude.json co 2 duong dan project chi khac chu hoa/thuong se bao
    # "duplicated keys". Dictionary cua parser nay giu nguyen ca hai project.
    $serializer = New-CaseSensitiveJsonSerializer
    return $serializer.DeserializeObject($raw)
  }
}

function Save-JsonConfig {
  param([string]$Path, [object]$Value)
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  $expectedFingerprint = $script:jsonConfigFingerprints[$Path]
  if ($null -eq $expectedFingerprint) { $expectedFingerprint = '<missing>' }
  if ((Get-FileFingerprint $Path) -ne $expectedFingerprint) {
    throw "File cau hinh da thay doi trong luc cai MCP, nen khong ghi de: $Path. Hay chay lai."
  }

  $json = if ($Value -is [System.Collections.IDictionary]) {
    $serializer = New-CaseSensitiveJsonSerializer
    $serializer.Serialize((ConvertTo-CaseSensitiveJsonTree $Value))
  } else {
    $Value | ConvertTo-Json -Depth 100
  }
  $tempPath = Join-Path $parent (
    ".{0}.tmp-{1}-{2}" -f ([IO.Path]::GetFileName($Path)), $PID, ([Guid]::NewGuid().ToString('N'))
  )
  $utf8Bom = New-Object System.Text.UTF8Encoding($true)
  [IO.File]::WriteAllText($tempPath, $json + [Environment]::NewLine, $utf8Bom)

  try {
    if (Test-Path -LiteralPath $Path) {
      [IO.File]::Replace($tempPath, $Path, "$Path.backup-$stamp")
    } else {
      [IO.File]::Move($tempPath, $Path)
    }
  } finally {
    if (Test-Path -LiteralPath $tempPath) {
      Remove-Item -LiteralPath $tempPath -Force
    }
  }
  $script:jsonConfigFingerprints[$Path] = Get-FileFingerprint $Path
  Write-Host "Đã cập nhật MCP: $Path"
}

function Install-Claude {
  Add-SkillLinks (Join-Path $UserHome '.claude\skills')
  $desktopConfigPath = Join-Path $RoamingAppData 'Claude\claude_desktop_config.json'
  $desktopConfig = Read-JsonConfig $desktopConfigPath
  if (-not (Test-MemberProperty $desktopConfig 'mcpServers')) {
    Add-MemberProperty $desktopConfig 'mcpServers' ([pscustomobject]@{})
  }
  $desktopMcpServers = Get-MemberProperty $desktopConfig 'mcpServers'
  $desktopServer = [pscustomobject]@{
    command = $stableNodePath
    args = @($mcpArguments)
  }
  Remove-MemberProperty $desktopMcpServers 'super-post-king'
  Add-MemberProperty $desktopMcpServers 'super-post-king-local' $desktopServer
  Save-JsonConfig $desktopConfigPath $desktopConfig

  # Claude Code stores user-scoped MCP servers separately from Claude Desktop.
  $codeConfigPath = Join-Path $UserHome '.claude.json'
  $codeConfig = Read-JsonConfig $codeConfigPath
  if (-not (Test-MemberProperty $codeConfig 'mcpServers')) {
    Add-MemberProperty $codeConfig 'mcpServers' ([pscustomobject]@{})
  }
  $codeMcpServers = Get-MemberProperty $codeConfig 'mcpServers'
  $codeServer = [pscustomobject]@{
    type = 'stdio'
    command = $stableNodePath
    args = @($mcpArguments)
  }
  Remove-MemberProperty $codeMcpServers 'super-post-king'
  Add-MemberProperty $codeMcpServers 'super-post-king-local' $codeServer
  Save-JsonConfig $codeConfigPath $codeConfig
}

function Install-OpenClaw {
  Add-SkillLinks (Join-Path $UserHome '.openclaw\skills')
  $configPath = Join-Path $UserHome '.openclaw\openclaw.json'
  $config = Read-JsonConfig $configPath
  if (-not (Test-MemberProperty $config 'mcp')) {
    Add-MemberProperty $config 'mcp' ([pscustomobject]@{})
  }
  $mcp = Get-MemberProperty $config 'mcp'
  if (-not (Test-MemberProperty $mcp 'servers')) {
    Add-MemberProperty $mcp 'servers' ([pscustomobject]@{})
  }
  $servers = Get-MemberProperty $mcp 'servers'
  $server = [pscustomobject]@{
    command = $stableNodePath
    args = @($mcpArguments)
  }
  Remove-MemberProperty $servers 'super-post-king'
  Add-MemberProperty $servers 'super-post-king-local' $server
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
  $pattern = '(?ms)^\[mcp_servers\.(?:super-post-king-local|super-post-king)(?:\.[^\]]+)?\]\r?\n.*?(?=^\[|\z)'
  $raw = [regex]::Replace($raw, $pattern, '').TrimEnd()
  $nodeToml = $stableNodePath.Replace('\', '\\').Replace('"', '\"')
  $argumentsToml = ($mcpArguments | ForEach-Object {
    '"' + ([string]$_).Replace('\', '\\').Replace('"', '\"') + '"'
  }) -join ', '
  $block = @"

[mcp_servers.super-post-king-local]
command = "$nodeToml"
args = [$argumentsToml]
startup_timeout_sec = 120
"@
  Set-Content -LiteralPath $configPath -Encoding utf8 -Value ($raw + $block + "`r`n")
  Write-Host 'Da cap nhat MCP: Codex'
}

if ($Agent -in @('Claude', 'All')) { Install-Claude }
if ($Agent -in @('Codex', 'All')) { Install-Codex }
if ($Agent -in @('OpenClaw', 'All')) { Install-OpenClaw }

Write-Host 'Hoan tat. Hay thoat han Claude khoi khay he thong roi mo lai, hoac mo phien agent moi.'
