param([string]$Output = (Join-Path $PSScriptRoot '../build/SentenceReader.exe'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319/csc.exe' }
if (-not (Test-Path -LiteralPath $compiler)) { throw 'The Windows .NET Framework C# compiler is required.' }
$outputPath = [IO.Path]::GetFullPath($Output)
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($outputPath)) | Out-Null
$iconPath = [IO.Path]::ChangeExtension($outputPath, '.ico')
$images = @()
foreach ($size in @(16, 24, 32, 48, 64, 128, 256)) {
    $bitmap = New-Object Drawing.Bitmap($size, $size)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = 'AntiAlias'
    $graphics.TextRenderingHint = 'AntiAliasGridFit'
    $brush = New-Object Drawing.SolidBrush([Drawing.Color]::FromArgb(60, 97, 72))
    $graphics.FillRectangle($brush, 0, 0, $size, $size)
    $font = New-Object Drawing.Font('Microsoft YaHei', ($size * .73), [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Pixel)
    $format = New-Object Drawing.StringFormat
    $format.Alignment = 'Center'; $format.LineAlignment = 'Center'
    $bounds = New-Object Drawing.RectangleF(0, (-$size * .025), $size, $size)
    $graphics.DrawString(([char]0x53e5).ToString(), $font, [Drawing.Brushes]::White, $bounds, $format)
    $stream = New-Object IO.MemoryStream
    $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
    $images += ,([pscustomobject]@{ Size=$size; Bytes=$stream.ToArray() })
    $stream.Dispose(); $format.Dispose(); $font.Dispose(); $brush.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}
$file = [IO.File]::Create($iconPath)
$writer = New-Object IO.BinaryWriter($file)
try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$images.Count)
    $offset = 6 + 16 * $images.Count
    foreach ($image in $images) {
        $dimension = if ($image.Size -eq 256) { 0 } else { $image.Size }
        $writer.Write([byte]$dimension); $writer.Write([byte]$dimension); $writer.Write([byte]0); $writer.Write([byte]0)
        $writer.Write([uint16]1); $writer.Write([uint16]32); $writer.Write([uint32]$image.Bytes.Length); $writer.Write([uint32]$offset)
        $offset += $image.Bytes.Length
    }
    foreach ($image in $images) { $writer.Write([byte[]]$image.Bytes) }
} finally { $writer.Dispose(); $file.Dispose() }
& $compiler /nologo /target:winexe /optimize+ /debug- /platform:anycpu "/out:$outputPath" "/win32icon:$iconPath" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:Microsoft.CSharp.dll (Join-Path $PSScriptRoot 'windows-launcher.cs')
if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed.' }
Get-Item -LiteralPath $outputPath | Select-Object Name, Length
