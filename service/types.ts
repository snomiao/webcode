/**
 * A platform adapter for running webcode as a boot-time background service.
 * `webcode service …` (cli.ts) is platform-neutral and delegates to one of
 * these: windows.ts (scheduled task), systemd.ts (Linux user unit). A macOS
 * launchd adapter would implement the same interface.
 */

export type ServiceState = "running" | "stopped" | "not-installed";

export interface ServiceStatus {
  state: ServiceState;
  /** Native state string, e.g. "Ready" or "activating (auto-restart)". */
  detail: string;
}

/** Settings the service was installed with (what start.ts runs under). */
export interface ServiceConfig {
  /** Fixed vite shell port. */
  port?: number;
  /** WEBCODE_BASE_PATH, e.g. "/webcode". */
  base?: string;
}

export interface InstallOptions {
  port: number;
  terminalWsPort: number;
  base: string;
  tailscaleServe: boolean;
}

export interface ServiceAdapter {
  /** Shown in `status`, e.g. "systemd user unit". */
  kind: string;
  name: string;
  status(): Promise<ServiceStatus>;
  config(): Promise<ServiceConfig>;
  /** Register (replacing any previous install) and start at boot. */
  install(opts: InstallOptions): Promise<number>;
  uninstall(): Promise<number>;
  start(): Promise<number>;
  stop(): Promise<number>;
  logFile: string;
}
