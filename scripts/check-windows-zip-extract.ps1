param(
    [Parameter(Mandatory=$true)][string]$Archive,
    [Parameter(Mandatory=$true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$stateRoot = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.local\state\rayneo-paseo'))
$target = [IO.Path]::GetFullPath($Destination)
if (-not [IO.Path]::IsPathRooted($Archive) -or -not [IO.Path]::IsPathRooted($Destination) -or
    -not $target.StartsWith($stateRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
    (Test-Path -LiteralPath $target)) { throw 'Extraction acceptance requires a fresh directory inside project state.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
    $manifestEntry = $zip.GetEntry('manifest.json')
    if ($null -eq $manifestEntry) { throw 'Canonical package manifest missing.' }
    $reader = [IO.StreamReader]::new($manifestEntry.Open())
    try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
} finally { $zip.Dispose() }
$null = [IO.Directory]::CreateDirectory($target)
$shell = New-Object -ComObject Shell.Application
$source = $shell.NameSpace($Archive)
$output = $shell.NameSpace($target)
if ($null -eq $source -or $source.Items().Count -ne 4 -or $null -eq $output) { throw 'Windows compressed-folder reader did not recognize the package.' }
# Native Explorer ZIP extraction, with progress, replacement and error dialogs suppressed.
$output.CopyHere($source.Items(), (4 -bor 16 -bor 512 -bor 1024))
$deadline = [DateTime]::UtcNow.AddSeconds(60)
$ready = $false
do {
    $files = @([IO.Directory]::EnumerateFiles($target, '*', [IO.SearchOption]::AllDirectories))
    if ($files.Count -eq $manifest.files.Count + 1) {
        $ready = $true
        foreach ($entry in $manifest.files) {
            $file = Join-Path $target $entry.path
            if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Item -LiteralPath $file).Length -ne $entry.bytes) { $ready = $false; break }
        }
    }
    if (-not $ready) { Start-Sleep -Milliseconds 500 }
} while (-not $ready -and [DateTime]::UtcNow -lt $deadline)
if (-not $ready) { throw 'Windows extraction did not finish with all expected files.' }
[pscustomobject]@{nativeWindowsExtractionPassed=$true;extractedFiles=$manifest.files.Count + 1;destination=$target} | ConvertTo-Json -Compress
