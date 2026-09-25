/** One normalized base for Vite, its APIs, and the embedded editor. */
export function normalizeBase(value = "/"): string {
  const parts = value.split("/").filter(Boolean);
  if (parts.some((part) => !/^[a-zA-Z0-9_-]+$/.test(part))) {
    throw new Error("WEBCODE_BASE_PATH must contain only letters, numbers, underscores, hyphens, and slashes");
  }
  return parts.length ? `/${parts.join("/")}/` : "/";
}

export const appBase = normalizeBase(process.env.WEBCODE_BASE_PATH);
