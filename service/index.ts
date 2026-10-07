import type { ServiceAdapter } from "./types";
import { hasOxmgr, oxmgrAdapter } from "./oxmgr";
import { systemd } from "./systemd";
import { windows } from "./windows";

export type { InstallOptions, ServiceAdapter } from "./types";

/** The service adapter for this OS, or null where none exists yet. */
export function serviceAdapter(): ServiceAdapter | null {
  switch (process.platform) {
    case "win32":
      return windows;
    case "linux":
      return systemd;
    case "darwin":
      return hasOxmgr() ? oxmgrAdapter : null;
    default:
      return null;
  }
}
