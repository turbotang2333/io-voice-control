param(
    [string]$Serial,
    [switch]$UsbForward,
    [switch]$RemoveUsbForward
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
$profilePath = Join-Path $env:USERPROFILE '.local-secrets\rayneo-paseo\codex-direct.json'
$profile = Get-Content -LiteralPath $profilePath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($profile.version -ne 1 -or $profile.host -ne '127.0.0.1' -or $profile.port -ne 17469 -or $profile.apiToken -notmatch '^[a-f0-9]{64}$') {
    throw 'Unexpected experiment profile; stop without changing the phone'
}
if (-not (Test-Path -LiteralPath $adb)) { throw 'Existing Android SDK adb was not found' }
if ($UsbForward -and $RemoveUsbForward) { throw 'Choose only one forwarding operation' }
if (-not ($UsbForward -or $RemoveUsbForward)) {
    Write-Output 'Experiment profile and adb are ready. No phone settings, APK, or forwarding changed.'
    return
}
if ([string]::IsNullOrWhiteSpace($Serial) -or $Serial -notmatch '^[A-Za-z0-9._:-]+$') { throw 'An explicit device serial is required' }
$deviceState = & $adb -s $Serial get-state
if ($LASTEXITCODE -ne 0 -or $deviceState.Trim() -ne 'device') { throw 'Selected phone is not authorized and online' }
if ($UsbForward) {
    # Verify the already accepted APK; never install, uninstall, or touch glasses firmware.
    & (Join-Path $projectRoot 'scripts\phone-handoff.ps1') -Serial $Serial -VerifyInstalled
    if ($LASTEXITCODE -ne 0) { throw 'Existing APK verification failed' }
    & $adb -s $Serial reverse 'tcp:17469' 'tcp:17469' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Experiment USB forwarding failed' }
    Write-Output 'Experiment USB forwarding is ready on port 17469. Phone settings still need temporary configuration and later restoration.'
} else {
    & $adb -s $Serial reverse --remove 'tcp:17469' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not remove the experiment forwarding' }
    Write-Output 'Only experiment USB forwarding was removed. Restore the previous phone settings to use the daily version.'
}
