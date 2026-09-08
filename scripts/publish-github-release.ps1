param(
  [string]$Repository = "vinhailo2025-create/super-post-king-releases",
  [string]$Notes = "Cập nhật Super Post King: cải thiện độ ổn định và bổ sung cập nhật tự động."
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$package = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json
$version = [string]$package.version
$tag = "v$version"
$installer = Join-Path $projectRoot "dist\installer\Super-Post-King-Setup.exe"
$checksum = "$installer.sha256"
$handoff = Join-Path $projectRoot "dist\Super-Post-King-Ban-Giao.zip"
$handoffStage = Join-Path $projectRoot "dist\handoff"

if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
  throw "Chưa có installer. Hãy chạy build.bat trước."
}
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "Chưa cài GitHub CLI (gh)."
}

# Rebuild the customer handoff from the same installer used by the updater.
& (Join-Path $PSScriptRoot "package-release.ps1")

$guide = Join-Path $handoffStage "HUONG-DAN-CAN-DAT.txt"
$handoffChecksum = Join-Path $handoffStage "SHA256.txt"
$agentKit = Get-ChildItem -LiteralPath $handoffStage -Filter "Super-Post-Agent-Kit-*.zip" |
  Select-Object -First 1
if (-not $agentKit) {
  throw "Không tìm thấy gói Super Post Agent Kit trong $handoffStage."
}
$assets = @(
  $installer,
  $checksum,
  $handoff,
  $guide,
  $agentKit.FullName,
  $handoffChecksum
)
foreach ($asset in $assets) {
  if (-not (Test-Path -LiteralPath $asset -PathType Leaf)) {
    throw "Thiếu file bàn giao: $asset"
  }
}

$visibility = gh repo view $Repository --json visibility --jq ".visibility"
if ($LASTEXITCODE -ne 0) { throw "Không đọc được repository $Repository." }
if ($visibility.Trim().ToUpperInvariant() -ne "PUBLIC") {
  throw "Repository Release phải là PUBLIC để khách cập nhật không cần token."
}

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installer).Hash.ToLowerInvariant()
Set-Content -LiteralPath $checksum -Encoding ascii -NoNewline -Value "$hash  Super-Post-King-Setup.exe"
$releaseNotes = @"
$Notes

Khach hang tai file: Super-Post-King-Ban-Giao.zip
Goi nay gom bo cai, huong dan, Super Post Agent Kit va ma SHA-256.

Luu y: Source code (zip) va Source code (tar.gz) do GitHub tu dong tao, khach hang khong can tai hai file do.
Trinh cap nhat tu dong cua ung dung tiep tuc dung Super-Post-King-Setup.exe.
"@
$releaseNotesFile = Join-Path $handoffStage "RELEASE-NOTES.txt"
Set-Content -LiteralPath $releaseNotesFile -Encoding utf8 -Value $releaseNotes

$releaseExists = $false
try {
  gh release view $tag --repo $Repository *> $null
  $releaseExists = $LASTEXITCODE -eq 0
} catch {
  # A missing tag is expected on the first publication.
  $releaseExists = $false
}

if ($releaseExists) {
  gh release upload $tag $assets --repo $Repository --clobber
  if ($LASTEXITCODE -ne 0) { throw "Không cập nhật được asset của Release $tag." }
  gh release edit $tag --repo $Repository --title "Super Post King $version" --notes-file $releaseNotesFile --latest
} else {
  gh release create $tag $assets --repo $Repository --title "Super Post King $version" --notes-file $releaseNotesFile --latest
}
if ($LASTEXITCODE -ne 0) { throw "Không phát hành được GitHub Release $tag." }

Write-Host "Published $Repository $tag"
Write-Host "Customer handoff: $handoff"
Write-Host "Installer SHA-256: $hash"
