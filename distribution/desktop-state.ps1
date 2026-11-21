param([int]$SharedPort = 19569)
$ErrorActionPreference = 'Stop'
$package = Get-AppxPackage OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
if (-not $package) { Write-Output '{"installed":false,"desktopRunning":false,"sharedReady":false}'; return }
$desktop = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
$native = Join-Path $package.InstallLocation 'app\resources\codex.exe'
$running = $false
$inspectionFailed = $false
try { $running = [bool](Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $desktop }) }
catch { $inspectionFailed = $true }
$shared = $false
try {
    foreach ($listener in @(Get-NetTCPConnection -State Listen -LocalPort $SharedPort -ErrorAction SilentlyContinue)) {
        $owner = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $listener.OwningProcess)
        if ($owner -and $owner.ExecutablePath -eq $native -and $owner.CommandLine.Contains('--ws-auth capability-token')) { $shared = $true }
    }
} catch { $inspectionFailed = $true }
@{ installed = (Test-Path -LiteralPath $native -PathType Leaf); native = $native; desktopRunning = $running; sharedReady = $shared; inspectionFailed = $inspectionFailed } | ConvertTo-Json -Compress
