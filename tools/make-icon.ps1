# Draws the Tint app icon (monochrome eighth note with a round paintbrush-tip notehead)
# and writes assets\tint.ico, assets\tint.png (256px for Linux), and wwwroot\icon.png.
# Run again after changing the artwork.
param([string]$Root = (Split-Path -Parent $PSScriptRoot))

Add-Type -AssemblyName System.Drawing

function New-IconBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.PixelOffsetMode = 'HighQuality'
    $g.Clear([System.Drawing.Color]::Transparent)
    $s = $size / 256.0
    $g.ScaleTransform($s, $s)

    # Monochrome rounded-square badge
    $bx = 14.0; $by = 14.0; $bw = 228.0; $bh = 228.0; $br = 108.0
    $bgPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $bgPath.AddArc($bx, $by, $br, $br, 180, 90)
    $bgPath.AddArc($bx + $bw - $br, $by, $br, $br, 270, 90)
    $bgPath.AddArc($bx + $bw - $br, $by + $bh - $br, $br, $br, 0, 90)
    $bgPath.AddArc($bx, $by + $bh - $br, $br, $br, 90, 90)
    $bgPath.CloseFigure()
    $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush `
        (New-Object System.Drawing.PointF 36, 20), `
        (New-Object System.Drawing.PointF 220, 240), `
        ([System.Drawing.Color]::FromArgb(255, 36, 36, 41)), `
        ([System.Drawing.Color]::FromArgb(255, 17, 17, 20))
    $g.FillPath($bgBrush, $bgPath)

    $ink = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 246, 246, 248))
    $ferruleInk = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(143, 246, 246, 248))

    $g.TranslateTransform(2, 2)

    # Eighth-note stem and sweeping flag
    $flag = New-Object System.Drawing.Drawing2D.GraphicsPath
    $flag.AddLine(124, 126, 124, 42)
    $flag.AddBezier(124, 42, 124, 37, 129, 34, 134, 37)
    $flag.AddBezier(134, 37, 158, 52, 190, 69, 200, 103)
    $flag.AddBezier(200, 103, 205, 120, 201, 137, 191, 150)
    $flag.AddBezier(191, 150, 192, 132, 186, 115, 171, 103)
    $flag.AddBezier(171, 103, 161, 95, 152, 90, 146, 87)
    $flag.AddLine(146, 87, 146, 126)
    $flag.CloseFigure()
    $g.FillPath($ink, $flag)

    # Brush ferrule collar
    $fx = 117.0; $fy = 134.0; $fw = 36.0; $fh = 15.0; $fr = 10.0
    $fPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $fPath.AddArc($fx, $fy, $fr, $fr, 180, 90)
    $fPath.AddArc($fx + $fw - $fr, $fy, $fr, $fr, 270, 90)
    $fPath.AddArc($fx + $fw - $fr, $fy + $fh - $fr, $fr, $fr, 0, 90)
    $fPath.AddArc($fx, $fy + $fh - $fr, $fr, $fr, 90, 90)
    $fPath.CloseFigure()
    $g.FillPath($ferruleInk, $fPath)

    # Round notehead belly tapering into a paintbrush tip
    $tip = New-Object System.Drawing.Drawing2D.GraphicsPath
    $tip.AddLine(117, 157, 153, 157)
    $tip.AddBezier(153, 157, 162, 185, 147, 219, 116, 223)
    $tip.AddBezier(116, 223, 91, 226, 70, 214, 58, 197)
    $tip.AddBezier(58, 197, 68, 194, 74, 186, 78, 175)
    $tip.AddBezier(78, 175, 84, 160, 99, 157, 117, 157)
    $tip.CloseFigure()
    $g.FillPath($ink, $tip)

    $bgBrush.Dispose(); $bgPath.Dispose(); $ink.Dispose(); $ferruleInk.Dispose()
    $flag.Dispose(); $fPath.Dispose(); $tip.Dispose(); $g.Dispose()
    return $bmp
}

function Get-PngBytes($bmp) {
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    return , $ms.ToArray()
}

$sizes = 16, 24, 32, 48, 64, 256
$pngs = foreach ($sz in $sizes) { , (Get-PngBytes (New-IconBitmap $sz)) }

New-Item -ItemType Directory -Force (Join-Path $Root 'assets') | Out-Null
$ico = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $ico
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $dim = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
    $bw.Write([byte]$dim); $bw.Write([byte]$dim); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$pngs[$i].Length); $bw.Write([uint32]$offset)
    $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $bw.Write($p) }
$bw.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $Root 'assets\tint.ico'), $ico.ToArray())
[System.IO.File]::WriteAllBytes((Join-Path $Root 'assets\tint.png'), $pngs[-1])
[System.IO.File]::WriteAllBytes((Join-Path $Root 'wwwroot\icon.png'), (Get-PngBytes (New-IconBitmap 64)))
"Wrote assets\tint.ico, assets\tint.png and wwwroot\icon.png"
