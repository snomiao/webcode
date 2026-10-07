/**
 * macOS: an oxmgr-managed process (https://github.com/Vladimir-Urik/OxMgr).
 * oxmgr's own daemon is kept alive at login by launchd (`oxmgr service
 * install` writes the LaunchAgent), and it restarts webcode on exit and on a
 * failing health check, so this runs as you with your ~/ws, git/gh logins and
 * `code` CLI, and start / stop / status need no sudo.
 */

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InstallOptions, ServiceAdapter, ServiceConfig, ServiceStatus } from "./types";
import { REPO, run, SERVICE } from "./util";

/** oxmgr's data dir (state.json, logs/). */
const DATA_DIR =
  process.env.OXMGR_HOME ||
  (process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "oxmgr")
    : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "oxmgr"));

/** `oxmgr` on PATH, else bun's global bin (a launchd/cron PATH often lacks it). */
function oxmgrBin(): string {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const p = dir && path.join(dir, "oxmgr");
    if (p && existsSync(p)) return p;
  }
  return path.join(os.homedir(), ".bun", "bin", "oxmgr");
}

export function hasOxmgr(): boolean {
  return existsSync(oxmgrBin());
}

const oxmgr = (...args: string[]) => run(oxmgrBin(), args, 60_000);

interface OxProcess {
  name: string;
  status?: string;
  env?: Record<string, string>;
  stdout_log?: string;
}

function processState(): OxProcess | null {
  try {
    const state = JSON.parse(readFileSync(path.join(DATA_DIR, "state.json"), "utf8"));
    const procs: OxProcess[] = Object.values(state.processes ?? {});
    return procs.find((p) => p.name === SERVICE) ?? null;
  } catch {
    return null;
  }
}

export const oxmgrAdapter: ServiceAdapter = {
  kind: "oxmgr process",
  name: SERVICE,
  logFile: path.join(DATA_DIR, "logs", `${SERVICE}.{out,err}.log`),

  async status(): Promise<ServiceStatus> {
    const { code, out } = await oxmgr("status", SERVICE);
    if (code !== 0) return { state: "not-installed", detail: "not installed" };
    const field = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, "m").exec(out)?.[1]?.trim();
    const status = field("Status") ?? "unknown";
    const extra = [field("Uptime") && `up ${field("Uptime")}`, field("Health") && `health ${field("Health")}`]
      .filter(Boolean)
      .join(", ");
    return { state: status === "running" ? "running" : "stopped", detail: extra ? `${status} (${extra})` : status };
  },

  async config(): Promise<ServiceConfig> {
    const env = processState()?.env;
    if (!env) return {};
    // start.ts defaults: PORT 3001, base "/".
    return { port: Number(env.PORT || 3001), base: env.WEBCODE_BASE_PATH };
  },

  async install(o: InstallOptions) {
    const env: Record<string, string> = {
      // The oxmgr daemon's PATH (from launchd) lacks ~/.bun/bin, ~/.local/bin etc.
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      PORT: String(o.port),
      TERMINAL_WS_PORT: String(o.terminalWsPort),
      WEBCODE_BASE_PATH: o.base,
      TAILSCALE_SERVE: o.tailscaleServe ? "1" : "0",
    };
    const base = o.base.endsWith("/") ? o.base : `${o.base}/`;
    if (processState()) await oxmgr("delete", SERVICE);
    const r = await oxmgr(
      "start",
      "--name", SERVICE,
      "--restart", "always",
      "--cwd", REPO,
      ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
      "--health-cmd", `/usr/bin/curl -fsS -o /dev/null http://127.0.0.1:${o.port}${base}`,
      "--health-interval", "30",
      // A cold start rebuilds the shell, which takes minutes on a busy machine;
      // with oxmgr's default (3 x 30s) it killed every restart mid-build until
      // max_restarts gave up on the service.
      "--health-max-failures", "10",
      `${process.execPath} start.ts`,
    );
    if (r.code !== 0) {
      console.error(`oxmgr start failed:\n${r.out}`);
      return 1;
    }
    // oxmgr's daemon must itself come back after a reboot / logout.
    if ((await oxmgr("service", "status")).code !== 0) {
      console.warn("warning: oxmgr's daemon isn't registered with launchd, so webcode won't survive a reboot.\n         Run once: oxmgr service install");
    }
    return 0;
  },

  async uninstall() {
    const r = await oxmgr("delete", SERVICE);
    if (r.code !== 0) console.error(r.out);
    else console.log(`Removed oxmgr process ${SERVICE}.`);
    return r.code;
  },

  async start() {
    // `oxmgr start` registers a new process; a registered, stopped one restarts.
    const r = await oxmgr("restart", SERVICE);
    if (r.code !== 0) console.error(r.out);
    return r.code;
  },

  async stop() {
    const r = await oxmgr("stop", SERVICE);
    if (r.code !== 0) console.error(r.out);
    return r.code;
  },
};
