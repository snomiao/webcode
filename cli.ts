#!/usr/bin/env bun
/**
 * webcode CLI.
 *
 *   webcode serve [status]   service state + live portless / Tailscale URLs
 *   webcode serve start      start the `webcode` scheduled task
 *   webcode serve stop       stop it (kills the whole process tree)
 *   webcode serve install    register the boot-time task (UAC; see install-windows-service.ps1)
 *   webcode serve uninstall  remove it (UAC)
 *
 * URLs are discovered from what's actually running: portless's routes.json
 * gives the vite port for webcode.localhost, and `tailscale serve status`
 * is matched against that port, so both reflect the live instance whether it
 * runs as the service or via `bun run dev`.
 */

import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = process.env.WEBCODE_SERVICE || "webcode";
const HOSTNAME = "webcode.localhost";
const PORTLESS_DIR = path.join(os.homedir(), ".portless");
const LOG = path.join(HERE, ".logs", "webcode.log");
const IS_WIN = process.platform === "win32";

function run(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
  });
}

// --- Windows scheduled task ---------------------------------------------
// webcode runs as a boot-time scheduled task (S4U: as you, no stored
// password) rather than a service, which would need your password.

type TaskState = "Running" | "Ready" | "Disabled" | "Queued" | "NotInstalled" | string;

async function taskState(): Promise<TaskState> {
  if (!IS_WIN) return "NotInstalled";
  const { code, out } = await run("schtasks.exe", ["/query", "/tn", SERVICE, "/fo", "csv", "/nh"]);
  if (code !== 0) return "NotInstalled";
  // e.g. "\webcode","N/A","Running"
  const first = out.split(/\r?\n/)[0] ?? "";
  return /"([^"]*)"\s*$/.exec(first)?.[1] ?? "Unknown";
}

/** Settings the task was installed with (launcher args in the task XML). */
async function taskEnv(): Promise<Record<string, string>> {
  if (!IS_WIN) return {};
  const { code, out } = await run("schtasks.exe", ["/query", "/tn", SERVICE, "/xml"]);
  if (code !== 0) return {};
  const args = /<Arguments>([^<]*)<\/Arguments>/.exec(out)?.[1]?.replace(/&quot;/g, '"') ?? "";
  const base = /-Base\s+"?([^"\s]+)"?/.exec(args)?.[1];
  return base ? { WEBCODE_BASE_PATH: base } : {};
}

async function waitForState(want: TaskState, timeoutMs = 30_000): Promise<TaskState> {
  const until = Date.now() + timeoutMs;
  let state = await taskState();
  while (state !== want && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 500));
    state = await taskState();
  }
  return state;
}

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

// --- commands --------------------------------------------------------------

async function status(): Promise<number> {
  const state = await taskState();
  const env = await taskEnv();
  console.log(`task     : ${SERVICE} — ${state === "NotInstalled" ? "not installed (webcode serve install)" : state.toLowerCase()}`);

  const route = portlessRoute();
  if (!route) {
    console.log("urls     : none (webcode is not registered with portless — not running?)");
    return state === "Running" ? 1 : 0;
  }

  const ts = await tailscaleUrls(route.port);
  // Base path: the Tailscale mount is authoritative for the live instance;
  // fall back to the task's configured base.
  const base = ts[0] ? new URL(ts[0]).pathname : normBase(env.WEBCODE_BASE_PATH ?? process.env.WEBCODE_BASE_PATH);
  const local = `${route.url}${base}`;

  console.log(`portless : ${local}  [${await probe(`${local}__config`)}]`);
  if (ts.length) {
    for (const u of ts) console.log(`tailscale: ${u}  [${await probe(`${u}__config`)}]`);
  } else {
    console.log("tailscale: not served (set TAILSCALE_SERVE=1)");
  }
  console.log(`vite     : http://localhost:${route.port}${base}`);
  console.log(`open     : <url>github.com/<owner>/<repo>/tree/<branch>  (?ui=vscode | ?ui=wtx)`);
  if (state !== "NotInstalled") console.log(`logs     : ${LOG}`);
  return 0;
}

async function control(action: "start" | "stop"): Promise<number> {
  if (!IS_WIN) {
    console.error("webcode serve start/stop controls the Windows scheduled task; on this OS run `bun run dev`.");
    return 1;
  }
  const state = await taskState();
  if (state === "NotInstalled") {
    console.error(`Task '${SERVICE}' is not installed. Run: webcode serve install`);
    return 1;
  }
  if (action === "stop") {
    // Ending the task kills the launcher; its kill-on-close job object (see
    // serve.ps1) takes down vite, code serve-web, wtx and their shells with it.
    if (state === "Running") await run("schtasks.exe", ["/end", "/tn", SERVICE]);
    const final = await waitForState("Ready");
    console.log(`task     : ${SERVICE} — ${final.toLowerCase()}`);
    return final === "Ready" ? 0 : 1;
  }
  // Retry: right after a stop, Task Scheduler can still be tearing down the
  // previous instance and silently ignore the run (MultipleInstances=IgnoreNew).
  for (let attempt = 0; (await taskState()) !== "Running"; attempt++) {
    if (attempt === 3) {
      console.error(`Task did not start. Logs: ${LOG}`);
      return 1;
    }
    const { code, out } = await run("schtasks.exe", ["/run", "/tn", SERVICE]);
    if (code !== 0) {
      console.error(out);
      return 1;
    }
    await waitForState("Running", 5_000);
  }
  // The portless alias is static, so wait for vite itself to answer (and the
  // tailscale mount, registered right after) before reporting.
  const until = Date.now() + 60_000;
  for (;;) {
    const route = portlessRoute();
    const up = route && (await probe(`${route.url}${normBase((await taskEnv()).WEBCODE_BASE_PATH)}__config`)) === "ok";
    if (up || Date.now() > until) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await new Promise((r) => setTimeout(r, 1500));
  return status();
}

function installer(uninstall: boolean): number {
  if (!IS_WIN) {
    console.error("The installer is Windows-only.");
    return 1;
  }
  const script = path.join(HERE, "install-windows-service.ps1");
  // Pass the unelevated caller so the task runs as them even if UAC elevates
  // into a different admin account. On failure, keep the window open.
  const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  const inner =
    `try { & '${script}' -User '${user}'${uninstall ? " -Uninstall" : ""}; Start-Sleep 3; exit 0 } ` +
    `catch { Write-Host $_ -ForegroundColor Red; Read-Host 'Failed - press Enter to close'; exit 1 }`;
  // -EncodedCommand (UTF-16LE base64) sidesteps nested quoting through Start-Process.
  const encoded = Buffer.from(inner, "utf16le").toString("base64");
  const r = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `$p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru ` +
        `-ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'; exit $p.ExitCode`,
    ],
    { stdio: "inherit" },
  );
  if (r.status !== 0) return r.status ?? 1;
  return uninstall ? 0 : Number(spawnSync(process.execPath, [fileURLToPath(import.meta.url), "serve", "start"], { stdio: "inherit" }).status ?? 1);
}

function usage(): number {
  console.log(`Usage: webcode serve [status|start|stop|install|uninstall]`);
  return 1;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, sub = "status"] = argv;
  if (cmd !== "serve") return usage();
  switch (sub) {
    case "status":
      return status();
    case "start":
    case "stop":
      return control(sub);
    case "install":
      return installer(false);
    case "uninstall":
      return installer(true);
    default:
      return usage();
  }
}

process.exit(await main(process.argv.slice(2)));
