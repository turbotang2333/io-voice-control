param(
    [string]$OutputDirectory = (Join-Path $env:USERPROFILE '.local\state\rayneo-paseo\daily-v1-prep-20261027')
)
$ErrorActionPreference = 'Stop'
$stateRoot = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.local\state\rayneo-paseo'))
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (-not $output.StartsWith($stateRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Startup preparation must stay in the project state directory' }
$project = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
& $node (Join-Path $project 'bridge\supervisor.mjs') --check
if ($LASTEXITCODE -ne 0) { throw 'Runtime configuration check failed' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$command = [Security.SecurityElement]::Escape((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
$arguments = [Security.SecurityElement]::Escape('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $project 'scripts\run-daily.ps1') + '"')
$working = [Security.SecurityElement]::Escape($project)
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>$sid</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>$sid</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Hidden>true</Hidden><RestartOnFailure><Interval>PT1M</Interval><Count>10</Count></RestartOnFailure></Settings>
  <Actions Context="Author"><Exec><Command>$command</Command><Arguments>$arguments</Arguments><WorkingDirectory>$working</WorkingDirectory></Exec></Actions>
</Task>
"@
[xml]$validated = $xml
New-Item -ItemType Directory -Path $output -Force | Out-Null
$path = Join-Path $output 'daily-startup.task.xml'
$xml | Set-Content -LiteralPath $path -Encoding Unicode
Write-Output 'Logon task XML prepared and parsed; no task registered or started. Requires this user to log on after reboot.'
