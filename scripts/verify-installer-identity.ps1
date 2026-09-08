param(
  [Parameter(Mandatory = $true)][string]$IssPath,
  [Parameter(Mandatory = $true)][string]$ExpectedAppId,
  [Parameter(Mandatory = $true)][string]$ExpectedInstallDir,
  [Parameter(Mandatory = $true)][string]$ExpectedDataDir
)

$ErrorActionPreference = 'Stop'
$content = Get-Content -Raw -Encoding UTF8 -LiteralPath $IssPath

function Assert-Contains([string]$Value, [string]$Label) {
  if (-not $content.Contains($Value)) {
    throw "$Label is not isolated correctly in $IssPath. Expected: $Value"
  }
}

Assert-Contains "AppId={{$ExpectedAppId}" 'AppId'
Assert-Contains "DefaultDirName=$ExpectedInstallDir" 'Install directory'
Assert-Contains 'UsePreviousAppDir=no' 'Previous-directory protection'
Assert-Contains "Name: `"$ExpectedDataDir\src\database`"" 'Data directory'

Write-Host "Installer identity verified: $IssPath"
