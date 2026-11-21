param([Parameter(Mandatory=$true)][string]$Directory, [string]$Hostname = '')
$ErrorActionPreference = 'Stop'
$publicIp = $null
$isIp = $Hostname -and [Net.IPAddress]::TryParse($Hostname, [ref]$publicIp)
if ($Hostname -and (($isIp -and ($publicIp.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $publicIp.ToString() -ne $Hostname)) -or (-not $isIp -and ($Hostname.Length -gt 253 -or $Hostname -notmatch '^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$')))) { throw 'Invalid public hostname.' }
$target = [IO.Path]::GetFullPath($Directory)
if (-not [IO.Path]::IsPathRooted($Directory) -or -not (Test-Path -LiteralPath $target -PathType Container)) { throw 'A prepared absolute private directory is required.' }
$pfx = Join-Path $target 'server.p12'
$cer = Join-Path $target 'local.cer'
if ((Test-Path -LiteralPath $pfx) -or (Test-Path -LiteralPath $cer)) { throw 'Existing certificates will not be replaced.' }
$password = $env:RAYNEO_INSTALL_PFX_PASSWORD
if ($password -notmatch '^[a-f0-9]{64}$') { throw 'A private installation password is required.' }
$rsa = [System.Security.Cryptography.RSACng]::new(3072)
$certificate = $null
try {
    $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=RayneoConnectorLocal', $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $names = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $names.AddDnsName('localhost'); $names.AddIpAddress([Net.IPAddress]::Loopback)
    if ($isIp) { $names.AddIpAddress($publicIp) } elseif ($Hostname) { $names.AddDnsName($Hostname) }
    $request.CertificateExtensions.Add($names.Build())
    $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
    $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment, $true))
    $usages = [System.Security.Cryptography.OidCollection]::new()
    $null = $usages.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
    $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($usages, $true))
    $certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), [DateTimeOffset]::UtcNow.AddYears(1))
    [IO.File]::WriteAllBytes($pfx, $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $password))
    [IO.File]::WriteAllBytes($cer, $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
    Write-Output '{"certificatePrepared":true,"systemCertificateStoreChanged":false,"administratorRequired":false}'
} finally {
    if ($certificate) { $certificate.Dispose() }
    $rsa.Dispose()
}
