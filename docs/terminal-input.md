# Terminal input ownership

The browser emits VT input. WTx transports it to the outer PTY. An agent-yes
wrapper creates an inner ConPTY for the native Windows application.

- **agent-yes** owns that nested PTY boundary. It consumes the inner ConPTY's
  private `DECSET/DECRST 9001` negotiation before forwarding output. Forwarding
  it to the outer console causes arrow, paste, and mouse sequences to arrive
  at the native app as literal characters. Its Rust runner also restores the
  console mode captured before entering raw mode.
- **WTx/webcode** owns browser connections and history replay. Replay is marked
  with `replay-start`/`replay-end`. The browser suppresses generated replies and
  waits for xterm's write queue to drain before accepting input again. Browser
  theme changes update colors without sending unsolicited control bytes.

The earlier mouse-disable UI and Bash prompt-reset workarounds were removed.
Mouse, navigation keys, and bracketed paste remain application-controlled.

## Verify

From webcode:

```powershell
bun test ./lib/wtx/src/replay.test.ts ./lib/wtx/src/replay-server.test.ts
bun run typecheck
bun run build
```

From agent-yes on Windows, after rebuilding:

```powershell
bun test tests/windows-conpty.bun.spec.ts
```

That test compares actual Windows keyboard/mouse records through direct and
wrapped PTYs, for both installed Rust and built TypeScript runtimes. It also
compares the outer console's before/after mode. The pre-fix Rust executable
fails the same test. See agent-yes's `docs/windows-terminal-input.md`.

A running wrapper keeps its old executable until it exits. New launches use
the rebuilt version. The WTx backend must restart to emit replay markers;
the updated browser remains compatible with older backends in the meantime.
