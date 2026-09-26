import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { CodexMessage } from "../../types";
import {
  type WorkspaceState,
  readWorkspaceState,
  writeWorkspaceState,
  ensureWorkspaceState,
  defaultWorkspaceState,
} from "./workspace-state";

export interface AutonomousCompactionContext {
  turnCount: number;
  estimatedTokens: number;
  capacityTokens: number;
  consecutiveUncompactedTurns?: number;
  actionRequired?: string;
}

export interface TurnCheckpoint {
  epoch: number;
  timestamp: string;
  turnCount: number;
  stateSnapshot: WorkspaceState | null;
  compactSummary: string;
  prunedFileReferences: string[];
  metadata?: Record<string, unknown>;
}

export interface CompactionQualityVerdict {
  valid: boolean;
  missingInvariants: string[];
  detectedFiles: string[];
}

export const AUTONOMOUS_COMPACTION_TOKEN_THRESHOLD_RATIO = 0.85;
export const AUTONOMOUS_COMPACTION_MAX_UNCOMPACTED_TURNS = 20;
export const DEFAULT_CHECKPOINT_MAX_RETENTION = 5;
export const MIN_COMPACTION_SUMMARY_LENGTH = 50;

/**
 * Evaluates whether an autonomous background compaction should be triggered based
 * on context window pressure, turn count, or preflight budget recommendations.
 */
export function evaluateAutonomousCompactionNeeded(context: AutonomousCompactionContext): boolean {
  if (context.actionRequired === "trigger_compaction") {
    return true;
  }

  if (context.capacityTokens > 0) {
    const ratio = context.estimatedTokens / context.capacityTokens;
    if (ratio >= AUTONOMOUS_COMPACTION_TOKEN_THRESHOLD_RATIO) {
      return true;
    }
  }

  if (context.consecutiveUncompactedTurns !== undefined) {
    if (context.consecutiveUncompactedTurns >= AUTONOMOUS_COMPACTION_MAX_UNCOMPACTED_TURNS) {
      return true;
    }
  } else if (context.turnCount >= AUTONOMOUS_COMPACTION_MAX_UNCOMPACTED_TURNS) {
    return true;
  }

  return false;
}

/**
 * Resolves or creates the local checkpoint directory under .agents/checkpoints/
 */
export function resolveCheckpointsDirectory(workspaceRoot?: string): string {
  if (workspaceRoot && typeof workspaceRoot === "string") {
    try {
      const dir = join(workspaceRoot, ".agents", "checkpoints");
      mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      // Fallback on unwritable workspace
    }
  }

  const fallbackDir = join(homedir(), ".codex-chatgpt-web", "checkpoints", "default");
  try {
    mkdirSync(fallbackDir, { recursive: true });
  } catch {
    // Ignore fallback directory creation errors
  }
  return fallbackDir;
}

/**
 * Atomically saves a turn checkpoint into .agents/checkpoints/ and rotates old checkpoints.
 */
export function saveTurnCheckpoint(
  workspaceRoot: string,
  checkpoint: Omit<TurnCheckpoint, "timestamp"> & { timestamp?: string },
  maxRetention = DEFAULT_CHECKPOINT_MAX_RETENTION,
): string {
  const dir = resolveCheckpointsDirectory(workspaceRoot);
  const timestamp = checkpoint.timestamp || new Date().toISOString();
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  const filename = `checkpoint_${checkpoint.epoch.toString().padStart(4, "0")}_${safeTimestamp}.json`;
  const targetPath = join(dir, filename);

  const fullCheckpoint: TurnCheckpoint = {
    ...checkpoint,
    timestamp,
  };

  const payload = JSON.stringify(fullCheckpoint, null, 2);
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;

  try {
    writeFileSync(tmpPath, payload, "utf-8");
    renameSync(tmpPath, targetPath);
  } catch {
    try {
      writeFileSync(targetPath, payload, "utf-8");
    } catch (e) {
      console.warn(`[autonomous-compaction] Failed to write checkpoint to ${targetPath}:`, e);
      return targetPath;
    }
  }

  // Rotate older checkpoints if exceeding retention
  try {
    const entries = readdirSync(dir).filter(f => f.startsWith("checkpoint_") && f.endsWith(".json"));
    if (entries.length > maxRetention) {
      const sorted = entries.sort(); // Natural alphabetical sort matches epoch and timestamp order
      const excessCount = sorted.length - maxRetention;
      const toDelete = sorted.slice(0, excessCount);
      for (const oldFile of toDelete) {
        try {
          unlinkSync(join(dir, oldFile));
        } catch {
          // Ignore removal errors
        }
      }
    }
  } catch {
    // Ignore rotation error
  }

  return targetPath;
}

/**
 * Lists all available turn checkpoints sorted descending by epoch and timestamp.
 */
export function listTurnCheckpoints(workspaceRoot: string): TurnCheckpoint[] {
  const dir = resolveCheckpointsDirectory(workspaceRoot);
  if (!existsSync(dir)) return [];

  try {
    const entries = readdirSync(dir).filter(f => f.startsWith("checkpoint_") && f.endsWith(".json"));
    const checkpoints: TurnCheckpoint[] = [];

    for (const file of entries) {
      try {
        const content = readFileSync(join(dir, file), "utf-8");
        const parsed = JSON.parse(content) as TurnCheckpoint;
        checkpoints.push(parsed);
      } catch {
        // Skip corrupted checkpoint files
      }
    }

    return checkpoints.sort((a, b) => {
      if (b.epoch !== a.epoch) return b.epoch - a.epoch;
      return b.timestamp.localeCompare(a.timestamp);
    });
  } catch {
    return [];
  }
}

/**
 * Extracts candidate source and test file paths referenced in messages.
 */
export function extractReferencedFilePaths(messages: readonly CodexMessage[]): string[] {
  const fileRegex = /(?:^|[\s"'`(\[{<])([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+\.[a-zA-Z0-9_-]+|[a-zA-Z0-9_-]+\.(?:ts|js|tsx|jsx|json|md|py|go|rs|css|html|yaml|yml))(?:$|[\s"'`)\]}>:,;])/g;
  const discovered = new Set<string>();

  for (const msg of messages) {
    const text = typeof msg.content === "string"
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map(p => (p && typeof p === "object" && "text" in p ? String(p.text) : "")).join(" ")
        : "";

    if (!text) continue;

    let match: RegExpExecArray | null;
    while ((match = fileRegex.exec(text)) !== null) {
      const candidate = match[1];
      // Filter out URLs, version numbers, or obvious false positives
      if (
        !candidate.startsWith("http://") &&
        !candidate.startsWith("https://") &&
        !/^\d+\.\d+/.test(candidate) &&
        candidate.length > 3
      ) {
        discovered.add(candidate);
      }
    }
  }

  return Array.from(discovered);
}

/**
 * Validates the quality of a generated compaction summary against original messages,
 * ensuring no critical file paths or structural context are lost.
 */
export function validateCompactionQuality(
  originalMessages: readonly CodexMessage[],
  summary: string,
): CompactionQualityVerdict {
  if (!summary || typeof summary !== "string" || summary.trim().length < MIN_COMPACTION_SUMMARY_LENGTH) {
    return {
      valid: false,
      missingInvariants: [`Summary is too short or empty (minimum ${MIN_COMPACTION_SUMMARY_LENGTH} chars required)`],
      detectedFiles: [],
    };
  }

  const detectedFiles = extractReferencedFilePaths(originalMessages);
  const missingInvariants: string[] = [];

  for (const file of detectedFiles) {
    // Check if filename (or path) appears in summary
    const basename = file.split("/").pop() ?? file;
    if (!summary.includes(file) && !summary.includes(basename)) {
      missingInvariants.push(`Missing reference to modified or referenced file: ${file}`);
    }
  }

  return {
    valid: missingInvariants.length === 0,
    missingInvariants,
    detectedFiles,
  };
}

/**
 * Merges a newly completed compaction summary into the persistent .agents/STATE.md.
 */
export function mergeCompactionIntoWorkspaceState(
  workspaceRoot: string,
  summary: string,
  completedMilestones?: string[],
): WorkspaceState {
  const existing = readWorkspaceState(workspaceRoot) ?? ensureWorkspaceState(workspaceRoot);

  if (completedMilestones && completedMilestones.length > 0) {
    for (const milestone of completedMilestones) {
      const trimmed = milestone.trim();
      if (trimmed && !existing.completedMilestones.includes(trimmed)) {
        existing.completedMilestones.push(trimmed);
      }
    }
  }

  existing.lastUpdatedIso = new Date().toISOString();
  writeWorkspaceState(workspaceRoot, existing);

  return existing;
}
