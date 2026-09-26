/**
 * Windows: a boot-time scheduled task (S4U: runs as you, no stored password)
 * rather than a Windows service, which would need your password. The task
 * runs serve.ps1; install-windows-service.ps1 registers it (needs UAC).
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import type { InstallOptions, ServiceAdapter, ServiceConfig, ServiceStatus } from "./types";
import { LOG, REPO, run, SERVICE, sleep } from "./util";

async function taskState(): Promise<string | null> {
  const { code, out } = await run("schtasks.exe", ["/query", "/tn", SERVICE, "/fo", "csv", "/nh"]);
  if (code !== 0) return null;
  // e.g. "\webcode","N/A","Running"
  const first = out.split(/\r?\n/)[0] ?? "";
  return /"([^"]*)"\s*$/.exec(first)?.[1] ?? "Unknown";
}

async function waitForState(want: string, timeoutMs = 30_000): Promise<string | null> {
  const until = Date.now() + timeoutMs;
  let state = await taskState();
  while (state !== want && Date.now() < until) {
    await sleep(500);
    state = await taskState();
  }
  return state;
}

/** Run install-windows-service.ps1 elevated (one UAC prompt). */
function elevated(extraArgs: string): number {
  const script = path.join(REPO, "install-windows-service.ps1");
  // Pass the unelevated caller so the task runs as them even if UAC elevates
  // into a different admin account. On failure, keep the window open.
  const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  const inner =
    `try { & '${script}' -User '${user}'${extraArgs}; Start-Sleep 3; exit 0 } ` +
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
  return r.status ?? 1;
}

export const windows: ServiceAdapter = {
  kind: "scheduled task",
  name: SERVICE,
  logFile: LOG,

  async status(): Promise<ServiceStatus> {
    const s = await taskState();
    if (s === null) return { state: "not-installed", detail: "not installed" };
    return { state: s === "Running" ? "running" : "stopped", detail: s.toLowerCase() };
  },

  /** Settings the task was installed with (launcher args in the task XML). */
  async config(): Promise<ServiceConfig> {
    const { code, out } = await run("schtasks.exe", ["/query", "/tn", SERVICE, "/xml"]);
    if (code !== 0) return {};
    const args = /<Arguments>([^<]*)<\/Arguments>/.exec(out)?.[1]?.replace(/&quot;/g, '"') ?? "";
    const base = /-Base\s+"?([^"\s]+)"?/.exec(args)?.[1];
    const port = Number(/-Port\s+(\d+)/.exec(args)?.[1]) || undefined;
    return { base, port };
  },

  async install(o: InstallOptions) {
    return elevated(
      ` -Port ${o.port} -TerminalWsPort ${o.terminalWsPort} -Base '${o.base}' -TailscaleServe ${o.tailscaleServe ? 1 : 0}`,
    );
  },

  async uninstall() {
    return elevated(" -Uninstall");
  },

  async start() {
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
    return 0;
  },

  async stop() {
    // Ending the task kills the launcher; its kill-on-close job object (see
    // serve.ps1) takes down vite, code serve-web, wtx and their shells with it.
    if ((await taskState()) === "Running") await run("schtasks.exe", ["/end", "/tn", SERVICE]);
    return (await waitForState("Ready")) === "Ready" ? 0 : 1;
  },
};
