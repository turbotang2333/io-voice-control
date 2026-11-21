param(
    [ValidateSet('Enable', 'Disable', 'Check')][string]$Mode = 'Check',
    [string]$Configuration = (Join-Path $env:USERPROFILE '.local-secrets\rayneo-paseo\shared-runtime\startup.json')
)
$ErrorActionPreference = 'Stop'
$taskName = 'Rayneo Codex Daily'
$command = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' +
    (Join-Path $PSScriptRoot 'run-codex-daily.ps1') + '" -Configuration "' + [IO.Path]::GetFullPath($Configuration) + '"'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Test-CurrentUser([string]$UserId) {
    if ($UserId -eq $sid) { return $true }
    try {
        $account = New-Object Security.Principal.NTAccount($UserId)
        return $account.Translate([Security.Principal.SecurityIdentifier]).Value -eq $sid
    } catch { return $false }
}
$current = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($current -and ($current.Actions.Count -ne 1 -or $current.Actions[0].Execute -ne $command -or
    $current.Actions[0].Arguments -cne $arguments -or -not (Test-CurrentUser $current.Principal.UserId) -or
    $current.Principal.RunLevel -ne 'Limited')) {
    throw 'An unrelated startup task uses this name. It was not changed.'
}
if ($Mode -eq 'Disable') {
    if ($current) { Unregister-ScheduledTask -TaskName $taskName -TaskPath '\' -Confirm:$false }
    [pscustomobject]@{ enabled = $false; runningProcessesStopped = $false; modelMessagesSent = 0 } | ConvertTo-Json -Compress
    return
}
if ($Mode -eq 'Enable') {
    & (Join-Path $PSScriptRoot 'prepare-codex-startup.ps1') -Configuration $Configuration | Out-Null
    if (-not $?) { throw 'Startup preparation failed.' }
    $xmlPath = Join-Path $env:USERPROFILE '.local\state\rayneo-paseo\codex-startup\codex-startup.task.xml'
    $xml = Get-Content -LiteralPath $xmlPath -Encoding Unicode -Raw
    Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Xml $xml -Force | Out-Null
    $current = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
    if ($current.Actions[0].Execute -ne $command -or $current.Actions[0].Arguments -cne $arguments -or
        -not (Test-CurrentUser $current.Principal.UserId) -or $current.Principal.RunLevel -ne 'Limited') {
        throw 'Startup task verification failed.'
    }
}
[pscustomobject]@{ registered = [bool]$current; enabled = [bool]($current -and $current.Settings.Enabled);
    administratorRequired = $false; taskStarted = $false; requiresUserLogon = $true; modelMessagesSent = 0 } | ConvertTo-Json -Compress
