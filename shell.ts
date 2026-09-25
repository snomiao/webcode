/**
 * Client shell. Reads the pretty GitHub-style URL, asks the server to
 * provision the matching local worktree (clone if missing, fetch +
 * pull-if-clean if present), then embeds VS Code web for the folder the
 * server reports.
 *
 *   https://webcode.localhost/github.com/<owner>/<repo>/tree/<branch>
 *     -> GET /api/repo/<owner>/<repo>/tree/<branch>   (provision)
 *     -> iframe src = /_vscode/?folder=<local worktree>
 *
 * The bare ws root (empty path) skips provisioning and just opens
 * `~/<wsRoot>` so you can browse what's already checked out.
 */

import { appPath, appRelativePath } from "./app-base";

import {
  createBranchFromLocation,
  progressView,
  provisionFromLocation,
  statusNote,
  watchStatusLive,
  type Config,
  type GitStatus,
} from "./provision-client";

function setStatus(msg: HTMLElement, html: string) {
  msg.innerHTML = html;
  msg.hidden = false;
}

/**
 * Escape text for safe interpolation into innerHTML. The repo path comes
 * from `location.pathname` (attacker-controllable in a crafted link), so
 * it must never reach innerHTML unescaped — otherwise e.g.
 * `/%3Cimg%20onerror=...%3E/tree/main` would run script on this origin.
 */
function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );
}

// UI selector: `?ui=both` (the default) shows the web terminal and VS Code
// side by side, `?ui=vscode` only VS Code, `?ui=wtx` only the terminal.
const UI = new URLSearchParams(location.search).get("ui") || "both";
const SPLIT = UI === "both";

async function main() {
  // The terminal lives on its own page (terminal.html, a React/xterm bundle)
  // to keep the VS Code path a dependency-free iframe shell; `?ui=wtx` routes
  // there preserving the repo path so the same /api/repo provisioning applies.
  if (UI === "wtx") {
    // Hand off to the terminal page (a separate React/xterm bundle), passing
    // the repo path as `?repo=` so terminal.html is reached at a clean URL
    // (vite's SPA fallback otherwise wouldn't serve it under a repo path).
    const rel = repoPathFromLocation();
    location.replace(appPath(`terminal.html?repo=${encodeURIComponent(rel)}`));
    return;
  }

  const msg = document.getElementById("msg") as HTMLDivElement;
  const frame = document.getElementById("frame") as HTMLIFrameElement;

  // Force VS Code Web to use its built-in English NLS. With a non-English
  // OS locale (e.g. ja_JP) VS Code resolves the locale from `navigator.
  // language` and fetches `…/<locale>/nls.messages.js` from
  // www.vscode-unpkg.net — version-mismatched (`{0}` placeholders) and
  // CORS-blocked from the webcode origin, which aborts the workbench
  // bootstrap (blank editor, empty tree). The cookie rides the iframe's
  // own request so the editor sees `en` before computing the NLS URL.
  localStorage.setItem("vscode.nls.locale", "en");
  document.cookie = `vscode.nls.locale=en;path=${appPath()};max-age=3153600000`;

  let cfg: Config;
  try {
    cfg = await (await fetch(appPath("__config"))).json();
  } catch (e) {
    setStatus(msg, `Could not load /__config: ${e}`);
    return;
  }

  const rel = repoPathFromLocation();

  // Tag this tab with a unique, discoverable name so a duplicate tab can focus
  // *this* one via window.open("", name). Keyed by repo so it's human-meaningful.
  window.name = `web-code:${rel}#${Math.random().toString(36).slice(2, 8)}`;

  // Bare ws root: open it directly, no provisioning.
  if (!rel) {
    openVscode(frame, msg, cfg.wsRoot);
    return;
  }

  // Provision the repo via the API, surfacing progress + git status.
  const view = progressView(msg, rel);
  const result = await provisionFromLocation(rel, false, view.update);
  view.stop();

  if (!result.ok) {
    if (result.reason === "missing-git") {
      offerRecovery(msg, frame, rel, result.folder);
      return;
    }
    // Remote repo exists but the branch doesn't yet → offer to create it
    // locally (branched off the default branch, no push).
    if (result.reason === "branch-not-found") {
      const branch = rel.split("/tree/")[1] ?? rel;
      offerCreateBranch(msg, frame, rel, branch);
      return;
    }
    // Any other failure (backend down, bad/non-JSON response, network): show
    // the error but still offer to open VS Code at the expected worktree path,
    // so a flaky/dead provisioner never fully blocks you.
    offerOpenAnyway(
      msg,
      frame,
      rel,
      result.folder || `${cfg.wsRoot}/${rel}`,
      result.error,
    );
    return;
  }

  setTitle(rel, result.git);
  liveTitle(rel);
  setStatus(msg, `${esc(statusNote(result, rel))}. Opening…`);
  openVscode(frame, msg, result.folder);
}

/**
 * Accept both /github.com/<owner>/... and the legacy /<owner>/... shape.
 */
function repoPathFromLocation(): string {
  return decodeURIComponent(appRelativePath(location.pathname)).replace(
    /^github\.com\/+/,
    "",
  );
}

// Tab title controller.
//
// Settled: `[!] [↓behind] [↑ahead] <branch>@<repo>\<owner> - web-code` — `!` =
// uncommitted changes, `↓N`/`↑N` = commits behind/ahead upstream (each shown
// only when non-zero). While files are actively changing, a braille spinner
// replaces the flags; after SETTLE_MS of quiet it falls back to the flags.
// Classic ASCII spinner (renders in every tab font; braille can render blank).
const SPINNER = ["-", "/", "|", "\\"];
const SETTLE_MS = 5000;
const TS = {
  rel: "",
  git: undefined as GitStatus | undefined,
  spinUntil: 0,
  idx: 0,
  timer: null as ReturnType<typeof setInterval> | null,
  dup: false, // this repo is also open in another tab
};

function renderTitle() {
  const [ownerRepo, branch = TS.rel] = TS.rel.split("/tree/");
  const [owner = "", repo = ""] = (ownerRepo ?? "").split("/");
  // `⧉` marks a duplicate tab (same repo open elsewhere).
  const dup = TS.dup ? "⧉ " : "";
  // Spinner only animates in the foreground — a frozen frame in a background
  // tab would look broken, and you can't watch it anyway; backgrounded tabs
  // show the settled flags (the Slack-style at-a-glance signal).
  const spinning = Date.now() < TS.spinUntil && !document.hidden;
  let prefix: string;
  if (spinning) {
    prefix = `${dup}${SPINNER[TS.idx % SPINNER.length]} `;
  } else {
    const flags = [
      TS.git?.dirty ? "!" : "",
      TS.git && TS.git.ahead > 0 ? `↑${TS.git.ahead}` : "",
      TS.git && TS.git.behind > 0 ? `↓${TS.git.behind}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    prefix = `${dup}${flags ? `${flags} ` : ""}`;
  }
  document.title = `${prefix}${branch}@${repo}\\${owner} - web-code`;
}

function spinTick() {
  if (Date.now() >= TS.spinUntil || document.hidden) {
    if (TS.timer) {
      clearInterval(TS.timer);
      TS.timer = null;
    }
    renderTitle();
    return;
  }
  TS.idx++;
  renderTitle();
}

/** A filesystem change happened — spin until SETTLE_MS of quiet. */
function pokeActivity() {
  TS.spinUntil = Date.now() + SETTLE_MS;
  if (!TS.timer && !document.hidden) TS.timer = setInterval(spinTick, 120);
  renderTitle();
}

/** Set the (settled) title once, before live updates begin. */
function setTitle(rel: string, git?: GitStatus) {
  TS.rel = rel;
  if (git !== undefined) TS.git = git;
  renderTitle();
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (TS.timer) {
      clearInterval(TS.timer);
      TS.timer = null;
    }
  } else if (Date.now() < TS.spinUntil && !TS.timer) {
    TS.timer = setInterval(spinTick, 120);
  }
  renderTitle();
});

/**
 * Keep the title live: subscribe to the worktree's status (over the
 * shared-worker WebSocket, multiplexed across all tabs). Any filesystem change
 * spins the title; git status changes update the settled flags. Works while
 * backgrounded, so the title is a Slack-style at-a-glance indicator.
 */
function liveTitle(rel: string) {
  TS.rel = rel;
  // Live status is a non-essential enhancement — never let it block opening the
  // editor. (A throw here would otherwise skip openVscode and leave the shell
  // stuck on "Provisioning…".)
  try {
    watchStatusLive(rel, (ev) => {
      if (ev.status) TS.git = ev.status;
      if (ev.presence != null) {
        // We're a duplicate when another tab is the canonical (primary) one.
        const isDup =
          ev.presence >= 2 &&
          !!ev.primaryName &&
          ev.primaryName !== window.name;
        TS.dup = isDup;
        if (isDup) showDupBanner(ev.primaryName!);
        else hideDupBanner();
      }
      if (ev.activity) pokeActivity();
      else renderTitle();
    });
  } catch (e) {
    console.error("[web-code] live status unavailable:", e);
  }
}

let dupBanner: HTMLDivElement | null = null;

/**
 * This repo is already open in another (primary) tab. Offer to jump to it.
 * Focus works only via a named-window handle — `window.open("", primaryName)`
 * brings the uniquely-named primary tab forward (plain `window.focus()` on a
 * background tab is blocked by browsers). Then close this duplicate.
 */
function showDupBanner(primaryName: string) {
  if (dupBanner) return;
  const b = document.createElement("div");
  b.style.cssText =
    "position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;" +
    "background:#3a2d00;color:#ffd479;border:1px solid #6b5300;padding:.4rem .7rem;" +
    "border-radius:6px;font:13px -apple-system,BlinkMacSystemFont,sans-serif;" +
    "box-shadow:0 2px 10px rgba(0,0,0,.5)";
  b.innerHTML =
    `⧉ Also open in another tab. ` +
    `<a href="#" id="dup-go" style="color:#ffd479;font-weight:600">Switch &amp; close</a>` +
    ` · <a href="#" id="dup-x" style="color:#bbb;text-decoration:none">dismiss</a>`;
  document.body.appendChild(b);
  dupBanner = b;
  b.querySelector("#dup-go")?.addEventListener("click", (e) => {
    e.preventDefault();
    window.open("", primaryName); // focus the canonical tab by its window.name
    window.close(); // close this duplicate (works if it was script-opened)
  });
  b.querySelector("#dup-x")?.addEventListener("click", (e) => {
    e.preventDefault();
    hideDupBanner();
  });
}

function hideDupBanner() {
  dupBanner?.remove();
  dupBanner = null;
}

/**
 * Provisioning failed for a reason we can't auto-handle (backend down, bad
 * response, network). Surface the error and offer to open VS Code at the
 * expected worktree path anyway — the editor still works against whatever is
 * (or isn't) on disk, so a dead/flaky provisioner never fully blocks you.
 */
function offerOpenAnyway(
  msg: HTMLElement,
  frame: HTMLIFrameElement,
  rel: string,
  folder: string,
  error?: string,
) {
  setStatus(
    msg,
    `<strong>Could not provision <code>${esc(rel)}</code></strong>` +
      `<br><pre>${esc(error || "unknown error")}</pre>` +
      `<button id="open-anyway">Open VS Code anyway</button>` +
      `<p style="opacity:.6;font-size:.9em">Opens <code>${esc(folder)}</code> directly — may be empty or stale if provisioning didn't finish.</p>`,
  );
  msg
    .querySelector<HTMLButtonElement>("#open-anyway")
    ?.addEventListener("click", () => {
      setTitle(rel);
      liveTitle(rel);
      openVscode(frame, msg, folder);
    });
}

/** Render a "Create branch" affordance and wire it to the create API. */
function offerCreateBranch(
  msg: HTMLElement,
  frame: HTMLIFrameElement,
  rel: string,
  branch: string,
) {
  const b = esc(branch);
  setStatus(
    msg,
    `<p>Branch <code>${b}</code> doesn't exist on the remote yet.</p>` +
      `<button id="create-branch">Create branch <code>${b}</code> locally</button>` +
      `<p style="opacity:.6;font-size:.9em">Branches off the repo's default branch. Not pushed — push it later from the editor or terminal.</p>`,
  );
  const btn = msg.querySelector<HTMLButtonElement>("#create-branch");
  btn?.addEventListener("click", async () => {
    btn.disabled = true;
    setStatus(msg, `Creating <code>${b}</code>…`);
    const r = await createBranchFromLocation(rel);
    if (!r.ok) {
      setStatus(
        msg,
        `<strong>Could not create <code>${b}</code></strong><br><pre>${esc(r.error || "unknown error")}</pre>`,
      );
      return;
    }
    setTitle(rel, r.git);
    liveTitle(rel);
    setStatus(msg, `${esc(statusNote(r, rel))}. Opening…`);
    openVscode(frame, msg, r.folder);
  });
}

// VS Code Web's `?folder=` is a URI path, so a Windows path like
// `C:\Users\me\ws` must become `/c:/Users/me/ws`; otherwise the workbench
// can't resolve a filesystem provider for it. POSIX paths pass through.
function toVscodePath(folder: string): string {
  const p = folder.replace(/\\/g, "/");
  const drive = /^([A-Za-z]):\//.exec(p);
  return drive ? `/${drive[1].toLowerCase()}:${p.slice(2)}` : p;
}

function offerRecovery(
  msg: HTMLElement,
  frame: HTMLIFrameElement,
  rel: string,
  folder: string,
) {
  setStatus(msg,
    `<strong>Troubleshooting: incomplete checkout</strong>` +
    `<p><code>${esc(folder)}</code> contains files, but its <code>.git</code> metadata is missing. It needs provisioning again to work as a Git checkout.</p>` +
    `<p>Back up and provision again moves the existing folder to a unique sibling backup directory, then clones <code>${esc(rel)}</code>. Your existing files remain in the backup even if cloning fails.</p>` +
    `<button id="recover">Back up and provision again</button> ` +
    `<button id="open-existing">Open existing files</button>`);
  msg.querySelector("#open-existing")?.addEventListener("click", () => {
    setTitle(rel);
    openVscode(frame, msg, folder);
  });
  msg.querySelector("#recover")?.addEventListener("click", async () => {
    const view = progressView(msg, rel);
    const result = await provisionFromLocation(rel, true, view.update);
    view.stop();
    const backupNote = result.backup
      ? `<p>Original files saved at <code>${esc(result.backup)}</code>.</p>`
      : "";
    if (!result.ok) {
      setStatus(msg, `<strong>Provisioning could not finish</strong>${backupNote}<pre>${esc(result.error || "unknown error")}</pre>` +
        `<p>Check the repository URL, branch, network connection, and GitHub access, then reload to retry.</p>`);
      return;
    }
    setStatus(msg, `<strong>Checkout ready</strong>${backupNote}<button id="open-recovered">Open VS Code</button>`);
    msg.querySelector("#open-recovered")?.addEventListener("click", () => {
      setTitle(rel, result.git);
      liveTitle(rel);
      openVscode(frame, msg, result.folder);
    });
  });
}

function openVscode(
  frame: HTMLIFrameElement,
  msg: HTMLElement,
  folder: string,
) {
  frame.src = appPath(`_vscode/?folder=${encodeURIComponent(toVscodePath(folder))}`);
  frame.hidden = false;
  frame.addEventListener("load", () => (msg.hidden = true), { once: true });
  if (SPLIT) openTerminal();
}

const SPLIT_KEY = "webcode.split";
const SPLIT_DEFAULT = 40;

/**
 * Split mode: load the terminal page into the left pane and wire the divider.
 * Called once provisioning has settled, so terminal.html's own provisioning
 * call finds an existing worktree instead of racing a second clone.
 */
function openTerminal() {
  const term = document.getElementById("term") as HTMLIFrameElement;
  const divider = document.getElementById("divider") as HTMLDivElement;
  if (!term.hidden) return;
  const rel = repoPathFromLocation();
  term.src = appPath(`terminal.html${rel ? `?repo=${encodeURIComponent(rel)}` : ""}`);
  term.hidden = false;
  divider.hidden = false;

  const panes = document.getElementById("panes") as HTMLDivElement;
  const setSplit = (pct: number) => {
    const clamped = Math.min(90, Math.max(10, pct));
    panes.style.setProperty("--split", `${clamped}%`);
    return clamped;
  };
  let saved = SPLIT_DEFAULT;
  try {
    saved = Number(localStorage.getItem(SPLIT_KEY)) || SPLIT_DEFAULT;
  } catch {
    /* storage unavailable — use the default */
  }
  setSplit(saved);

  const save = (pct: number) => {
    try {
      localStorage.setItem(SPLIT_KEY, String(Math.round(pct * 10) / 10));
    } catch {
      /* ignore */
    }
  };
  divider.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    divider.setPointerCapture(e.pointerId);
    document.body.classList.add("dragging");
    const rect = panes.getBoundingClientRect();
    let pct = saved;
    const onMove = (ev: PointerEvent) => {
      pct = setSplit(((ev.clientX - rect.left) / rect.width) * 100);
    };
    const onUp = () => {
      document.body.classList.remove("dragging");
      divider.removeEventListener("pointermove", onMove);
      divider.removeEventListener("pointerup", onUp);
      divider.removeEventListener("pointercancel", onUp);
      saved = pct;
      save(pct);
    };
    divider.addEventListener("pointermove", onMove);
    divider.addEventListener("pointerup", onUp);
    divider.addEventListener("pointercancel", onUp);
  });
  divider.addEventListener("dblclick", () => {
    saved = setSplit(SPLIT_DEFAULT);
    save(saved);
  });
}

main();
