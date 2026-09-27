import { CHATGPT_WEB_INSTANT_AUTO_COMPACT_TOKEN_LIMIT } from "../../../chatgpt-web-models";
import { estimateTokens } from "../../../lib/token-estimate";
import { isReadableCompactionSummaryText } from "../../../responses/compaction";
import type { CodexContentPart, CodexMessage, CodexToolResultMessage } from "../../../types";
import {
  formatSubagentResultSummary,
  parseSubagentStructuredResult,
  trimDeepSubagentHistory,
} from "../subagent-protocol";
import { condenseVerboseProseWithSyntaxAwareness } from "../syntax-condenser";
import { sanitizeHistoricalParalysisClaims } from "./sanitization";
import {
  DEFAULT_MICRO_COMPACTION_TOKEN_CEILING,
  DEFAULT_RETAINED_COMPLETED_TOOL_RESULTS,
  DEFAULT_ROOT_PRUNING_TOKEN_CEILING,
  HISTORICAL_TOOL_OUTPUT_PRUNE_THRESHOLD_CHARS,
  type AdaptivePruningOptions,
  type PruneHistoricalToolOutputOptions,
} from "./types";

export {
  DEFAULT_MICRO_COMPACTION_TOKEN_CEILING,
  DEFAULT_RETAINED_COMPLETED_TOOL_RESULTS,
  DEFAULT_ROOT_PRUNING_TOKEN_CEILING,
  HISTORICAL_TOOL_OUTPUT_PRUNE_THRESHOLD_CHARS,
};

function toolResultMessageCharCount(message: CodexToolResultMessage): number {
  if (typeof message.content === "string") return message.content.length;
  if (Array.isArray(message.content)) {
    return message.content.reduce((sum, part) => {
      if (part.type === "text") return sum + part.text.length;
      return sum + 1_000;
    }, 0);
  }
  return 0;
}

/**
 * Prunes voluminous tool outputs from earlier completed turns.
 * The active turn (everything after the latest user/agent instruction) is preserved 100% intact.
 * For completed turns, the most recent N tool results are retained intact; older tool results
 * exceeding the character threshold are replaced with concise status tombstones.
 */
export function pruneHistoricalToolOutputs(
  messages: readonly CodexMessage[],
  options?: PruneHistoricalToolOutputOptions,
): CodexMessage[] {
  const retainRecentCount = options?.retainRecentCount ?? DEFAULT_RETAINED_COMPLETED_TOOL_RESULTS;
  const maxCharThreshold = options?.maxHistoricalCharThreshold ?? HISTORICAL_TOOL_OUTPUT_PRUNE_THRESHOLD_CHARS;

  // The active turn begins with the latest user or agent message.
  const lastInstructionIndex = messages.findLastIndex(
    message => message.role === "user" || message.role === "agentMessage",
  );
  if (lastInstructionIndex === -1) return [...messages];

  // Tool results at or before lastInstructionIndex belong to earlier, completed turns.
  const historicalToolIndices: number[] = [];
  for (let index = 0; index <= lastInstructionIndex; index += 1) {
    if (messages[index]?.role === "toolResult") {
      historicalToolIndices.push(index);
    }
  }

  if (historicalToolIndices.length <= retainRecentCount) {
    return [...messages];
  }

  // The most recent N historical tool results are kept intact.
  const retainedIndices = new Set(historicalToolIndices.slice(-retainRecentCount));

  return messages.map((message, index) => {
    if (message.role !== "toolResult" || retainedIndices.has(index) || index > lastInstructionIndex) {
      return message;
    }
    const charCount = toolResultMessageCharCount(message);
    if (charCount <= maxCharThreshold) {
      return message;
    }
    const outcome = message.isError ? "failed" : "completed";
    const tombstone = `[Historical tool output omitted: ${message.toolName} ${outcome} in earlier turn (${charCount.toLocaleString("en-US")} chars)]`;
    return {
      ...message,
      content: tombstone,
    };
  });
}

const ENVIRONMENT_CONTEXT_REGEX = /<environment_context>[\s\S]*?<\/environment_context>/gi;

function messageTextContent(message: CodexMessage): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part): part is { type: "text"; text: string } => (part as { type?: string }).type === "text")
      .map(part => part.text)
      .join("\n");
  }
  return "";
}

function hasEnvironmentContextTag(message: CodexMessage): boolean {
  if (message.role === "assistant" || message.role === "toolResult") return false;
  return /<environment_context>[\s\S]*?<\/environment_context>/i.test(messageTextContent(message));
}

function stripEnvironmentContextFromContent(
  content: string | CodexContentPart[],
): string | CodexContentPart[] {
  if (typeof content === "string") {
    const withoutEnv = content.replace(ENVIRONMENT_CONTEXT_REGEX, "").trim();
    if (withoutEnv.length === 0) {
      return "[Historical environment context omitted: superseded by latest turn environment]";
    }
    return content.replace(ENVIRONMENT_CONTEXT_REGEX, "[Historical environment context omitted]");
  }
  if (Array.isArray(content)) {
    return content.map(part => {
      if (part.type !== "text") return part;
      const withoutEnv = part.text.replace(ENVIRONMENT_CONTEXT_REGEX, "").trim();
      const text = withoutEnv.length === 0
        ? "[Historical environment context omitted: superseded by latest turn environment]"
        : part.text.replace(ENVIRONMENT_CONTEXT_REGEX, "[Historical environment context omitted]");
      return { ...part, text };
    });
  }
  return content;
}

/**
 * Deduplicates multiple <environment_context> XML blocks across history.
 * Only the most recent environment context block is retained intact; earlier redundant copies
 * are replaced with lightweight markers to preserve prompt token budget.
 */
export function deduplicateEnvironmentContexts(messages: readonly CodexMessage[]): CodexMessage[] {
  const lastEnvIndex = messages.findLastIndex(hasEnvironmentContextTag);
  if (lastEnvIndex === -1) return [...messages];

  return messages.map((message, index) => {
    if (index >= lastEnvIndex || !hasEnvironmentContextTag(message)) {
      return message;
    }
    // Only user, developer, and agentMessage roles carry environment_context tags.
    if (message.role === "user") {
      return { ...message, content: stripEnvironmentContextFromContent(message.content) };
    }
    if (message.role === "developer") {
      const content = stripEnvironmentContextFromContent(message.content);
      if (typeof content === "string") return { ...message, content };
      return message;
    }
    if (message.role === "agentMessage") {
      return { ...message, content: stripEnvironmentContextFromContent(message.content) };
    }
    return message;
  });
}

function estimateMessageWeight(message: CodexMessage): number {
  if (message.role === "assistant") {
    return message.content.reduce((sum, part) => {
      if (part.type === "text") return sum + estimateTokens(part.text);
      if (part.type === "thinking") return sum + estimateTokens(part.thinking);
      if (part.type === "toolCall") return sum + estimateTokens(JSON.stringify(part.arguments));
      return sum;
    }, 0);
  }
  if (typeof message.content === "string") {
    return estimateTokens(message.content);
  }
  if (Array.isArray(message.content)) {
    return message.content.reduce((sum, part) => {
      if (part.type === "text") return sum + estimateTokens(part.text);
      if (part.type === "image") return sum + 1_000;
      return sum;
    }, 0);
  }
  return 0;
}

function estimateTotalMessagesTokens(messages: readonly CodexMessage[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageWeight(msg), 0);
}

/**
 * Enforces a micro-compaction boundary preventing accumulated context from overflowing
 * the browser's context window during long-running multi-turn sessions.
 */
export function applyMicroCompactionBoundary(
  messages: readonly CodexMessage[],
  maxTokens: number = CHATGPT_WEB_INSTANT_AUTO_COMPACT_TOKEN_LIMIT,
): CodexMessage[] {
  if (estimateTotalMessagesTokens(messages) <= maxTokens) {
    return [...messages];
  }

  const lastInstructionIndex = messages.findLastIndex(
    message => message.role === "user" || message.role === "agentMessage",
  );
  if (lastInstructionIndex === -1) return [...messages];

  // Stage 1: Condense verbose earlier assistant prose (>400 chars) in turns before the latest completed turn
  let working = messages.map((message, index) => {
    if (message.role !== "assistant" || index >= lastInstructionIndex - 1) {
      return message;
    }
    const condensedContent = message.content.map(part => {
      if (part.type !== "text") return part;
      const subagentResult = parseSubagentStructuredResult(part.text);
      if (subagentResult) {
        return { ...part, text: formatSubagentResultSummary(subagentResult) };
      }
      if (part.text.length <= 400) return part;
      const condensed = condenseVerboseProseWithSyntaxAwareness(part.text, 400);
      return { ...part, text: condensed };
    });
    return { ...message, content: condensedContent };
  });

  if (estimateTotalMessagesTokens(working) <= maxTokens) {
    return working;
  }

  // Stage 2: Replace earlier assistant messages with concise summaries
  working = working.map((message, index) => {
    if (message.role !== "assistant" || index >= lastInstructionIndex - 1) {
      return message;
    }
    const condensedContent = message.content.map(part => {
      if (part.type !== "text") return part;
      const subagentResult = parseSubagentStructuredResult(part.text);
      if (subagentResult) {
        return { ...part, text: formatSubagentResultSummary(subagentResult) };
      }
      if (part.text.length <= 100) return part;
      return { ...part, text: "[Earlier assistant reply condensed for context budget]" };
    });
    return { ...message, content: condensedContent };
  });

  if (estimateTotalMessagesTokens(working) <= maxTokens) {
    return working;
  }

  // Stage 3: Condense very early user prompts (excluding compaction summaries and the recent 2 instructions)
  working = working.map((message, index) => {
    if (message.role !== "user" || index >= lastInstructionIndex - 2) {
      return message;
    }
    const content = message.content;
    let rawText: string | undefined;
    if (typeof content === "string") {
      rawText = content;
    } else if (Array.isArray(content) && content.every(p => p.type === "text")) {
      rawText = content.map(p => p.type === "text" ? p.text : "").join("\n");
    }
    if (rawText === undefined) return message;
    // Don't condense compaction summaries - they are already the compressed form of history.
    if (isReadableCompactionSummaryText(rawText)) return message;
    const safeText: string = rawText;
    if (safeText.length <= 250) return message;
    const condensed = `${safeText.slice(0, 120)}\n[... historical prompt details omitted for context budget ...]`;
    return { ...message, content: condensed };
  });

  return working;
}

/**
 * Adaptive history pruning pipeline:
 * 1. Sanitizes unverified paralysis claims from historical assistant messages to prevent toxic hallucination feedback loops.
 * 2. Deduplicates repetitive environment context XML blocks across historical user messages.
 * 3. Prunes voluminous outputs of earlier completed tool results.
 * 4. Enforces deep subagent history compression.
 * 5. Enforces the micro-compaction boundary soft ceiling.
 */
export function withAdaptiveHistoryPruning(
  messages: readonly CodexMessage[],
  options?: AdaptivePruningOptions,
): CodexMessage[] {
  let pruned = sanitizeHistoricalParalysisClaims(messages);
  pruned = deduplicateEnvironmentContexts(pruned);
  pruned = pruneHistoricalToolOutputs(pruned, {
    retainRecentCount: options?.retainRecentToolResults,
    maxHistoricalCharThreshold: options?.maxHistoricalCharThreshold,
  });
  pruned = trimDeepSubagentHistory(pruned, {
    retainRecentCount: options?.retainRecentSubagents,
  });
  pruned = applyMicroCompactionBoundary(
    pruned,
    options?.maxPromptTokens ?? CHATGPT_WEB_INSTANT_AUTO_COMPACT_TOKEN_LIMIT,
  );
  return pruned;
}
