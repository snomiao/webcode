import type { ServiceAdapter } from "./types";
import { systemd } from "./systemd";
import { windows } from "./windows";

export type { InstallOptions, ServiceAdapter } from "./types";

/** The service adapter for this OS, or null where none exists yet (macOS: launchd). */
export function serviceAdapter(): ServiceAdapter | null {
  switch (process.platform) {
    case "win32":
      return windows;
    case "linux":
      return systemd;
    default:
      return null;
  }
}
