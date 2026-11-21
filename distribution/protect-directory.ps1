param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($Directory)
if (-not [IO.Path]::IsPathRooted($Directory) -or -not (Test-Path -LiteralPath $target -PathType Container)) { throw 'A new absolute private directory is required.' }
$item = Get-Item -LiteralPath $target -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or @(Get-ChildItem -LiteralPath $target -Force).Count -ne 0) { throw 'Only a new empty private directory can be protected.' }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($user)
$acl.SetAccessRuleProtection($true, $false)
$inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
foreach ($identity in @($user, $system)) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $null = $acl.AddAccessRule($rule)
}
[IO.Directory]::SetAccessControl($target, $acl)
$actual = Get-Acl -LiteralPath $target
if (-not $actual.AreAccessRulesProtected) { throw 'Private directory still inherits permissions.' }
foreach ($rule in $actual.Access) {
    $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($rule.AccessControlType -eq 'Allow' -and $sid -notin @($user.Value, $system.Value)) { throw 'Unexpected access to private directory.' }
}
Write-Output '{"newPrivateDirectoryProtected":true,"existingConfigurationChanged":false,"administratorRequired":false}'
