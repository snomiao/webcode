import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export async function installWtx(
  root: string,
  install = async (cwd: string) => {
    const child = Bun.spawn(["bun", "install"], {
      cwd,
      stdio: ["inherit", "inherit", "inherit"],
    });
    return await child.exited;
  },
): Promise<number> {
  const cwd = join(root, "lib", "wtx");
  if (!existsSync(join(cwd, "package.json"))) {
    throw new Error(
      "The wtx submodule is not initialized. Run git submodule update --init lib/wtx, then retry installation.",
    );
  }
  return await install(cwd);
}

if (import.meta.main) {
  try {
    process.exit(await installWtx(fileURLToPath(new URL("..", import.meta.url))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
