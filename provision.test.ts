import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function workspace() {
  const home = await mkdtemp(path.join(os.tmpdir(), "webcode-provision-"));
  homes.push(home);
  const folder = path.join(home, "ws", "owner", "repo", "tree", "main");
  await mkdir(path.dirname(folder), { recursive: true });
  return { home, folder };
}

async function provisionAt(home: string, recover = false) {
  // Isolate WS_ROOT from the user's actual workspace without mocking Git.
  const moduleUrl = new URL("./provision.ts", import.meta.url).href;
  const { stdout } = await execFileP(process.execPath, ["-e", `
    const { provision } = await import(${JSON.stringify(moduleUrl)});
    console.log(JSON.stringify(await provision({ owner: "owner", repo: "repo", branch: "main" }, ${recover})));
  `], { env: { ...process.env, HOME: home, USERPROFILE: home } }); // os.homedir() reads USERPROFILE on Windows
  return JSON.parse(stdout);
}

test("flags missing Git metadata and preserves files until recovery is requested", async () => {
  const { home, folder } = await workspace();
  await mkdir(folder);
  await writeFile(path.join(folder, "README.md"), "local work\n");
  expect(await provisionAt(home)).toMatchObject({
    ok: false, reason: "missing-git", action: "error", folder,
  });
  expect(await readFile(path.join(folder, "README.md"), "utf8")).toBe("local work\n");
  expect(await readdir(folder)).toEqual(["README.md"]);
});

async function localRemote(home: string, branch: string) {
  const remote = path.join(home, "remote");
  await mkdir(remote);
  const git = (args: string[]) => execFileP("git", args, { cwd: remote });
  await git(["init", "-b", branch]);
  await git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Initial"]);
  await writeFile(path.join(home, ".gitconfig"),
    // Forward slashes: git config treats backslashes as escapes (Windows paths).
    `[url "${remote.replace(/\\/g, "/")}"]\n\tinsteadOf = https://github.com/owner/repo\n`);
}

test("recovery preserves the original files in a backup and clones a real checkout", async () => {
  const { home, folder } = await workspace();
  await mkdir(folder);
  await writeFile(path.join(folder, "local.txt"), "unsaved work");
  await localRemote(home, "main");
  const result = await provisionAt(home, true);
  expect(result).toMatchObject({ ok: true, action: "cloned", folder });
  expect(await readFile(path.join(result.backup, "local.txt"), "utf8")).toBe("unsaved work");
  const { stdout } = await execFileP("git", ["-C", folder, "branch", "--show-current"]);
  expect(stdout.trim()).toBe("main");
});

test("failed recovery still reports the preserved backup", async () => {
  const { home, folder } = await workspace();
  await mkdir(folder);
  await writeFile(path.join(folder, "local.txt"), "unsaved work");
  await localRemote(home, "other");
  const result = await provisionAt(home, true);
  expect(result).toMatchObject({ ok: false, reason: "branch-not-found" });
  expect(await readFile(path.join(result.backup, "local.txt"), "utf8")).toBe("unsaved work");
});

test("does not report a file at the destination as a usable workspace", async () => {
  const { home, folder } = await workspace();
  await writeFile(folder, "keep me");
  expect(await provisionAt(home)).toMatchObject({ ok: false, action: "error" });
  expect(await readFile(folder, "utf8")).toBe("keep me");
});
