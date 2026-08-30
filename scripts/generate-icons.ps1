$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceSvg = Join-Path $projectRoot "assets\extension-icon.svg"
$outputDir = Join-Path $projectRoot "public\icons"
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null

$chromeCandidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chrome = $chromeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $chrome) {
  throw "Google Chrome was not found."
}

$sourcePath = (Resolve-Path -LiteralPath $sourceSvg).Path
$sourceUri = (New-Object System.Uri($sourcePath)).AbsoluteUri
$masterPath = Join-Path $outputDir "icon-master.png"
$profileDir = Join-Path $projectRoot "scripts\.icon-render-profile"
$resolvedProject = [System.IO.Path]::GetFullPath($projectRoot).TrimEnd("\") + "\"
$resolvedProfile = [System.IO.Path]::GetFullPath($profileDir)
if (-not $resolvedProfile.StartsWith($resolvedProject, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Unsafe temporary profile path."
}

try {
  New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
  $chromeArgs = @(
    "--headless=new",
    "--disable-gpu",
    "--disable-extensions",
    "--hide-scrollbars",
    "--run-all-compositor-stages-before-draw",
    "--default-background-color=00000000",
    "--window-size=512,512",
    "--user-data-dir=$profileDir",
    "--screenshot=$masterPath",
    $sourceUri
  )
  & $chrome $chromeArgs | Out-Null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $masterPath)) {
    throw "Failed to render the source icon."
  }

  Add-Type -AssemblyName System.Drawing
  $sourceBitmap = [System.Drawing.Bitmap]::FromFile($masterPath)
  foreach ($size in @(16, 32, 48, 128)) {
    $iconPath = Join-Path $outputDir "icon-$size.png"
    $icon = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($icon)
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.DrawImage($sourceBitmap, 0, 0, $size, $size)
    $icon.Save($iconPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose()
    $icon.Dispose()
  }
  $sourceBitmap.Dispose()
} finally {
  if (Test-Path -LiteralPath $masterPath) {
    Remove-Item -LiteralPath $masterPath -Force
  }
  if (Test-Path -LiteralPath $resolvedProfile) {
    Remove-Item -LiteralPath $resolvedProfile -Recurse -Force
  }
}
