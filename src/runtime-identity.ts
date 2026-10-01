import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

export const RUNTIME_PROTOCOL_VERSION = 2;

export interface RuntimeIdentity {
  protocolVersion: number;
  buildCommit: string | null;
  artifactSha256: string | null;
  generation: string;
  pid: number;
  artifactSetSha256?: string | null;
  artifactVerification?: "paired_manifest_verified" | "entrypoint_only" | "manifest_mismatch" | "unavailable";
}

const generation = randomUUID();

export function createRuntimeIdentity(entrypoint: string | undefined = process.argv[1]): RuntimeIdentity {
  let artifactSha256: string | null = null;
  let buildCommit: string | null = null;
  let artifactSetSha256: string | null = null;
  let artifactVerification: RuntimeIdentity["artifactVerification"] = "unavailable";
  if (entrypoint) {
    try {
      artifactSha256 = createHash("sha256").update(readFileSync(entrypoint)).digest("hex");
      artifactVerification = "entrypoint_only";
      const appDir = dirname(entrypoint);
      const artifactName = basename(entrypoint);
      if (basename(appDir) === "app" && (artifactName === "cli.js" || artifactName === "browser-helper.cjs")) {
        const manifest = JSON.parse(readFileSync(join(appDir, "..", "manifest.json"), "utf8")) as {
          buildCommit?: unknown;
          files?: Array<{ path?: unknown; sha256?: unknown }>;
        };
        const artifactPath = relative(join(appDir, ".."), entrypoint).replaceAll("\\", "/");
        const listed = manifest.files?.find((file) => file.path === artifactPath);
        const pairedPaths = ["app/browser-helper.cjs", "app/cli.js"];
        const pairedFiles = pairedPaths.map((path) => manifest.files?.find((file) => file.path === path));
        if (pairedFiles.every((file) => file !== undefined)) {
          const actual = pairedPaths.map((path) => ({
            path,
            sha256: createHash("sha256")
              .update(readFileSync(join(appDir, "..", path)))
              .digest("hex"),
          }));
          if (actual.every((file, index) => file.sha256 === pairedFiles[index]?.sha256)) {
            artifactSetSha256 = createHash("sha256").update(JSON.stringify(actual)).digest("hex");
            artifactVerification = "paired_manifest_verified";
          } else {
            artifactVerification = "manifest_mismatch";
          }
        }
        if (
          listed?.sha256 === artifactSha256 &&
          artifactVerification !== "manifest_mismatch" &&
          typeof manifest.buildCommit === "string" &&
          /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(manifest.buildCommit)
        ) {
          buildCommit = manifest.buildCommit;
        } else {
          artifactVerification = "manifest_mismatch";
        }
      }
    } catch {
      // Source checkouts and older runtime layouts may have no manifest or entrypoint file.
    }
  }
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    buildCommit,
    artifactSha256,
    generation,
    pid: process.pid,
    artifactSetSha256,
    artifactVerification,
  };
}

export const runtimeIdentity = createRuntimeIdentity();

export interface HelperRuntimeDiagnostic {
  pid: number;
  protocolStatus: "compatible" | "legacy_unverified";
  identity: RuntimeIdentity | null;
}

const observedHelpers = new Map<symbol, HelperRuntimeDiagnostic>();

export function getObservedHelperDiagnostics(): HelperRuntimeDiagnostic[] {
  return [...observedHelpers.values()];
}

export function setObservedHelperDiagnostic(owner: symbol, diagnostic: HelperRuntimeDiagnostic | null): void {
  if (diagnostic) {
    observedHelpers.set(owner, diagnostic);
  } else {
    observedHelpers.delete(owner);
  }
}
