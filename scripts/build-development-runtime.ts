import { type ExecFileSyncOptionsWithStringEncoding, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

interface SourceInput {
  path: string;
  bytes: Buffer;
}

interface ArtifactFile {
  path: string;
  size: number;
  sha256: string;
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceInputs(sourceRoot: string): SourceInput[] {
  const inputs: SourceInput[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(join(sourceRoot, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) inputs.push({ path, bytes: readFileSync(join(sourceRoot, path)) });
      else throw new Error(`Unsupported development source input: ${path}`);
    }
  };
  visit("src");
  for (const path of ["package.json", "bun.lock", "tsconfig.json"]) {
    inputs.push({ path, bytes: readFileSync(join(sourceRoot, path)) });
  }
  return inputs.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function verifiedBuildCommit(sourceRoot: string, inputs: SourceInput[]): string | null {
  try {
    const options: ExecFileSyncOptionsWithStringEncoding = {
      cwd: sourceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    };
    if (execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], options).trim()) return null;
    const commit = execFileSync("git", ["rev-parse", "HEAD"], options).trim();
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit)) return null;
    for (const input of inputs) {
      const committed = execFileSync("git", ["show", `${commit}:${input.path}`], {
        cwd: sourceRoot,
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 16 * 1024 * 1024,
      });
      if (!committed.equals(input.bytes)) return null;
    }
    return commit;
  } catch {
    return null;
  }
}

function descriptor(runtimeRoot: string) {
  const manifest = JSON.parse(readFileSync(join(runtimeRoot, "manifest.json"), "utf8"));
  const actual = ["app/browser-helper.cjs", "app/cli.js"].map((path) => ({
    path,
    sha256: sha256(readFileSync(join(runtimeRoot, path))),
  }));
  if (
    actual.some(
      (file) => manifest.files?.find((listed: ArtifactFile) => listed.path === file.path)?.sha256 !== file.sha256,
    ) ||
    manifest.artifactSetSha256 !== sha256(JSON.stringify(actual))
  ) {
    throw new Error(`Development runtime manifest mismatch: ${runtimeRoot}`);
  }
  return {
    runtimeRoot,
    entrypoint: join(runtimeRoot, "app", "cli.js"),
    helperPath: join(runtimeRoot, "app", "browser-helper.cjs"),
    sourceInputsSha256: manifest.sourceInputsSha256 as string,
    artifactSetSha256: manifest.artifactSetSha256 as string,
  };
}

export async function buildDevelopmentRuntime(sourceRoot: string) {
  sourceRoot = resolve(sourceRoot);
  const inputs = sourceInputs(sourceRoot);
  const inputDigest = createHash("sha256");
  inputDigest.update(
    JSON.stringify({ schemaVersion: 1, bunVersion: Bun.version, platform: process.platform, arch: process.arch }),
  );
  inputDigest.update(readFileSync(import.meta.path));
  for (const input of inputs) {
    inputDigest.update(JSON.stringify([input.path, input.bytes.length, sha256(input.bytes)]));
  }
  const sourceInputsSha256 = inputDigest.digest("hex");
  const snapshots = join(sourceRoot, ".launcher-runtime");
  const runtimeRoot = join(snapshots, sourceInputsSha256);
  if (existsSync(runtimeRoot)) return descriptor(runtimeRoot);
  mkdirSync(snapshots, { recursive: true });
  const staging = mkdtempSync(join(snapshots, ".building-"));
  try {
    const capturedSource = join(staging, "inputs");
    for (const input of inputs) {
      const destination = join(capturedSource, input.path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, input.bytes);
    }
    const dependencies = join(sourceRoot, "node_modules");
    if (existsSync(dependencies)) symlinkSync(dependencies, join(capturedSource, "node_modules"), "junction");
    const appDir = join(staging, "app");
    mkdirSync(appDir);
    for (const [entrypoint, naming, target, format] of [
      ["src/cli.ts", "cli.js", "bun", "esm"],
      ["src/adapters/chatgpt-web/browser-helper-main.ts", "browser-helper.cjs", "node", "cjs"],
    ] as const) {
      const built = await Bun.build({
        entrypoints: [join(capturedSource, entrypoint)],
        target,
        format,
        minify: false,
        external: ["playwright-core"],
        outdir: appDir,
        naming,
      }).catch((cause: unknown) => {
        throw new Error(`Development runtime build failed (${naming})`, { cause });
      });
      if (!built.success) {
        throw new Error(
          `Development runtime build failed (${naming}): ${built.logs.map((log) => log.message).join("; ")}`,
        );
      }
    }
    if (existsSync(dependencies)) symlinkSync(dependencies, join(appDir, "node_modules"), "junction");
    const files: ArtifactFile[] = ["app/browser-helper.cjs", "app/cli.js"].map((path) => {
      const bytes = readFileSync(join(staging, path));
      return { path, size: bytes.length, sha256: sha256(bytes) };
    });
    const artifactSetSha256 = sha256(JSON.stringify(files.map(({ path, sha256 }) => ({ path, sha256 }))));
    writeFileSync(
      join(staging, "manifest.json"),
      `${JSON.stringify(
        {
          schemaVersion: 2,
          sourceInputsSha256,
          artifactSetSha256,
          buildCommit: verifiedBuildCommit(sourceRoot, inputs),
          bunVersion: Bun.version,
          entrypoint: "app/cli.js",
          files,
        },
        null,
        2,
      )}\n`,
    );
    rmSync(capturedSource, { recursive: true, force: true });
    descriptor(staging);
    try {
      renameSync(staging, runtimeRoot);
    } catch (error) {
      if (!existsSync(runtimeRoot)) throw error;
      // A concurrent launcher may have published this generation first. Never replace it.
    }
    return descriptor(runtimeRoot);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const snapshot = await buildDevelopmentRuntime(process.argv[2] ?? resolve(import.meta.dir, ".."));
  process.stdout.write(`${JSON.stringify(snapshot)}\n`);
}
