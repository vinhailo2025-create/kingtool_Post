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

if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
  throw "Chưa có installer. Hãy chạy build.bat trước."
}
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "Chưa cài GitHub CLI (gh)."
}

$visibility = gh repo view $Repository --json visibility --jq ".visibility"
if ($LASTEXITCODE -ne 0) { throw "Không đọc được repository $Repository." }
if ($visibility.Trim().ToUpperInvariant() -ne "PUBLIC") {
  throw "Repository Release phải là PUBLIC để khách cập nhật không cần token."
}

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installer).Hash.ToLowerInvariant()
Set-Content -LiteralPath $checksum -Encoding ascii -NoNewline -Value "$hash  Super-Post-King-Setup.exe"

$releaseExists = $false
try {
  gh release view $tag --repo $Repository *> $null
  $releaseExists = $LASTEXITCODE -eq 0
} catch {
  # A missing tag is expected on the first publication.
  $releaseExists = $false
}

if ($releaseExists) {
  gh release upload $tag $installer $checksum --repo $Repository --clobber
  if ($LASTEXITCODE -ne 0) { throw "Không cập nhật được asset của Release $tag." }
  gh release edit $tag --repo $Repository --title "Super Post King $version" --notes $Notes --latest
} else {
  gh release create $tag $installer $checksum --repo $Repository --title "Super Post King $version" --notes $Notes --latest
}
if ($LASTEXITCODE -ne 0) { throw "Không phát hành được GitHub Release $tag." }

Write-Host "Published $Repository $tag"
Write-Host "Installer SHA-256: $hash"
