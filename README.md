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
bun run dev
```

On first use, portless creates and trusts a local CA. The app is then available
at `https://webcode.localhost`.

To use the shell directly without portless:

```sh
bun run dev:direct
```

This exposes the Vite shell at `http://localhost:3001`.

## Tailscale Serve

Install the CLI locally (for development, `bun link`), then configure a
persistent HTTPS mount on this machine's Tailscale name:

```sh
webcode setup --tailscale
webcode
```

The first command saves the base path in `~/.config/webcode/config.json` and
configures Tailscale Serve in the background. The second starts Webcode with
all browser, API, WebSocket, terminal, and VS Code Server routes below:

```text
https://<machine>.<tailnet>.ts.net/webcode/
```

Use a different mount or local port when needed:

```sh
webcode setup --tailscale --path /code --port 3101
```

Other services can share the same hostname at other paths:

```sh
tailscale serve --bg --https=443 --set-path=/docs http://127.0.0.1:4000/docs
tailscale serve status
```

On macOS, Webcode also discovers the CLI embedded in a standard
`/Applications/Tailscale.app` installation. For other installation locations,
put `tailscale` on `PATH` before running setup.

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

Append `?ui=wtx` for a PTY-backed web terminal in the same worktree.
