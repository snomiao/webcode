/** One normalized base for Vite, its APIs, and the embedded editor. */
export function normalizeBase(value = "/"): string {
  const parts = value.split("/").filter(Boolean);
  if (parts.some((part) => !/^[a-zA-Z0-9_-]+$/.test(part))) {
    throw new Error("WEBCODE_BASE_PATH must contain only letters, numbers, underscores, hyphens, and slashes");
  }
  return parts.length ? `/${parts.join("/")}/` : "/";
}

/** Serve strips each public mount; the target restores the internal path. */
export function serveMounts(base: string, port: number): { mount: string; target: string }[] {
  base = normalizeBase(base);
  const target = `http://127.0.0.1:${port}${base}`;
  const mounts = [{ mount: base === "/" ? "/" : base.slice(0, -1), target }];
  if (base !== "/" && base !== "/gh/") mounts.push({ mount: "/gh", target: `${target}gh` });
  return mounts;
}

/** Repository routes are independent of the internal asset/API mount. */
export function repoPath(pathname: string, base = "/"): string {
  const relative = pathname.startsWith(base) ? pathname.slice(base.length) : pathname.replace(/^\/+/, "");
  return decodeURIComponent(relative).replace(/^(?:gh|github\.com)(?:\/+|$)/, "");
}

/** Redirect legacy repository URLs without changing their encoded branch or query. */
export function legacyRepoRedirect(url: string, base = "/"): string | null {
  const relative = url.startsWith(base) ? url.slice(base.length) : url.replace(/^\/+/, "");
  if (relative.startsWith("github.com/")) return `/gh/${relative.slice("github.com/".length)}`;
  // Only match the complete owner/repo/tree/branch shape, leaving APIs,
  // assets, and already-canonical short URLs to their own handlers.
  if (/^(?:gh|api|assets|_vscode|_wtx)\//.test(relative)) return null;
  if (!/^[^/?#]+\/[^/?#]+\/tree\/[^?#]+(?:[?#].*)?$/.test(relative)) return null;
  const canonical = `/gh/${relative}`;
  return canonical === url ? null : canonical;
}
