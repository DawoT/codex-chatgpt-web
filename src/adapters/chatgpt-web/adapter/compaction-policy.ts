import type { CodexMessage } from "../../../types";
import { CHATGPT_WEB_LUNA_MODEL_ID } from "../model";

export const HEAVY_TURN_TOOL_CALL_THRESHOLD = 35;

export function isHeavyCompactionTurn(
  messages: readonly CodexMessage[],
  threshold = HEAVY_TURN_TOOL_CALL_THRESHOLD,
): boolean {
  const toolCalls = new Set<string>();
  for (const message of messages) {
    if (message.role === "toolResult") {
      toolCalls.add(message.toolCallId);
    } else if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "toolCall") toolCalls.add(part.id);
      }
    }
  }
  return toolCalls.size >= threshold;
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
}): "configured_fresh_conversation" | "retained" {
  if (input.freshConversationPerTurn) return "configured_fresh_conversation";
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
