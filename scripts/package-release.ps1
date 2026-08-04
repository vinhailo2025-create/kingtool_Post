$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$distRoot = Join-Path $projectRoot "dist"
$installer = Join-Path $distRoot "installer\Super-Post-King-Setup.exe"
$guide = Join-Path $projectRoot "packaging\HUONG-DAN-CAN-DAT.txt"
$zipPath = Join-Path $distRoot "Super-Post-King-Ban-Giao.zip"
$stage = Join-Path $distRoot "handoff"

if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
  throw "Missing installer: $installer"
}

$resolvedDist = (Resolve-Path -LiteralPath $distRoot).Path
if (-not $stage.StartsWith($resolvedDist, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Unsafe handoff stage: $stage"
}

if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item -LiteralPath $installer -Destination $stage
Copy-Item -LiteralPath $guide -Destination $stage

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installer).Hash
Set-Content -LiteralPath (Join-Path $stage "SHA256.txt") -Encoding utf8 -Value "Super-Post-King-Setup.exe  $hash"

if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zipPath -CompressionLevel Optimal

$zip = Get-Item -LiteralPath $zipPath
Write-Host ("Created {0} ({1:N1} MB)" -f $zip.FullName, ($zip.Length / 1MB))
