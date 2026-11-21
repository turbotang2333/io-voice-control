param(
    [Parameter(Mandatory=$true)][string]$SourceDirectory,
    [Parameter(Mandatory=$true)][string]$OutputArchive
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if (-not [IO.Path]::IsPathRooted($SourceDirectory) -or -not [IO.Path]::IsPathRooted($OutputArchive)) { throw 'Absolute package paths are required.' }
$source = [IO.Path]::GetFullPath($SourceDirectory)
$output = [IO.Path]::GetFullPath($OutputArchive)
if (-not (Test-Path -LiteralPath $source -PathType Container) -or -not (Test-Path -LiteralPath (Join-Path $source 'manifest.json') -PathType Leaf)) { throw 'A prepared connector package is required.' }
if ((Test-Path -LiteralPath $output) -or $output.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive output must be a fresh file outside the package directory.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
# Windows compressed folders reject the ./ prefixes emitted by tar -C package .
[IO.Compression.ZipFile]::CreateFromDirectory($source, $output, [IO.Compression.CompressionLevel]::Optimal, $false)
$archive = [IO.Compression.ZipFile]::OpenRead($output)
try {
    $dotEntries = @($archive.Entries | Where-Object { $_.FullName.StartsWith('./') -or $_.FullName.StartsWith('.\') }).Count
    $files = @($archive.Entries | Where-Object { $_.Name.Length -gt 0 }).Count
    if ($dotEntries -gt 0) { throw 'Windows-incompatible ZIP entry prefix.' }
} finally { $archive.Dispose() }
$shell = New-Object -ComObject Shell.Application
$folder = $shell.NameSpace($output)
$count = if ($null -ne $folder) { $folder.Items().Count } else { 0 }
if ($count -lt 1) { throw 'Windows compressed-folder reader cannot enumerate the package.' }
[pscustomobject]@{windowsShellVisibleItems=$count;dotPrefixedEntries=$dotEntries;files=$files} | ConvertTo-Json -Compress
