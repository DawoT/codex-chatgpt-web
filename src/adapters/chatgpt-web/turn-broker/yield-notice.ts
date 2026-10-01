import { CHATGPT_OPTIMAL_TOOL_BURST_LIMIT } from "../browser/context-pressure";
import type { BrokerToolResult } from "./types";

export function shouldInjectGracefulYieldNotice(completedToolsCount: number, compactionRequired = false): boolean {
  return compactionRequired || completedToolsCount >= CHATGPT_OPTIMAL_TOOL_BURST_LIMIT;
}

export function isUrgentCompactionNotice(_completedToolsCount: number, compactionRequired = false): boolean {
  return compactionRequired;
}

export function gracefulYieldNoticeText(completedToolsCount: number, compactionRequired = false): string {
  if (isUrgentCompactionNotice(completedToolsCount, compactionRequired)) {
    return "[System Notice: Codex requested context compaction. Consume the confirmed result, stop ordinary tool work, and settle the current phase for the checkpoint handoff.]";
  }
  return `[System Notice: ${completedToolsCount} actions completed in this phase. Finish the immediate verification and conclude at a safe phase boundary. The next phase may continue in this same conversation; tool count alone does not require context compaction.]`;
}

export function injectGracefulYieldNoticeIfRecommended(
  result: BrokerToolResult,
  completedToolsCount: number,
  compactionRequired = false,
): BrokerToolResult {
  if (!shouldInjectGracefulYieldNotice(completedToolsCount, compactionRequired)) {
    return result;
  }
  const content = Array.isArray(result.content) ? [...result.content] : [];
  content.push({
    type: "text",
    text: gracefulYieldNoticeText(completedToolsCount, compactionRequired),
  });
  return {
    ...result,
    content,
  };
}
