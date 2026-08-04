$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$targetDir = Join-Path $projectRoot "packaging\prereqs"
New-Item -ItemType Directory -Path $targetDir -Force | Out-Null

$downloads = @(
  @{
    Name = "MicrosoftEdgeWebview2Setup.exe"
    Url = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
    Publisher = "Microsoft Corporation"
  },
  @{
    Name = "ChromeSetup.exe"
    Url = "https://dl.google.com/chrome/install/latest/chrome_installer.exe"
    Publisher = "Google LLC"
  }
)

foreach ($download in $downloads) {
  $path = Join-Path $targetDir $download.Name
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    Write-Host "Downloading $($download.Name)..."
    Invoke-WebRequest -Uri $download.Url -OutFile $path -UseBasicParsing
  }

  $signature = Get-AuthenticodeSignature -LiteralPath $path
  if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Subject -notlike "*$($download.Publisher)*") {
    throw "Invalid publisher signature for $($download.Name): $($signature.Status) $($signature.SignerCertificate.Subject)"
  }
  Write-Host "Verified $($download.Name): $($download.Publisher)"
}
