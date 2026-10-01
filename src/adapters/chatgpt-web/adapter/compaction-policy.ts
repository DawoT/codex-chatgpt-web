import type { CodexMessage } from "../../../types";
import { CHATGPT_WEB_LUNA_MODEL_ID } from "../model";

export const HEAVY_TURN_TOOL_CALL_THRESHOLD = 35;

export function isHeavyCompactionTurn(
  messages: readonly CodexMessage[],
  threshold = HEAVY_TURN_TOOL_CALL_THRESHOLD,
): boolean {
  let toolCount = 0;
  for (const message of messages) {
    if (message.role === "toolResult") {
      toolCount += 1;
    } else if (message.role === "assistant" && Array.isArray(message.content)) {
      toolCount += message.content.filter((part) => part.type === "toolCall").length;
    }
  }
  return toolCount >= threshold;
}

export function compactionControlPolicy(input: {
  modelId: string;
  localToolsEnabled: boolean;
  manualRequest: boolean;
  retainedLauncherDescriptor: string | undefined;
  hasStructuredBroker: boolean;
}): "classic" | "unavailable" | "structured" {
  if (input.modelId === CHATGPT_WEB_LUNA_MODEL_ID || !input.localToolsEnabled) return "classic";
  if (!input.retainedLauncherDescriptor || (!input.manualRequest && !input.hasStructuredBroker)) return "unavailable";
  return "structured";
}

export function initialCompactionRoute(input: {
  freshConversationPerTurn: boolean;
  heavyTurn: boolean;
}): "configured_fresh_conversation" | "heavy_turn_fast_path" | "retained" {
  if (input.freshConversationPerTurn) return "configured_fresh_conversation";
  if (input.heavyTurn) return "heavy_turn_fast_path";
  return "retained";
}

export function retainedCompactionStrategy(input: {
  manualRequest: boolean;
  sourceActive: boolean;
  sourceMode: string;
}): "zero-risk-tools" | "zero-risk-completed" | "retained-tools" | "retained-completed" {
  const activeTools = input.sourceActive && input.sourceMode === "tools";
  if (input.manualRequest) return activeTools ? "zero-risk-tools" : "zero-risk-completed";
  return activeTools ? "retained-tools" : "retained-completed";
}
