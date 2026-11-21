param(
    [Parameter(Mandatory=$true)][ValidateSet('Paseo','Codex')][string]$Backend,
    [ValidateSet('Check','Start','Recover')][string]$Action = 'Check'
)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$node = & (Join-Path $PSScriptRoot 'resolve-node.ps1')
$state = Join-Path $env:USERPROFILE '.local\state\rayneo-paseo'
$check = Join-Path $PSScriptRoot 'check-assistant-connection.mjs'
$selected = $Backend.ToLowerInvariant()
if ($Action -ne 'Check') {
    $launcher = Join-Path $PSScriptRoot $(if ($selected -eq 'paseo') { 'run-daily.ps1' } else { 'run-codex-daily.ps1' })
    if ($selected -eq 'codex') {
        $startup = Get-Content -LiteralPath (Join-Path $env:USERPROFILE '.local-secrets\rayneo-paseo\shared-runtime\startup.json') -Encoding UTF8 -Raw | ConvertFrom-Json
        $profile = Get-Content -LiteralPath $startup.connectorConfiguration -Encoding UTF8 -Raw | ConvertFrom-Json
        if ($profile.host -ne '127.0.0.1' -or $profile.port -isnot [int] -or $profile.port -lt 1024 -or $profile.port -gt 65535) { throw 'Invalid local connector profile.' }
    }
    $lock = if ($selected -eq 'paseo') { Join-Path $state 'daily-supervisor.lock' } else { Join-Path $state ('codex-connector\maintenance-' + $profile.port + '\supervisor.lock') }
    $running = $false
    if (Test-Path -LiteralPath $lock -PathType Leaf) {
        $identity = Get-Content -LiteralPath $lock -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($identity.version -ne 1 -or $identity.pid -isnot [int] -or $identity.pid -le 0) { throw 'Unrecognized connection maintenance lock.' }
        $owner = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $identity.pid)
        if ($owner) {
            $entry = if ($selected -eq 'paseo') { 'bridge\\supervisor[.]mjs' } else { 'experiments\\codex-connector\\supervisor[.]mjs' }
            if ($owner.ExecutablePath -ne $node -or $owner.CommandLine.Replace('/','\') -notmatch ('(?:^|[\s\\"])' + $entry + '"?(?:\s|$)')) {
                throw 'Lock belongs to another process. No process was stopped.'
            }
            if ($selected -eq 'codex' -and (-not $owner.CommandLine.Contains('"' + $startup.connectorConfiguration + '"') -or
                -not $owner.CommandLine.Contains('"' + $startup.wirelessConfiguration + '"'))) { throw 'Connector lock configuration does not match.' }
            $running = $true
        }
    }
    if (-not $running) {
        & powershell.exe -NoProfile -NonInteractive -File $launcher -Check | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Prepared connection startup check failed.' }
        $shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        Start-Process -FilePath $shell -ArgumentList ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launcher + '"') -WorkingDirectory $project -WindowStyle Hidden | Out-Null
        Start-Sleep -Seconds 3
    } elseif ($selected -eq 'codex') {
        & powershell.exe -NoProfile -NonInteractive -File $launcher | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Shared desktop readiness check failed. No existing desktop was stopped.' }
    }
    # Both supervisors already recover their own transport. Never kill a desktop or replay a task here.
}
& $node $check --backend $selected
exit $LASTEXITCODE
