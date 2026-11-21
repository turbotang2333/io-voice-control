param(
    [string]$PreparationDirectory = (Join-Path $env:USERPROFILE '.local\state\rayneo-paseo\daily-v1-prep-20261027'),
    [string]$Serial,
    [switch]$Install,
    [switch]$UsbForward,
    [switch]$VerifyInstalled
)
$ErrorActionPreference = 'Stop'
$stateRoot = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.local\state\rayneo-paseo'))
$preparation = [IO.Path]::GetFullPath($PreparationDirectory)
if (-not $preparation.StartsWith($stateRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Preparation must be inside project state' }
$release = Get-Content -LiteralPath (Join-Path $preparation 'release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$apk = [IO.Path]::GetFullPath($release.artifact)
if (-not $apk.StartsWith($stateRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'APK must be inside project state' }
if ((Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant() -ne $release.sha256) { throw 'Candidate APK differs from the release receipt' }
if ($release.packageName -ne 'com.rayneo.venus.pub' -or $release.versionCode -ne 216) { throw 'Unexpected target package' }
$adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
if (-not (Test-Path -LiteralPath $adb)) { throw 'Existing Android SDK adb was not found' }
if (-not ($Install -or $UsbForward -or $VerifyInstalled)) {
    Write-Output 'Offline phone preparation passed: APK receipt and adb are ready. No device connection attempted.'
    return
}
if ([string]::IsNullOrWhiteSpace($Serial) -or $Serial -notmatch '^[A-Za-z0-9._:-]+$') { throw 'An explicit device serial is required' }
function Invoke-Adb([string[]]$Arguments) {
    $result = & $adb -s $Serial @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'Device operation failed; no uninstall or firmware operation will be attempted' }
    return $result
}
function Get-InstalledHash {
    $paths = @(Invoke-Adb @('shell','pm','path','com.rayneo.venus.pub'))
    if ($paths.Count -ne 1 -or $paths[0].Trim() -notmatch '^package:(/data/app/[A-Za-z0-9_~+/.=-]+/base\.apk)$') { throw 'Installed APK layout is unexpected; keep the existing app' }
    $remoteApk = $Matches[1]
    $hashLine = Invoke-Adb @('shell','sha256sum',$remoteApk)
    if ($hashLine -notmatch '^([a-fA-F0-9]{64})\s') { throw 'Cannot verify installed APK' }
    return $Matches[1].ToLowerInvariant()
}
if ((Invoke-Adb @('get-state')).Trim() -ne 'device') { throw 'Selected phone is not authorized and online' }
if ($Install) {
    $previous = Get-InstalledHash
    if ($previous -ne $release.rollbackCandidate.sha256 -and $previous -ne $release.sha256) { throw 'Installed app differs from the prepared rollback candidate; stop and preserve it before any installation' }
    $rollback = [IO.Path]::GetFullPath($release.rollbackCandidate.artifact)
    if (-not $rollback.StartsWith($stateRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or (Get-FileHash -LiteralPath $rollback -Algorithm SHA256).Hash.ToLowerInvariant() -ne $release.rollbackCandidate.sha256) { throw 'Rollback candidate is missing or changed' }
    Invoke-Adb @('install','-r',$apk) | Out-Null
    $VerifyInstalled = $true
}
if ($VerifyInstalled) {
    if ((Get-InstalledHash) -ne $release.sha256) { throw 'Installed APK does not match the candidate receipt' }
    Write-Output 'Installed APK matches the candidate checksum. Lens and wireless acceptance are still pending.'
}
if ($UsbForward) {
    $settings = Get-Content -LiteralPath (Join-Path $env:USERPROFILE '.local-secrets\rayneo-paseo\daily.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($settings.port -ne 7468) { throw 'Daily port changed; review USB forwarding before proceeding' }
    Invoke-Adb @('reverse','tcp:7468','tcp:7468') | Out-Null
    Write-Output 'Candidate USB forwarding is ready. This does not verify unplugged or mobile-network operation.'
}
