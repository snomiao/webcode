import { appBase } from "./server-base";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type ViteDevServer } from "vite";
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
  base: appBase,
  // Point vite's env-file loader at a dedicated empty dir so it never picks up
  // `.env` / `.env.local` (from this lab or the repo root). The shell server is
  // an embedded dev tool — it runs purely on the system/default process env,
  // and provisioned worktrees get their own `.env.local` via provision.ts.
  envDir: path.join(HERE, "no-env"),
  server: {
    host: "127.0.0.1",
    port: 3001,
    strictPort: true,
    // Dev mode only (`start.ts --dev`). A checkout of webcode is often edited
    // from inside webcode, and with HMR every save to the shell's sources
    // full-reloads every open tab — tearing down the VS Code and terminal
    // iframes. Off unless WEBCODE_HMR=1, which `start.ts --dev` sets.
    hmr: process.env.WEBCODE_HMR === "1",
    proxy: {
      [`${appBase}_vscode/`]: {
        target: "http://127.0.0.1:9999",
        ws: true,
      },
      [`${appBase}_wtx/`]: {
        // Same default as lib/wtx/src/server.ts; override when 3004 is taken.
        target: `http://127.0.0.1:${process.env.TERMINAL_WS_PORT || 3004}`,
        ws: true,
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
      // Same gateway (API, status socket) on the dev server (`start.ts
      // --dev`) and on the preview server that serves the built shell
      // (`start.ts`).
      configureServer: installGateway,
      configurePreviewServer: installGateway,
    },
  ],
});

function installGateway(
  server: Pick<ViteDevServer, "middlewares" | "httpServer">,
) {
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
    if (pathname !== `${appBase}api/watch-ws`) return; // leave vite HMR upgrades alone
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

  server.middlewares.use(`${appBase}__config`, (_req, res) => {
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
  //   (`?stream=1` streams NDJSON progress, then the result)
  // POST /api/repo/<owner>/<repo>/tree/<branch>?create=1 -> create the
  //   branch locally off the repo's default branch (no push), for when
  //   provision returned reason:"branch-not-found".
  // POST /api/repo/<owner>/<repo>/tree/<branch>?recover=1 -> back up a
  //   populated folder with no .git, then provision (reason:"missing-git").
  server.middlewares.use(`${appBase}api/repo/`, async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? "", "http://localhost");
      // The middleware sees the full path, so parse after "/api/repo/".
      const full = decodeURIComponent(url.pathname);
      const specPath = full.replace(/^\/api\/repo\//, "");
      const spec = parseSpec(specPath);
      if (!spec) {
        return json(400, {
          ok: false,
          error: "expected /api/repo/<owner>/<repo>/tree/<branch>",
        });
      }
      const isPost = req.method === "POST";
      const isCreate = isPost && url.searchParams.get("create") === "1";
      const recover = isPost && url.searchParams.get("recover") === "1";
      if (!isCreate && url.searchParams.get("stream") === "1") {
        // NDJSON: {type:"progress",…} lines while a clone/setup runs,
        // then one {type:"result",result}. Pings keep proxies from
        // dropping the connection during a quiet install step.
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
        });
        const line = (o: object) => res.write(`${JSON.stringify(o)}\n`);
        const ping = setInterval(() => line({ type: "ping" }), 15_000);
        try {
          const result = await provision(spec, recover, (p) =>
            line({ type: "progress", ...p }),
          );
          line({ type: "result", result });
        } finally {
          clearInterval(ping);
          res.end();
        }
        return;
      }
      const result = isCreate
        ? await createBranch(spec)
        : await provision(spec, recover);
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
  server.middlewares.use(`${appBase}api/watch/`, async (req, res) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const specPath = decodeURIComponent(url.pathname).replace(
      /^\/api\/watch\//,
      "",
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
}

// Re-export so `folderFor` is reachable for tests/tools importing the config.
export { folderFor };
