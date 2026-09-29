import {
  CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER,
  type ChatGptWebAdapterEffort,
  type ChatGptWebBackendModel,
  resolveChatGptWebContextLimits,
} from "../../chatgpt-web-models";
import { estimateTokens } from "../../lib/token-estimate";
import { type CompactionRequirement, extractStructuredCompactionHandoff } from "../../responses/compaction";
import type { CodexMessage, CodexParsedRequest } from "../../types";
import { chatGptContextCompactionRequiredError } from "./adapter-error";
import { measureCompiledChatGptWebInput } from "./input-tokens";
import type { ChatGptWebCapabilities } from "./model";
import type { CompiledChatGptWebPrompt } from "./prompt";

export interface MissionHeadroomDecision {
  compact: boolean;
  reserveTokens: number;
}

export function evaluateMissionHeadroom(input: {
  inputTokens: number;
  contextWindow: number;
  requirements?: readonly CompactionRequirement[];
  growthSamples: readonly number[];
}): MissionHeadroomDecision {
  if (
    !input.requirements?.some((item) => item.status === "pending" || item.status === "blocked") ||
    input.growthSamples.length === 0
  ) {
    return { compact: false, reserveTokens: 0 };
  }
  const recent = input.growthSamples.slice(-5).filter((value) => Number.isFinite(value) && value >= 0);
  if (recent.length === 0) return { compact: false, reserveTokens: 0 };
  const sorted = [...recent].sort((a, b) => a - b);
  const p90 = sorted[Math.ceil(sorted.length * 0.9) - 1]!;
  const reserveTokens = Math.min(Math.floor(input.contextWindow * 0.2), Math.max(8_192, Math.ceil(p90 * 1.25)));
  return {
    compact: input.inputTokens + reserveTokens >= input.contextWindow,
    reserveTokens,
  };
}

function messageText(message: CodexMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => ("text" in part && typeof part.text === "string" ? part.text : "")).join("\n");
}

export function missionRequirements(messages: readonly CodexMessage[]): CompactionRequirement[] | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user" || message.origin !== "compaction_summary") continue;
    const state = extractStructuredCompactionHandoff(messageText(message)).state;
    if (state?.version === 2 && state.requirements) return state.requirements;
  }
  return undefined;
}

export function completedTurnGrowth(messages: readonly CodexMessage[], modelId: string): number[] {
  const growth: number[] = [];
  let current: number | undefined;
  for (const message of messages) {
    if (message.role === "user") {
      if (current !== undefined) growth.push(current);
      current = 0;
    }
    if (current !== undefined) current += estimateTokens(messageText(message), modelId);
  }
  return growth.slice(-5);
}

export function enforceMissionHeadroom(
  request: CodexParsedRequest,
  compiled: CompiledChatGptWebPrompt,
  effort: ChatGptWebAdapterEffort,
  capabilities: ChatGptWebCapabilities,
): void {
  if (request._compactionRequest) return;
  const requirements = missionRequirements(request.context.messages);
  if (!requirements?.some((item) => item.status !== "verified")) return;
  const { contextWindow: baseWindow } = resolveChatGptWebContextLimits(
    request.modelId as ChatGptWebBackendModel,
    effort,
    { ...capabilities, experimentalBiggerContext: false },
  );
  const contextWindow = compiled.multipart
    ? baseWindow * Math.min(compiled.multipart.parts.length, CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER)
    : baseWindow;
  const decision = evaluateMissionHeadroom({
    inputTokens: measureCompiledChatGptWebInput(compiled, request.modelId).inputTokens,
    contextWindow,
    requirements,
    growthSamples: completedTurnGrowth(request.context.messages, request.modelId),
  });
  if (decision.compact) {
    throw chatGptContextCompactionRequiredError(
      `Pending mission requirements need ${decision.reserveTokens.toLocaleString("en-US")} tokens of measured next-turn headroom.`,
    );
  }
}
