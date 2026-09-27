import type { CodexParsedRequest } from "../../types";
import type { ChatGptWebCapabilities } from "./model";

export const PREFLIGHT_SAFE_INLINE_CHAR_LIMIT = 65_000;
export const PREFLIGHT_MAX_STAGE_CHAR_LIMIT = 45_000;
export const PREFLIGHT_MAX_TOTAL_CHAR_LIMIT = 240_000;

export type PreflightAction = "none" | "promote_multipart" | "trigger_compaction";
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
  experimentalBiggerContext?: boolean;
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

export function evaluatePreflightBudget(
  request: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  options?: PreflightBudgetOptions,
): PreflightBudgetVerdict {
  const safeLimit = options?.safeCharLimit ?? PREFLIGHT_SAFE_INLINE_CHAR_LIMIT;
  const maxTotalLimit = options?.maxTotalCharLimit ?? PREFLIGHT_MAX_TOTAL_CHAR_LIMIT;

  const estimatedChars = estimateRequestCharacters(request);
  const estimatedTokens = Math.ceil(estimatedChars / 3.8);
  const prunableToolResultsCount = 0; // Automatic evidence deletion is not permitted.
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
        prunableToolResultsCount: 0,
        reason: `Inline character payload (${estimatedChars.toLocaleString("en-US")}) exceeds safety limit (${safeLimit.toLocaleString("en-US")}). Promoting to multipart-6.`,
      };
    }

    // Oversized context requires native compaction, with evidence preserved.
    return {
      safe: false,
      estimatedChars,
      estimatedTokens,
      recommendedTransport: "multipart-6",
      actionRequired: "trigger_compaction",
      prunableToolResultsCount: 0,
      reason: "Context exceeds the transport planning limit; native compaction is required. Historical evidence is preserved.",
    };
  }

  // Case 3: Multipart is not supported (inline only)
  return {
    safe: false,
    estimatedChars,
    estimatedTokens,
    recommendedTransport: "inline",
    actionRequired: "trigger_compaction",
    prunableToolResultsCount: 0,
    reason: "Context exceeds the inline planning limit; native compaction is required. Historical evidence is preserved.",
  };
}

export function preparePreflightInput(
  input: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  options?: PreflightBudgetOptions,
): { input: CodexParsedRequest; verdict: PreflightBudgetVerdict } {
  const verdict = evaluatePreflightBudget(input, capabilities, options);
  // Transport planning cannot decide which historical evidence is dispensable.
  // Preserve failures, obligations and tool output until native semantic compaction.
  return { input, verdict };
}
