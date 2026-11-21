param(
    [string]$Configuration = (Join-Path $env:USERPROFILE '.local-secrets\rayneo-paseo\shared-runtime\startup.json'),
    [string]$OutputDirectory = (Join-Path $env:USERPROFILE '.local\state\rayneo-paseo\codex-startup')
)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$stateRoot = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.local\state\rayneo-paseo'))
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (-not $output.StartsWith($stateRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Startup preparation must stay in the project state directory.' }
& (Join-Path $PSScriptRoot 'run-codex-daily.ps1') -Check -Configuration $Configuration | Out-Null
if (-not $?) { throw 'Startup check failed.' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$command = [Security.SecurityElement]::Escape((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
$arguments = [Security.SecurityElement]::Escape('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' +
    (Join-Path $PSScriptRoot 'run-codex-daily.ps1') + '" -Configuration "' + [IO.Path]::GetFullPath($Configuration) + '"')
$working = [Security.SecurityElement]::Escape($project)
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>$sid</UserId><Delay>PT15S</Delay></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>$sid</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Hidden>true</Hidden><RestartOnFailure><Interval>PT1M</Interval><Count>10</Count></RestartOnFailure></Settings>
  <Actions Context="Author"><Exec><Command>$command</Command><Arguments>$arguments</Arguments><WorkingDirectory>$working</WorkingDirectory></Exec></Actions>
</Task>
"@
[xml]$validated = $xml
New-Item -ItemType Directory -Path $output -Force | Out-Null
$xml | Set-Content -LiteralPath (Join-Path $output 'codex-startup.task.xml') -Encoding Unicode
[pscustomobject]@{ prepared = $true; startupRegistered = $false; administratorRequired = $false; requiresUserLogon = $true } | ConvertTo-Json -Compress
