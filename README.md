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

## Run at boot (Windows) and CLI

`bun link` puts a `webcode` command on your PATH:

```sh
webcode serve install     # register the boot-time task (one UAC click, no password)
webcode serve start       # start it; waits until it answers, then prints the URLs
webcode serve status      # task state + live portless / Tailscale URLs
webcode serve stop        # stop it, including vite, VS Code and the terminals
webcode serve uninstall
```

webcode runs as a scheduled task at boot, as you (S4U logon, so no stored
password), via `serve.ps1`: `start.ts` on a fixed port (4390) behind a static
`portless alias`, with `WEBCODE_BASE_PATH=/webcode` and `TAILSCALE_SERVE=1` (change
them in `install-windows-service.ps1`). Logs go to `.logs/webcode.log`. The
launcher sits in a kill-on-close job object, so `stop` ends the whole tree.

The task doesn't start the portless proxy, because a proxy in the task's
session would drop your desktop apps' routes. `webcode.localhost` works
whenever your desktop's portless proxy runs; the Tailscale URL needs no proxy.
`status` reads URLs from what's actually running, so it also works for a
manual `bun run dev`.

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
