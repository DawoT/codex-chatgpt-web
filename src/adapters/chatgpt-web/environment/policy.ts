import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { decodeXmlText, matchesPath, pathIdentity, record } from "./helpers";
import type { ChatGptMetadataSandbox, ChatGptSandboxPolicy } from "./types";

export function sandboxTypeFromEnvironment(text: string): ChatGptSandboxPolicy["type"] | undefined {
  const unrestricted =
    /<permission_profile\s+type=["']disabled["'][^>]*>[\s\S]*?<file_system\s+type=["']unrestricted["'][^>]*\/?\s*>/i.test(
      text,
    ) || /<sandbox_mode>danger-full-access<\/sandbox_mode>/i.test(text);
  const restrictedFileSystem =
    /<permission_profile\s+type=["']managed["'][^>]*>[\s\S]*?<file_system\s+type=["']restricted["'][^>]*>([\s\S]*?)<\/file_system>/i.exec(
      text,
    );
  const restrictedHasWriteEntry =
    restrictedFileSystem !== null && /<entry\s+access=["']write["'][^>]*>/i.test(restrictedFileSystem[1]!);
  const workspaceWrite = /<sandbox_mode>workspace-write<\/sandbox_mode>/i.test(text) || restrictedHasWriteEntry;
  const readOnly =
    /<sandbox_mode>read-only<\/sandbox_mode>/i.test(text) ||
    (restrictedFileSystem !== null && !restrictedHasWriteEntry);
  if (Number(unrestricted) + Number(workspaceWrite) + Number(readOnly) !== 1) return undefined;
  return unrestricted ? "dangerFullAccess" : workspaceWrite ? "workspaceWrite" : "readOnly";
}

export function canonicalSandboxMetadata(metadata: Record<string, unknown>): unknown {
  return metadata.sandbox_mode ?? metadata.sandbox;
}

export function sandboxTypeFromMetadata(value: unknown): ChatGptMetadataSandbox | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase().replaceAll("_", "-")) {
    case "none":
    case "unrestricted":
    case "danger-full-access":
      return "dangerFullAccess";
    case "workspace-write":
      return "workspaceWrite";
    case "read-only":
      return "readOnly";
    // Codex CLI reports the host sandbox mechanism here, while the XML envelope carries the
    // effective filesystem policy. Keep the platform tag as a separate class and validate the
    // actual policy below instead of guessing write access from the platform name.
    case "windows-sandbox":
    case "windows-elevated":
    case "seatbelt":
    case "seccomp":
      return "platform";
    default:
      return undefined;
  }
}

export function sandboxMetadataMatchesEnvironment(metadataValue: unknown, environmentText: string): boolean {
  const metadataSandbox = sandboxTypeFromMetadata(metadataValue);
  const environmentSandbox = sandboxTypeFromEnvironment(environmentText);
  if (!metadataSandbox || !environmentSandbox) return false;
  if (metadataSandbox === "platform") {
    return environmentSandbox === "workspaceWrite" || environmentSandbox === "readOnly";
  }
  return metadataSandbox === environmentSandbox;
}

export function isCurrentOrParentThreadVisualizationRoot(path: string, metadata: Record<string, unknown>): boolean {
  const threadIds = [metadata.thread_id, metadata.parent_thread_id]
    .filter((value): value is string => typeof value === "string")
    .map((value) => (process.platform === "win32" ? value.trim().toLowerCase() : value.trim()))
    .filter(Boolean);
  if (threadIds.length === 0) return false;

  // Codex advertises its task-scoped visualization output directory in workspace_roots but omits
  // it from Git-oriented turn metadata. Authenticate that one auxiliary shape by both its private
  // Codex home and current or parent thread id; arbitrary roots and unrelated output remain untrusted.
  const configuredCodexHome = process.env.CODEX_HOME?.trim();
  const codexHome = resolve(configuredCodexHome || join(homedir(), ".codex"));
  const visualizationBase = pathIdentity(join(codexHome, "visualizations"));
  const rel = relative(visualizationBase, pathIdentity(path));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;

  const parts = rel.split(sep);
  return (
    parts.length === 4 &&
    /^\d{4}$/.test(parts[0]!) &&
    /^(?:0[1-9]|1[0-2])$/.test(parts[1]!) &&
    /^(?:0[1-9]|[12]\d|3[01])$/.test(parts[2]!) &&
    threadIds.includes(parts[3]!)
  );
}

export function environmentCwdMatches(text: string, preferredRoots: string[] = []): string[] {
  const sections = [...text.matchAll(/<environments>([\s\S]*?)<\/environments>/gi)];
  if (sections.length === 0) {
    const cwdMatches = [...text.matchAll(/<cwd>([^<]+)<\/cwd>/gi)].map((match) => match[1] ?? "");
    if (cwdMatches.length > 0 || /<\/?cwd\b/i.test(text)) return cwdMatches;

    // Codex Desktop 0.150+ can emit a filesystem-only environment diff when an existing task is
    // rebound to another model. Its ordered multi-folder contract uses the first workspace root as
    // the task's working directory and the remaining roots as additional filesystem authority.
    // Recover only that exact cwd-less shape; malformed cwd markup and multi-environment payloads
    // continue to fail closed.
    const rootSections = [...text.matchAll(/<workspace_roots>[\s\S]*?<\/workspace_roots>/gi)];
    if (rootSections.length !== 1) return [];
    const rootSection = rootSections[0]![0];
    const roots = [...rootSection.matchAll(/<root>([^<]+)<\/root>/gi)].map((match) => match[1] ?? "");
    const rootOpenings = [...rootSection.matchAll(/<root\b[^>]*>/gi)];
    const rootClosings = [...rootSection.matchAll(/<\/root\s*>/gi)];
    if (rootOpenings.length !== roots.length || rootClosings.length !== roots.length) return [];
    return roots.length > 0 ? [roots[0]!] : [];
  }
  if (sections.length !== 1) return [];

  const section = sections[0]!;
  const outside = text.replace(section[0], "");
  if (/<cwd>[^<]*<\/cwd>/i.test(outside)) return [];

  const environments = [...section[1]!.matchAll(/<environment\b([^>]*)>([\s\S]*?)<\/environment>/gi)];
  const primary = environments.filter((match) => /\bprimary\s*=\s*["']true["']/i.test(match[1] ?? ""));
  if (primary.length === 1) {
    return [...primary[0]![2]!.matchAll(/<cwd>([^<]+)<\/cwd>/gi)].map((match) => match[1] ?? "");
  }
  if (primary.length > 1) return [];

  // Codex 0.146.x emitted multiple environments without a primary attribute. Only use that
  // legacy shape when canonical workspace metadata identifies one candidate; never pick by order.
  const candidates = environments.flatMap((environment) => {
    const cwdMatches = [...environment[2]!.matchAll(/<cwd>([^<]+)<\/cwd>/gi)].map((match) => match[1] ?? "");
    return cwdMatches.length === 1 ? cwdMatches : [];
  });
  if (candidates.length === 1) return candidates;
  if (preferredRoots.length === 0) return [];

  const exact = candidates.filter((candidate) =>
    preferredRoots.some((root) => pathIdentity(root) === pathIdentity(candidate)),
  );
  if (exact.length === 1) return exact;
  const contained = candidates.filter((candidate) => preferredRoots.some((root) => matchesPath(root, candidate)));
  return contained.length === 1 ? contained : [];
}

export function environmentMatchesCanonicalMetadata(
  environmentText: string,
  metadata: Record<string, unknown>,
  requireMetadataBoundRoots: boolean,
): boolean {
  const metadataSandboxValue = canonicalSandboxMetadata(metadata);
  const metadataSandbox = sandboxTypeFromMetadata(metadataSandboxValue);
  if (!metadataSandbox) return false;
  const workspaces = record(metadata.workspaces);
  const metadataRoots = workspaces ? Object.keys(workspaces) : [];
  if (metadataRoots.some((path) => !isAbsolute(path))) return false;
  const normalizedMetadataRoots = [...new Set(metadataRoots.map(pathIdentity))];

  let cwdMatches: string[];
  try {
    cwdMatches = environmentCwdMatches(environmentText, normalizedMetadataRoots).map((value) =>
      decodeXmlText(value.trim()),
    );
  } catch {
    return false;
  }
  if (cwdMatches.length !== 1 || !isAbsolute(cwdMatches[0]!)) return false;
  const rootMatches = [...environmentText.matchAll(/<workspace_roots>[\s\S]*?<\/workspace_roots>/g)].flatMap(
    (section) => [...section[0].matchAll(/<root>([^<]+)<\/root>/g)].map((match) => decodeXmlText(match[1]!.trim())),
  );
  const declaredRootValues = rootMatches.length > 0 ? rootMatches : cwdMatches;
  if (declaredRootValues.some((path) => !isAbsolute(path))) return false;
  const declaredRoots = [...new Set(declaredRootValues.map(pathIdentity))];
  const cwd = pathIdentity(cwdMatches[0]!);
  if (normalizedMetadataRoots.length > 0 && !normalizedMetadataRoots.some((root) => matchesPath(root, cwd)))
    return false;
  if (
    requireMetadataBoundRoots &&
    (normalizedMetadataRoots.length === 0 ||
      declaredRoots.some(
        (root) =>
          !normalizedMetadataRoots.some((metadataRoot) => matchesPath(metadataRoot, root)) &&
          !isCurrentOrParentThreadVisualizationRoot(root, metadata),
      ))
  )
    return false;
  if (!declaredRoots.some((root) => matchesPath(root, cwd))) return false;
  return sandboxMetadataMatchesEnvironment(metadataSandboxValue, environmentText);
}
