param(
    [string]$InputApk = (Join-Path $env:USERPROFILE '.local\state\rayneo-paseo\inputs\rayneo-ai-1.0.6.apk'),
    [string]$OutputDirectory = (Join-Path $env:USERPROFILE '.local\state\rayneo-paseo\build-2026-10-26'),
    [switch]$PromptDisplayTrial,
    [switch]$ReleaseSigning,
    [string]$PythonExecutable = (Join-Path $env:LOCALAPPDATA 'Python\pythoncore-3.14-64\python.exe')
)
$ErrorActionPreference = 'Stop'
if ($ReleaseSigning -and (-not $PSBoundParameters.ContainsKey('InputApk') -or [string]::IsNullOrWhiteSpace($InputApk))) {
    throw 'Release build requires an explicitly selected original APK (-InputApk).'
}
$project = Split-Path -Parent $PSScriptRoot
$stateRoot = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.local\state\rayneo-paseo'))
$build = [IO.Path]::GetFullPath($OutputDirectory)
if (-not $build.StartsWith($stateRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Build output must stay inside the project state directory' }
if ((Test-Path -LiteralPath $build) -and @(Get-ChildItem -LiteralPath $build -Force).Count -gt 0) { throw 'Build output is not empty; use a fresh output directory' }
if ($ReleaseSigning) {
    try { $null = & node (Join-Path $PSScriptRoot 'prepare-release-signing.mjs') '--check' 2>$null }
    catch { throw 'Release signing is not ready; the test signing key will not be used.' }
    if ($LASTEXITCODE -ne 0) { throw 'Release signing is not ready; the test signing key will not be used.' }
}
$profileJson = & node (Join-Path $PSScriptRoot 'host-profile.mjs') $InputApk
if ($LASTEXITCODE -ne 0) { throw 'Original APK checksum mismatch' }
$profile = $profileJson | ConvertFrom-Json
if ($PromptDisplayTrial -and $profile.versionName -ne '1.0.6') { throw 'Display trial is only supported on the pinned 1.0.6 host' }
if (-not (Test-Path -LiteralPath $PythonExecutable -PathType Leaf)) { throw 'Python executable not found; set -PythonExecutable' }
$sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$tools = Join-Path $sdk 'build-tools\36.0.0'
$androidJar = Join-Path $sdk 'platforms\android-36\android.jar'
$apktool = Join-Path $stateRoot 'build-tools\apktool_2.12.1.jar'
if ((Get-FileHash -LiteralPath $apktool -Algorithm SHA256).Hash.ToLowerInvariant() -ne '66cf4524a4a45a7f56567d08b2c9b6ec237bcdd78cee69fd4a59c8a0243aeafa') { throw 'Apktool checksum mismatch' }
function Invoke-Checked([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Build step failed: $Program" }
}
Push-Location -LiteralPath $project
$oldPassword = $env:RAYNEO_PASEO_BUILD_PASSWORD
try {
    Invoke-Checked 'node' @('scripts/prepare-local.mjs')
    Invoke-Checked 'node' @('scripts/prepare-android-deps.mjs')
    $zxing = Join-Path $stateRoot 'build-tools\zxing-core-3.5.3.jar'
    $secretRoot = Join-Path $env:USERPROFILE '.local-secrets\rayneo-paseo'
    $settings = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $secretRoot 'local-test.json') | ConvertFrom-Json
    $signingKey = Join-Path $secretRoot 'apk-signing.p12'
    $signingAlias = 'local-apk'
    $env:RAYNEO_PASEO_BUILD_PASSWORD = $settings.password
    if ($ReleaseSigning) {
        $releaseRoot = Join-Path $secretRoot 'release-signing'
        $releaseSettings = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $releaseRoot 'settings.json') | ConvertFrom-Json
        $signingKey = Join-Path $releaseRoot 'signing.p12'
        $signingAlias = $releaseSettings.alias
        $env:RAYNEO_PASEO_BUILD_PASSWORD = $releaseSettings.password
    }
    $hostDir = Join-Path $build ('host-' + $profile.versionCode)
    $classes = Join-Path $build 'addon-classes'
    $dex = Join-Path $build 'addon-dex'
    New-Item -ItemType Directory -Path $build,$classes,$dex -Force | Out-Null
    $bindings = Join-Path $build 'generated-src\cn\yilu\rayneopaseo\HostBindings.java'
    $generatedProfile = & node 'scripts/host-profile.mjs' $InputApk '--java-output' $bindings
    if ($LASTEXITCODE -ne 0 -or $generatedProfile -ne $profileJson) { throw 'Host profile generation failed' }
    Invoke-Checked 'java' @('-jar',$apktool,'d','--no-res','--output',$hostDir,$InputApk)
    $patchArgs = @('scripts/patch-host.mjs',$hostDir,$InputApk)
    if ($PromptDisplayTrial) { $patchArgs += '--prompt-display-trial' }
    Invoke-Checked 'node' $patchArgs
    if ((Test-Path -LiteralPath (Join-Path $hostDir '.paseo-prompt-display-trial')) -ne [bool]$PromptDisplayTrial) {
        throw 'Build flavor changed; use a fresh output directory'
    }
    $sources = @(Get-ChildItem -LiteralPath (Join-Path $project 'android-addon\src\cn\yilu\rayneopaseo') -Filter '*.java' | ForEach-Object FullName)
    $sources += $bindings
    if ($PromptDisplayTrial) {
        $sources += @(Get-ChildItem -LiteralPath (Join-Path $project 'experiments\prompt-display\src\cn\yilu\rayneopaseo') -Filter '*.java' | ForEach-Object FullName)
    }
    Invoke-Checked 'javac' (@('-encoding','UTF-8','-source','8','-target','8','-classpath',($androidJar + ';' + $zxing),'-d',$classes) + $sources)
    $addonJar = Join-Path $build 'probe-addon.jar'
    Invoke-Checked 'jar' @('--create','--file',$addonJar,'-C',$classes,'.')
    Invoke-Checked 'java' @('-cp',(Join-Path $tools 'lib\d8.jar'),'com.android.tools.r8.D8','--lib',$androidJar,'--min-api','29','--output',$dex,$addonJar,$zxing)
    $assembled = Join-Path $build 'host-rebuilt.apk'
    Invoke-Checked 'java' @('-jar',$apktool,'b',$hostDir,'-o',$assembled)
    $unsigned = Join-Path $build 'rayneo-paseo-voice-probe-unsigned.apk'
    $assembleArgs = @('scripts/assemble-apk.py',$InputApk,$assembled,(Join-Path $dex 'classes.dex'),(Join-Path $secretRoot 'local.cer'),$unsigned)
    if ($ReleaseSigning) { $assembleArgs += '--wireless-only' }
    Invoke-Checked $PythonExecutable $assembleArgs
    $aligned = Join-Path $build 'rayneo-paseo-voice-probe-aligned.apk'
    Invoke-Checked (Join-Path $tools 'zipalign.exe') @('-f','-P','16','4',$unsigned,$aligned)
    $signed = Join-Path $build ('rayneo-paseo-voice-probe-' + $profile.versionName + '.apk')
    Invoke-Checked 'java' @('-jar',(Join-Path $tools 'lib\apksigner.jar'),'sign','--ks',$signingKey,'--ks-key-alias',$signingAlias,'--ks-pass','env:RAYNEO_PASEO_BUILD_PASSWORD','--key-pass','env:RAYNEO_PASEO_BUILD_PASSWORD','--v4-signing-enabled','false','--out',$signed,$aligned)
    Invoke-Checked 'java' @('-jar',(Join-Path $tools 'lib\apksigner.jar'),'verify','--verbose',$signed)
    Invoke-Checked (Join-Path $tools 'zipalign.exe') @('-c','-P','16','4',$signed)
    $artifactHash = (Get-FileHash -LiteralPath $signed -Algorithm SHA256).Hash.ToLowerInvariant()
    $cleanup = $null
    try {
        $cleanupScript = Join-Path $PSScriptRoot 'build-cleanup.ps1'
        $registrationJson = & $cleanupScript -Mode Register -BuildDirectory $build -Artifact $signed -HostVersionCode $profile.versionCode
        $previewJson = & $cleanupScript -Mode Preview
        $preview = $previewJson | ConvertFrom-Json
        $command = $null
        if (@($preview.candidates).Count -gt 0) {
            $command = 'powershell.exe -NoProfile -File "' + $cleanupScript + '" -Mode Apply -PlanId ' + $preview.planId
            Write-Warning 'Earlier build intermediates are available. Review cleanup.candidates and ask for confirmation before running cleanup.confirm_then_run.'
        }
        $cleanup = [pscustomobject]@{requires_confirmation=(@($preview.candidates).Count -gt 0); candidates=@($preview.candidates); confirm_then_run=$command}
    } catch {
        $cleanup = [pscustomobject]@{error=$_.Exception.Message; confirm_then_run=$null}
    }
    [pscustomobject]@{artifact=$signed; sha256=$artifactHash; host_version=$profile.versionName; host_version_code=$profile.versionCode; prompt_display_trial=[bool]$PromptDisplayTrial; installed=$false; firmware_written=$false; cleanup=$cleanup} | ConvertTo-Json -Depth 12
} finally {
    $env:RAYNEO_PASEO_BUILD_PASSWORD = $oldPassword
    Pop-Location
}
