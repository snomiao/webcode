/// <reference types="vite/client" />

/** Absolute app path, including the configured mount prefix. */
export function appPath(path = ""): string {
  return import.meta.env.BASE_URL + path.replace(/^\/+/, "");
}

export function appRelativePath(pathname: string): string {
  const base = import.meta.env.BASE_URL;
  return pathname.startsWith(base) ? pathname.slice(base.length) : pathname.replace(/^\/+/, "");
}
