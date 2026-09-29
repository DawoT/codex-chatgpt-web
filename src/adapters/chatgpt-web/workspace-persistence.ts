import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { CodexMessage } from "../../types";
import {
  extractReferencedFilePaths,
  listTurnCheckpoints,
  mergeCompactionIntoWorkspaceState,
  saveTurnCheckpoint,
} from "./autonomous-compaction";
import type { ChatGptTurnEnvironment } from "./environment";
import { assertWritableRootContainment } from "./fast-path/sandbox";
import { resolveSubagentWorkspace, sanitizeSubagentId } from "./subagent-workspace";
import { ensureWorkspaceState, readWorkspaceState } from "./workspace-state";

/** Automatic bridge persistence never invents authority or falls back to home storage. */
function writableWorkspace(environment: ChatGptTurnEnvironment | undefined, paths: string[]): string | undefined {
  if (!environment?.cwd || environment.execution === "host-only" || environment.sandboxPolicy.type === "readOnly")
    return undefined;
  const root = resolve(environment.cwd);
  const writableRoots =
    environment.sandboxPolicy.type === "workspaceWrite" ? environment.sandboxPolicy.writableRoots : [root];
  assertWritableRootContainment(root, root, writableRoots);
  for (const path of paths) {
    const target = join(root, ".agents", path);
    assertWritableRootContainment(target, target, writableRoots);
  }
  return root;
}

export function initializeTurnWorkspace(environment: ChatGptTurnEnvironment | undefined, subagentId?: string): void {
  const paths = ["STATE.md"];
  if (subagentId) paths.push(join("subagents", sanitizeSubagentId(subagentId)));
  const root = writableWorkspace(environment, paths);
  if (!root) return;
  ensureWorkspaceState(root, undefined, true);
  if (subagentId) resolveSubagentWorkspace(root, subagentId, true);
}

export function persistTurnCompaction(
  environment: ChatGptTurnEnvironment | undefined,
  messages: readonly CodexMessage[],
  summary: string,
): boolean {
  const root = writableWorkspace(environment, ["STATE.md", "checkpoints"]);
  if (!root) return false;
  // The Responses parser stamps every reconstructed message with the current request time.
  // An exact HTTP replay must retain the same checkpoint epoch.
  const stableHistory = messages.map(({ timestamp: _timestamp, ...message }) => message);
  const sourceHistoryHash = createHash("sha256").update(JSON.stringify(stableHistory)).digest("hex");
  const latest = listTurnCheckpoints(root)[0];
  if (latest?.compactSummary !== summary || latest.metadata?.sourceHistoryHash !== sourceHistoryHash) {
    saveTurnCheckpoint(
      root,
      {
        epoch: (latest?.epoch ?? 0) + 1,
        turnCount: messages.length,
        stateSnapshot: readWorkspaceState(root),
        compactSummary: summary,
        prunedFileReferences: extractReferencedFilePaths(messages),
        metadata: { sourceHistoryHash },
      },
      undefined,
      true,
    );
  }
  // Recheck immediately before the second write; checkpoint persistence may take time.
  writableWorkspace(environment, ["STATE.md"]);
  mergeCompactionIntoWorkspaceState(root, summary, undefined, true);
  return true;
}
