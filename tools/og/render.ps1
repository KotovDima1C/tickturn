# Рисует баннер превью ссылки (1200x630) из HTML через Microsoft Edge без окна.
# По умолчанию: tools/og/og.html -> docs/og.png (скрипт лежит в tools/og/ проекта).
#   .\render.ps1
#   .\render.ps1 -Html .\og-dark.html -Out ..\..\docs\og.png
param(
  [string]$Html = (Join-Path $PSScriptRoot 'og.html'),
  [string]$Out  = (Join-Path $PSScriptRoot '..\..\docs\og.png'),
  [int]$Width   = 1200,
  [int]$Height  = 630
)
$ErrorActionPreference = 'Stop'

$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Не найден Microsoft Edge (msedge.exe)' }

$Html = (Resolve-Path $Html).Path
$Out  = [IO.Path]::GetFullPath($Out)
New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
$src  = 'file:///' + ($Html -replace '\\', '/')
# Свой профиль во временной папке: не трогаем профиль пользователя и не мешаем открытому Edge.
$tmp  = Join-Path $env:TEMP 'og-render-profile'

# --virtual-time-budget даёт время загрузить шрифты Google Fonts (в og.html они с display=block).
# Edge пишет служебные строки в stderr; в Windows PowerShell 5.1 при 'Stop' это стало бы ошибкой.
if (Test-Path $Out) { Remove-Item $Out }
$ErrorActionPreference = 'Continue'
& $edge --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 `
  --user-data-dir="$tmp" --window-size="$Width,$Height" --virtual-time-budget=8000 `
  --screenshot="$Out" $src 2>&1 | Out-Null
$ErrorActionPreference = 'Stop'
Start-Sleep -Milliseconds 500

if (-not (Test-Path $Out)) { throw "Edge не создал $Out" }
Get-Item $Out | Select-Object FullName, @{ n = 'KB'; e = { [math]::Round($_.Length / 1KB) } }
