import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installWtx } from "./install-wtx";

const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "wtx-install-"));
  roots.push(root);
  mkdirSync(join(root, "lib", "wtx"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"fixture"}');
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("an empty submodule never runs Bun against the parent package", async () => {
  const root = fixture();
  let invoked = false;
  await expect(installWtx(root, async () => { invoked = true; return 0; }))
    .rejects.toThrow("git submodule update --init lib/wtx");
  expect(invoked).toBe(false);
});

test("an initialized submodule installs in its own directory and preserves failure", async () => {
  const root = fixture(), cwd = join(root, "lib", "wtx");
  writeFileSync(join(cwd, "package.json"), '{"name":"child-fixture"}');
  const seen: string[] = [];
  expect(await installWtx(root, async value => { seen.push(value); return 7; })).toBe(7);
  expect(seen).toEqual([cwd]);
});
