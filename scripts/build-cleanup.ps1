param(
    [Parameter(Mandatory=$true)][ValidateSet('Register','Preview','Apply')][string]$Mode,
    [string]$StateRoot = (Join-Path $env:USERPROFILE '.local\state\rayneo-paseo'),
    [string]$BuildDirectory,
    [string]$Artifact,
    [int]$HostVersionCode,
    [string]$PlanId
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$projectRoot = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.local\state\rayneo-paseo')).TrimEnd('\')
$root = [IO.Path]::GetFullPath($StateRoot).TrimEnd('\')
if ($root -ne $projectRoot -and -not $root.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'State root outside project state.' }
function Assert-SafePath([string]$path) {
    $path = [IO.Path]::GetFullPath($path).TrimEnd('\')
    if ($path -ne $root -and -not $path.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Path outside state root.' }
    $part = $path
    while ($part) {
        if (([IO.File]::GetAttributes($part) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Link in path.' }
        $part = [IO.Path]::GetDirectoryName($part)
    }
    return $path
}
Assert-SafePath $root | Out-Null
$registry = Join-Path $root 'build-history'
$receipts = Join-Path $root 'build-cleanup-receipts'
function Assert-NotReserved([string]$path) {
    foreach ($reserved in @($registry,$receipts)) {
        if ($path -eq $reserved -or $path.StartsWith($reserved + '\', [StringComparison]::OrdinalIgnoreCase) -or $reserved.StartsWith($path + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Build directory overlaps cleanup records.' }
    }
}
if ($Mode -eq 'Register') {
    $directory = Assert-SafePath $BuildDirectory
    if ($directory -eq $root -or $HostVersionCode -le 0) { throw 'Invalid build directory or host version.' }
    Assert-NotReserved $directory
    $apk = Assert-SafePath $Artifact
    if ([IO.Path]::GetDirectoryName($apk) -ne $directory -or -not (Test-Path -LiteralPath $apk -PathType Leaf)) { throw 'Final artifact must be a file directly in the build directory.' }
    if ([IO.Path]::GetFileName($apk) -in @('host-rebuilt.apk','rayneo-paseo-voice-probe-unsigned.apk','rayneo-paseo-voice-probe-aligned.apk')) { throw 'Intermediate file is not a final artifact.' }
    New-Item -ItemType Directory -Path $registry -Force | Out-Null
    Assert-SafePath $registry | Out-Null
    foreach ($entry in @(Get-ChildItem -LiteralPath $registry -Filter '*.json' -File)) {
        $old = Get-Content -LiteralPath $entry.FullName -Encoding UTF8 -Raw | ConvertFrom-Json
        if ($old.buildDirectory -eq $directory -or $directory.StartsWith($old.buildDirectory + '\', [StringComparison]::OrdinalIgnoreCase) -or $old.buildDirectory.StartsWith($directory + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Build directory overlaps an existing record.' }
    }
    $apkFile = Get-Item -LiteralPath $apk
    $record = [ordered]@{version=1; id=[guid]::NewGuid().ToString('N'); completedTicks=[DateTime]::UtcNow.Ticks.ToString(); buildDirectory=$directory; artifact=$apk; artifactLength=$apkFile.Length; artifactModifiedTicks=$apkFile.LastWriteTimeUtc.Ticks.ToString(); artifactSha256=(Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant(); hostVersionCode=$HostVersionCode}
    $record | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $registry ($record.id + '.json')) -Encoding UTF8
    $record | ConvertTo-Json -Depth 4 -Compress
    exit 0
}
if (-not ('BuildCleanupSnapshot' -as [type])) { Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Security.Cryptography;
using System.Collections.Generic;
public static class BuildCleanupSnapshot {
  public static string Inspect(string path) {
    var lines = new List<string>(); var stack = new Stack<FileSystemInfo>();
    var full = @"\\?\" + path; var info = File.GetAttributes(full);
    stack.Push((info & FileAttributes.Directory) != 0 ? (FileSystemInfo)new DirectoryInfo(full) : new FileInfo(full));
    long bytes = 0;
    while (stack.Count > 0) {
      var item = stack.Pop(); var attr = item.Attributes;
      if ((attr & FileAttributes.ReparsePoint) != 0) throw new IOException("Link refused");
      if (item.Name == ".local-secrets") throw new IOException("Private subtree refused");
      long length = 0;
      if ((attr & FileAttributes.Directory) != 0) {
        foreach (var child in ((DirectoryInfo)item).EnumerateFileSystemInfos()) stack.Push(child);
      } else { length = ((FileInfo)item).Length; bytes += length; }
      lines.Add(item.FullName + "\0" + (int)attr + "\0" + length + "\0" + item.LastWriteTimeUtc.Ticks);
    }
    lines.Sort(StringComparer.Ordinal);
    using (var hash = SHA256.Create()) {
      var digest = hash.ComputeHash(Encoding.UTF8.GetBytes(String.Join("\n", lines)));
      return bytes + ":" + BitConverter.ToString(digest).Replace("-", "").ToLowerInvariant();
    }
  }
}
'@
}
function Get-Preview {
    $records = @()
    if (Test-Path -LiteralPath $registry) {
        Assert-SafePath $registry | Out-Null
        foreach ($file in @(Get-ChildItem -LiteralPath $registry -File -Filter '*.json')) {
            Assert-SafePath $file.FullName | Out-Null
            $record = Get-Content -LiteralPath $file.FullName -Encoding UTF8 -Raw | ConvertFrom-Json
            if ($record.version -ne 1 -or $record.id -notmatch '^[0-9a-f]{32}$' -or $file.BaseName -ne $record.id -or $record.completedTicks -notmatch '^\d+$' -or "$($record.hostVersionCode)" -notmatch '^[1-9][0-9]{0,8}$') { throw 'Invalid build record.' }
            $directory = Assert-SafePath $record.buildDirectory
            Assert-NotReserved $directory
            $apk = Assert-SafePath $record.artifact
            if ($directory -eq $root -or [IO.Path]::GetDirectoryName($apk) -ne $directory) { throw 'Invalid registered paths.' }
            if ([IO.Path]::GetFileName($apk) -in @('host-rebuilt.apk','rayneo-paseo-voice-probe-unsigned.apk','rayneo-paseo-voice-probe-aligned.apk')) { throw 'Intermediate file is not a final artifact.' }
            $artifactFile = Get-Item -LiteralPath $apk
            if ($artifactFile.PSIsContainer -or $artifactFile.Length -ne $record.artifactLength -or $artifactFile.LastWriteTimeUtc.Ticks.ToString() -ne $record.artifactModifiedTicks) { throw 'Final artifact missing or changed.' }
            $records += $record
        }
    }
    $records = @($records | Sort-Object @{Expression={ [long]$_.completedTicks }; Descending=$true}, @{Expression='id'; Descending=$true})
    for ($i=0; $i -lt $records.Count; $i++) {
        for ($j=$i+1; $j -lt $records.Count; $j++) {
            $a=$records[$i].buildDirectory; $b=$records[$j].buildDirectory
            if ($a -eq $b -or $a.StartsWith($b + '\', [StringComparison]::OrdinalIgnoreCase) -or $b.StartsWith($a + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Overlapping build records.' }
        }
    }
    $candidates = @()
    if ($records.Count -gt 2) {
        foreach ($record in $records | Select-Object -Skip 2) {
            $directory = $record.buildDirectory
            $names = @(('host-' + $record.hostVersionCode),'addon-classes','addon-dex','generated-src','probe-addon.jar','host-rebuilt.apk','rayneo-paseo-voice-probe-unsigned.apk','rayneo-paseo-voice-probe-aligned.apk')
            $targets = @(); [long]$total = 0
            foreach ($name in $names) {
                $target = Join-Path $directory $name
                if (-not (Test-Path -LiteralPath $target)) { continue }
                Assert-SafePath $target | Out-Null
                $isDirectory = (Get-Item -LiteralPath $target).PSIsContainer
                $expectedDirectory = $name -in @(('host-' + $record.hostVersionCode),'addon-classes','addon-dex','generated-src')
                if ($isDirectory -ne $expectedDirectory -or $target -eq $record.artifact) { throw 'Unexpected candidate type or artifact overlap.' }
                $snapshot = [BuildCleanupSnapshot]::Inspect($target).Split(':')
                $targets += [ordered]@{path=$target; bytes=[long]$snapshot[0]; fingerprint=$snapshot[1]}
                $total += [long]$snapshot[0]
            }
            if ($targets.Count) { $candidates += [ordered]@{buildDirectory=$directory; buildId=$record.id; bytes=$total; targets=@($targets)} }
        }
    }
    $payload = [ordered]@{version=1; records=@($records | ForEach-Object { $_.id }); candidates=@($candidates)}
    $content = $payload | ConvertTo-Json -Depth 12 -Compress
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($content))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
    return [ordered]@{planId=$hash; candidates=@($candidates)}
}
$preview = Get-Preview
if ($Mode -eq 'Preview') { $preview | ConvertTo-Json -Depth 12 -Compress; exit 0 }
if ($PlanId -notmatch '^[0-9a-f]{64}$' -or $PlanId -ne $preview.planId) { throw 'Reviewed plan missing or changed; preview again.' }
if ($preview.candidates.Count -eq 0) { throw 'No candidates to clean.' }
$processes = @(Get-CimInstance Win32_Process)
foreach ($candidate in $preview.candidates) {
    foreach ($process in $processes) {
        if ($process.ProcessId -ne $PID -and $process.CommandLine -and $process.CommandLine.IndexOf($candidate.buildDirectory, [StringComparison]::OrdinalIgnoreCase) -ge 0) { throw 'Build directory is referenced by a running process.' }
    }
}
New-Item -ItemType Directory -Path $receipts -Force | Out-Null
Assert-SafePath $receipts | Out-Null
$receipt = Join-Path $receipts (([guid]::NewGuid().ToString('N')) + '.jsonl')
$deleted = 0; [long]$bytes = 0
foreach ($candidate in $preview.candidates) {
    foreach ($target in $candidate.targets) {
        $path = Assert-SafePath $target.path
        if ([BuildCleanupSnapshot]::Inspect($path) -ne ($target.bytes.ToString() + ':' + $target.fingerprint)) { throw 'Candidate changed after preview.' }
        $item = Get-Item -LiteralPath $path
        if ($item.PSIsContainer) { Remove-Item -LiteralPath ('\\?\' + $path) -Recurse -Force -ErrorAction Stop }
        else { Remove-Item -LiteralPath $path -Force -ErrorAction Stop }
        if (Test-Path -LiteralPath $path) { throw 'Candidate was not removed.' }
        $deleted++; $bytes += $target.bytes
        [ordered]@{planId=$PlanId; removedAt=[DateTime]::UtcNow.ToString('o'); path=$path; bytes=$target.bytes} | ConvertTo-Json -Compress | Add-Content -LiteralPath $receipt -Encoding UTF8
    }
}
[ordered]@{deletedTargets=$deleted; deletedBytes=$bytes; receipt=$receipt} | ConvertTo-Json -Compress
