# Launcher for the `webcode` scheduled task (see install-windows-service.ps1).
# Runs start.ts on a fixed port behind a static portless alias, logging to
# .logs\webcode.log. `webcode service stop` ends the task; the job object below
# then kills the whole process tree.
#
# Why not `bun run dev` (portless run)? A portless route carries the owning
# PID, and the proxy drops routes whose PID it can't signal. The task runs in
# its own logon session, so a proxy started from your desktop gets EPERM for
# it and treats the route as dead (404). A static alias (pid 0) is always kept.

param(
  [string]$Bun = "bun",
  [int]$Port = 4390,
  [int]$TerminalWsPort = 3014,
  [string]$Base = "/webcode",
  [int]$TailscaleServe = 1
)

# The task has no console, so record launcher failures somewhere visible.
trap {
  "$(Get-Date -Format o) launcher error: $_" |
    Out-File -Append -Encoding utf8 (Join-Path $PSScriptRoot ".logs\launcher-error.log")
  exit 1
}

$repo = $PSScriptRoot
$logDir = Join-Path $repo ".logs"
$log = Join-Path $logDir "webcode.log"
New-Item -ItemType Directory -Force $logDir | Out-Null

# A just-stopped instance can hold the log open for a moment while its job
# tears down; wait for it rather than failing the start.
for ($i = 0; $i -lt 60; $i++) {
  try {
    [IO.File]::Open($log, "OpenOrCreate", "ReadWrite", "None").Dispose()
    break
  } catch {
    Start-Sleep -Milliseconds 500
  }
}

# Keep one previous log instead of growing forever.
if ((Test-Path $log) -and (Get-Item $log).Length -gt 10MB) {
  Move-Item -Force $log "$log.1"
}
Set-Content -Path (Join-Path $logDir "webcode.pid") -Value $PID -Encoding ascii

Set-Location $repo
$portless = Join-Path $repo "node_modules\.bin\portless.exe"
$portlessDir = Join-Path $env:USERPROFILE ".portless"

$env:PORT = "$Port"
$env:HOST = "127.0.0.1"
$env:PORTLESS_URL = "https://webcode.localhost"
$env:NODE_EXTRA_CA_CERTS = Join-Path $portlessDir "ca.pem"
$env:TERMINAL_WS_PORT = "$TerminalWsPort"
$env:WEBCODE_BASE_PATH = $Base
$env:TAILSCALE_SERVE = "$TailscaleServe"

# cmd's redirection writes the child's bytes as-is (PowerShell 5's `>>` would
# re-encode them as UTF-16).
function Log([string]$cmdline) {
  cmd.exe /d /c "$cmdline >> `"$log`" 2>&1"
}

# Deliberately NOT starting the portless proxy here: a proxy running in this
# task's session can't signal desktop-session apps either, so it would drop
# their routes (the same EPERM problem in reverse), and inside the job below
# it would die with every `webcode service stop`. The static alias works with
# whichever proxy your desktop runs; the Tailscale URL needs no proxy at all.

# Put this launcher in a kill-on-close job object. Every child (bun, vite,
# code serve-web, wtx, the shells it spawns) joins the job automatically, so
# when the task is ended (`schtasks /end`, i.e. `webcode service stop`) and this
# process dies, Windows kills the whole tree. Your desktop session can't
# taskkill them itself: the task runs in a separate logon session.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class WebcodeJob {
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long a, b; public uint LimitFlags; public UIntPtr c, d; public uint e; public UIntPtr f; public uint g, h; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC Basic; public IO Io; public UIntPtr i, j, k, l; }
  [DllImport("kernel32.dll")] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr j, int c, ref EXT i, uint l);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  static IntPtr job;
  public static bool Enter() {
    job = CreateJobObject(IntPtr.Zero, null);
    var info = new EXT();
    info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    return SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(EXT)))
      && AssignProcessToJobObject(job, GetCurrentProcess());
  }
}
"@
$inJob = [WebcodeJob]::Enter()

"=== webcode start $(Get-Date -Format o) (pid $PID, port $Port, job $inJob) ===" | Out-File -Append -Encoding ascii $log
# Route webcode.localhost to our fixed port, then run the app.
Log "`"$portless`" alias webcode $Port --force"
Log "`"$Bun`" start.ts"
exit $LASTEXITCODE
