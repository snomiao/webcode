import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The webcode checkout (parent of service/). */
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LOG = path.join(REPO, ".logs", "webcode.log");
export const SERVICE = process.env.WEBCODE_SERVICE || "webcode";

export function run(cmd: string, args: string[], timeout = 30_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
