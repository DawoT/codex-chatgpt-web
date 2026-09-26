import type { CodexMessage, CodexParsedRequest, CodexToolResultMessage } from "../../types";
import type { ChatGptWebCapabilities } from "./model";

export const PREFLIGHT_SAFE_INLINE_CHAR_LIMIT = 65_000;
export const PREFLIGHT_MAX_STAGE_CHAR_LIMIT = 45_000;
export const PREFLIGHT_MAX_TOTAL_CHAR_LIMIT = 240_000;
export const DEFAULT_PREFLIGHT_TOOL_RETENTION_COUNT = 2;
export const PREFLIGHT_TOOL_PRUNE_MIN_CHARS = 250;

export type PreflightAction = "none" | "promote_multipart" | "apply_pruning" | "trigger_compaction";
export type RecommendedTransport = "inline" | "multipart-2" | "multipart-6";

export interface PreflightBudgetVerdict {
  safe: boolean;
  estimatedChars: number;
  estimatedTokens: number;
  recommendedTransport: RecommendedTransport;
  actionRequired: PreflightAction;
  prunableToolResultsCount: number;
  reason?: string;
}

export interface PreflightBudgetOptions {
  safeCharLimit?: number;
  maxTotalCharLimit?: number;
  retainRecentToolCount?: number;
  experimentalBiggerContext?: boolean;
}

export interface PredictivePruningOptions {
  retainRecentToolCount?: number;
  charThreshold?: number;
}

export function messageContentCharCount(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    return content.reduce((sum: number, part: unknown) => {
      if (!part || typeof part !== "object") return sum;
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") return sum + text.length;
      return sum + 200; // estimated overhead for images or non-text blocks
    }, 0);
  }
  return 0;
}

export function estimateRequestCharacters(request: CodexParsedRequest): number {
  let chars = 0;
  if (request.context.systemPrompt) {
    for (const sys of request.context.systemPrompt) {
      chars += sys.length;
    }
  }
  if (request.context.messages) {
    for (const msg of request.context.messages) {
      chars += messageContentCharCount(msg.content);
    }
  }
  return chars;
}

export function countPrunableToolResults(
  messages: readonly CodexMessage[],
  retainRecentCount = DEFAULT_PREFLIGHT_TOOL_RETENTION_COUNT,
): number {
  let toolCount = 0;
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      toolCount += 1;
    }
  }
  return Math.max(0, toolCount - retainRecentCount);
}

export function applyPreflightPredictivePruning(
  messages: readonly CodexMessage[],
  options?: PredictivePruningOptions,
): CodexMessage[] {
  const retainCount = options?.retainRecentToolCount ?? DEFAULT_PREFLIGHT_TOOL_RETENTION_COUNT;
  const threshold = options?.charThreshold ?? PREFLIGHT_TOOL_PRUNE_MIN_CHARS;

  // Find all indices of toolResult messages
  const toolIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === "toolResult") {
      toolIndices.push(i);
    }
  }

  if (toolIndices.length <= retainCount) {
    return [...messages];
  }

  // The last `retainCount` tool results are protected from pruning
  const protectedIndices = new Set(toolIndices.slice(-retainCount));

  return messages.map((message, index) => {
    if (message.role !== "toolResult" || protectedIndices.has(index)) {
      return message;
    }

    const toolMsg = message as CodexToolResultMessage;
    const origChars = messageContentCharCount(toolMsg.content);

    if (origChars <= threshold) {
      return message;
    }

    const status = toolMsg.isError ? "failed" : "completed";
    const tombstone = `[Historical tool output pruned by Preflight Guardian: ${toolMsg.toolName} ${status} (${origChars.toLocaleString("en-US")} chars)]`;

    return {
      ...toolMsg,
      content: tombstone,
    };
  });
}

export function evaluatePreflightBudget(
  request: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  options?: PreflightBudgetOptions,
): PreflightBudgetVerdict {
  const safeLimit = options?.safeCharLimit ?? PREFLIGHT_SAFE_INLINE_CHAR_LIMIT;
  const maxTotalLimit = options?.maxTotalCharLimit ?? PREFLIGHT_MAX_TOTAL_CHAR_LIMIT;
  const retainToolCount = options?.retainRecentToolCount ?? DEFAULT_PREFLIGHT_TOOL_RETENTION_COUNT;

  const messages = request.context.messages ?? [];
  const estimatedChars = estimateRequestCharacters(request);
  const estimatedTokens = Math.ceil(estimatedChars / 3.8);
  const prunableToolResultsCount = countPrunableToolResults(messages, retainToolCount);
  const multipartSupported = options?.experimentalBiggerContext !== undefined ? options.experimentalBiggerContext : true;

  // Case 1: Within safe inline budget
  if (estimatedChars < safeLimit) {
    return {
      safe: true,
      estimatedChars,
      estimatedTokens,
      recommendedTransport: "inline",
      actionRequired: "none",
      prunableToolResultsCount,
    };
  }

  // Case 2: Exceeds safe inline budget, multipart is supported
  if (multipartSupported) {
    if (estimatedChars <= maxTotalLimit) {
      return {
        safe: false,
        estimatedChars,
        estimatedTokens,
        recommendedTransport: "multipart-6",
        actionRequired: "promote_multipart",
        prunableToolResultsCount,
        reason: `Inline character payload (${estimatedChars.toLocaleString("en-US")}) exceeds safety limit (${safeLimit.toLocaleString("en-US")}). Promoting to multipart-6.`,
      };
    }

    // Exceeds even multipart total limit: check if pruning can help
    if (prunableToolResultsCount > 0) {
      return {
        safe: false,
        estimatedChars,
        estimatedTokens,
        recommendedTransport: "multipart-6",
        actionRequired: "apply_pruning",
        prunableToolResultsCount,
        reason: `Total characters exceed multipart limit. Found ${prunableToolResultsCount} historical tool results eligible for pre-flight pruning.`,
      };
    }

    // Unprunable and oversized
    return {
      safe: false,
      estimatedChars,
      estimatedTokens,
      recommendedTransport: "multipart-6",
      actionRequired: "trigger_compaction",
      prunableToolResultsCount: 0,
      reason: "Total context exceeds maximum capacity with zero prunable tool results remaining.",
    };
  }

  // Case 3: Multipart is not supported (inline only)
  if (prunableToolResultsCount > 0) {
    return {
      safe: false,
      estimatedChars,
      estimatedTokens,
      recommendedTransport: "inline",
      actionRequired: "apply_pruning",
      prunableToolResultsCount,
      reason: `Inline payload exceeds limit and multipart is disabled. Found ${prunableToolResultsCount} prunable tool results.`,
    };
  }

  return {
    safe: false,
    estimatedChars,
    estimatedTokens,
    recommendedTransport: "inline",
    actionRequired: "trigger_compaction",
    prunableToolResultsCount: 0,
    reason: "Inline context exceeds safe transport boundary with no prunable tool results remaining.",
  };
}

export function preparePreflightInput(
  input: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  options?: PreflightBudgetOptions,
): { input: CodexParsedRequest; verdict: PreflightBudgetVerdict } {
  const verdict = evaluatePreflightBudget(input, capabilities, options);
  if (verdict.actionRequired === "apply_pruning") {
    const prunedMessages = applyPreflightPredictivePruning(input.context.messages, options);
    return {
      input: {
        ...input,
        context: {
          ...input.context,
          messages: prunedMessages,
        },
      },
      verdict,
    };
  }
  return { input, verdict };
}

