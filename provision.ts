/**
 * Repo provisioning for the web-code gateway.
 *
 * Maps a GitHub-style path `<owner>/<repo>/tree/<branch>` to a local
 * worktree under `~/ws/<owner>/<repo>/tree/<branch>` and ensures it
 * exists & is reasonably fresh:
 *
 *   - missing  -> `git clone --branch <branch> --single-branch
 *                  --recurse-submodules https://github.com/<owner>/<repo>`
 *                  into that dir (independent clone per branch)
 *   - present  -> `git fetch --prune`; then `git pull --ff-only` **only
 *                  if** the worktree is clean and fast-forwardable —
 *                  otherwise fetch-only (never clobber local work)
 *
 * After a clone, branch creation, or a pull that advanced the checkout, the
 * cross-platform `setup-repo.sh` runs via Bun Shell (`bun setup-repo.sh`):
 * it updates submodules and installs dependencies for whichever ecosystem(s)
 * the repo uses (JS via its pinned lockfile, Rust, Go, Python, Ruby). For any
 * non-`main` branch we also seed `.env.local` from the sibling `tree/main`
 * worktree (seed-once: never overwrites one already in the branch).
 *
 * All git invocations use `execFile` (argv array, no shell) and every
 * path segment is validated, so a hostile `owner`/`repo`/`branch` can't
 * inject options or escape `~/ws`.
 */

import watcher from "@parcel/watcher";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const WS_ROOT = path.join(os.homedir(), "ws");
const GIT_TIMEOUT_MS = 120_000;
// Dependency installs / builds can be slow; give the setup script its own
// generous budget.
const SETUP_TIMEOUT_MS = 600_000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETUP_SCRIPT = path.join(HERE, "setup-repo.sh");

export type RepoSpec = { owner: string; repo: string; branch: string };

export type GitStatus = {
  branch: string;
  head: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  hasUpstream: boolean;
};

/**
 * Why a provision failed, when we can tell:
 *   - "branch-not-found": repo exists on the remote but the branch does
 *     not — the shell offers a "Create branch" action for this.
 *   - "repo-not-found": the remote repo itself is missing/inaccessible.
 *   - "other": anything else (network, auth, disk, …).
 */
export type FailReason = "branch-not-found" | "repo-not-found" | "missing-git" | "other";

export type ProvisionResult = {
  ok: boolean;
  spec: RepoSpec;
  /** Absolute local worktree path (the VS Code `?folder=` target). */
  folder: string;
  existed: boolean;
  action: "cloned" | "pulled" | "fetched" | "created" | "none" | "error";
  git?: GitStatus;
  error?: string;
  reason?: FailReason;
  backup?: string;
};

/**
 * A provisioning progress update, streamed to the client while a clone or
 * setup runs. `text` is the latest output line; `percent` is set only when
 * the tool reports one (git's `Receiving objects:  45% (…)`), so the UI can
 * fall back to an indeterminate bar.
 */
export type ProvisionProgress = {
  phase: "clone" | "setup";
  text: string;
  percent?: number;
};

// Credential shapes that can surface in git/install output (auth'd remote
// URLs, tokens echoed by a failing install, env dumps). Everything streamed or
// returned to the browser goes through `redact` first.
const SECRET_PATTERNS: [RegExp, string][] = [
  // userinfo in URLs: https://user:token@host, https://token@host
  [/(\b[a-z][\w+.-]*:\/\/)[^\s/@]+@/gi, "$1***@"],
  // GitHub, npm, Slack, OpenAI/Anthropic-style, AWS, GitLab tokens
  [/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/g, "$1***"],
  [/\bnpm_[A-Za-z0-9]{20,}/g, "npm_***"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "xox*-***"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-***"],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "$1***"],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, "glpat-***"],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "***.jwt"],
  // Authorization headers
  [/\b(authorization:\s*(?:bearer|basic|token)\s+)\S+/gi, "$1***"],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1***"],
  // key=value / key: value where the key looks secret-ish
  [
    /\b([\w.-]*(?:token|secret|passw(?:or)?d|api[_-]?key|auth|credential|private[_-]?key)[\w.-]*\s*[=:]\s*)(["']?)[^\s"']+\2/gi,
    "$1$2***$2",
  ],
];

export function redact(s: string): string {
  for (const [re, rep] of SECRET_PATTERNS) s = s.replace(re, rep);
  return s;
}

function classifyError(msg: string): FailReason {
  if (/remote branch .* not found/i.test(msg)) return "branch-not-found";
  if (/repository .* not found|could not read from remote/i.test(msg))
    return "repo-not-found";
  return "other";
}

/** Parse `<owner>/<repo>/tree/<branch>` (branch may contain slashes). */
export function parseSpec(p: string): RepoSpec | null {
  const clean = decodeURIComponent(p).replace(/^\/+/, "").replace(/\/+$/, "");
  const m = clean.match(/^([^/]+)\/([^/]+)\/tree\/(.+)$/);
  if (!m) return null;
  const [, owner, repo, branch] = m;
  if (![owner, repo, ...branch.split("/")].every(isSafeSegment)) return null;
  return { owner, repo, branch };
}

/** A path segment that can't traverse, hide options, or inject control. */
function isSafeSegment(s: string): boolean {
  return (
    s.length > 0 &&
    s !== "." &&
    s !== ".." &&
    !s.startsWith("-") && // no option injection (e.g. branch "--upload-pack=…")
    !/[/\\\0]/.test(s) &&
    !/[\x00-\x1f]/.test(s)
  );
}

export function folderFor(spec: RepoSpec): string {
  return path.join(WS_ROOT, spec.owner, spec.repo, "tree", spec.branch);
}

async function git(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileP("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    // Force git's error messages to stable English regardless of the daemon's
    // locale, so `classifyError`'s regexes match (a zh_TW/ja_JP daemon emits
    // e.g. "找不到遠端分支" instead of "Remote branch ... not found", which
    // would otherwise be misclassified as "other" and hide the Create-branch
    // affordance). LC_ALL=C is load-bearing here — gettext ignores LANGUAGE
    // once the locale resolves to C. `env` replaces (not merges), so spread.
    env: { ...process.env, LC_ALL: "C", LANG: "C", LANGUAGE: "C" },
  });
}

// git's in-place progress redraws, e.g. `Receiving objects:  45% (450/1000)`.
const PROGRESS_RE = /^(remote: )?[\w ]+:\s+(\d{1,3})%/;

/**
 * Like `execFile`, but streams stdout/stderr to `onLine` line by line (git's
 * `\r` progress redraws count as lines) instead of buffering until exit.
 * Resolves with the non-progress stderr; rejects like execFile
 * (`{ message, stderr }`) on a non-zero exit or timeout.
 */
function runStreaming(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number; env?: NodeJS.ProcessEnv },
  onLine: (line: string) => void,
): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const kept: string[] = []; // stderr minus progress noise, for errors
    const handle = (line: string, isErr: boolean) => {
      const t = line.trimEnd();
      if (!t) return;
      onLine(t);
      if (isErr && !PROGRESS_RE.test(t)) {
        kept.push(t);
        if (kept.length > 200) kept.shift();
      }
    };
    const feed = (stream: NodeJS.ReadableStream, isErr: boolean) => {
      let buf = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        buf += chunk;
        const parts = buf.split(/\r\n|\r|\n/);
        buf = parts.pop()!;
        for (const l of parts) handle(l, isErr);
      });
      stream.on("end", () => buf && handle(buf, isErr));
    };
    feed(child.stdout!, false);
    feed(child.stderr!, true);
    const timer = setTimeout(() => child.kill(), opts.timeout);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const stderr = kept.join("\n");
      if (code === 0) resolve({ stderr });
      else reject({ message: `${cmd} exited with ${signal ?? code}`, stderr });
    });
  });
}

/** Read ahead/behind/dirty for a worktree (assumes it is a git dir). */
async function readStatus(dir: string): Promise<GitStatus> {
  // porcelain=v2 --branch gives `# branch.*` headers + entries.
  const { stdout } = await git(dir, ["status", "--porcelain=v2", "--branch"]);
  let branch = "";
  let head = "";
  let ahead = 0;
  let behind = 0;
  let hasUpstream = false;
  let dirty = false;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("# branch.head ")) branch = line.slice(14).trim();
    else if (line.startsWith("# branch.oid ")) head = line.slice(13).trim();
    else if (line.startsWith("# branch.ab ")) {
      hasUpstream = true;
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (line && !line.startsWith("#") && !line.startsWith("?")) {
      dirty = true; // tracked changes only (untracked files don't count)
    }
  }
  return { branch, head: head.slice(0, 12), ahead, behind, dirty, hasUpstream };
}

/** Git status for an existing worktree, or null if it isn't provisioned. */
export async function statusOf(spec: RepoSpec): Promise<GitStatus | null> {
  const folder = folderFor(spec);
  if (!existsSync(path.join(folder, ".git"))) return null;
  try {
    return await readStatus(folder);
  } catch {
    return null;
  }
}

/**
 * One shared native watcher per worktree, fanned out to many subscribers.
 * Recursive watch over a large tree (and the `git status` it triggers) is
 * expensive, so N browser tabs on the same repo must NOT each spin one up —
 * that starves the single-threaded dev server. We keep a per-folder registry:
 * the first subscriber creates the watcher, the last to leave tears it down,
 * and every change recomputes status once and broadcasts it.
 */
/**
 * A watch notification. `activity` is true for every (debounced) filesystem
 * burst — the signal the UI uses to show a "working" spinner. `status` is
 * present only when the git status actually changed since the last burst (or
 * for the snapshot handed to a brand-new subscriber), so the wire stays quiet
 * when nothing meaningful moved.
 */
export type StatusEvent = { activity: boolean; status?: GitStatus };

type WatchEntry = {
  subscribers: Set<(e: StatusEvent) => void>;
  last?: GitStatus;
  teardown: () => Promise<void>;
};
const watches = new Map<string, WatchEntry>();

/**
 * Subscribe to live git status for `spec`'s worktree. `onChange` fires with a
 * fresh `GitStatus` whenever the working tree or index may have changed (and
 * immediately with the last-known status, if any). Native recursive watch via
 * @parcel/watcher (FSEvents / inotify / ReadDirectoryChangesW); node_modules
 * and `.git/objects` churn are ignored, but `.git/index` & `.git/HEAD` are
 * watched so stage/commit/checkout transitions are caught; bursts are
 * debounced before the (fast) `git status`. Returns an unsubscribe fn; the
 * underlying watcher is shared and only torn down when the last subscriber
 * leaves. Best-effort: errors are swallowed.
 */
export async function watchStatus(
  spec: RepoSpec,
  onChange: (e: StatusEvent) => void,
): Promise<() => Promise<void>> {
  const folder = folderFor(spec);
  let entry = watches.get(folder);

  if (!entry) {
    // Register synchronously (before the async subscribe) so a second
    // concurrent caller joins this entry instead of creating a rival watcher.
    const subscribers = new Set<(e: StatusEvent) => void>();
    entry = { subscribers, teardown: async () => {} };
    watches.set(folder, entry);

    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastKey = "";
    let pendingWorkingTree = false; // did a non-.git file change this burst?
    const schedule = (workingTree: boolean) => {
      if (workingTree) pendingWorkingTree = true;
      // .git-only events (VS Code git polling) must not extend the debounce
      // window if a timer is already running — otherwise the timer never
      // settles and the spinner never fires. Working-tree events always
      // restart the window; .git-only events only start a fresh one.
      if (workingTree || !timer) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          timer = null;
          const activity = pendingWorkingTree;
          pendingWorkingTree = false;
          try {
            const status = await readStatus(folder);
            const key = JSON.stringify(status);
            const changed = key !== lastKey;
            if (changed) {
              lastKey = key;
              entry!.last = status;
            }
            // Stay silent when neither the working tree nor the status moved.
            if (!activity && !changed) return;
            for (const cb of subscribers)
              cb({ activity, status: changed ? status : undefined });
          } catch {
            // worktree vanished mid-watch, or a transient git lock — ignore
          }
        }, 300);
      }
    };
    try {
      const sub = await watcher.subscribe(
        folder,
        (err, events) => {
          if (err) return;
          // A change outside .git is a real edit (spins the title); .git-only
          // bursts still recompute status but don't spin.
          const workingTree = events.some(
            (e) => !/[\\/]\.git[\\/]/.test(e.path),
          );
          schedule(workingTree);
        },
        {
          ignore: [
            "**/node_modules/**",
            "**/.git/objects/**",
            "**/.git/lfs/**",
          ],
        },
      );
      entry.teardown = async () => {
        if (timer) clearTimeout(timer);
        await sub.unsubscribe();
      };
    } catch {
      // watcher unavailable — drop the entry so a later call can retry
      watches.delete(folder);
      throw new Error("watch unavailable");
    }
  }

  entry.subscribers.add(onChange);
  // Hand the newcomer current state at once (no `activity` → no spurious spin).
  if (entry.last) onChange({ activity: false, status: entry.last });

  return async () => {
    const e = watches.get(folder);
    if (!e) return;
    e.subscribers.delete(onChange);
    if (e.subscribers.size === 0) {
      watches.delete(folder);
      await e.teardown();
    }
  };
}

/**
 * Run the cross-platform repo setup script (`setup-repo.sh`) in a worktree
 * via Bun Shell — `bun <script>` interprets the `.sh` with Bun's own shell,
 * so it works identically on Windows. The script updates submodules and
 * installs dependencies for whichever ecosystem(s) the repo uses (JS via the
 * pinned package manager, Rust, Go, Python, Ruby). Best-effort: a failed or
 * slow install must not fail provisioning — the editor still opens and the
 * user can re-run setup from the integrated terminal.
 */
async function runRepoSetup(
  dir: string,
  onLine: (line: string) => void = () => {},
): Promise<void> {
  try {
    await runStreaming(
      "bun",
      [SETUP_SCRIPT],
      { cwd: dir, timeout: SETUP_TIMEOUT_MS },
      onLine,
    );
  } catch {
    // best-effort
  }
}

/**
 * Fire-and-forget remote refresh for an existing worktree: `git fetch`, then
 * `git pull --ff-only` if it's safe (clean, behind, not ahead), then re-run
 * setup if the checkout actually advanced. Runs detached from the request so a
 * slow fetch never blocks the editor opening; the file watcher broadcasts any
 * resulting status change to the live UI. Best-effort — errors are swallowed.
 */
async function refreshInBackground(folder: string): Promise<void> {
  try {
    await git(folder, ["fetch", "--prune", "origin"]);
    const st = await readStatus(folder);
    if (st.hasUpstream && !st.dirty && st.behind > 0 && st.ahead === 0) {
      const before = st.head;
      await git(folder, ["pull", "--ff-only"]);
      const after = await readStatus(folder);
      if (after.head !== before) await runRepoSetup(folder);
    }
  } catch {
    // network/auth/lock hiccup — leave the worktree as-is
  }
}

/**
 * Seed a non-`main` branch worktree's `.env.local` from the sibling
 * `tree/main` worktree, so feature checkouts inherit the local (gitignored)
 * env without re-entry. Seed-once: skips if the branch already has one, so
 * per-branch edits are never clobbered. Always reads `tree/main` directly
 * (not `../main`) so branches containing `/` resolve correctly.
 */
async function seedEnvLocal(spec: RepoSpec, folder: string): Promise<void> {
  if (spec.branch === "main") return;
  const src = path.join(
    WS_ROOT,
    spec.owner,
    spec.repo,
    "tree",
    "main",
    ".env.local",
  );
  const dest = path.join(folder, ".env.local");
  if (!existsSync(src) || existsSync(dest)) return;
  try {
    await copyFile(src, dest);
  } catch {
    // best-effort — a locked/disappearing source must not fail provisioning
  }
}

type ProvisionJob = {
  promise: Promise<ProvisionResult>;
  listeners: Set<(p: ProvisionProgress) => void>;
  last?: ProvisionProgress;
};
// In-flight provisions by worktree folder: a second tab opening the same repo
// mid-clone joins the running job (and its progress) instead of racing a
// second clone into the same directory.
const jobs = new Map<string, ProvisionJob>();
const PROGRESS_THROTTLE_MS = 150;

/**
 * Ensure the worktree for `spec` exists and is fresh. Never throws —
 * failures are returned as `{ ok:false, action:"error", error }`.
 * `recover` backs up a populated folder that lacks `.git` before cloning.
 * `onProgress` receives clone/setup output while a fresh clone runs.
 */
export function provision(
  spec: RepoSpec,
  recover = false,
  onProgress?: (p: ProvisionProgress) => void,
): Promise<ProvisionResult> {
  const folder = folderFor(spec);
  const job = jobs.get(folder);
  if (job) {
    if (onProgress && job.last) onProgress(job.last);
  } else {
    const j: ProvisionJob = {
      promise: undefined as unknown as Promise<ProvisionResult>,
      listeners: new Set(),
    };
    // git redraws progress many times a second; forward at most one update
    // per PROGRESS_THROTTLE_MS (always the latest), but phase changes at once.
    let pending: ProvisionProgress | undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      if (!pending) return;
      j.last = pending;
      pending = undefined;
      for (const l of j.listeners) l(j.last);
    };
    const emit = (raw: ProvisionProgress) => {
      const p = { ...raw, text: redact(raw.text).slice(0, 300) };
      const phaseChanged = (pending ?? j.last)?.phase !== p.phase;
      pending = p;
      if (phaseChanged) {
        if (timer) clearTimeout(timer);
        flush();
      } else if (!timer) timer = setTimeout(flush, PROGRESS_THROTTLE_MS);
    };
    // Register before starting so no early update is missed.
    if (onProgress) j.listeners.add(onProgress);
    j.promise = doProvision(spec, folder, recover, emit).finally(() => {
      if (timer) clearTimeout(timer);
      jobs.delete(folder);
    });
    jobs.set(folder, j);
    return j.promise;
  }
  if (onProgress) {
    const { listeners } = job;
    listeners.add(onProgress);
    void job.promise.finally(() => listeners.delete(onProgress));
  }
  return job.promise;
}

async function doProvision(
  spec: RepoSpec,
  folder: string,
  recover: boolean,
  emit: (p: ProvisionProgress) => void,
): Promise<ProvisionResult> {
  const base: Omit<ProvisionResult, "action"> & {
    action: ProvisionResult["action"];
  } = {
    ok: false,
    spec,
    folder,
    existed: existsSync(path.join(folder, ".git")),
    action: "none",
  };

  try {
    if (!base.existed) {
      // Files alone don't mean provisioning succeeded. Preserve them before
      // retrying, and only move them on an explicit recovery request.
      const entries = await readdir(folder).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      if (entries.length > 0) {
        if (!recover) {
          return {
            ...base, ok: false, action: "error", reason: "missing-git",
            error: "This folder contains files but has no .git metadata. Back up the folder and provision again to restore a Git checkout.",
          };
        }
        const backupDir = await mkdtemp(`${folder}.backup-`);
        const backup = path.join(backupDir, "workspace");
        await rename(folder, backup);
        base.backup = backup;
      }

      // Clone this branch independently into the worktree path.
      await mkdir(path.dirname(folder), { recursive: true });
      const url = `https://github.com/${spec.owner}/${spec.repo}`;
      emit({ phase: "clone", text: `git clone ${url}` });
      await runStreaming(
        "git",
        [
          "clone",
          "--progress", // stderr isn't a TTY; force the progress lines
          "--branch",
          spec.branch,
          "--single-branch",
          "--recurse-submodules",
          "--",
          url,
          folder,
        ],
        // LC_ALL=C: see git() — classifyError matches English messages.
        {
          cwd: WS_ROOT,
          timeout: GIT_TIMEOUT_MS,
          env: { ...process.env, LC_ALL: "C", LANG: "C", LANGUAGE: "C" },
        },
        (text) => {
          const m = PROGRESS_RE.exec(text);
          emit({ phase: "clone", text, percent: m ? Number(m[2]) : undefined });
        },
      );
      await seedEnvLocal(spec, folder);
      emit({ phase: "setup", text: "running setup-repo.sh" });
      await runRepoSetup(folder, (text) => emit({ phase: "setup", text }));
      const git2 = await readStatus(folder);
      return { ...base, ok: true, action: "cloned", git: git2 };
    }

    // Present: return the current local status immediately, then refresh from
    // the remote in the BACKGROUND. A `git fetch` on a large, actively-pushed
    // repo can be slow, and blocking the response on it stalls the editor
    // opening (and trips the proxy's upstream timeout → 502). The watcher
    // pushes any pull-induced changes live, so the UI still converges.
    await seedEnvLocal(spec, folder);
    const current = await readStatus(folder);
    void refreshInBackground(folder);
    return { ...base, ok: true, action: "fetched", git: current };
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    const error = redact((err.stderr || err.message || String(e)).trim()).slice(0, 600);
    return {
      ...base,
      ok: false,
      action: "error",
      error,
      reason: classifyError(error),
    };
  }
}

/**
 * Create `spec.branch` locally (no push) for a repo whose remote branch
 * doesn't exist yet. Clones the repo's default branch into the worktree
 * path, then `git switch -c <branch>`. Refuses if the worktree already
 * exists (use the normal provision path for that). Never throws.
 */
export async function createBranch(spec: RepoSpec): Promise<ProvisionResult> {
  const folder = folderFor(spec);
  const base = {
    ok: false as boolean,
    spec,
    folder,
    existed: existsSync(path.join(folder, ".git")),
    action: "none" as ProvisionResult["action"],
  };
  if (base.existed) {
    return {
      ...base,
      ok: false,
      action: "error",
      error: "worktree already exists",
    };
  }
  try {
    await mkdir(path.dirname(folder), { recursive: true });
    const url = `https://github.com/${spec.owner}/${spec.repo}`;
    // Clone the default branch (no --branch), then branch off it locally.
    await git(WS_ROOT, ["clone", "--recurse-submodules", "--", url, folder]);
    await git(folder, ["switch", "-c", spec.branch]);
    await seedEnvLocal(spec, folder);
    await runRepoSetup(folder);
    const status = await readStatus(folder);
    return { ...base, ok: true, action: "created", git: status };
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    const error = redact((err.stderr || err.message || String(e)).trim()).slice(0, 600);
    return {
      ...base,
      ok: false,
      action: "error",
      error,
      reason: classifyError(error),
    };
  }
}
