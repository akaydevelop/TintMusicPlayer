# Builds the release version of Tint into dist\ (Tint.exe plus its wwwroot folder).
#   .\tools\publish.ps1              build only
#   .\tools\publish.ps1 -Shortcut    also add a Start menu shortcut pointing at dist\Tint.exe
param([switch]$Shortcut)

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'

Get-Process Tint -ErrorAction SilentlyContinue | ForEach-Object {
    $_.CloseMainWindow() | Out-Null
    if (-not $_.WaitForExit(3000)) { $_ | Stop-Process -Force }
}

if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
dotnet publish (Join-Path $root 'Tint.csproj') -f net10.0-windows -c Release -r win-x64 --self-contained false `
    -p:PublishSingleFile=true -p:DebugType=none -o $dist -nologo -v q
if ($LASTEXITCODE -ne 0) { throw 'Publish failed.' }

# API documentation files and a second copy of the WebView2 loader come along with the package; the app needs neither.
Get-ChildItem $dist -Filter '*.xml' -File | Remove-Item
$extra = Join-Path $dist 'runtimes'
if (Test-Path $extra) { Remove-Item $extra -Recurse -Force }
if (-not (Test-Path (Join-Path $dist 'WebView2Loader.dll'))) { throw 'WebView2Loader.dll is missing from the published app.' }

if ($Shortcut) {
    $link = Join-Path ([Environment]::GetFolderPath('Programs')) 'Tint.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $s = $shell.CreateShortcut($link)
    $s.TargetPath = Join-Path $dist 'Tint.exe'
    $s.WorkingDirectory = $dist
    $s.Description = 'Tint music player'
    $s.Save()
    "Start menu shortcut: $link"
}

$size = (Get-ChildItem $dist -Recurse -File | Measure-Object Length -Sum).Sum
"Published to $dist ({0:N1} MB)" -f ($size / 1MB)
