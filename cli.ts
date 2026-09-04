#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type Config = {
  basePath?: string;
  port?: number;
  tailscale?: boolean;
  allowedHost?: string;
};

const configHome =
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
const configPath = path.join(configHome, "webcode", "config.json");

function normalizeBasePath(value: string): string {
  const segment = value.replace(/^\/+|\/+$/g, "");
  if (!segment || segment.split("/").some((part) => !part)) {
    throw new Error("the Tailscale path must contain at least one path segment");
  }
  return `/${segment}`;
}

function loadConfig(): Config {
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as Config;
  } catch {
    return {};
  }
}

function saveConfig(config: Config): void {
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}

function valueAfter(args: string[], flag: string, fallback: string): string {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

function tailscaleCommand(): string {
  const macAppCli = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  return process.platform === "darwin" && existsSync(macAppCli)
      ? macAppCli
      : "tailscale";
}

function runTailscale(args: string[]): void {
  const command = tailscaleCommand();
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new Error(
      "tailscale CLI was not found. On macOS, install CLI integration from Tailscale Settings → General, then retry.",
    );
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`tailscale serve exited with status ${result.status}`);
  }
}

function tailscaleDnsName(): string | undefined {
  const result = spawnSync(tailscaleCommand(), ["status", "--json"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return undefined;
  try {
    const status = JSON.parse(result.stdout) as { Self?: { DNSName?: string } };
    return status.Self?.DNSName?.replace(/\.$/, "");
  } catch {
    return undefined;
  }
}

function setupTailscale(args: string[]): void {
  const current = loadConfig();
  const basePath = normalizeBasePath(
    valueAfter(args, "--path", current.basePath || "/webcode"),
  );
  const portText = valueAfter(args, "--port", String(current.port || 3001));
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${portText}`);
  }

  // A target URL containing the mount path makes Serve add the prefix back
  // after matching/stripping --set-path. The backend therefore sees the same
  // /webcode/... paths as the browser, which is required by VS Code Web.
  const target = `http://127.0.0.1:${port}${basePath}`;
  runTailscale([
    "serve",
    "--bg",
    "--https=443",
    `--set-path=${basePath}`,
    target,
  ]);

  saveConfig({
    ...current,
    basePath,
    port,
    tailscale: true,
    allowedHost: tailscaleDnsName(),
  });
  console.log(`\nSaved ${configPath}`);
  console.log(`Run \`webcode\`; it will serve Webcode at ${basePath}/.`);
  console.log("Use `tailscale serve status` to see the full HTTPS URL.");
}

async function serve(): Promise<void> {
  const config = loadConfig();
  if (config.basePath && !process.env.WEB_CODE_BASE_PATH) {
    process.env.WEB_CODE_BASE_PATH = config.basePath;
  }
  if (config.port && !process.env.PORT) process.env.PORT = String(config.port);
  if (config.allowedHost && !process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS) {
    process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS = config.allowedHost;
  }
  await import("./start");
}

function help(): void {
  console.log(`webcode

Usage:
  webcode                         Start the Webcode server
  webcode serve                   Start the Webcode server
  webcode setup --tailscale       Mount it at /webcode with Tailscale Serve

Options for setup --tailscale:
  --path <path>                   URL mount path (default: /webcode)
  --port <port>                   Local Webcode port (default: 3001)

Configuration is stored at ${configPath}.`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    help();
    return;
  }
  if (args[0] === "setup") {
    if (!args.includes("--tailscale")) {
      throw new Error("setup currently requires --tailscale");
    }
    setupTailscale(args.slice(1));
    return;
  }
  if (args.length === 0 || (args.length === 1 && args[0] === "serve")) {
    await serve();
    return;
  }
  throw new Error(`unknown command: ${args.join(" ")}`);
}

main().catch((error) => {
  console.error(`webcode: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
