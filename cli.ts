#!/usr/bin/env bun
/**
 * webcode CLI.
 *
 *   webcode service [status]   service state + live portless / Tailscale URLs
 *   webcode service start      start the background service
 *   webcode service stop       stop it (kills the whole process tree)
 *   webcode service install    register it to run at boot, then start it
 *   webcode service restart    stop, then start
 *   webcode service logs       follow the service log
 *   webcode service uninstall  remove it
 *   webcode share [off]        publish the running instance on your tailnet
 *                              (tailnet-only `tailscale serve`), print its URL
 *
 * `serve` is an alias for `service`, and its subcommands also work bare
 * (`webcode status`, `webcode start`, …). The service itself is
 * platform-specific (see service/): a scheduled task on Windows, a systemd
 * user unit on Linux, an oxmgr process on macOS.
 *
 * URLs are discovered from what's actually running: portless's routes.json
 * (or the service's fixed port) gives the vite port, and `tailscale serve
 * status` is matched against that port, so both reflect the live instance
 * whether it runs as the service or via `bun run dev`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { serviceAdapter, type InstallOptions, type ServiceAdapter } from "./service";
import { run, sleep } from "./service/util";
import { findTailscale } from "./find-tailscale";

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

/** This machine's current MagicDNS name, or null if unknown. */
async function tailscaleSelf(bin: string): Promise<string | null> {
  const { code, out } = await run(bin, ["status", "--json"]);
  if (code !== 0) return null;
  try {
    return String(JSON.parse(out)?.Self?.DNSName || "").replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

/**
 * Tailscale Serve mounts that proxy to `port`, as full URLs. Only this
 * machine's current name counts: serve config keeps entries for names from
 * tailnets it has since left, which no longer resolve.
 */
async function tailscaleUrls(port: number): Promise<string[]> {
  const bin = findTailscale();
  if (!bin) return [];
  const self = await tailscaleSelf(bin);
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
    if (self && host !== self) continue;
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
  // The base path is for the Tailscale mount; locally the shell also answers
  // at the root (probed at `${base}__config`, which the app always requests).
  const local = `http://localhost:${port}/`;

  console.log(`local    : ${local}  [${await probe(`http://localhost:${port}${base}__config`)}]`);
  if (route) console.log(`portless : ${route.url}/  [${await probe(`${route.url}${base}__config`)}]`);
  if (ts.length) {
    for (const u of ts) console.log(`tailscale: ${u}  [${await probe(`${u}__config`)}]`);
  } else {
    console.log("tailscale: not served (install with Tailscale enabled, or set TAILSCALE_SERVE=1)");
  }
  console.log(`open     : <url>github.com/<owner>/<repo>/tree/<branch>  (?ui=vscode | ?ui=wtx)`);
  if (svc) console.log(`logs     : ${svc.logFile}`);
  return 0;
}

/**
 * `webcode share`: mount the live shell on this machine's tailnet origin with
 * `tailscale serve` (tailnet-only; refused while Funnel would make it public)
 * and print the link. `webcode share off` removes the mount.
 */
async function share(svc: ServiceAdapter | null, args: string[]): Promise<number> {
  const bin = findTailscale();
  if (!bin) {
    console.error("share: the tailscale CLI was not found. Install Tailscale and log in first.");
    return 1;
  }
  const { port, base: cfgBase } = await liveShell(svc);
  const live = port ? await tailscaleUrls(port) : [];
  const base = live[0] ? new URL(live[0]).pathname : normBase(cfgBase ?? process.env.WEBCODE_BASE_PATH);
  const mount = base === "/" ? "/" : base.slice(0, -1);

  if (args[0] === "off" || args[0] === "stop") {
    const r = await run(bin, ["serve", "--set-path", mount, "off"]);
    if (r.code !== 0) {
      console.error(`tailscale serve --set-path ${mount} off failed:\n${r.out}`);
      return r.code;
    }
    console.log(`Stopped sharing ${mount} on the tailnet.`);
    return 0;
  }
  if (args.length) {
    console.error("Usage: webcode share [off]");
    return 1;
  }

  if (!port || (await probe(`http://localhost:${port}${base}__config`)) !== "ok") {
    console.error("share: webcode isn't running. Start it first: webcode start");
    return 1;
  }
  if (base === "/") console.warn("warning: base path is \"/\", so this claims the whole tailnet origin (set WEBCODE_BASE_PATH).");

  if (!live.length) {
    const { out } = await run(bin, ["serve", "status", "--json"]);
    let funnel = false;
    try {
      funnel = Object.values(JSON.parse(out).AllowFunnel ?? {}).some(Boolean);
    } catch {
      /* no serve config yet */
    }
    if (funnel) {
      console.error("Tailscale Funnel is on for this machine, so a Serve route here would be public, not tailnet-only. Not sharing.\n  Turn Funnel off (tailscale funnel reset), then webcode share again.");
      return 1;
    }
    const target = `http://127.0.0.1:${port}${base}`;
    const r = await run(bin, ["serve", "--bg", "--set-path", mount, target]);
    if (r.code !== 0) {
      console.error(`tailscale serve failed. Run it yourself, then webcode share again:\n  tailscale serve --bg --set-path ${mount} ${target}\n${r.out}`);
      return 1;
    }
  }

  const urls = live.length ? live : await tailscaleUrls(port);
  for (const u of urls) {
    const state = await probe(`${u}__config`);
    console.log(`shared   : ${u}  [${state}]  (tailnet only)`);
    // vite rejects Host headers it doesn't know; start.ts allows the tailnet
    // name only when it registered the route itself (TAILSCALE_SERVE=1).
    if (state === "HTTP 403") console.warn("warning: the shell rejects the tailnet host name. Reinstall with Tailscale enabled (webcode service install), or set __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS and restart.");
  }
  if (urls[0]) console.log(`open     : ${urls[0]}github.com/<owner>/<repo>/tree/<branch>`);
  console.log("stop     : webcode share off");
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

/** Follow the service log(s) until interrupted. */
function logs(svc: ServiceAdapter): number {
  const files = svc.logFile.includes("{out,err}")
    ? ["out", "err"].map((k) => svc.logFile.replace("{out,err}", k))
    : [svc.logFile];
  const existing = files.filter((f) => existsSync(f));
  if (!existing.length) {
    console.error(`no log yet: ${svc.logFile}`);
    return 1;
  }
  const [cmd, ...args] = IS_WIN
    ? ["powershell", "-NoProfile", "-Command", `Get-Content -Wait -Tail 100 '${existing[0]}'`]
    : ["tail", "-n", "100", "-F", ...existing];
  return spawnSync(cmd, args, { stdio: "inherit" }).status ?? 0;
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
      "Usage: webcode [service] [status|start|stop|restart|logs|install|uninstall]",
      "       webcode share [off]",
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
  // `webcode start` == `webcode service start`, etc.
  if (argv[0] !== "service" && argv[0] !== "serve" && argv[0] !== "share") argv = ["service", ...argv];
  const [cmd, sub = "status", ...rest] = argv;
  const svc = serviceAdapter();
  if (cmd === "share") return share(svc, argv.slice(1));
  if (sub === "status") return status(svc);
  if (sub === "help" || sub === "--help" || sub === "-h") {
    usage();
    return 0;
  }
  if (!["start", "stop", "restart", "logs", "install", "uninstall"].includes(sub)) return usage();
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
  } else if (sub === "logs") {
    return logs(svc);
  } else {
    const installed = (await svc.status()).state !== "not-installed";
    if (!installed) {
      console.error(`${svc.name} is not installed. Run: webcode service install`);
      return 1;
    }
    if (sub === "restart") {
      const code = await svc.stop();
      if (code !== 0) return code;
    }
    const code = await svc[sub === "restart" ? "start" : (sub as "start" | "stop")]();
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
