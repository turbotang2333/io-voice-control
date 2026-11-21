param([switch]$Check, [switch]$LocalOnly)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$node = & (Join-Path $PSScriptRoot 'resolve-node.ps1')
$entry = Join-Path $project 'bridge\supervisor.mjs'
$mode = @()
if ($LocalOnly) { $mode += '--local-only' }
if ($Check) {
    & $node $entry --check @mode
    exit $LASTEXITCODE
}
$arguments = '"' + $entry + '"'
if ($LocalOnly) { $arguments += ' --local-only' }
$process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $project -WindowStyle Hidden -PassThru -Wait
exit $process.ExitCode
