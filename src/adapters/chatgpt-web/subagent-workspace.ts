import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { SubagentStructuredResult, SubagentResultStatus } from "./subagent-protocol";
import { pruneCodexSessions } from "./session-store-pruner";

export interface SubagentWorkspaceInfo {
  subagentId: string;
  workspaceDir: string;
  scratchDir: string;
  resultPath: string;
}

export function sanitizeSubagentId(id: string): string {
  if (!id || typeof id !== "string") return "sub_unknown";
  return id.replace(/[^\w.-]/g, "_").slice(0, 48);
}

export function resolveSubagentWorkspace(workspaceRoot?: string, subagentId = "sub_default"): string {
  const safeId = sanitizeSubagentId(subagentId);

  if (workspaceRoot && typeof workspaceRoot === "string") {
    try {
      const subagentDir = resolve(workspaceRoot, ".agents", "subagents", safeId);
      mkdirSync(subagentDir, { recursive: true });
      return subagentDir;
    } catch {
      // Fall through to home fallback if workspace is not writable
    }
  }

  const fallbackDir = join(homedir(), ".codex-chatgpt-web", "subagents", safeId);
  try {
    mkdirSync(fallbackDir, { recursive: true });
  } catch {
    // Ignore error
  }
  return fallbackDir;
}

export function resolveSubagentScratchDir(workspaceRoot?: string, subagentId = "sub_default"): string {
  const workspaceDir = resolveSubagentWorkspace(workspaceRoot, subagentId);
  const scratchDir = join(workspaceDir, "scratch", "outputs");
  mkdirSync(scratchDir, { recursive: true });
  return scratchDir;
}

export function writeSubagentResult(
  workspaceRoot: string,
  subagentId: string,
  result: SubagentStructuredResult,
): void {
  const workspaceDir = resolveSubagentWorkspace(workspaceRoot, subagentId);
  const resultPath = join(workspaceDir, "result.json");
  const tmpPath = `${resultPath}.tmp.${process.pid}.${Date.now()}`;

  const payload = JSON.stringify(result, null, 2);
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, resultPath);
}

export function readSubagentResult(
  workspaceRoot?: string,
  subagentId = "sub_default",
): SubagentStructuredResult | null {
  const workspaceDir = resolveSubagentWorkspace(workspaceRoot, subagentId);
  const resultPath = join(workspaceDir, "result.json");

  if (!existsSync(resultPath)) return null;

  try {
    const raw = readFileSync(resultPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as SubagentStructuredResult;
  } catch {
    return null;
  }
}

export function listSubagentWorkspaces(workspaceRoot?: string): string[] {
  let baseDir: string;
  if (workspaceRoot && typeof workspaceRoot === "string") {
    baseDir = resolve(workspaceRoot, ".agents", "subagents");
  } else {
    baseDir = join(homedir(), ".codex-chatgpt-web", "subagents");
  }

  if (!existsSync(baseDir)) return [];

  try {
    const entries = readdirSync(baseDir);
    return entries.filter(entry => {
      try {
        const fullPath = join(baseDir, entry);
        return statSync(fullPath).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

export function cleanupSubagentWorkspace(
  workspaceRoot: string,
  subagentId: string,
  options?: { retainArtifacts?: boolean },
): void {
  const workspaceDir = resolveSubagentWorkspace(workspaceRoot, subagentId);
  const scratchDir = join(workspaceDir, "scratch");

  // Remove scratch directory completely
  if (existsSync(scratchDir)) {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
      // Re-create empty scratch outputs directory for subsequent uses
      mkdirSync(join(scratchDir, "outputs"), { recursive: true });
    } catch {
      // Ignore cleanup error
    }
  }

  const retainArtifacts = options?.retainArtifacts !== false;
  if (!retainArtifacts) {
    // Remove all files except result.json
    try {
      const files = readdirSync(workspaceDir);
      for (const file of files) {
        if (file === "result.json" || file === "scratch") continue;
        rmSync(join(workspaceDir, file), { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup error
    }
  }
}

export interface SubagentGcPolicy {
  maxWorkspaces?: number;
  maxAgeMs?: number;
  retainScratchForStatuses?: SubagentResultStatus[];
  pruneSessions?: boolean;
  sessionsDir?: string;
}

export interface SubagentGcReport {
  purgedWorkspaces: string[];
  cleanedScratchDirs: string[];
  prunedRolloutsCount?: number;
  reclaimedRolloutBytes?: number;
}

export const DEFAULT_MAX_SUBAGENT_WORKSPACES = 20;
export const DEFAULT_SUBAGENT_WORKSPACE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Periodically garbage collects subagent workspaces:
 * - Purges temporary scratch/outputs for completed and failed subagents.
 * - Enforces FIFO retention of completed subagents, retaining at most maxWorkspaces.
 * - Protects active or blocked subagents from premature deletion.
 */
export function gcSubagentWorkspaces(
  workspaceRoot: string,
  policy: SubagentGcPolicy = {},
): SubagentGcReport {
  const maxWorkspaces = policy.maxWorkspaces ?? DEFAULT_MAX_SUBAGENT_WORKSPACES;
  const retainScratch = policy.retainScratchForStatuses ?? ["blocked"];

  const cleanedScratchDirs: string[] = [];
  const purgedWorkspaces: string[] = [];

  const subagents = listSubagentWorkspaces(workspaceRoot);
  const now = Date.now();

  const completedSubagents: Array<{ id: string; dir: string; mtimeMs: number }> = [];

  for (const id of subagents) {
    const wsDir = resolveSubagentWorkspace(workspaceRoot, id);
    const result = readSubagentResult(workspaceRoot, id);
    let mtimeMs = now;
    try {
      mtimeMs = statSync(wsDir).mtimeMs;
    } catch {
      // Ignore stat error
    }

    // 1. Purge scratch outputs if completed or failed and not in retain list
    if (result && result.status !== "blocked" && !retainScratch.includes(result.status)) {
      const scratchOutputs = join(wsDir, "scratch", "outputs");
      if (existsSync(scratchOutputs)) {
        try {
          const files = readdirSync(scratchOutputs);
          if (files.length > 0) {
            for (const file of files) {
              unlinkSync(join(scratchOutputs, file));
            }
            cleanedScratchDirs.push(id);
          }
        } catch {
          // Ignore scratch cleanup error
        }
      }
    }

    // Only completed subagents participate in FIFO workspace purging
    if (result && result.status === "completed") {
      completedSubagents.push({ id, dir: wsDir, mtimeMs });
    }
  }

  // Sort completed subagents oldest first
  completedSubagents.sort((a, b) => a.mtimeMs - b.mtimeMs);

  // If completed subagents exceed maxWorkspaces, delete oldest excess
  if (completedSubagents.length > maxWorkspaces) {
    const excess = completedSubagents.length - maxWorkspaces;
    const toPurge = completedSubagents.slice(0, excess);
    for (const item of toPurge) {
      try {
        rmSync(item.dir, { recursive: true, force: true });
        purgedWorkspaces.push(item.id);
      } catch {
        // Ignore removal error
      }
    }
  }

  let prunedRolloutsCount = 0;
  let reclaimedRolloutBytes = 0;
  if (policy.pruneSessions) {
    try {
      const pruneResult = pruneCodexSessions({
        sessionsDir: policy.sessionsDir,
        targetSources: ["subagent:thread_spawn", "subagent:other"],
        protectRecentMs: 3_600_000,
      });
      prunedRolloutsCount = pruneResult.prunedFiles.length;
      reclaimedRolloutBytes = pruneResult.reclaimedBytes;
    } catch {
      // Ignore prune errors
    }
  }

  return { purgedWorkspaces, cleanedScratchDirs, prunedRolloutsCount, reclaimedRolloutBytes };
}

