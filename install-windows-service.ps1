# Install webcode to run at boot as the current user, via a scheduled task
# (S4U logon: runs whether or not you're logged in, no stored password).
# Checkouts land in your ~/ws and portless certs / the `code` CLI resolve as
# usual. Only a UAC prompt is needed — `webcode serve install` elevates for you.
#
# Unlike a Windows service running as a user, S4U needs no password. Git/gh
# logins from Windows Credential Manager work in the web terminal while you are
# logged in; before your first login after a reboot they may not.
#
# Manual use, from an elevated PowerShell:
#   powershell -ExecutionPolicy Bypass -File install-windows-service.ps1
#   powershell -ExecutionPolicy Bypass -File install-windows-service.ps1 -Uninstall

param(
  [string]$Name = "webcode",
  # Fixed vite port behind the static `portless alias webcode <port>`.
  [int]$Port = 4390,
  # wtx's default (3004) is often taken by other local tools.
  [int]$TerminalWsPort = 3014,
  # URL prefix; also the Tailscale Serve mount (https://<host>.ts.net/webcode/).
  [string]$Base = "/webcode",
  # Publish on the tailnet via `tailscale serve` (set to 0 to keep it local).
  [int]$TailscaleServe = 1,
  # The user the task runs as; `webcode serve install` passes the unelevated caller.
  [string]$User = "$env:USERDOMAIN\$env:USERNAME",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script from an elevated (Administrator) PowerShell."
}

$repo = $PSScriptRoot

function Stop-Webcode {
  # Ending the task kills the launcher's job (and so its whole tree). Also
  # sweep up processes orphaned by older launchers without the job object:
  # session-0 (task-side, never your desktop apps) webcode processes. The
  # supervisors (`portless webcode …`, `bun start.ts`) go first, or they'd
  # respawn the children as we kill them.
  Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  $userName = $User.Split("\")[-1]
  $mine = Get-CimInstance Win32_Process |
    Where-Object { $_.SessionId -eq 0 -and $_.ProcessId -ne $PID } |
    Where-Object { (Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue).User -eq $userName }
  $supervisors = 'portless(\.exe)?"?\s+webcode\b|\bstart\.ts\b|serve\.ps1'
  $mine | Where-Object { $_.CommandLine -match $supervisors } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep 1
  $pattern = [regex]::Escape($repo)
  $mine | Where-Object { $_.CommandLine -match $pattern } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
  Stop-Webcode
  Unregister-ScheduledTask -TaskName $Name -Confirm:$false
}
if ($Uninstall) {
  & (Join-Path $repo "node_modules\.bin\portless.exe") alias --remove webcode 2>$null | Out-Null
  Write-Host "Removed scheduled task '$Name'."
  return
}

$bun = (Get-Command bun).Source
$launcher = Join-Path $repo "serve.ps1"
$argsLine = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`" " +
  "-Bun `"$bun`" -Port $Port -TerminalWsPort $TerminalWsPort -Base `"$Base`" -TailscaleServe $TailscaleServe"

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argsLine -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited

Register-ScheduledTask -TaskName $Name -Description "webcode: browser VS Code / web terminal (https://webcode.localhost$Base)" `
  -Action $action -Trigger $trigger -Settings $settings -Principal $taskPrincipal | Out-Null

# Let the user start/stop/query the task without elevation, so
# `webcode serve start|stop` works from a normal shell.
$sid = (New-Object Security.Principal.NTAccount($User)).Translate([Security.Principal.SecurityIdentifier]).Value
$svc = New-Object -ComObject Schedule.Service
$svc.Connect()
$task = $svc.GetFolder("\").GetTask($Name)
$task.SetSecurityDescriptor("D:(A;;FA;;;BA)(A;;FA;;;SY)(A;;FA;;;$sid)", 0)

Start-ScheduledTask -TaskName $Name
Get-ScheduledTask -TaskName $Name | Select-Object TaskName, State
Write-Host "Logs: $repo\.logs\webcode.log"
Write-Host "Control it with: webcode serve status|start|stop"
