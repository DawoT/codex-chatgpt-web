import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildValidation } from "../scripts/check-harness-continuity";

const roots: string[] = [];
const builder = resolve(import.meta.dir, "../scripts/build-development-runtime.ts");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "cgw-development-build-"));
  roots.push(root);
  mkdirSync(join(root, "src/adapters/chatgpt-web"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"module","version":"1.0.0"}\n');
  writeFileSync(join(root, "bun.lock"), "fixture lock\n");
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
  writeFileSync(join(root, "src/generation.ts"), 'export const generation = "September";\n');
  writeFileSync(join(root, "src/cli.ts"), 'import { generation } from "./generation";\nconsole.log(generation);\n');
  writeFileSync(
    join(root, "src/adapters/chatgpt-web/browser-helper-main.ts"),
    'import { generation } from "../../generation";\nconsole.log(generation);\n',
  );
  return root;
}

function build(root: string) {
  return spawnSync(process.execPath, [builder, root], { encoding: "utf8", timeout: 30_000 });
}

test("continuity gates measure the runnable launcher snapshot rather than an unrelated build recipe", async () => {
  const root = fixture();
  const measured = await buildValidation(root);
  expect(measured.kind).toBe("immutable-development-snapshot");
  const snapshot = JSON.parse(build(root).stdout);
  expect(measured.runtimeRoot).toBe(snapshot.runtimeRoot);
  expect(measured.artifactSetSha256).toBe(snapshot.artifactSetSha256);
  for (const bundle of measured.bundles) {
    const filename = bundle.name === "cli" ? "cli.js" : "browser-helper.cjs";
    const bytes = readFileSync(join(snapshot.runtimeRoot, "app", filename));
    expect(bundle.bytes).toBe(bytes.length);
    expect(bundle.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  }
});

test("startup builder emits a runnable pair with a manifest of actual artifact hashes", () => {
  const root = fixture();
  const built = build(root);
  expect(built.status).toBe(0);
  const snapshot = JSON.parse(built.stdout);
  expect(snapshot.runtimeRoot).toMatch(/\.launcher-runtime[/\\][a-f0-9]{64}$/);
  for (const [executable, artifact] of [
    [process.execPath, snapshot.entrypoint],
    ["node", snapshot.helperPath],
  ]) {
    const child = spawnSync(executable, [artifact], { encoding: "utf8" });
    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toBe("September");
  }
  const manifest = JSON.parse(readFileSync(join(snapshot.runtimeRoot, "manifest.json"), "utf8"));
  const actual = ["app/browser-helper.cjs", "app/cli.js"].map((path) => ({
    path,
    sha256: createHash("sha256")
      .update(readFileSync(join(snapshot.runtimeRoot, path)))
      .digest("hex"),
  }));
  expect(manifest.files.map(({ path, sha256 }: { path: string; sha256: string }) => ({ path, sha256 }))).toEqual(
    actual,
  );
  expect(manifest.artifactSetSha256).toBe(createHash("sha256").update(JSON.stringify(actual)).digest("hex"));
  expect(snapshot.artifactSetSha256).toBe(manifest.artifactSetSha256);
  expect(manifest.buildCommit).toBeNull();
});

test("changed source creates a new pair while the earlier generation remains runnable", () => {
  const root = fixture();
  const first = JSON.parse(build(root).stdout);
  writeFileSync(join(root, "src/generation.ts"), 'export const generation = "October";\n');
  const secondBuild = build(root);
  expect(secondBuild.status).toBe(0);
  const second = JSON.parse(secondBuild.stdout);
  expect(second.runtimeRoot).not.toBe(first.runtimeRoot);
  for (const [snapshot, expected] of [
    [first, "September"],
    [second, "October"],
  ] as const) {
    const cli = spawnSync(process.execPath, [snapshot.entrypoint], { encoding: "utf8" });
    const helper = spawnSync("node", [snapshot.helperPath], { encoding: "utf8" });
    expect(cli.status).toBe(0);
    expect(helper.status).toBe(0);
    expect(cli.stdout.trim()).toBe(expected);
    expect(helper.stdout.trim()).toBe(expected);
  }
});

test("a broken helper build cannot publish a partial runnable generation", () => {
  const root = fixture();
  writeFileSync(join(root, "src/adapters/chatgpt-web/browser-helper-main.ts"), 'import "./missing-dependency";\n');
  const failed = build(root);
  expect(failed.status).not.toBe(0);
  expect(failed.stderr).toContain("Development runtime build failed (browser-helper.cjs)");
  expect(failed.stdout).toBe("");
});

test("development snapshots resolve external modules from frozen dependencies instead of mutable checkout modules", () => {
  const root = fixture();
  const project = resolve(import.meta.dir, "..");
  writeFileSync(join(root, "package.json"), readFileSync(join(project, "package.json")));
  writeFileSync(join(root, "bun.lock"), readFileSync(join(project, "bun.lock")));
  mkdirSync(join(root, "node_modules/playwright-core"), { recursive: true });
  writeFileSync(
    join(root, "node_modules/playwright-core/package.json"),
    JSON.stringify({ name: "playwright-core", version: "1.62.0", main: "index.cjs" }),
  );
  writeFileSync(
    join(root, "node_modules/playwright-core/index.cjs"),
    'exports.chromium = { launch: "mutable checkout dependency" };\n',
  );
  const entry = 'import { chromium } from "playwright-core";\nconsole.log(typeof chromium.launch);\n';
  writeFileSync(join(root, "src/cli.ts"), entry);
  writeFileSync(join(root, "src/adapters/chatgpt-web/browser-helper-main.ts"), entry);
  const built = build(root);
  expect(built.status).toBe(0);
  const snapshot = JSON.parse(built.stdout);
  for (const artifact of [snapshot.entrypoint, snapshot.helperPath]) {
    const child = spawnSync(process.execPath, [artifact], { encoding: "utf8", timeout: 5000 });
    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toBe("function");
  }
});
