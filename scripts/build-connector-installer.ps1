param(
    [Parameter(Mandatory=$true)][string]$PackageDirectory,
    [Parameter(Mandatory=$true)][string]$OutputInstaller,
    [Parameter(Mandatory=$true)][string]$PayloadArchive
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$package = [IO.Path]::GetFullPath($PackageDirectory)
$output = [IO.Path]::GetFullPath($OutputInstaller)
$payload = [IO.Path]::GetFullPath($PayloadArchive)
if (-not [IO.Path]::IsPathRooted($PackageDirectory) -or -not [IO.Path]::IsPathRooted($OutputInstaller) -or -not [IO.Path]::IsPathRooted($PayloadArchive)) { throw 'Absolute paths are required.' }
if (-not (Test-Path -LiteralPath (Join-Path $package '眼镜连接器.exe') -PathType Leaf)) { throw 'A complete tray package is required.' }
if ((Test-Path -LiteralPath $output) -or (Test-Path -LiteralPath $payload)) { throw 'Output already exists.' }
if ($output.StartsWith($package + '\', [StringComparison]::OrdinalIgnoreCase) -or $payload.StartsWith($package + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Outputs must be outside the package directory.' }
$node = Join-Path $package 'runtime\node.exe'
$verify = Join-Path $package 'app\distribution\integrity.mjs'
@'
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(process.argv[2]));
await m.verifyConnectorPackage(process.argv[3]);
'@ | & $node --input-type=module - $verify $package
if ($LASTEXITCODE -ne 0) { throw 'Package verification failed.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($package, $payload, [IO.Compression.CompressionLevel]::Optimal, $false)
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$source = Join-Path $PSScriptRoot '..\distribution\Installer.cs'
& $compiler /nologo /target:winexe /optimize+ "/out:$output" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll "/resource:$payload,connector.zip" $source
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $output -PathType Leaf)) { throw 'Installer compilation failed.' }
[pscustomobject]@{ installer = $output; bytes = (Get-Item -LiteralPath $output).Length; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $output).Hash } | ConvertTo-Json -Compress
