import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../../config";
import type { CodexMessage } from "../../types";
import {
  compactionDraftText,
  compactionStateFields,
  countActiveCompactionStates,
  countCompactionRequirementItems,
  extractStructuredCompactionHandoff,
  locateCompactionStateBounds,
  type CompactionRequirement,
} from "../../responses/compaction";
import { evaluateMissionHeadroom } from "./mission-headroom";
import {
  buildCompactionEvidenceIndex,
  completedExecutionStatus,
  executionResultText,
  hasReportedTestFailures,
} from "./compaction-evidence";
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
  requirements?: readonly CompactionRequirement[];
  growthSamples?: readonly number[];
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

export const DEFAULT_CHECKPOINT_MAX_RETENTION = 5;
export const MIN_COMPACTION_SUMMARY_LENGTH = 50;

/**
 * Compacts only at a measured hard limit or when pending mission work has sampled
 * next-turn growth that cannot fit in the remaining window.
 */
export function evaluateAutonomousCompactionNeeded(context: AutonomousCompactionContext): boolean {
  if (context.actionRequired === "trigger_compaction") {
    return true;
  }

  if (context.capacityTokens <= 0) return false;
  if (context.estimatedTokens >= context.capacityTokens) return true;
  return evaluateMissionHeadroom({
    inputTokens: context.estimatedTokens,
    contextWindow: context.capacityTokens,
    requirements: context.requirements,
    growthSamples: context.growthSamples ?? [],
  }).compact;
}

/**
 * Resolves or creates the local checkpoint directory under .agents/checkpoints/
 */
export function resolveCheckpointsDirectory(workspaceRoot?: string, strict = false): string {
  if (strict) {
    if (!workspaceRoot) throw new Error("Strict persistence requires a workspace root");
    const dir = join(workspaceRoot, ".agents", "checkpoints");
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  if (workspaceRoot && typeof workspaceRoot === "string") {
    try {
      const dir = join(workspaceRoot, ".agents", "checkpoints");
      mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      // Fallback on unwritable workspace
    }
  }

  const fallbackDir = join(getConfigDir(), "checkpoints", "default");
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
  strict = false,
): string {
  const dir = resolveCheckpointsDirectory(workspaceRoot, strict);
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
  } catch (error) {
    if (strict) throw error;
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
  const dir = join(workspaceRoot, ".agents", "checkpoints");
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

/** Successful patch results are evidence of changed files; incidental prose is not. */
export function extractModifiedFilePaths(messages: readonly CodexMessage[]): string[] {
  const files = new Set<string>();
  for (const message of messages) {
    if (message.role !== "toolResult" || message.isError
      || !["apply_patch", "codex_apply_patch"].includes(message.toolName)) continue;
    const output = typeof message.content === "string"
      ? message.content
      : message.content.map(part => "text" in part && typeof part.text === "string" ? part.text : "").join("\n");
    if (!/^Success\./m.test(output)) continue;
    for (const match of output.matchAll(/^[AMD]\s+([^\r\n]+)$/gm)) files.add(match[1]!.trim());
  }
  return [...files];
}

/**
 * Validates the quality of a generated compaction summary against original messages,
 * ensuring no critical file paths or structural context are lost.
 */
export function validateCompactionQuality(
  originalMessages: readonly CodexMessage[],
  summary: string,
  options?: { requireStructured?: boolean; evidenceSessionId?: string },
): CompactionQualityVerdict {
  const draft = typeof summary === "string" ? compactionDraftText(summary) : "";
  if (draft.trim().length < MIN_COMPACTION_SUMMARY_LENGTH) {
    return {
      valid: false,
      missingInvariants: [`Summary is too short or empty (minimum ${MIN_COMPACTION_SUMMARY_LENGTH} chars required)`],
      detectedFiles: [],
    };
  }

  const detectedFiles = extractReferencedFilePaths(originalMessages);
  const missingInvariants: string[] = [];
  const messageText = (message: CodexMessage) => typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map(part => part && typeof part === "object" && "text" in part ? String(part.text) : "").join(" ")
      : "";
  const sourceText = originalMessages.map(messageText).join("\n");
  const normalized = (value: unknown) => typeof value === "string"
    ? value.toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim()
    : "";
  const normalizedSource = normalized(sourceText);

  for (const file of options?.requireStructured ? [] : detectedFiles) {
    // Check if filename (or path) appears in summary
    const basename = file.split("/").pop() ?? file;
    if (!draft.includes(file) && !draft.includes(basename)) {
      missingInvariants.push(`Missing reference to modified or referenced file: ${file}`);
    }
  }

  const hasOnlyFencedState = locateCompactionStateBounds(draft) !== null
    && locateCompactionStateBounds(draft, { unfencedOnly: true }) === null;
  const structured = hasOnlyFencedState
    ? null
    : extractStructuredCompactionHandoff(draft).state;
  if (options?.requireStructured) {
    if (countActiveCompactionStates(draft) > 1) {
      missingInvariants.push("Multiple active compaction state blocks");
    }
    if (!structured) {
      missingInvariants.push("Missing structured compaction state");
    } else {
      if (!structured.activeHypothesis) missingInvariants.push("Missing active objective or hypothesis");
      if (structured.version !== 2) missingInvariants.push("Checkpoint requires mission checklist version 2");
      if (!structured.originalRequestRef) missingInvariants.push("Missing original request reference");
      if (!structured.requirements?.length) missingInvariants.push("Missing mission requirements");
      if (countCompactionRequirementItems(draft) !== (structured.requirements?.length ?? 0)) {
        missingInvariants.push("Invalid mission requirement item");
      }
      if (!structured.closureCriteria?.length) missingInvariants.push("Missing closure criteria");
      if (structured.nextActions.length !== 1) missingInvariants.push("Checkpoint requires one clear next action");
      const fields = compactionStateFields(draft);
      for (const section of [
        "modified_files",
        "requirements",
        "closure_criteria",
        "verified_achievements",
        "decisions_and_invariants",
        "blockers_or_test_failures",
        "pending_obligations",
        "next_actions",
      ]) {
        if (!fields.has(section) && !(section === "blockers_or_test_failures" && fields.has("blockers"))) {
          missingInvariants.push(`Missing ${section} section`);
        }
      }
      for (const [section, values] of [
        ["verified_achievements", structured.verifiedAchievements ?? []],
        ["decisions_and_invariants", structured.decisionsAndInvariants ?? []],
        ["blockers_or_test_failures", structured.blockersOrTestFailures],
        ["pending_obligations", structured.pendingObligations ?? []],
      ] as const) {
        const unique = new Set(values.map(value => normalized(
          typeof value === "string" ? value : value.result,
        )));
        if (unique.size !== values.length) missingInvariants.push(`Duplicate ${section} entries`);
      }
      const ids = new Set<string>();
      for (const requirement of structured.requirements ?? []) {
        if (typeof requirement.id !== "string" || !/^[-A-Za-z0-9_]+$/.test(requirement.id)) {
          missingInvariants.push("Mission requirement has an invalid stable ID");
        }
        if (ids.has(requirement.id)) missingInvariants.push(`Duplicate requirement ID: ${requirement.id}`);
        ids.add(requirement.id);
        if (typeof requirement.source !== "string" || !requirement.source.trim()) {
          missingInvariants.push(`Missing source for requirement ${requirement.id}`);
        }
        if (!["pending", "blocked", "verified"].includes(requirement.status)) {
          missingInvariants.push(`Invalid status for requirement ${requirement.id}`);
        }
        if (requirement.status === "verified" && (typeof requirement.evidence !== "string" || !requirement.evidence.trim())) {
          missingInvariants.push(`Verified requirement ${requirement.id} lacks evidence`);
        }
      }
      for (const file of extractModifiedFilePaths(originalMessages)) {
        if (!structured.modifiedFiles.includes(file)) {
          missingInvariants.push(`Missing modified file from successful patch: ${file}`);
        }
      }
    }
  }
  const boundToolCall = (toolCallId: string, beforeIndex: number) => {
    for (let index = beforeIndex - 1; index >= 0; index--) {
      const message = originalMessages[index]!;
      if (message.role !== "assistant") continue;
      const call = message.content.findLast(part => part.type === "toolCall" && part.id === toolCallId);
      if (call?.type === "toolCall") return call;
    }
    return undefined;
  };
  const toolCommand = (toolCallId: string, toolName: string, beforeIndex: number): string | undefined => {
    const call = boundToolCall(toolCallId, beforeIndex);
    if (!call || call.name !== toolName) return undefined;
    if (typeof call.arguments.cmd === "string") return call.arguments.cmd;
    if (toolName !== "write_stdin" && toolName !== "codex_write_stdin") return undefined;
    const sessionId = call.arguments.session_id;
    if (!Number.isSafeInteger(sessionId)) return undefined;
    for (let index = beforeIndex - 1; index >= 0; index--) {
      const prior = originalMessages[index]!;
      if (prior.role !== "toolResult" || prior.isError || prior.toolName !== "exec_command") continue;
      const priorText = messageText(prior);
      const match = /"session_id"\s*:\s*(\d+)/.exec(priorText);
      if (match && Number(match[1]) === sessionId) {
        return toolCommand(prior.toolCallId, prior.toolName, index);
      }
    }
    return undefined;
  };
  const observedEvidence = (
    evidence: unknown,
    requirement: unknown,
    allowedResultIndexes?: ReadonlySet<number>,
  ): boolean => typeof evidence === "string"
    && evidence.trim().length > 0 && originalMessages.some((message, index) => {
    if (allowedResultIndexes && !allowedResultIndexes.has(index)) return false;
    const content = messageText(message);
    if (!normalized(content).includes(normalized(evidence))) return false;
    if (message.role === "toolResult") {
      const testInvocation = /\b(?:bun test|npm test|pnpm test|yarn test|pytest|cargo test|go test)\b[^:\n]*/i.exec(evidence)?.[0]?.trim();
      const requirementAction = typeof requirement === "string"
        ? requirement.replace(/^user turn [^:]+:\s*/i, "").trim() : "";
      const requiresTestExecution = /^(?:test|pytest)\b|^(?:run|execute|rerun|verify)\b[^\n]*\b(?:test|tests|pytest)\b/i
        .test(requirementAction);
      const requiresDeployment = /\b(?:deploy|deployed|deployment|publish|published|release)\b/i
        .test(requirementAction);
      if (message.toolName === "apply_patch" || message.toolName === "codex_apply_patch") {
        const callBound = boundToolCall(message.toolCallId, index)?.name === message.toolName;
        const changedLines = /^([AM])\s+([^\n]+)$/gm;
        return message.isError !== true && !requiresTestExecution && callBound
          && /^Success\. Updated the following files:\s*\n/.test(content)
          && [...content.matchAll(changedLines)].some(match => normalized(match[0]) === normalized(evidence)
            && typeof requirement === "string" && normalized(requirement).includes(normalized(match[2]!)));
      }
      const command = toolCommand(message.toolCallId, message.toolName, index);
      let directCommand = command?.trim().replace(/^set\s+-o\s+pipefail\s*;\s*/, "");
      // Permit only inert, explicit wrappers around a test invocation. Arbitrary shell prefixes
      // (including echoing a saved result) must never prove that the test actually ran.
      for (let index = 0; directCommand !== undefined && index < 4; index++) {
        const wrapper = /^(?:cd\s+(?:[A-Za-z0-9_./-]+|'[^'$`\n]+'|"[^"$`\n]+")\s*&&\s*|env\s+(?:[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_./:@-]+\s+)+|timeout\s+[1-9][0-9]*(?:s|m|h)?\s+)/.exec(directCommand);
        if (!wrapper) break;
        directCommand = directCommand.slice(wrapper[0].length);
      }
      const deploymentCommand = directCommand !== undefined
        && /^(?:(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:deploy|publish|release)|(?:wrangler|vercel|netlify|firebase)\s+deploy)\b(?:\s+[-\w./:=]+)*$/i.test(directCommand)
        && !/(?:^|\s)(?:-h\b|--(?:help|version|dry[-_]?run|plan|check|preview)\b)/i.test(directCommand)
        && !/\bUsage:\s/i.test(content);
      return message.isError !== true
        && ["exec_command", "write_stdin", "codex_exec", "codex_write_stdin"].includes(message.toolName)
        && directCommand !== undefined
        && (!testInvocation || normalized(directCommand).startsWith(normalized(testInvocation)))
        && (!requiresTestExecution || /^(?:(?:bun|npm|pnpm|yarn|cargo|go)\s+test\b|pytest\b|node\s+--test\b)/i.test(directCommand))
        && (!requiresDeployment || deploymentCommand)
        && completedExecutionStatus(content, message.isError) === "succeeded"
        && !hasReportedTestFailures(executionResultText(content));
    }
    return false;
  });
  const evidenceIndex = new Map(buildCompactionEvidenceIndex(
    originalMessages,
    options?.evidenceSessionId ?? "",
  ).map(observation => [observation.ref, observation]));
  for (const requirement of structured?.requirements ?? []) {
    if (requirement.evidenceRefs !== undefined) {
      if (!Array.isArray(requirement.evidenceRefs) || requirement.evidenceRefs.length === 0
        || requirement.evidenceRefs.some(ref => typeof ref !== "string" || !evidenceIndex.has(ref))) {
        missingInvariants.push(`Requirement ${requirement.id} has an unknown evidence reference`);
      } else if (requirement.status === "verified"
        && requirement.evidenceRefs.some(ref => evidenceIndex.get(ref)?.status !== "succeeded")) {
        missingInvariants.push(`Requirement ${requirement.id} references an unfinished or failed result`);
      }
    }
    const allowedResultIndexes = requirement.evidenceRefs?.every(ref => evidenceIndex.has(ref))
      ? new Set(requirement.evidenceRefs.map(ref => evidenceIndex.get(ref)!.messageIndex ?? -1))
      : undefined;
    const inheritedUnchanged = originalMessages.some(message => {
      if (message.role !== "user" || message.origin !== "compaction_summary") return false;
      const prior = extractStructuredCompactionHandoff(messageText(message)).state;
      return prior?.requirements?.some(item => item.status === "verified"
        && item.id === requirement.id
        && item.source === requirement.source
        && normalized(item.evidence) === normalized(requirement.evidence)) === true;
    });
    if (requirement.status === "verified" && requirement.evidence
      && !inheritedUnchanged
      && !observedEvidence(requirement.evidence, requirement.source, allowedResultIndexes)) {
      missingInvariants.push(`Verified requirement ${requirement.id} has no completed observation`);
    }
  }
  if (structured?.verifiedAchievements) {
    for (const achievement of structured.verifiedAchievements) {
      const inheritedUnchanged = originalMessages.some(message => {
        if (message.role !== "user" || message.origin !== "compaction_summary") return false;
        const prior = extractStructuredCompactionHandoff(messageText(message)).state;
        return prior?.verifiedAchievements?.some(item => {
          if (typeof item === "string" && typeof achievement === "string") {
            return normalized(item) === normalized(achievement);
          }
          if (typeof item !== "string" && typeof achievement !== "string") {
            return normalized(item.result) === normalized(achievement.result)
              && normalized(item.evidence) === normalized(achievement.evidence)
              && JSON.stringify(item.evidenceRefs ?? []) === JSON.stringify(achievement.evidenceRefs ?? []);
          }
          return false;
        }) === true;
      });
      if (inheritedUnchanged) continue;
      if (typeof achievement !== "string") {
        if (typeof achievement.result !== "string" || !achievement.result.trim()
          || typeof achievement.evidence !== "string" || !achievement.evidence.trim()) {
          missingInvariants.push("Structured achievement lacks result or evidence");
          continue;
        }
        let allowedResultIndexes: Set<number> | undefined;
        if (achievement.evidenceRefs !== undefined) {
          if (!Array.isArray(achievement.evidenceRefs) || achievement.evidenceRefs.length === 0
            || achievement.evidenceRefs.some(ref => typeof ref !== "string" || !evidenceIndex.has(ref))) {
            missingInvariants.push(`Achievement ${achievement.result} has an unknown evidence reference`);
            continue;
          }
          if (achievement.evidenceRefs.some(ref => evidenceIndex.get(ref)?.status !== "succeeded")) {
            missingInvariants.push(`Achievement ${achievement.result} references an unfinished or failed result`);
            continue;
          }
          allowedResultIndexes = new Set(achievement.evidenceRefs.map(ref => evidenceIndex.get(ref)!.messageIndex ?? -1));
        }
        if (!observedEvidence(achievement.evidence, achievement.result, allowedResultIndexes)) {
          missingInvariants.push(`Achievement ${achievement.result} has no completed observation`);
        }
        continue;
      }
      const evidence = /\bevidence\s*:\s*(.+)$/i.exec(achievement)?.[1]?.trim();
      if (!evidence) {
        missingInvariants.push(`Verified achievement lacks observable evidence: ${achievement}`);
      } else if (evidence.length < 8 || !normalizedSource.includes(normalized(evidence))) {
        missingInvariants.push(`Verified achievement evidence is not present in source: ${achievement}`);
      } else if (!observedEvidence(evidence, achievement)) {
        missingInvariants.push(`Verified achievement evidence is not a completed observation: ${achievement}`);
      }
    }
  }
  for (const message of originalMessages) {
    if (message.role !== "user" || message.origin !== "compaction_summary") continue;
    const content = messageText(message);
    const prior = extractStructuredCompactionHandoff(content).state;
    if (!prior) continue;
    if (options?.requireStructured) {
      if (prior.originalRequestRef && structured?.originalRequestRef !== prior.originalRequestRef) {
        missingInvariants.push("Checkpoint original request reference changed");
      }
      for (const priorFile of prior.modifiedFiles) {
        if (!structured?.modifiedFiles.includes(priorFile)) {
          missingInvariants.push(`Missing modified file from prior checkpoint: ${priorFile}`);
        }
      }
      for (const requirement of prior.requirements ?? []) {
        const next = structured?.requirements?.find(item => item.id === requirement.id);
        if (!next) {
          missingInvariants.push(`Missing prior requirement ${requirement.id}`);
        } else if (requirement.status === "verified" && next.status !== "verified") {
          missingInvariants.push(`Verified requirement ${requirement.id} regressed`);
        } else if (next.source !== requirement.source) {
          missingInvariants.push(`Requirement ${requirement.id} changed its source`);
        }
      }
    }
    for (const [label, values, retained] of [
      ["decision or invariant", prior.decisionsAndInvariants ?? [], structured?.decisionsAndInvariants ?? []],
      ["blocker or test failure", prior.blockersOrTestFailures, structured?.blockersOrTestFailures ?? []],
      ["pending obligation", prior.version === 2 && prior.requirements?.length
        ? [] : prior.pendingObligations ?? [], structured?.pendingObligations ?? []],
    ] as const) {
      for (const value of values) {
        if (normalized(value) === "none") continue;
        if (!retained.some(item => normalized(item).includes(normalized(value)))) {
          missingInvariants.push(`Missing ${label} from prior checkpoint: ${value}`);
        }
      }
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
  strict = false,
): WorkspaceState {
  const existing = readWorkspaceState(workspaceRoot) ?? ensureWorkspaceState(workspaceRoot, undefined, strict);

  if (completedMilestones && completedMilestones.length > 0) {
    for (const milestone of completedMilestones) {
      const trimmed = milestone.trim();
      if (trimmed && !existing.completedMilestones.includes(trimmed)) {
        existing.completedMilestones.push(trimmed);
      }
    }
  }

  existing.customSections = {
    ...existing.customSections,
    lastCompactionSummary: summary.slice(0, 32_768),
  };
  existing.lastUpdatedIso = new Date().toISOString();
  writeWorkspaceState(workspaceRoot, existing, strict);

  return existing;
}
