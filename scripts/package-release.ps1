$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$distRoot = Join-Path $projectRoot "dist"
$installer = Join-Path $distRoot "installer\Super-Post-King-Setup.exe"
$installerChecksum = "$installer.sha256"
$guide = Join-Path $projectRoot "packaging\HUONG-DAN-CAN-DAT.txt"
$agentKitSource = Join-Path $projectRoot "release\agent-kit"
$agentKitManifest = Join-Path $agentKitSource "plugins\super-post-agent-kit\.codex-plugin\plugin.json"
$zipPath = Join-Path $distRoot "Super-Post-King-Ban-Giao.zip"
$stage = Join-Path $distRoot "handoff"

if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
  throw "Missing installer: $installer"
}
if (-not (Test-Path -LiteralPath $agentKitManifest -PathType Leaf)) {
  throw "Missing Agent Kit manifest: $agentKitManifest"
}

$resolvedDist = (Resolve-Path -LiteralPath $distRoot).Path
if (-not $stage.StartsWith($resolvedDist, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Unsafe handoff stage: $stage"
}

if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item -LiteralPath $installer -Destination $stage
Copy-Item -LiteralPath $guide -Destination $stage

$agentKitVersion = ((Get-Content -LiteralPath $agentKitManifest -Raw | ConvertFrom-Json).version -split '\+')[0]
$agentKitZipName = "Super-Post-Agent-Kit-$agentKitVersion.zip"
$agentKitZip = Join-Path $stage $agentKitZipName
Compress-Archive -Path (Join-Path $agentKitSource "*") -DestinationPath $agentKitZip -CompressionLevel Optimal

Add-Type -AssemblyName System.IO.Compression.FileSystem
$agentArchive = [IO.Compression.ZipFile]::OpenRead($agentKitZip)
try {
  $entryNames = $agentArchive.Entries.FullName -replace '\\', '/'
  foreach ($required in @(
    '.agents/plugins/marketplace.json',
    'plugins/super-post-agent-kit/.codex-plugin/plugin.json',
    'plugins/super-post-agent-kit/mcp/super-post-mcp-server.jsc',
    'plugins/super-post-agent-kit/scripts/start-mcp.ps1'
  )) {
    if ($entryNames -notcontains $required) {
      throw "Agent Kit ZIP is missing: $required"
    }
  }
  foreach ($forbidden in @(
    'plugins/super-post-agent-kit/mcp/super-post-mcp-server.js',
    'plugins/super-post-agent-kit/skills/post-face-super-post/references/super-post-contract.md',
    'plugins/super-post-agent-kit/skills/super-post-profile-mapper/references/profile-target-contract.md'
  )) {
    if ($entryNames -contains $forbidden) {
      throw "Agent Kit ZIP exposes protected source or internal documentation: $forbidden"
    }
  }
} finally {
  $agentArchive.Dispose()
}

$hashLines = @(
  "Super-Post-King-Setup.exe  $((Get-FileHash -Algorithm SHA256 -LiteralPath $installer).Hash)",
  "$agentKitZipName  $((Get-FileHash -Algorithm SHA256 -LiteralPath $agentKitZip).Hash)"
)
Set-Content -LiteralPath (Join-Path $stage "SHA256.txt") -Encoding utf8 -Value $hashLines
$installerHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installer).Hash.ToLowerInvariant()
Set-Content -LiteralPath $installerChecksum -Encoding ascii -NoNewline -Value "$installerHash  Super-Post-King-Setup.exe"

if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zipPath -CompressionLevel Optimal

$zip = Get-Item -LiteralPath $zipPath
Write-Host ("Created {0} ({1:N1} MB)" -f $zip.FullName, ($zip.Length / 1MB))
