# Draws the Tint app icon (a record sliding out of its sleeve) and writes
# assets\tint.ico plus wwwroot\icon.png. Run again after changing the artwork.
param([string]$Root = (Split-Path -Parent $PSScriptRoot))

Add-Type -AssemblyName System.Drawing

function New-IconBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.PixelOffsetMode = 'HighQuality'
    $g.Clear([System.Drawing.Color]::Transparent)
    $s = $size / 256.0

    # Record, peeking out to the right of the sleeve.
    $disc = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 240, 178, 84))
    $g.FillEllipse($disc, 96 * $s, 38 * $s, 150 * $s, 150 * $s)
    $hole = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 20, 38, 43))
    $g.FillEllipse($hole, 157 * $s, 99 * $s, 28 * $s, 28 * $s)

    # Sleeve.
    $r = 30 * $s
    $x = 14 * $s; $y = 30 * $s; $w = 166 * $s; $h = 166 * $s
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($x, $y, $r, $r, 180, 90)
    $path.AddArc($x + $w - $r, $y, $r, $r, 270, 90)
    $path.AddArc($x + $w - $r, $y + $h - $r, $r, $r, 0, 90)
    $path.AddArc($x, $y + $h - $r, $r, $r, 90, 90)
    $path.CloseFigure()
    $sleeve = New-Object System.Drawing.Drawing2D.LinearGradientBrush `
        (New-Object System.Drawing.PointF $x, $y), `
        (New-Object System.Drawing.PointF ($x + $w), ($y + $h)), `
        ([System.Drawing.Color]::FromArgb(255, 48, 96, 106)), `
        ([System.Drawing.Color]::FromArgb(255, 24, 50, 58))
    $g.FillPath($sleeve, $path)

    $g.Dispose()
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
[System.IO.File]::WriteAllBytes((Join-Path $Root 'wwwroot\icon.png'), (Get-PngBytes (New-IconBitmap 64)))
"Wrote assets\tint.ico and wwwroot\icon.png"
