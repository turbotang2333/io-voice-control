param(
    [switch]$Check,
    [switch]$LocalOnly,
    [string]$Configuration = (Join-Path $env:USERPROFILE '.local-secrets\rayneo-paseo\shared-runtime\startup.json')
)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$node = & (Join-Path $PSScriptRoot 'resolve-node.ps1')
$entry = Join-Path $project 'experiments\codex-connector\supervisor.mjs'
$state = Join-Path $env:USERPROFILE '.local\state\rayneo-paseo\codex-connector'

function Read-PrivateJson([string]$Path) {
    if (-not [IO.Path]::IsPathRooted($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw 'Codex startup requires prepared private configuration files.'
    }
    if ((Get-Item -LiteralPath $Path).Length -gt 16384) { throw 'Startup configuration is too large.' }
    return Get-Content -LiteralPath $Path -Encoding UTF8 -Raw | ConvertFrom-Json
}

try {
    $settings = Read-PrivateJson $Configuration
    if ($settings.version -ne 1) { throw 'Unsupported startup configuration.' }
    $required = @($settings.adapter, $settings.desktopConfiguration, $settings.connectorConfiguration)
    if (-not $LocalOnly) { $required += $settings.wirelessConfiguration }
    foreach ($path in $required) {
        if (-not [IO.Path]::IsPathRooted($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw 'Prepared startup files are missing.'
        }
    }
    $desktopProfile = Read-PrivateJson $settings.desktopConfiguration
    $connectorProfile = Read-PrivateJson $settings.connectorConfiguration
    $package = Get-AppxPackage OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
    if (-not $package) { throw 'Codex Desktop is not installed.' }
    $desktop = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
    $native = Join-Path $package.InstallLocation 'app\resources\codex.exe'
    if ($desktopProfile.executable -ne $native) { throw 'Codex Desktop changed version; prepare the shared adapter again before enabling startup.' }
    if ($desktopProfile.connection.endpoint -cne $connectorProfile.sharedConnection.endpoint -or
        $desktopProfile.connection.tokenFile -ne $connectorProfile.sharedConnection.tokenFile) {
        throw 'Desktop and connector must use the same prepared shared connection.'
    }
    & (Join-Path $PSScriptRoot 'start-codex-shared.ps1') -Check -Adapter $settings.adapter -Configuration $settings.desktopConfiguration | Out-Null
    $maintenanceArgs = @('--config', $settings.connectorConfiguration)
    if ($LocalOnly) { $maintenanceArgs += '--local-only' }
    else { $maintenanceArgs += @('--wireless', $settings.wirelessConfiguration) }
    & $node $entry check @maintenanceArgs | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Connector startup configuration check failed.' }
    if ($Check) {
        [pscustomobject]@{ prepared = $true; localOnly = [bool]$LocalOnly; desktopStarted = $false; serviceStarted = $false; startupRegistered = $false; modelMessagesSent = 0 } | ConvertTo-Json -Compress
        return
    }

    # Never terminate a desktop opened by the user. A normal desktop must be closed manually to switch modes.
    if (-not (Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $desktop })) {
        & (Join-Path $PSScriptRoot 'start-codex-shared.ps1') -Adapter $settings.adapter -Configuration $settings.desktopConfiguration | Out-Null
    }
    $shared = [uri]$desktopProfile.connection.endpoint
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
        $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $shared.Port -ErrorAction SilentlyContinue)
        $ready = $false
        foreach ($listener in $listeners) {
            $owner = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $listener.OwningProcess)
            if ($owner.ExecutablePath -eq $native -and $owner.CommandLine.Contains('--ws-auth capability-token')) { $ready = $true }
        }
        if ($ready) { break }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $ready) { throw 'Shared desktop did not become ready. Save and close the normal desktop, then run the prepared startup entry.' }

    # A repeated launch may reuse only this exact configuration's existing maintenance process.
    $lock = Join-Path $state ('maintenance-' + $connectorProfile.port + '\supervisor.lock')
    if (Test-Path -LiteralPath $lock -PathType Leaf) {
        $identity = Read-PrivateJson $lock
        if ($identity.version -ne 1 -or $identity.pid -isnot [int] -or $identity.pid -le 0) { throw 'Unrecognized maintenance lock.' }
        $owner = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $identity.pid)
        if ($owner) {
            $commandLine = $owner.CommandLine.Replace('/', '\')
            if ($owner.ExecutablePath -ne $node -or $commandLine -notmatch '(?:^|[\s\\"])experiments\\codex-connector\\supervisor[.]mjs"?\s+start\s+--config\s+' -or
                -not $commandLine.Contains('"' + $settings.connectorConfiguration + '"')) {
                throw 'Maintenance lock belongs to another process; no process was stopped.'
            }
            $runningLocalOnly = $commandLine -match '(?:^|\s)--local-only(?:\s|$)'
            if ($runningLocalOnly -ne [bool]$LocalOnly -or (-not $LocalOnly -and
                -not $commandLine.Contains('"' + $settings.wirelessConfiguration + '"'))) {
                throw 'Maintenance mode does not match; no process was stopped.'
            }
            [pscustomobject]@{ reused = $true; maintenancePid = $identity.pid; modelMessagesSent = 0 } | ConvertTo-Json -Compress
            return
        }
    }
    # The supervisor owns the service and relay and retains message deduplication across restarts.
    & $node $entry start @maintenanceArgs
    if ($LASTEXITCODE -ne 0) { throw 'Connector maintenance exited.' }
} catch {
    # Store only a fixed classification, never exception details containing private configuration.
    New-Item -ItemType Directory -Path $state -Force | Out-Null
    [pscustomobject]@{ version = 1; checkedAt = [DateTime]::UtcNow.ToString('o'); state = 'startup-failed'; modelMessagesSent = 0 } |
        ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $state 'startup-failure.json') -Encoding UTF8
    Write-Error 'Codex startup failed. Check the desktop launch mode and private configuration. Existing desktop and messages were not changed.'
    exit 1
}
