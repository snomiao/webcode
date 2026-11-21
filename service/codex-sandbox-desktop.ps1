# Opt-in compatibility for Codex's cross-user runner in a Windows service
# session. This only changes the noninteractive window station and desktop;
# filesystem and network sandbox policies are untouched.
param(
  [Parameter(Mandatory = $true)][string]$BackupDirectory,
  [switch]$Restore
)

$ErrorActionPreference = "Stop"
if ([Diagnostics.Process]::GetCurrentProcess().SessionId -ne 0) { return }
$sandboxGroup = Get-LocalGroup -Name CodexSandboxUsers -ErrorAction SilentlyContinue
if (-not $sandboxGroup) { return }

if (-not ("WebcodeSandboxDesktop" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class WebcodeSandboxDesktop {
  [DllImport("user32.dll")] public static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint threadId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, int size, out int needed);
  [DllImport("user32.dll", SetLastError = true)]
  static extern bool GetUserObjectSecurity(IntPtr handle, ref uint flags, byte[] data, uint size, out uint needed);
  [DllImport("user32.dll", SetLastError = true)]
  static extern bool SetUserObjectSecurity(IntPtr handle, ref uint flags, byte[] data);
  public static string Name(IntPtr handle) {
    var name = new StringBuilder(512); int needed;
    if (!GetUserObjectInformation(handle, 2, name, name.Capacity * 2, out needed))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    return name.ToString();
  }
  public static byte[] Read(IntPtr handle) {
    uint flags = 4, needed;
    GetUserObjectSecurity(handle, ref flags, null, 0, out needed);
    var data = new byte[needed];
    if (!GetUserObjectSecurity(handle, ref flags, data, needed, out needed))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    return data;
  }
  public static void Write(IntPtr handle, byte[] data) {
    uint flags = 4;
    if (!SetUserObjectSecurity(handle, ref flags, data))
      throw new Win32Exception(Marshal.GetLastWin32Error());
  }
}
"@
}

$station = [WebcodeSandboxDesktop]::GetProcessWindowStation()
$stationName = [WebcodeSandboxDesktop]::Name($station)
if ($stationName -notlike 'Service-0x0-*') {
  throw "Refusing to change a window station that is not a service station."
}
$desktop = [WebcodeSandboxDesktop]::GetThreadDesktop([WebcodeSandboxDesktop]::GetCurrentThreadId())
$desktopName = [WebcodeSandboxDesktop]::Name($desktop)
$handles = @($station, $desktop)
# Participant access excludes DELETE, WRITE_DAC, and WRITE_OWNER.
$masks = @(0x0002037f, 0x000201ff)
$descriptors = @($handles | ForEach-Object {
  New-Object Security.AccessControl.RawSecurityDescriptor([WebcodeSandboxDesktop]::Read($_), 0)
})
New-Item -ItemType Directory -Force -Path $BackupDirectory | Out-Null
$backup = Join-Path $BackupDirectory "codex-desktop-$stationName.json"
if ($Restore) {
  $saved = Get-Content -LiteralPath $backup -Raw | ConvertFrom-Json
  if ($saved.station -ne $stationName -or $saved.desktop -ne $desktopName) {
    throw "Desktop changed; refusing to restore another desktop's access rules."
  }
  $descriptors = @($saved.sddl | ForEach-Object { New-Object Security.AccessControl.RawSecurityDescriptor($_) })
} else {
  if (-not (Test-Path -LiteralPath $backup)) {
    @{
      station = $stationName
      desktop = $desktopName
      sddl = @($descriptors | ForEach-Object { $_.GetSddlForm([Security.AccessControl.AccessControlSections]::Access) })
    } | ConvertTo-Json | Set-Content -LiteralPath $backup -Encoding utf8
  }
  for ($i = 0; $i -lt $handles.Count; $i++) {
    $acl = $descriptors[$i].DiscretionaryAcl
    if ($null -eq $acl) { throw "Refusing to replace an unrestricted desktop ACL." }
    $present = @($acl | Where-Object {
      $_ -is [Security.AccessControl.CommonAce] -and
      $_.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed -and
      $_.SecurityIdentifier -eq $sandboxGroup.SID -and
      ($_.AccessMask -band $masks[$i]) -eq $masks[$i]
    }).Count -gt 0
    if (-not $present) {
      $ace = New-Object Security.AccessControl.CommonAce(
        [Security.AccessControl.AceFlags]::None,
        [Security.AccessControl.AceQualifier]::AccessAllowed,
        $masks[$i], $sandboxGroup.SID, $false, $null)
      $acl.InsertAce($acl.Count, $ace)
    }
  }
}
for ($i = 0; $i -lt $handles.Count; $i++) {
  $data = New-Object byte[] $descriptors[$i].BinaryLength
  $descriptors[$i].GetBinaryForm($data, 0)
  [WebcodeSandboxDesktop]::Write($handles[$i], $data)
}
Write-Output "Codex service desktop access $(if ($Restore) { 'restored' } else { 'ready' }): $stationName\$desktopName"
