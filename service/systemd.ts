/**
 * Linux: a systemd *user* unit (~/.config/systemd/user/webcode.service), so
 * it runs as you with your ~/ws, git/gh logins and `code` CLI, and start /
 * stop / status need no sudo. Lingering (`loginctl enable-linger`) makes the
 * user manager start at boot, before (and without) any login.
 *
 * KillMode=control-group means `stop` takes down the whole tree: vite,
 * code serve-web, wtx and the terminals' shells.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InstallOptions, ServiceAdapter, ServiceConfig, ServiceStatus } from "./types";
import { LOG, REPO, run, SERVICE } from "./util";

const UNIT = `${SERVICE}.service`;
const UNIT_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "systemd", "user");
const UNIT_FILE = path.join(UNIT_DIR, UNIT);
const PORTLESS = path.join(REPO, "node_modules", ".bin", "portless");

const systemctl = (...args: string[]) => run("systemctl", ["--user", ...args], 60_000);

/** systemd quoting: wrap in double quotes, escaping backslashes and quotes. */
const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

function unitFile(o: InstallOptions): string {
  const env: Record<string, string> = {
    // Captured at install time: the user manager's PATH lacks ~/.bun/bin,
    // ~/.local/bin (the `code` CLI) etc.
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: os.homedir(),
    PORT: String(o.port),
    TERMINAL_WS_PORT: String(o.terminalWsPort),
    WEBCODE_BASE_PATH: o.base,
    TAILSCALE_SERVE: o.tailscaleServe ? "1" : "0",
  };
  const lines = [
    "[Unit]",
    `Description=webcode: browser VS Code / web terminal (${o.base})`,
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${REPO}`,
    ...Object.entries(env).map(([k, v]) => `Environment=${q(`${k}=${v}`)}`),
    // Route webcode.localhost to the fixed port if portless is installed;
    // a leading "-" lets the service start even if that fails.
    ...(existsSync(PORTLESS) ? [`ExecStartPre=-${q(PORTLESS)} alias webcode ${o.port} --force`] : []),
    `ExecStart=${q(process.execPath)} start.ts`,
    "Restart=always",
    "RestartSec=5",
    "KillMode=control-group",
    "TimeoutStopSec=20",
    `StandardOutput=append:${LOG}`,
    `StandardError=append:${LOG}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ];
  return lines.join("\n");
}

async function ensureLinger(): Promise<void> {
  const user = os.userInfo().username;
  const { out } = await run("loginctl", ["show-user", user, "-p", "Linger", "--value"]);
  if (out.trim() === "yes") return;
  if ((await run("loginctl", ["enable-linger", user])).code === 0) return;
  console.warn(
    `warning: could not enable lingering, so webcode starts only once you log in.\n` +
      `         Run once: sudo loginctl enable-linger ${user}`,
  );
}

/** start.ts registers the Tailscale Serve route itself, which needs operator rights. */
async function checkTailscaleOperator(): Promise<void> {
  const { code, out } = await run("tailscale", ["debug", "prefs"]);
  if (code !== 0) return; // no tailscale, or not running: start.ts logs it
  let operator = "";
  try {
    operator = JSON.parse(out).OperatorUser ?? "";
  } catch {
    return;
  }
  const user = os.userInfo().username;
  if (operator !== user) {
    console.warn(
      `warning: '${user}' is not the Tailscale operator, so the tailnet route can't be registered.\n` +
        `         Run once: sudo tailscale set --operator=${user}`,
    );
  }
}

export const systemd: ServiceAdapter = {
  kind: "systemd user unit",
  name: UNIT,
  logFile: LOG,

  async status(): Promise<ServiceStatus> {
    const { out } = await systemctl("show", UNIT, "-p", "LoadState,ActiveState,SubState");
    const p = Object.fromEntries(out.split("\n").map((l) => l.split("=", 2) as [string, string]));
    if (p.LoadState !== "loaded") return { state: "not-installed", detail: "not installed" };
    return {
      state: p.ActiveState === "active" ? "running" : "stopped",
      detail: `${p.ActiveState} (${p.SubState})`,
    };
  },

  async config(): Promise<ServiceConfig> {
    let text: string;
    try {
      text = readFileSync(UNIT_FILE, "utf8");
    } catch {
      return {};
    }
    const env = (k: string) => new RegExp(`^Environment="${k}=([^"]*)"`, "m").exec(text)?.[1];
    return { base: env("WEBCODE_BASE_PATH"), port: Number(env("PORT")) || undefined };
  },

  async install(o) {
    mkdirSync(UNIT_DIR, { recursive: true });
    mkdirSync(path.dirname(LOG), { recursive: true });
    writeFileSync(UNIT_FILE, unitFile(o));
    console.log(`wrote    : ${UNIT_FILE}`);
    for (const args of [["daemon-reload"], ["enable", UNIT], ["restart", UNIT]]) {
      const r = await systemctl(...args);
      if (r.code !== 0) {
        console.error(`systemctl --user ${args.join(" ")} failed:\n${r.out}`);
        return 1;
      }
    }
    await ensureLinger();
    if (o.tailscaleServe) await checkTailscaleOperator();
    return 0;
  },

  async uninstall() {
    await systemctl("disable", "--now", UNIT);
    rmSync(UNIT_FILE, { force: true });
    await systemctl("daemon-reload");
    if (existsSync(PORTLESS)) await run(PORTLESS, ["alias", "--remove", "webcode"]);
    console.log(`Removed ${UNIT}.`);
    return 0;
  },

  async start() {
    const r = await systemctl("start", UNIT);
    if (r.code !== 0) console.error(r.out);
    return r.code;
  },

  async stop() {
    const r = await systemctl("stop", UNIT);
    if (r.code !== 0) console.error(r.out);
    return r.code;
  },
};
