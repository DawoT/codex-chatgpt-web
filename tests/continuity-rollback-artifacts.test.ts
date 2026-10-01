import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyRollbackPreparation } from "../scripts/harness-live-canary";

const commit = "a".repeat(40);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cgw-rollback-"));
  const app = join(root, "app");
  mkdirSync(app);
  const files = ["app/browser-helper.cjs", "app/cli.js"].map((path) => {
    const bytes = Buffer.from(`artifact: ${path}\n`);
    writeFileSync(join(root, path), bytes);
    return { path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const manifest = {
    buildCommit: commit,
    files,
    dependencies: "none",
    artifactSetSha256: createHash("sha256")
      .update(JSON.stringify(files.map(({ path, sha256 }) => ({ path, sha256 }))))
      .digest("hex"),
  };
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(app, "source-commit.txt"), `${commit}\n`);
  return { root, app, manifest };
}

test("helper and a claimed source commit alone cannot constitute a rollback", () => {
  const { root, app } = fixture();
  try {
    rmSync(join(app, "cli.js"));
    expect(verifyRollbackPreparation(app)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback validates both artifact bytes and exact committed provenance", () => {
  const { root, app } = fixture();
  try {
    expect(verifyRollbackPreparation(app)).toBe(true);
    writeFileSync(join(app, "source-commit.txt"), `${"b".repeat(40)}\n`);
    expect(verifyRollbackPreparation(app)).toBe(false);
    writeFileSync(join(app, "source-commit.txt"), `${commit}\n`);
    writeFileSync(join(app, "cli.js"), "different artifact\n");
    expect(verifyRollbackPreparation(app)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback cannot omit declared frozen external dependencies", () => {
  const { root, app, manifest } = fixture();
  try {
    manifest.dependencies = "frozen-lockfile-copy";
    writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
    expect(verifyRollbackPreparation(app)).toBe(false);
    mkdirSync(join(app, "node_modules"));
    expect(verifyRollbackPreparation(app)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
