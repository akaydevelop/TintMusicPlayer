# Rebuilds Tint and starts it in dev mode: the UI is served straight from wwwroot (edit, then
# reload with F5), DevTools opens with F12, and tools\eval.mjs can script the page.
param([switch]$NoBuild)

$root = Split-Path -Parent $PSScriptRoot
Get-Process Tint -ErrorAction SilentlyContinue | ForEach-Object {
    $_.CloseMainWindow() | Out-Null
    if (-not $_.WaitForExit(3000)) { $_ | Stop-Process -Force }
}
if (-not $NoBuild) {
    dotnet build (Join-Path $root 'Tint.csproj') -f net10.0-windows -c Debug -nologo -v q | Select-Object -Last 4
    if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
}
Start-Process (Join-Path $root 'bin\Debug\net10.0-windows\Tint.exe') -ArgumentList '--dev'
