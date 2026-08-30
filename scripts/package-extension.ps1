$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $projectRoot "public\manifest.json"
$distPath = Join-Path $projectRoot "dist"
$releasePath = Join-Path $projectRoot "release"

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$manifest.version
if (-not $version -or $version -notmatch '^\d+\.\d+\.\d+(?:\.\d+)?$') {
  throw "The extension manifest has an invalid version."
}

Push-Location $projectRoot
try {
  & npm.cmd run typecheck
  if ($LASTEXITCODE -ne 0) { throw "Type checking failed." }

  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw "Build failed." }

  Copy-Item -LiteralPath (Join-Path $projectRoot "LICENSE") -Destination (Join-Path $distPath "LICENSE") -Force

  New-Item -ItemType Directory -Path $releasePath -Force | Out-Null
  $archivePath = Join-Path $releasePath "spoiler-barrage-ai-filter-v$version.zip"
  if (Test-Path -LiteralPath $archivePath) {
    Remove-Item -LiteralPath $archivePath -Force
  }
  Compress-Archive -Path (Join-Path $distPath "*") -DestinationPath $archivePath
  Write-Host "Created $archivePath"
} finally {
  Pop-Location
}
