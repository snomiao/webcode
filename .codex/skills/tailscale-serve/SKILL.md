---
name: tailscale-serve
description: Configure, troubleshoot, or implement Tailscale Serve access for local web applications, including HTTPS, MagicDNS, reverse proxies, WebSockets, multiple path-mounted services, and base-path-aware development servers. Use when a user wants a local app reachable privately through Tailscale; do not use for public exposure unless the user explicitly requests Funnel.
---

# Tailscale Serve

Expose the requested local service privately to the user's tailnet and verify the
actual browser URL. Preserve existing Serve routes and unrelated services.
The workflow is framework-agnostic. Treat named products such as VS Code Web or
Vite as examples of common integration constraints, not required components.

## Inspect first

- Check the app's listening address, port, absolute URLs, API paths, redirects,
  WebSocket endpoints, and framework host validation.
- Check `tailscale version`, `tailscale status --json`, and
  `tailscale serve status`. On macOS, if `tailscale` is absent from `PATH`, also
  check `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.
- Derive the current machine FQDN from `Self.DNSName`; never hardcode a user's
  machine name, tailnet suffix, node ID, IP, or activation URL in source code.
- Current CLI behavior can change. For implementation or troubleshooting that
  depends on exact flags, verify against the official Tailscale Serve CLI docs.

## Choose the URL shape

For an app that can own the hostname root, prefer:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:3000
```

For multiple services on one machine, mount each at a distinct path:

```sh
tailscale serve --bg --https=443 --set-path=/app \
  http://127.0.0.1:3000/app
tailscale serve --bg --https=443 --set-path=/docs \
  http://127.0.0.1:4000/docs
```

The target path restores the mount prefix after Serve matches and strips
`--set-path`. Use it only when the backend is configured to receive that same
prefix. Confirm the behavior on the installed Tailscale version.

MagicDNS normally provides `<machine>.<tailnet>.ts.net`, not arbitrary nested
records such as `<service>.<machine>.<tailnet>.ts.net`. If the requested name
does not resolve, explain this limitation and offer a path mount, a separate
Tailscale node/service, a renamed machine, or a user-controlled DNS domain.
Changing a machine name affects its MagicDNS identity and requires explicit
user authorization.

## Make subpaths complete

Do not treat a successful HTML response as proof that a path-mounted app works.
Configure the same base path across all relevant layers:

- generated asset URLs and router/navigation paths;
- browser fetch, SSE, worker, service-worker, and WebSocket URLs;
- reverse-proxy route keys and rewrites;
- backend redirects and cookie paths;
- embedded upstream servers with independent base-path settings (for example,
  VS Code Web's `--server-base-path`);
- development-server HMR paths and allowed hosts.

Prefer an exact MagicDNS hostname allowlist. Never set Vite's `allowedHosts` to
`true` merely to make Serve work. The local HTTP backend should listen on
`127.0.0.1`; a server bound only to IPv6 `::1` causes Serve to return 502.
Ensure every intermediary supports WebSocket upgrades when the app needs them.

## Mutations and activation

Configuring Serve, enabling tailnet HTTPS, renaming a machine, editing DNS, or
opening an activation page changes external state. Obtain approval immediately
before those operations. Do not use Funnel unless public internet exposure was
explicitly requested. If Serve reports that it is disabled, open or provide the
activation URL and wait for the user to finish; do not claim setup succeeded.

Add or update one path without resetting the full configuration. Remove only a
specific route with the matching protocol, port, and `--set-path ... off` form.
Avoid `tailscale serve reset` unless the user explicitly wants every Serve route
removed.

## Verify

After starting the backend and applying Serve configuration:

1. Verify the loopback URL and the full MagicDNS URL independently.
2. Check representative HTML, API, static asset, WebSocket, and embedded-app
   paths. A 403 commonly indicates host validation; a 502 commonly indicates a
   dead backend, wrong port/path, or IPv4/IPv6 binding mismatch.
3. Run the project's proportionate typecheck/build/tests after code changes.
4. Report the exact working URL, whether the route is persistent (`--bg`), and
   any other existing Serve routes left untouched.
5. Scan repository changes for machine names and tailnet identifiers before
   committing or opening a pull request.
