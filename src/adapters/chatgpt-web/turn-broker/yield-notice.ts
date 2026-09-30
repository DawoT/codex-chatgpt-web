import { CHATGPT_CEILING_TOOL_BURST_LIMIT, CHATGPT_OPTIMAL_TOOL_BURST_LIMIT } from "../browser/context-pressure";
import type { BrokerToolResult } from "./types";

export function shouldInjectGracefulYieldNotice(completedToolsCount: number): boolean {
  return completedToolsCount >= CHATGPT_OPTIMAL_TOOL_BURST_LIMIT;
}

export function isUrgentCompactionNotice(completedToolsCount: number): boolean {
  return completedToolsCount >= CHATGPT_CEILING_TOOL_BURST_LIMIT;
}

export function gracefulYieldNoticeText(completedToolsCount: number): string {
  if (isUrgentCompactionNotice(completedToolsCount)) {
    return `[System Urgent: Context pressure safe burst limit reached (${completedToolsCount} actions completed). Conclude turn immediately to allow context compaction and prevent tab crash.]`;
  }
  return `[System Notice: Continuous tool burst threshold reached (${completedToolsCount} actions completed). Complete your immediate test assertions or verified state and conclude your current phase so context compaction can run cleanly before the next phase.]`;
}

export function injectGracefulYieldNoticeIfRecommended(
  result: BrokerToolResult,
  completedToolsCount: number,
): BrokerToolResult {
  if (!shouldInjectGracefulYieldNotice(completedToolsCount)) {
    return result;
  }
  const content = Array.isArray(result.content) ? [...result.content] : [];
  content.push({
    type: "text",
    text: gracefulYieldNoticeText(completedToolsCount),
  });
  return {
    ...result,
    content,
  };
}
