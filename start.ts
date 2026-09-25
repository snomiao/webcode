/**
 * Launcher for the web-code lab.
 *
 *  1. spawn `code serve-web` on :9999 with base path /_vscode/
 *  2. spawn the vite shell (and its VS Code/wtx reverse proxies): the built
 *     bundle via `vite preview` by default, or the dev server with HMR when
 *     run with `--dev`
 *
 * Run with `portless webcode bun start.ts` for
 * https://webcode.localhost/github.com/<owner>/<repo>/tree/<branch>.
 */

import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appBase } from "./server-base";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VSCODE_PORT = 9999;
const VSCODE_BASE = `${appBase}_vscode/`;
const SHELL_PORT = Number(process.env.PORT || 3001);
// `--dev` (or WEBCODE_DEV=1): vite dev server + HMR instead of the built shell.
const DEV = process.argv.includes("--dev") || process.env.WEBCODE_DEV === "1";
// Lab-local server data dir so we can pre-seed settings (and not pollute
// the user's global ~/.vscode-server).
const VSCODE_DATA_DIR = path.join(HERE, ".vscode-serve-web");
// Opt-in Tailscale Serve: publish the shell on the tailnet at
//   https://<machine>.<tailnet>.ts.net<appBase>
// mounted at appBase so nothing else on the tailnet origin is claimed. Opt-in
// (TAILSCALE_SERVE=1) because it rewrites the machine's `tailscale serve`
// config. Serve strips the mount path before proxying, so the proxy target
// carries appBase to restore it (same as the manual route in the README).
const TAILSCALE_SERVE = process.env.TAILSCALE_SERVE === "1";
const TAILSCALE_MOUNT = appBase === "/" ? "/" : appBase.slice(0, -1);

// Each long-lived child is supervised: if it dies while we're still up
// (e.g. vite gets SIGTERM'd, or VS Code's server crashes), we respawn it
// with exponential backoff instead of leaving a half-dead daemon. Before
// this, a single vite-shell death left the launcher — and so oxmgr —
// reporting "running" while the shell server was gone.
const children = new Map<string, ChildProcess>();
let shuttingDown = false;

// Supervisor backoff/guard tuning.
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
// A child that stayed up at least this long is treated as healthy, so its
// next death restarts the backoff from zero rather than counting as part of
// a crash loop.
const STABLE_MS = 10_000;

/**
 * Locate the `code-server` binary from the VS Code CLI serve-web cache.
 * VS Code 1.132+ split the serve-web binary out from the main `code` shell
 * script — it's no longer `code serve-web` but `code-server` at:
 *   ~/.vscode/cli/serve-web/<version>/bin/code-server   (macOS)
 *   ~/.codehost/vscode/<version>/code                    (legacy codehost)
 * Falls back to the legacy `code serve-web` shell command if needed.
 * Returns `{ cmd, isLegacy }` — legacy needs `[serve-web, ...args]`, the new
 * code-server binary takes the serve-web flags directly.
 */
function findCodeServer(): { cmd: string; legacy: boolean } {
  const serveWebDir = path.join(os.homedir(), ".vscode", "cli", "serve-web");
  const lruPath = path.join(serveWebDir, "lru.json");
  let versions: string[] = [];
  try {
    versions = JSON.parse(readFileSync(lruPath, "utf-8"));
  } catch { /* ok */ }
  for (const ver of versions) {
    const bin = path.join(serveWebDir, ver, "bin", "code-server");
    if (existsSync(bin)) return { cmd: bin, legacy: false };
  }
  const codehostDir = path.join(os.homedir(), ".codehost", "vscode");
  try {
    for (const ver of readdirSync(codehostDir)) {
      const bin = path.join(codehostDir, ver, "code");
      if (existsSync(bin)) return { cmd: bin, legacy: true };
    }
  } catch { /* not present */ }
  return { cmd: "code", legacy: true };
}

/**
 * Pre-seed VS Code's User settings for the embedded serve-web instance.
 * Workspace Trust is disabled so opening a folder via `?folder=` shows the
 * file tree immediately instead of starting in restricted mode (which
 * otherwise leaves the Explorer empty until you click "Trust"). This is an
 * embedded, single-user dev tool, so the trust gate adds only friction.
 */
function seedVscodeSettings(): void {
  const userDir = path.join(VSCODE_DATA_DIR, "data", "User");
  mkdirSync(userDir, { recursive: true });
  writeFileSync(
    path.join(userDir, "settings.json"),
    JSON.stringify(
      {
        "security.workspace.trust.enabled": false,
        "workbench.startupEditor": "none",
      },
      null,
      2,
    ),
  );
}

// On Windows, `code`/`bun`/`bunx` resolve to .cmd/.bat shims that Node's
// spawn can't exec directly — it needs a shell. Harmless on Unix.
const NEEDS_SHELL = process.platform === "win32";

function supervise(cmd: string, args: string[], label: string): void {
  let restarts = 0;
  let startedAt = 0;

  const start = () => {
    if (shuttingDown) return;
    console.log(`[web-code] starting ${label}: ${cmd} ${args.join(" ")}`);
    // Pin cwd to this lab dir so vite resolves ./vite.config.ts (and its
    // /__config + /api/repo middleware, multi-page input, react plugin)
    // regardless of where the launcher was invoked from. Without this,
    // `bun lab/web-code/start.ts` from the repo root starts vite with the
    // repo root as its root → no config, no index.html, every route 404s.
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: NEEDS_SHELL,
      cwd: HERE,
    });
    startedAt = Date.now();
    children.set(label, child);
    child.on("exit", (code, signal) => {
      children.delete(label);
      if (shuttingDown) return;
      // A healthy long run clears the crash counter so a one-off death
      // respawns immediately; only rapid repeat crashes get backed off.
      if (Date.now() - startedAt >= STABLE_MS) restarts = 0;
      restarts++;
      const delay = Math.min(
        MAX_BACKOFF_MS,
        BASE_BACKOFF_MS * 2 ** (restarts - 1),
      );
      console.log(
        `[web-code] ${label} exited (${signal ?? code}); respawning #${restarts} in ${delay}ms`,
      );
      setTimeout(start, delay);
    });
  };

  start();
}

/** Locate the `tailscale` CLI: PATH first, then the stock install locations. */
function findTailscale(): string | null {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, "tailscale" + ext);
      if (existsSync(p)) return p;
    }
  }
  for (const p of [
    "C:\\Program Files\\Tailscale\\tailscale.exe",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/usr/bin/tailscale",
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

function tailscale(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

/**
 * Register the vite shell with `tailscale serve` at TAILSCALE_MOUNT. Re-run
 * on every launch because portless hands out a fresh port each time, so a
 * static `tailscale serve` entry would go stale.
 */
async function tailscaleServeUp(bin: string): Promise<void> {
  const target = `http://127.0.0.1:${SHELL_PORT}${appBase}`;
  await tailscale(bin, ["serve", "--bg", "--set-path", TAILSCALE_MOUNT, target]);
}

/** This machine's MagicDNS name (`<machine>.<tailnet>.ts.net`), or null. */
async function tailscaleHost(bin: string): Promise<string | null> {
  try {
    const status = JSON.parse(await tailscale(bin, ["status", "--json"]));
    return String(status?.Self?.DNSName || "").replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

async function tailscaleServeDown(bin: string): Promise<void> {
  await tailscale(bin, ["serve", "--set-path", TAILSCALE_MOUNT, "off"]).catch(() => {});
}

async function main() {
  // 1. VS Code web server
  seedVscodeSettings();
  const { cmd: codeServerBin, legacy } = findCodeServer();
  const codeServerArgs = legacy
    ? ["serve-web", "--host", "127.0.0.1", "--port", String(VSCODE_PORT), "--server-base-path", VSCODE_BASE, "--server-data-dir", VSCODE_DATA_DIR, "--without-connection-token", "--accept-server-license-terms"]
    : ["--host", "127.0.0.1", "--port", String(VSCODE_PORT), "--server-base-path", VSCODE_BASE, "--server-data-dir", VSCODE_DATA_DIR, "--without-connection-token", "--accept-server-license-terms"];
  supervise(
    codeServerBin,
    codeServerArgs,
    "code serve-web",
  );

  // Vite only answers Host headers it allows. Behind Tailscale Serve requests
  // carry this machine's tailnet name, so allow exactly that one (unless the
  // caller already set it; see the README's manual Tailscale setup).
  const tailscaleBin = TAILSCALE_SERVE ? findTailscale() : null;
  const tsHost = tailscaleBin ? await tailscaleHost(tailscaleBin) : null;
  if (tsHost) process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS ??= tsHost;

  // 2. vite shell (also reverse-proxies /_vscode and /_wtx so portless only
  // needs one named route). Default: build once, then serve the bundle with
  // `vite preview`, so editing this checkout never reloads open tabs. --dev:
  // the vite dev server with HMR, for working on the shell itself.
  const viteArgs = ["--host", "127.0.0.1", "--port", String(SHELL_PORT), "--strictPort"];
  if (DEV) {
    process.env.WEBCODE_HMR = "1";
    supervise("bunx", ["vite", ...viteArgs], "vite shell (dev)");
  } else {
    console.log("[web-code] building shell (vite build)…");
    const built = spawnSync("bunx", ["vite", "build"], {
      stdio: "inherit",
      shell: NEEDS_SHELL,
      cwd: HERE,
    });
    if (built.status !== 0) {
      console.error(`[web-code] vite build failed (${built.status}); exiting`);
      process.exit(1);
    }
    supervise("bunx", ["vite", "preview", ...viteArgs], "vite shell");
  }

  // 3. wtx PTY WebSocket server (web terminal backend, ?ui=wtx)
  supervise("bun", [path.join(HERE, "lib", "wtx", "wtx.mjs")], "wtx terminal");

  // Give the child services a moment to start before printing the URL.
  await new Promise((r) => setTimeout(r, 1500));

  const origin = process.env.PORTLESS_URL || `http://localhost:${SHELL_PORT}`;
  const base = `${origin}${appBase}`;
  console.log(
    "[webcode] ready.\n" +
      `  VS Code : ${base}github.com/<owner>/<repo>/tree/<branch>\n` +
      `  Terminal: ${base}github.com/<owner>/<repo>/tree/<branch>?ui=wtx`,
  );

  // 4. optional: expose the same shell on the tailnet via Tailscale Serve.
  let tailscaleServed = false;
  if (TAILSCALE_SERVE) {
    if (!tailscaleBin) {
      console.warn("[web-code] TAILSCALE_SERVE=1 but the tailscale CLI was not found; skipping");
    } else {
      try {
        await tailscaleServeUp(tailscaleBin);
        tailscaleServed = true;
        const tsOrigin = `https://${tsHost ?? "<machine>.<tailnet>.ts.net"}`;
        console.log(
          `[webcode] tailscale serve ${TAILSCALE_MOUNT} -> http://127.0.0.1:${SHELL_PORT}${appBase}\n` +
            `  ${tsOrigin}${appBase}github.com/<owner>/<repo>/tree/<branch>`,
        );
      } catch (e) {
        console.warn(`[web-code] tailscale serve failed: ${(e as Error).message}`);
      }
    }
  }

  // 5. cleanup on exit
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true; // stop supervisors from respawning during teardown
    console.log("\n[web-code] shutting down…");
    for (const c of children.values()) c.kill();
    // Drop our tailscale mounts so the tailnet URL doesn't dangle at a dead port.
    const done =
      tailscaleBin && tailscaleServed ? tailscaleServeDown(tailscaleBin) : Promise.resolve();
    done.finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
