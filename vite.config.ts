import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { WebSocketServer, type WebSocket } from "ws";
import {
  createBranch,
  folderFor,
  parseSpec,
  provision,
  statusOf,
  watchStatus,
} from "./provision";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE_PATH = normalizeBasePath(process.env.WEB_CODE_BASE_PATH);
const route = (pathname: string) => `${BASE_PATH}${pathname}`;

/** Connect strips a middleware's mount path before calling its handler. */
function pathBelowMount(pathname: string, mount: string): string {
  const remainder = pathname.startsWith(mount)
    ? pathname.slice(mount.length)
    : pathname;
  return remainder.replace(/^\/+/, "");
}

function normalizeBasePath(value?: string): string {
  if (!value || value === "/") return "";
  return `/${value.replace(/^\/+|\/+$/g, "")}`;
}

/**
 * The shell server (port 3001). It serves:
 *   - the iframe page (web-code shell)
 *   - `GET /__config`        — server home dir + ws root for the client
 *   - `GET /api/repo/<owner>/<repo>/tree/<branch>`
 *        — ensure the repo exists locally (clone if missing; fetch +
 *          pull-if-clean if present) and return its git status + the
 *          local folder path for VS Code's `?folder=`.
 *
 * `/api/`, `/__config`, VS Code, and wtx remain on one portless origin.
 */
export default defineConfig({
  base: `${BASE_PATH}/`.replace(/^\/\//, "/"),
  // Point vite's env-file loader at a dedicated empty dir so it never picks up
  // `.env` / `.env.local` (from this lab or the repo root). The shell server is
  // an embedded dev tool — it runs purely on the system/default process env,
  // and provisioned worktrees get their own `.env.local` via provision.ts.
  envDir: path.join(HERE, "no-env"),
  server: {
    // Tailscale Serve only proxies HTTP backends on 127.0.0.1. Pinning the
    // shell here also avoids localhost resolving to IPv6-only ::1 on macOS.
    host: process.env.HOST || "127.0.0.1",
    port: 3001,
    strictPort: true,
    proxy: {
      [route("/_vscode/")]: {
        target: "http://localhost:9999",
        ws: true,
      },
      [route("/_wtx/")]: {
        target: "http://localhost:3004",
        ws: true,
        rewrite: (pathname) => pathname.slice(BASE_PATH.length),
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: path.join(HERE, "index.html"),
        terminal: path.join(HERE, "terminal.html"),
      },
    },
  },
  plugins: [
    react(),
    {
      name: "web-code-shell",
      configureServer(server) {
        // Multiplexed git-status WebSocket at /api/watch-ws. One socket (held
        // by a client SharedWorker, shared across all tabs) carries many repo
        // subscriptions: {type:'sub'|'unsub', rel}. The server pushes
        // {rel, status} on every change. Watchers are server-side-deduped per
        // worktree (see provision.watchStatus), so 10+ tabs cost one watcher
        // per distinct repo and a single connection total. This sidesteps the
        // HTTP/1.1 ~6-connections-per-origin cap that long-lived SSE hits.
        const wss = new WebSocketServer({ noServer: true });
        server.httpServer?.on("upgrade", (req, socket, head) => {
          const { pathname } = new URL(req.url ?? "", "http://localhost");
          if (pathname !== route("/api/watch-ws")) return; // leave vite HMR upgrades alone
          wss.handleUpgrade(req, socket, head, (ws) => handleWatchSocket(ws));
        });

        async function handleWatchSocket(ws: WebSocket) {
          const subs = new Map<string, () => Promise<void>>(); // rel -> unsubscribe
          ws.on("message", async (data) => {
            let m: { type?: string; rel?: string };
            try {
              m = JSON.parse(data.toString());
            } catch {
              return;
            }
            const rel = String(m.rel ?? "");
            const spec = parseSpec(rel);
            if (!spec) return;
            if (m.type === "sub") {
              if (subs.has(rel)) return;
              const send = (msg: object) => {
                if (ws.readyState === ws.OPEN)
                  ws.send(JSON.stringify({ rel, ...msg }));
              };
              const initial = await statusOf(spec);
              if (initial) send({ activity: false, status: initial });
              try {
                subs.set(rel, await watchStatus(spec, (e) => send(e)));
              } catch {
                // worktree not provisioned / watcher unavailable — initial
                // snapshot (if any) already sent; no live updates.
              }
            } else if (m.type === "unsub") {
              const unsub = subs.get(rel);
              subs.delete(rel);
              await unsub?.();
            }
          });
          const cleanup = async () => {
            for (const unsub of subs.values()) await unsub();
            subs.clear();
          };
          ws.on("close", cleanup);
          ws.on("error", cleanup);
        }

        server.middlewares.use(route("/__config"), (_req, res) => {
          res.setHeader("Content-Type", "application/json");
          // `wsRoot` is the absolute path to the workspace root, joined
          // server-side so the client never concatenates with "/" (which
          // would produce mixed separators on Windows). Matches the base
          // used by provision.ts (folderFor).
          res.end(
            JSON.stringify({
              home: os.homedir(),
              wsRoot: path.join(os.homedir(), "ws"),
            }),
          );
        });

        // GET  /api/repo/<owner>/<repo>/tree/<branch>          -> provision
        // POST /api/repo/<owner>/<repo>/tree/<branch>?create=1 -> create the
        //   branch locally off the repo's default branch (no push), for when
        //   provision returned reason:"branch-not-found".
        server.middlewares.use(route("/api/repo/"), async (req, res) => {
          const json = (status: number, body: unknown) => {
            res.statusCode = status;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(body));
          };
          try {
            const url = new URL(req.url ?? "", "http://localhost");
            const full = decodeURIComponent(url.pathname);
            const specPath = pathBelowMount(full, route("/api/repo/"));
            const spec = parseSpec(specPath);
            if (!spec) {
              return json(400, {
                ok: false,
                error: "expected /api/repo/<owner>/<repo>/tree/<branch>",
              });
            }
            const isCreate =
              req.method === "POST" && url.searchParams.get("create") === "1";
            const result = isCreate
              ? await createBranch(spec)
              : await provision(spec);
            return json(result.ok ? 200 : 502, result);
          } catch (e) {
            return json(500, { ok: false, error: String(e) });
          }
        });

        // GET /api/watch/<owner>/<repo>/tree/<branch>
        //   Server-Sent Events: pushes the worktree's git status on every
        //   filesystem change (debounced), so the client can show live
        //   dirty/ahead/behind without polling. One `data: <GitStatus JSON>`
        //   per change, plus an initial snapshot and `: ping` heartbeats. The
        //   per-connection watcher is torn down when the client disconnects.
        server.middlewares.use(route("/api/watch/"), async (req, res) => {
          const url = new URL(req.url ?? "", "http://localhost");
          const specPath = pathBelowMount(
            decodeURIComponent(url.pathname),
            route("/api/watch/"),
          );
          const spec = parseSpec(specPath);
          if (!spec) {
            res.statusCode = 400;
            return res.end("expected /api/watch/<owner>/<repo>/tree/<branch>");
          }
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            // disable proxy/middleware buffering of the stream
            "X-Accel-Buffering": "no",
          });
          const send = (status: unknown) =>
            res.write(`data: ${JSON.stringify(status)}\n\n`);

          const initial = await statusOf(spec);
          if (initial) send(initial);

          let stop: (() => Promise<void>) | null = null;
          try {
            stop = await watchStatus(spec, send);
          } catch {
            // worktree not provisioned yet / watcher unavailable — the client
            // still has the initial snapshot (or none) and simply gets no live
            // updates; harmless.
          }
          // Heartbeat so intermediaries don't drop the idle connection.
          const hb = setInterval(() => res.write(": ping\n\n"), 25_000);
          req.on("close", () => {
            clearInterval(hb);
            void stop?.();
          });
        });
      },
    },
  ],
});

// Re-export so `folderFor` is reachable for tests/tools importing the config.
export { folderFor };
