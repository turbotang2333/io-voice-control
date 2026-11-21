param(
    [switch]$Check,
    [switch]$Original,
    [string]$Adapter,
    [string]$Configuration
)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$package = Get-AppxPackage OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
if (-not $package) { throw 'Codex Desktop is not installed' }
$desktop = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
$entry = Join-Path $project 'experiments\codex-shared\desktop-host.mjs'
$node = & (Join-Path $PSScriptRoot 'resolve-node.ps1')
if (-not (Test-Path -LiteralPath $desktop -PathType Leaf)) { throw 'Installed desktop executable was not found' }
if (-not $Original) {
    foreach ($path in @($Adapter, $Configuration, $entry)) {
        if (-not [IO.Path]::IsPathRooted($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Prepared adapter and private configuration are required' }
    }
}
$names = @('CODEX_CLI_PATH', 'CODEX_APP_SERVER_WS_URL', 'CODEX_APP_SERVER_FORCE_CLI',
    'RAYNEO_SHARED_NODE', 'RAYNEO_SHARED_ENTRY', 'RAYNEO_SHARED_DESKTOP_CONFIG')
$previous = @{}
foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
    if (-not $Original) {
        $env:CODEX_CLI_PATH = $Adapter
        $env:CODEX_APP_SERVER_FORCE_CLI = '1'
        $env:RAYNEO_SHARED_NODE = $node
        $env:RAYNEO_SHARED_ENTRY = $entry
        $env:RAYNEO_SHARED_DESKTOP_CONFIG = $Configuration
        $version = & $Adapter --version
        if ($LASTEXITCODE -ne 0 -or $version -notmatch '^codex-cli ') { throw 'Prepared adapter version check failed' }
    }
    if ($Check) {
        [pscustomobject]@{ prepared = $true; original = [bool]$Original; desktopStarted = $false; permanentEnvironmentChanged = $false } | ConvertTo-Json -Compress
        return
    }
    # Opening a second instance would silently reuse the old process and ignore this environment.
    $running = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $desktop }
    if ($running) { throw 'Codex Desktop is still running. Save its work and close it before switching launch modes.' }
    Start-Process -FilePath $desktop -WindowStyle Hidden -WorkingDirectory $project | Out-Null
    [pscustomobject]@{ launchRequested = $true; original = [bool]$Original; permanentEnvironmentChanged = $false } | ConvertTo-Json -Compress
} finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
}
