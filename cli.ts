#!/usr/bin/env bun
/**
 * webcode CLI.
 *
 *   webcode service [status]   service state + live portless / Tailscale URLs
 *   webcode service start      start the background service
 *   webcode service stop       stop it (kills the whole process tree)
 *   webcode service install    register it to run at boot, then start it
 *   webcode service uninstall  remove it
 *
 * `serve` is an alias for `service`. The service itself is platform-specific
 * (see service/): a scheduled task on Windows, a systemd user unit on Linux.
 *
 * URLs are discovered from what's actually running: portless's routes.json
 * (or the service's fixed port) gives the vite port, and `tailscale serve
 * status` is matched against that port, so both reflect the live instance
 * whether it runs as the service or via `bun run dev`.
 */

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { serviceAdapter, type InstallOptions, type ServiceAdapter } from "./service";
import { run, sleep } from "./service/util";

const HOSTNAME = "webcode.localhost";
const PORTLESS_DIR = path.join(os.homedir(), ".portless");
const IS_WIN = process.platform === "win32";

const DEFAULTS: InstallOptions = {
  // Fixed vite port (behind a static `portless alias webcode <port>`).
  port: 4390,
  // wtx's default (3004) is often taken by other local tools.
  terminalWsPort: 3014,
  // URL prefix; also the Tailscale Serve mount (https://<host>.ts.net/webcode/).
  base: "/webcode",
  tailscaleServe: true,
};

// --- URL discovery ---------------------------------------------------------

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** The vite port portless routes webcode.localhost to, if registered. */
function portlessRoute(): { port: number; url: string } | null {
  const routes = readJson<{ hostname: string; port: number }[]>(path.join(PORTLESS_DIR, "routes.json"));
  const route = routes?.find((r) => r.hostname === HOSTNAME);
  if (!route) return null;
  let proxyPort = 443;
  try {
    proxyPort = Number(readFileSync(path.join(PORTLESS_DIR, "proxy.port"), "utf8").trim()) || 443;
  } catch {
    /* default */
  }
  const tls = existsSync(path.join(PORTLESS_DIR, "proxy.tls"));
  const defaultPort = tls ? 443 : 80;
  const origin = `${tls ? "https" : "http"}://${HOSTNAME}${proxyPort === defaultPort ? "" : `:${proxyPort}`}`;
  return { port: route.port, url: origin };
}

/** Tailscale Serve mounts that proxy to `port`, as full URLs. */
async function tailscaleUrls(port: number): Promise<string[]> {
  const bin = findTailscale();
  if (!bin) return [];
  const { code, out } = await run(bin, ["serve", "status", "--json"]);
  if (code !== 0) return [];
  let status: { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
  try {
    status = JSON.parse(out);
  } catch {
    return [];
  }
  const urls: string[] = [];
  for (const [hostPort, web] of Object.entries(status.Web ?? {})) {
    const [host, p] = hostPort.split(":");
    for (const [mount, h] of Object.entries(web.Handlers ?? {})) {
      const target = h.Proxy ? new URL(h.Proxy) : null;
      if (target && Number(target.port) === port) {
        const mountPath = mount.endsWith("/") ? mount : `${mount}/`;
        urls.push(`https://${host}${p === "443" ? "" : `:${p}`}${mountPath}`);
      }
    }
  }
  return urls;
}

function findTailscale(): string | null {
  const exts = IS_WIN ? [".exe", ""] : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    for (const ext of exts) {
      const p = dir && path.join(dir, `tailscale${ext}`);
      if (p && existsSync(p)) return p;
    }
  }
  for (const p of ["C:\\Program Files\\Tailscale\\tailscale.exe", "/usr/bin/tailscale"]) {
    if (existsSync(p)) return p;
  }
  return null;
}

function normBase(raw: string | undefined): string {
  const t = (raw || "/").trim().replace(/^\/+|\/+$/g, "");
  return t ? `/${t}/` : "/";
}

async function probe(url: string): Promise<string> {
  // Browsers and curl resolve *.localhost to loopback themselves, but Bun's
  // resolver doesn't (ENOTFOUND on Windows), so dial 127.0.0.1 and route via
  // the Host header instead.
  const u = new URL(url);
  const headers: Record<string, string> = {};
  if (u.hostname.endsWith(".localhost")) {
    headers.Host = u.host;
    u.hostname = "127.0.0.1";
  }
  try {
    const res = await fetch(u, {
      headers,
      signal: AbortSignal.timeout(5000),
      tls: { rejectUnauthorized: false },
    } as RequestInit);
    return res.ok ? "ok" : `HTTP ${res.status}`;
  } catch (e) {
    return `unreachable (${(e as Error).message})`;
  }
}

/** Where the live instance listens: portless's route, else the service's fixed port. */
async function liveShell(svc: ServiceAdapter | null) {
  const cfg = (await svc?.config()) ?? {};
  const route = portlessRoute();
  const port = route?.port ?? cfg.port;
  return { route, port, base: cfg.base };
}

// --- commands --------------------------------------------------------------

async function status(svc: ServiceAdapter | null): Promise<number> {
  if (svc) {
    const s = await svc.status();
    const hint = s.state === "not-installed" ? " (webcode service install)" : "";
    console.log(`service  : ${svc.name} [${svc.kind}] — ${s.detail}${hint}`);
  } else {
    console.log(`service  : not supported on ${process.platform} yet (run \`bun run dev\`)`);
  }

  const { route, port, base: cfgBase } = await liveShell(svc);
  if (!port) {
    console.log("urls     : none (not registered with portless and no service installed — not running?)");
    return 0;
  }

  const ts = await tailscaleUrls(port);
  // Base path: the Tailscale mount is authoritative for the live instance;
  // fall back to the service's configured base.
  const base = ts[0] ? new URL(ts[0]).pathname : normBase(cfgBase ?? process.env.WEBCODE_BASE_PATH);
  const local = `http://localhost:${port}${base}`;

  console.log(`local    : ${local}  [${await probe(`${local}__config`)}]`);
  if (route) console.log(`portless : ${route.url}${base}  [${await probe(`${route.url}${base}__config`)}]`);
  if (ts.length) {
    for (const u of ts) console.log(`tailscale: ${u}  [${await probe(`${u}__config`)}]`);
  } else {
    console.log("tailscale: not served (install with Tailscale enabled, or set TAILSCALE_SERVE=1)");
  }
  console.log(`open     : <url>github.com/<owner>/<repo>/tree/<branch>  (?ui=vscode | ?ui=wtx)`);
  if (svc) console.log(`logs     : ${svc.logFile}`);
  return 0;
}

/** Wait for the shell (and the Tailscale mount, registered right after) to answer. */
async function waitUntilUp(svc: ServiceAdapter): Promise<void> {
  const until = Date.now() + 90_000;
  for (;;) {
    const { port, base } = await liveShell(svc);
    if (port && (await probe(`http://localhost:${port}${normBase(base)}__config`)) === "ok") break;
    if (Date.now() > until) {
      console.error(`Service didn't answer within 90s. Logs: ${svc.logFile}`);
      return;
    }
    await sleep(1000);
  }
  await sleep(1500);
}

function parseInstallOptions(args: string[]): InstallOptions {
  const o = { ...DEFAULTS };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = () => {
      const v = args[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--port") o.port = Number(value());
    else if (a === "--terminal-ws-port") o.terminalWsPort = Number(value());
    else if (a === "--base") o.base = value();
    else if (a === "--no-tailscale") o.tailscaleServe = false;
    else throw new Error(`unknown option: ${a}`);
  }
  if (!Number.isInteger(o.port) || !Number.isInteger(o.terminalWsPort)) throw new Error("ports must be integers");
  return o;
}

function usage(): number {
  console.log(
    [
      "Usage: webcode service [status|start|stop|install|uninstall]",
      "",
      "install options:",
      `  --port <n>              vite shell port (default ${DEFAULTS.port})`,
      `  --terminal-ws-port <n>  wtx terminal port (default ${DEFAULTS.terminalWsPort})`,
      `  --base <path>           URL prefix / Tailscale mount (default ${DEFAULTS.base})`,
      "  --no-tailscale          don't publish on the tailnet via `tailscale serve`",
    ].join("\n"),
  );
  return 1;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, sub = "status", ...rest] = argv;
  if (cmd !== "service" && cmd !== "serve") return usage();
  const svc = serviceAdapter();
  if (sub === "status") return status(svc);
  if (!["start", "stop", "install", "uninstall"].includes(sub)) return usage();
  if (!svc) {
    console.error(`webcode service ${sub}: no service adapter for ${process.platform} yet; run \`bun run dev\`.`);
    return 1;
  }

  if (sub === "install") {
    let opts: InstallOptions;
    try {
      opts = parseInstallOptions(rest);
    } catch (e) {
      console.error((e as Error).message);
      return usage();
    }
    const code = await svc.install(opts);
    if (code !== 0) return code;
  } else if (sub === "uninstall") {
    return svc.uninstall();
  } else {
    const installed = (await svc.status()).state !== "not-installed";
    if (!installed) {
      console.error(`${svc.name} is not installed. Run: webcode service install`);
      return 1;
    }
    const code = await svc[sub as "start" | "stop"]();
    if (code !== 0 || sub === "stop") {
      console.log(`service  : ${svc.name} — ${(await svc.status()).detail}`);
      return code;
    }
  }
  // install / start: report once it actually answers.
  await waitUntilUp(svc);
  return status(svc);
}

process.exit(await main(process.argv.slice(2)));
