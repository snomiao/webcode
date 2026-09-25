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
bun run dev
```

On first use, portless creates and trusts a local CA. The app is then available
at `https://webcode.localhost`.

To use the shell directly without portless:

```sh
bun run dev:direct
```

This exposes the Vite shell at `http://localhost:3001`.

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
