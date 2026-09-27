import { join, resolve } from "node:path";
import type { CodexMessage } from "../../types";
import type { ChatGptTurnEnvironment } from "./environment";
import { assertWritableRootContainment } from "./fast-path/sandbox";
import { ensureWorkspaceState, readWorkspaceState } from "./workspace-state";
import { resolveSubagentWorkspace, sanitizeSubagentId } from "./subagent-workspace";
import {
  extractReferencedFilePaths,
  listTurnCheckpoints,
  mergeCompactionIntoWorkspaceState,
  saveTurnCheckpoint,
} from "./autonomous-compaction";

/** Automatic bridge persistence never invents authority or falls back to home storage. */
function writableWorkspace(environment: ChatGptTurnEnvironment | undefined, paths: string[]): string | undefined {
  if (!environment?.cwd || environment.execution === "host-only" || environment.sandboxPolicy.type === "readOnly") return undefined;
  const root = resolve(environment.cwd);
  const writableRoots = environment.sandboxPolicy.type === "workspaceWrite"
    ? environment.sandboxPolicy.writableRoots
    : [root];
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

export function persistTurnCompaction(environment: ChatGptTurnEnvironment | undefined, messages: readonly CodexMessage[], summary: string): void {
  const root = writableWorkspace(environment, ["STATE.md", "checkpoints"]);
  if (!root) return;
  const nextEpoch = (listTurnCheckpoints(root)[0]?.epoch ?? 0) + 1;
  saveTurnCheckpoint(root, {
    epoch: nextEpoch,
    turnCount: messages.length,
    stateSnapshot: readWorkspaceState(root),
    compactSummary: summary,
    prunedFileReferences: extractReferencedFilePaths(messages),
  }, undefined, true);
  // Recheck immediately before the second write; checkpoint persistence may take time.
  writableWorkspace(environment, ["STATE.md"]);
  mergeCompactionIntoWorkspaceState(root, summary, undefined, true);
}
