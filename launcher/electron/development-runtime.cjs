const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const snapshots = new Map();
const BUILD_TIMEOUT_MS = 60_000;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function verifyDevelopmentRuntime(sourceRoot, runtimeRoot) {
  const generation = path.basename(runtimeRoot);
  if (!/^[a-f0-9]{64}$/.test(generation) || runtimeRoot !== path.join(sourceRoot, ".launcher-runtime", generation)) {
    throw new Error("Development runtime snapshot is outside the source generation directory");
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "manifest.json"), "utf8"));
  if (manifest.sourceInputsSha256 !== generation || !Array.isArray(manifest.files)) {
    throw new Error(`Development runtime manifest mismatch: ${runtimeRoot}`);
  }
  const actual = ["app/browser-helper.cjs", "app/cli.js"].map((artifactPath) => {
    const artifact = path.join(runtimeRoot, artifactPath);
    if (!fs.lstatSync(artifact).isFile()) throw new Error(`Invalid development runtime artifact: ${artifact}`);
    const bytes = fs.readFileSync(artifact);
    const matching = manifest.files.filter((file) => file.path === artifactPath);
    const hash = sha256(bytes);
    if (matching.length !== 1 || matching[0].sha256 !== hash || matching[0].size !== bytes.length) {
      throw new Error(`Development runtime manifest mismatch: ${artifact}`);
    }
    return { path: artifactPath, sha256: hash };
  });
  const artifactSetSha256 = sha256(JSON.stringify(actual));
  if (manifest.artifactSetSha256 !== artifactSetSha256) {
    throw new Error(`Development runtime artifact set mismatch: ${runtimeRoot}`);
  }
  return {
    runtimeRoot,
    entrypoint: path.join(runtimeRoot, "app", "cli.js"),
    helperPath: path.join(runtimeRoot, "app", "browser-helper.cjs"),
    sourceInputsSha256: generation,
    artifactSetSha256,
  };
}

function prepareDevelopmentRuntime(sourceRoot) {
  sourceRoot = path.resolve(sourceRoot);
  const pinned = snapshots.get(sourceRoot);
  if (pinned) {
    verifyDevelopmentRuntime(sourceRoot, pinned.runtimeRoot);
    return pinned;
  }
  const executable = process.env.CODEX_CHATGPT_WEB_BUN?.trim() || process.env.CODEX_WEB_GPT_BUN?.trim() || "bun";
  const built = spawnSync(executable, [path.join(sourceRoot, "scripts", "build-development-runtime.ts"), sourceRoot], {
    cwd: sourceRoot,
    env: process.env,
    encoding: "utf8",
    timeout: BUILD_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (built.error || built.status !== 0) {
    throw new Error(
      `Development runtime build failed before startup: ${built.error?.message || built.stderr || built.stdout || built.status}`,
    );
  }
  let snapshot;
  try {
    const result = JSON.parse(built.stdout);
    snapshot = Object.freeze({ ...verifyDevelopmentRuntime(sourceRoot, result.runtimeRoot), executable });
  } catch (error) {
    throw new Error(`Development runtime verification failed before startup: ${error.message}`);
  }
  snapshots.set(sourceRoot, snapshot);
  return snapshot;
}

module.exports = { prepareDevelopmentRuntime };
