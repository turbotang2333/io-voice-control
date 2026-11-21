param([string]$FixtureRoot, [string]$ProjectRoot)
$ErrorActionPreference = 'Stop'
$env:USERPROFILE = $FixtureRoot
$env:LOCALAPPDATA = Join-Path $FixtureRoot 'local-appdata'
$root = Join-Path $FixtureRoot '.local\state\rayneo-paseo'
$secret = Join-Path $FixtureRoot '.local-secrets\rayneo-paseo'
$sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$tools = Join-Path $sdk 'build-tools\36.0.0'
New-Item -ItemType Directory -Force -Path $root,$secret,$tools,(Join-Path $root 'build-tools') | Out-Null
'{"password":"fixture"}' | Set-Content -LiteralPath (Join-Path $secret 'local-test.json') -Encoding UTF8
Add-Type -TypeDefinition 'public static class FixtureExecutable { public static int Main(string[] args) { return 0; } }' -OutputAssembly (Join-Path $FixtureRoot 'fixture.exe') -OutputType ConsoleApplication
Copy-Item -LiteralPath (Join-Path $FixtureRoot 'fixture.exe') -Destination (Join-Path $tools 'zipalign.exe')
function Get-FileHash { param([string]$LiteralPath,[string]$Algorithm) return [pscustomobject]@{Hash='66cf4524a4a45a7f56567d08b2c9b6ec237bcdd78cee69fd4a59c8a0243aeafa'} }
function node {
    $global:LASTEXITCODE = 0
    if ($args[0] -like '*host-profile.mjs') { return '{"versionName":"1.0.10","versionCode":258}' }
}
function javac { $global:LASTEXITCODE = 0 }
function jar { $global:LASTEXITCODE = 0 }
function java {
    $global:LASTEXITCODE = 0
    $values = @($args)
    if ($values -contains '--output' -and $values -contains 'd') {
        $path = $values[([array]::IndexOf($values, '--output') + 1)]
        New-Item -ItemType Directory -Path $path -Force | Out-Null
        'fixture' | Set-Content -LiteralPath (Join-Path $path 'decoded.txt')
    }
    if ($values -contains '--out') {
        $path = $values[([array]::IndexOf($values, '--out') + 1)]
        'signed fixture' | Set-Content -LiteralPath $path
    }
}
$results = @()
foreach ($name in @('one','two','three')) {
    $out = Join-Path $root $name
    $json = & (Join-Path $ProjectRoot 'scripts\build-android.ps1') -InputApk (Join-Path $FixtureRoot 'input.apk') -OutputDirectory $out -PythonExecutable (Join-Path $FixtureRoot 'fixture.exe')
    $results += ($json | ConvertFrom-Json)
}
$results[-1] | ConvertTo-Json -Depth 12 -Compress
