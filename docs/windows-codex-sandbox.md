# Codex sandbox in the Windows service

Webcode's S4U scheduled task runs in Session 0, including the terminals it
creates. Codex 0.170.0 has two startup problems in that environment:

1. Its separate sandbox account cannot access the service window station and
   default desktop. The runner fails with `0xc0000142`, which Codex reports as
   a 15-second `connecting runner pipe-in` timeout.
2. After the runner starts, it creates a private desktop in the service window
   station but launches commands using a hardcoded `Winsta0` path. PowerShell
   then fails with `0xc0000142`.

The repair has two parts. Neither disables the filesystem/network sandbox or
the command's private desktop.

## Runner patch

[The patch](../patches/codex-0.170.0-service-desktop.patch) applies to OpenAI
Codex tag `rust-v0.170.0` (commit
`29eb79e9866b3262a777fdf8195c1b9e63684c91`). It queries the current window
station and includes its name in the private desktop's
[startup path](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/ns-processthreadsapi-startupinfow),
instead of hardcoding an interactive window station.

Apply it to that source version and build the `codex-command-runner` binary
from `codex-rs`:

```powershell
cargo build -p codex-windows-sandbox --bin codex-command-runner --profile dev-small
```

Back up the installed `codex-resources/codex-command-runner.exe` before
replacing it with the built binary. Codex refreshes its cached helper from
that installed source. This is a local compatibility patch, not an official
Codex release. A Codex package update can replace it; verify startup again
after updating rather than applying an old patch to an unknown version.

## Service desktop access

The opt-in `-CodexSandboxDesktop` launcher flag runs
[codex-sandbox-desktop.ps1](../service/codex-sandbox-desktop.ps1) at startup.
The script grants `CodexSandboxUsers` participant access to the current
noninteractive service window station and desktop. It excludes permission
to delete these objects or change their owner/access rules. It refuses to
modify interactive window stations and saves the original access rules in
`.logs/codex-desktop-*.json`.

For a new installation with the repaired runner, pass
`-CodexSandboxDesktop` to `install-windows-service.ps1`. Reinstalling stops
the service and its terminals. For an existing running installation, append
the flag to its scheduled task action without restarting the task, and run
the access script from a terminal inside that service:

```powershell
./service/codex-sandbox-desktop.ps1 -BackupDirectory .logs
```

The operation is idempotent. To undo access changes, run the same command
with `-Restore` in the same service session and remove the launcher flag.
Restore the original runner binary to undo the binary patch.

## Verify from a web terminal

```powershell
codex sandbox --include-managed-config -P :workspace -- powershell.exe -NoProfile -Command "Write-Output sandbox-ok"
```

Expect `sandbox-ok` and exit code 0. Also verify normal Codex command-tool
execution; a successful unsandboxed PowerShell command alone does not prove
this repair works.

The local repair was verified with ordinary and PTY command-tool execution,
PowerShell, Git, and Bun. A window-station/desktop query confirmed that the
command still uses a `CodexSandboxDesktop-*` private desktop in its service
window station. A disposable file test confirmed that workspace writes work
and an attempted write outside the workspace is denied.
