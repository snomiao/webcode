import { existsSync } from "node:fs";
import path from "node:path";

/** Locate the `tailscale` CLI: PATH first, then the stock install locations. */
export function findTailscale(): string | null {
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
    // macOS App Store / standalone app: the CLI lives inside the bundle and is
    // only on PATH if "Install CLI" was chosen in Tailscale's settings.
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/usr/bin/tailscale",
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}
