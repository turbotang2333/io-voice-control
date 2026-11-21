$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$project = Split-Path -Parent $PSScriptRoot
$bundle = Split-Path -Parent $project
$runtime = Join-Path $bundle 'runtime\node.exe'
if (Test-Path -LiteralPath (Join-Path $bundle 'manifest.json') -PathType Leaf) {
    if (-not (Test-Path -LiteralPath $runtime -PathType Leaf)) { throw 'Bundled Node runtime is missing. Extract the complete connector package again.' }
    Write-Output ([IO.Path]::GetFullPath($runtime))
} else {
    Write-Output (Get-Command node.exe -ErrorAction Stop).Source
}
