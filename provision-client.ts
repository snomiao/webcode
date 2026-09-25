/**
 * Client-side helper shared by the VS Code shell and the wtx terminal UI:
 * call the gateway's /api/repo endpoint to ensure the local worktree
 * exists (clone/fetch/pull), and report the result.
 */

import { appPath } from "./app-base";

/** `wsRoot` is the absolute workspace-root path (server-joined). */
export type Config = { home: string; wsRoot: string };

export type GitStatus = {
  branch: string;
  head: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  hasUpstream: boolean;
};

export type FailReason = "branch-not-found" | "repo-not-found" | "missing-git" | "other";

export type ProvisionResult = {
  ok: boolean;
  folder: string;
  existed: boolean;
  action: "cloned" | "pulled" | "fetched" | "created" | "none" | "error";
  git?: GitStatus;
  error?: string;
  reason?: FailReason;
  backup?: string;
};

/**
 * Read a `/api/repo` response as JSON, but tolerate a non-JSON body (backend
 * down, an HTML error page, a truncated stream). Instead of throwing a raw
 * `SyntaxError`, surface the status + body so the caller can show a useful
 * message (and its fallback "open anyway" affordance).
 */
async function parseResult(res: Response): Promise<ProvisionResult> {
  const text = await res.text();
  try {
    return JSON.parse(text) as ProvisionResult;
  } catch {
    return {
      ok: false,
      folder: "",
      existed: false,
      action: "error",
      error: `HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300) || "(empty body)"}`,
    };
  }
}

/** Clone/setup progress streamed by the server (secrets already redacted). */
export type ProvisionProgress = {
  phase: "clone" | "setup";
  text: string;
  percent?: number;
};

/**
 * Provision the repo named by a `<owner>/<repo>/tree/<branch>` path. With
 * `onProgress`, asks for the NDJSON stream so a long clone/install reports
 * as it goes instead of looking hung. `recover` backs up a populated folder
 * that has no `.git` and provisions again.
 */
export async function provisionFromLocation(
  rel: string,
  recover = false,
  onProgress?: (p: ProvisionProgress) => void,
): Promise<ProvisionResult> {
  try {
    const params = new URLSearchParams();
    if (recover) params.set("recover", "1");
    if (onProgress) params.set("stream", "1");
    const qs = params.size ? `?${params}` : "";
    const res = await fetch(
      appPath(`api/repo/${rel}${qs}`),
      recover ? { method: "POST" } : undefined,
    );
    const ndjson = res.headers.get("content-type")?.includes("ndjson");
    if (!onProgress || !ndjson || !res.body) return await parseResult(res);

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const l of lines) {
        if (!l.trim()) continue;
        const m = JSON.parse(l) as
          | ({ type: "progress" } & ProvisionProgress)
          | { type: "result"; result: ProvisionResult }
          | { type: "ping" };
        if (m.type === "result") return m.result;
        if (m.type === "progress") onProgress(m);
      }
    }
    return {
      ok: false,
      folder: "",
      existed: false,
      action: "error",
      error: "provisioning stream ended without a result",
    };
  } catch (e) {
    return {
      ok: false,
      folder: "",
      existed: false,
      action: "error",
      error: String(e),
    };
  }
}

/**
 * Create the branch locally (off the repo's default branch, no push) for a
 * `<owner>/<repo>/tree/<branch>` path whose remote branch doesn't exist.
 */
export async function createBranchFromLocation(
  rel: string,
): Promise<ProvisionResult> {
  try {
    const res = await fetch(appPath(`api/repo/${rel}?create=1`), { method: "POST" });
    return await parseResult(res);
  } catch (e) {
    return {
      ok: false,
      folder: "",
      existed: false,
      action: "error",
      error: String(e),
    };
  }
}

const PHASE_LABEL: Record<ProvisionProgress["phase"], string> = {
  clone: "Cloning",
  setup: "Installing dependencies",
};

/**
 * Render a provisioning progress panel into `el`: phase, elapsed time, a bar
 * (determinate when git reports a percent, indeterminate otherwise) and the
 * latest output line. Returns `update` for each progress event and `stop` to
 * end the elapsed-time ticker. Built with textContent only — output lines are
 * never interpreted as HTML.
 */
export function progressView(el: HTMLElement, rel: string) {
  el.replaceChildren();
  el.hidden = false;
  const head = document.createElement("div");
  const title = document.createElement("span");
  title.textContent = `Provisioning ${rel}`;
  const elapsed = document.createElement("span");
  elapsed.style.cssText = "opacity:.6;margin-left:.5em";
  head.append(title, elapsed);
  const bar = document.createElement("progress");
  bar.style.cssText = "width:min(560px,100%);display:block;margin:.5rem 0";
  const phase = document.createElement("div");
  phase.style.cssText = "font-size:.9em";
  const line = document.createElement("pre");
  line.style.cssText =
    "margin:.25rem 0;opacity:.6;font-size:.85em;white-space:pre-wrap;word-break:break-all;max-width:min(560px,100%)";
  el.append(head, bar, phase, line);

  const started = Date.now();
  const tick = () => {
    const s = Math.floor((Date.now() - started) / 1000);
    elapsed.textContent = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  };
  tick();
  const timer = setInterval(tick, 1000);

  return {
    update(p: ProvisionProgress) {
      phase.textContent = PHASE_LABEL[p.phase];
      line.textContent = p.text;
      if (p.percent != null) bar.value = p.percent / 100;
      else bar.removeAttribute("value"); // indeterminate
    },
    stop() {
      clearInterval(timer);
    },
  };
}

/** Short human-readable git-state note for status lines. */
export function statusNote(r: ProvisionResult, rel: string): string {
  const g = r.git;
  const parts = [
    r.action === "cloned" || r.action === "created"
      ? r.action
      : r.existed
        ? r.action
        : "ready",
    g ? `@ ${g.head}` : "",
    g && g.dirty ? "· local changes" : "",
    g && g.behind ? `· ${g.behind} behind` : "",
    g && g.ahead ? `· ${g.ahead} ahead` : "",
  ].filter(Boolean);
  return `${rel} — ${parts.join(" ")}`;
}

/**
 * Subscribe to live git status for a worktree over Server-Sent Events
 * (`GET /api/watch/<rel>`). Calls `onEvent` with each pushed `GitStatus`
 * (initial snapshot + every debounced filesystem change). Returns an
 * unsubscribe fn that closes the stream. Auto-reconnects (EventSource does
 * this for us); malformed frames are ignored.
 */
/**
 * A live watch event. `activity` marks any filesystem change (drives the UI
 * spinner); `status` is the git status, present only when it changed (or as the
 * initial snapshot).
 */
export type LiveEvent = {
  activity?: boolean;
  status?: GitStatus;
  /** How many tabs currently have this repo open (>=2 means duplicates). */
  presence?: number;
  /** window.name of the first/canonical tab — target for "switch to it". */
  primaryName?: string;
};

export function watchStatus(
  rel: string,
  onEvent: (ev: LiveEvent) => void,
): () => void {
  const es = new EventSource(appPath(`api/watch/${rel}`));
  es.onmessage = (e) => {
    try {
      // SSE carries a status per message; treat each as activity + status.
      onEvent({ activity: true, status: JSON.parse(e.data) as GitStatus });
    } catch {
      // ignore heartbeats / malformed frames
    }
  };
  return () => es.close();
}

// --- Multiplexed live status via a single shared WebSocket -----------------
// All tabs of this origin share ONE SharedWorker holding ONE WebSocket
// (/api/watch-ws). It multiplexes every repo subscription, so opening 10+
// tabs costs one connection total (not one per tab) and keeps the tab title
// live while backgrounded. Falls back to per-tab SSE where SharedWorker is
// unavailable.

let sharedPort: MessagePort | null | undefined;
const liveHandlers = new Map<string, Set<(ev: LiveEvent) => void>>();

function ensureWorkerPort(): MessagePort | null {
  if (sharedPort !== undefined) return sharedPort;
  if (typeof SharedWorker === "undefined") return (sharedPort = null);
  try {
    const worker = new SharedWorker(
      new URL("./status-worker.ts", import.meta.url),
      // Named so every tab shares ONE instance — and so bumping the suffix
      // forces a fresh worker when the worker protocol changes (browsers key
      // SharedWorkers by URL + name and otherwise reuse a running instance).
      { type: "module", name: "fbi-web-code-status-v3" },
    );
    const port = worker.port;
    port.onmessage = (e: MessageEvent) => {
      const { rel, activity, status, presence, primaryName } = (e.data ??
        {}) as { rel?: string } & LiveEvent;
      if (rel)
        liveHandlers
          .get(rel)
          ?.forEach((cb) => cb({ activity, status, presence, primaryName }));
    };
    port.start();
    // Release this tab's subscriptions in the worker when the tab goes away.
    addEventListener("pagehide", () => port.postMessage({ type: "close" }));
    return (sharedPort = port);
  } catch {
    return (sharedPort = null);
  }
}

/**
 * Live git status for `rel`, multiplexed over the shared worker's single
 * WebSocket (or per-tab SSE as a fallback). Calls `onEvent` with each pushed
 * `GitStatus`. Returns an unsubscribe fn.
 */
export function watchStatusLive(
  rel: string,
  onEvent: (ev: LiveEvent) => void,
): () => void {
  const port = ensureWorkerPort();
  if (!port) return watchStatus(rel, onEvent); // SSE fallback

  let set = liveHandlers.get(rel);
  if (!set) {
    set = new Set();
    liveHandlers.set(rel, set);
  }
  set.add(onEvent);
  // Include this tab's window.name so the worker can name the canonical tab
  // back to duplicates (for "switch to existing tab").
  port.postMessage({ type: "sub", rel, name: window.name });

  return () => {
    set!.delete(onEvent);
    if (set!.size === 0) {
      liveHandlers.delete(rel);
      port.postMessage({ type: "unsub", rel });
    }
  };
}
