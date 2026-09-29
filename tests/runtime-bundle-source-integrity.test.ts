import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

for (const sourceChange of ["modified", "untracked"] as const) test(`release builder refuses ${sourceChange} source at HEAD`, () => {
  const repository = resolve(import.meta.dir, "..");
  const root = mkdtempSync(join(tmpdir(), "cgw-dirty-release-"));
  const checkout = join(root, "checkout");
  try {
    const added = spawnSync("git", ["worktree", "add", "--detach", checkout, "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    });
    expect(added.status).toBe(0);
    symlinkSync(join(repository, "node_modules"), join(checkout, "node_modules"), "dir");
    symlinkSync(join(repository, "launcher", "node_modules"), join(checkout, "launcher", "node_modules"), "dir");
    copyFileSync(join(repository, "scripts", "build-runtime-bundle.ts"),
      join(checkout, "scripts", "build-runtime-bundle.ts"));
    if (sourceChange === "modified") {
      appendFileSync(join(checkout, "src", "version.ts"), "\n// Deliberately dirty release source.\n");
    } else {
      writeFileSync(join(checkout, "LICENSES", "UNCOMMITTED.txt"), "Uncommitted release asset\n");
    }
    const built = spawnSync(process.execPath, ["scripts/build-runtime-bundle.ts"], {
      cwd: checkout,
      encoding: "utf8",
    });
    expect(built.status).not.toBe(0);
    expect(built.stderr).toContain("Runtime bundle requires a clean source worktree");
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", checkout], { cwd: repository });
    rmSync(root, { recursive: true, force: true });
  }
});
