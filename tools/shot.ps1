# Saves a PNG of the running Tint window (works even when it is behind other windows).
param([string]$Out = (Join-Path $env:TEMP 'tint-shot.png'))

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TintShot {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@

[TintShot]::SetProcessDPIAware() | Out-Null
$proc = Get-Process Tint -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { throw 'Tint is not running.' }

$rect = New-Object TintShot+RECT
[TintShot]::GetWindowRect($proc.MainWindowHandle, [ref]$rect) | Out-Null
$bmp = New-Object System.Drawing.Bitmap ($rect.R - $rect.L), ($rect.B - $rect.T)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
[TintShot]::PrintWindow($proc.MainWindowHandle, $dc, 2) | Out-Null
$g.ReleaseHdc($dc)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
"$Out ($($bmp.Width)x$($bmp.Height))"
