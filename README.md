# webcode

Open a GitHub repository in local browser VS Code or a web terminal:

```text
https://webcode.localhost/github.com/<owner>/<repo>/tree/<branch>
https://webcode.localhost/github.com/<owner>/<repo>/tree/<branch>?ui=wtx
```

webcode provisions the matching checkout under
`~/ws/<owner>/<repo>/tree/<branch>`, then opens it in VS Code Web. Existing
worktrees are fetched and only fast-forwarded when clean. Missing worktrees are
cloned with submodules and their dependencies are installed automatically.
Populated folders without Git metadata offer “Back up and provision again”.
Recovery moves the original folder into a unique sibling backup directory, then
clones a fresh checkout. The backup is retained even if cloning fails.

Everything shares one HTTPS origin through
[portless](https://github.com/vercel-labs/portless). Vite serves the shell and
proxies VS Code Web and [wtx](https://github.com/snomiao/wtx), including their
WebSockets.

## Requirements

- [Bun](https://bun.sh/)
- [portless](https://github.com/vercel-labs/portless)
- VS Code's `code` CLI on `PATH`

## Run

```sh
git clone --recurse-submodules https://github.com/snomiao/webcode
cd webcode
bun install
bun run start
```

On first use, portless creates and trusts a local CA. The app is then available
at `https://webcode.localhost`.

`start` builds the shell once and serves the bundle (`vite preview`), so
editing this checkout never reloads open tabs; restart to pick up changes.
When working on webcode itself, `bun run dev` runs the vite dev server with
HMR instead.

To use the shell directly without portless:

```sh
bun run dev:direct
```

This exposes the Vite shell at `http://localhost:3001`.

## Run at boot and CLI

`bun link` puts a `webcode` command on your PATH:

```sh
webcode service install     # register it to run at boot, start it, print the URLs
webcode service start       # start it; waits until it answers, then prints the URLs
webcode service status      # service state + live local / portless / Tailscale URLs
webcode service stop        # stop it, including vite, VS Code and the terminals
webcode service uninstall
```

(`webcode serve …` is an alias.) `install` runs `start.ts` on a fixed port
(4390) with `WEBCODE_BASE_PATH=/webcode` and `TAILSCALE_SERVE=1`; override with
`--port <n>`, `--terminal-ws-port <n>`, `--base <path>` or `--no-tailscale`.
Logs go to `.logs/webcode.log`. `status` reads URLs from what's actually
running, so it also works for a manual `bun run dev`.

The service is platform-specific (adapters in `service/`):

- **Linux** (`service/systemd.ts`): a systemd *user* unit,
  `~/.config/systemd/user/webcode.service`, so it runs as you and start/stop
  need no sudo. `install` enables lingering so it starts at boot without a
  login (if that needs root: `sudo loginctl enable-linger $USER`), and
  captures your current `PATH` so `bun` and the `code` CLI resolve. For the
  Tailscale route, make yourself operator once:
  `sudo tailscale set --operator=$USER`. `KillMode=control-group` makes
  `stop` end the whole tree; `Restart=always` brings it back after a crash.
- **Windows** (`service/windows.ts`): a scheduled task at boot, as you (S4U
  logon, so no stored password, one UAC click to install), via `serve.ps1`
  behind a static `portless alias`. The launcher sits in a kill-on-close job
  object, so `stop` ends the whole tree. The task doesn't start the portless
  proxy, because a proxy in the task's session would drop your desktop apps'
  routes; `webcode.localhost` works whenever your desktop's portless proxy
  runs, and the Tailscale URL needs no proxy.
- **macOS**: not yet; a launchd adapter would implement the same
  `ServiceAdapter` interface (`service/types.ts`).

## URL and provisioning

The canonical path is:

```text
/github.com/<owner>/<repo>/tree/<branch>
```

For compatibility, `/<owner>/<repo>/tree/<branch>` is also accepted. Branch
names may contain slashes.

The provisioning API is:

```text
GET  /api/repo/<owner>/<repo>/tree/<branch>
POST /api/repo/<owner>/<repo>/tree/<branch>?create=1
```

Local changes are never overwritten. An existing checkout is pulled only when
it is clean, has an upstream, is behind, and is not ahead; otherwise webcode
fetches and leaves integration to you.

By default (`?ui=both`) the page shows a PTY-backed web terminal on the left
and VS Code on the right, split by a draggable divider (double-click resets it;
the position is remembered per browser). Use `?ui=vscode` for VS Code only or
`?ui=wtx` for the terminal only.

## Tailscale prefix

Start Webcode with a matching base path and allow only your machine’s hostname:

```sh
export WEBCODE_BASE_PATH=/webcode
export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS="$(tailscale status --json | bun -e 'console.log((await Bun.stdin.json()).Self.DNSName.replace(/\.$/, ""))')"
bun run dev:direct
```

In another terminal, add the private route without replacing other apps:

```sh
tailscale serve --bg --https=443 --set-path=/webcode http://127.0.0.1:3001/webcode
```

Open `https://<machine>.<tailnet>.ts.net/webcode/`, optionally followed by
`github.com/<owner>/<repo>/tree/<branch>` or `?ui=wtx`.
The proxy target includes `/webcode` to restore the prefix stripped by Serve.
`WEBCODE_BASE_PATH` defaults to `/` for local use. The Serve route persists;
keep the Webcode process running separately.

Alternatively, set `TAILSCALE_SERVE=1`: `start.ts` then allows the machine's
tailnet hostname, registers the same route itself on every launch, and removes
it on shutdown.
