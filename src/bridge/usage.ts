import type { CodexUsage } from "../types";
import { usageDisplayTotalTokens } from "../usage/totals";

export function responsesUsage(usage: CodexUsage | undefined): Record<string, unknown> {
  if (!usage) return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  // inputTokens is already inclusive of cache read/write (types.ts convention).
  const inputTokens = usage.inputTokens;
  const out: Record<string, unknown> = {
    input_tokens: inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usageDisplayTotalTokens(usage) ?? inputTokens + usage.outputTokens,
  };
  const inputDetails: Record<string, number> = {};
  if (usage.cachedInputTokens !== undefined) {
    // cached_tokens carries cache READS only, matching OpenAI semantics.
    inputDetails.cached_tokens = usage.cachedInputTokens;
  }
  if (usage.cacheCreationInputTokens !== undefined) {
    inputDetails.cache_write_tokens = usage.cacheCreationInputTokens;
  }
  if (Object.keys(inputDetails).length > 0) {
    out.input_tokens_details = inputDetails;
  }
  if (usage.reasoningOutputTokens !== undefined) {
    out.output_tokens_details = { reasoning_tokens: usage.reasoningOutputTokens };
  }
  return out;
}
