import { estimateTokens } from "../../lib/token-estimate";
import {
  CHATGPT_WEB_PLATFORM_RESERVE_TOKENS,
  resolveChatGptWebContextLimits,
  resolveChatGptWebTransportLimits,
  type ChatGptWebAdapterEffort,
  type ChatGptWebBackendModel,
} from "../../chatgpt-web-models";
import type { ChatGptWebCapabilities } from "./model";

export function checkpointRepairPromptFits(
  prompt: string,
  modelId: ChatGptWebBackendModel,
  effort: ChatGptWebAdapterEffort,
  capabilities: ChatGptWebCapabilities,
): boolean {
  const tokens = estimateTokens(prompt, modelId);
  const transport = resolveChatGptWebTransportLimits(modelId, effort, capabilities);
  const context = resolveChatGptWebContextLimits(modelId, effort, capabilities);
  return (transport.browserComposerCharLimit === undefined || prompt.length <= transport.browserComposerCharLimit)
    && (transport.browserMessageTokenLimit === undefined || tokens <= transport.browserMessageTokenLimit)
    && tokens + CHATGPT_WEB_PLATFORM_RESERVE_TOKENS < context.contextWindow;
}

export function shouldRepairCheckpoint(input: {
  remainingMs: number;
  transportFits: boolean;
  observedDurationsMs: readonly number[];
}): boolean {
  if (!input.transportFits) return false;
  const observed = input.observedDurationsMs
    .filter(duration => Number.isFinite(duration) && duration >= 0)
    .sort((a, b) => a - b);
  const p95 = observed.length > 0
    ? observed[Math.ceil(observed.length * 0.95) - 1]!
    : 0;
  return input.remainingMs >= Math.max(120_000, Math.ceil(p95 * 1.2));
}
