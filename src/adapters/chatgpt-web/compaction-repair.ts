import { estimateTokens } from "../../lib/token-estimate";
import type { CodexParsedRequest } from "../../types";
import {
  CHATGPT_WEB_PLATFORM_RESERVE_TOKENS,
  resolveChatGptWebContextLimits,
  resolveChatGptWebTransportLimits,
  type ChatGptWebAdapterEffort,
  type ChatGptWebBackendModel,
} from "../../chatgpt-web-models";
import type { ChatGptWebCapabilities } from "./model";
import { resolveChatGptWebModelMode } from "./model";
import {
  assertChatGptWebInputWithinLimits,
  assertChatGptWebMultipartInputWithinLimits,
  resolveChatGptWebMultipartStagingMode,
} from "./browser/staging-limits";
import {
  compiledChatGptWebMessages,
  estimateChatGptWebImageTokens,
  measureCompiledChatGptWebInput,
} from "./input-tokens";
import { enforcePreflightDeliveryBudget, preparePreflightInput } from "./preflight-budget";
import { compileChatGptWebPrompt } from "./prompt";
import { skillFileTokens } from "./skill-attachments";
import { resolveBiggerContextMultipartParts } from "./usage";

export function checkpointCompiledRepairFits(
  request: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  options: {
    experimentalBiggerContext?: boolean;
    experimentalSkillAttachments?: boolean;
  } = {},
): boolean {
  try {
    const { input, verdict } = preparePreflightInput(request, capabilities, options);
    enforcePreflightDeliveryBudget(input, verdict);
    const promote = options.experimentalBiggerContext || verdict.actionRequired === "promote_multipart";
    const experimentalMultipartParts = promote
      ? resolveBiggerContextMultipartParts(
        input,
        capabilities,
        options.experimentalSkillAttachments,
        verdict.actionRequired === "promote_multipart",
      )
      : undefined;
    const compiled = compileChatGptWebPrompt(input, capabilities, undefined, {
      experimentalSkillAttachments: options.experimentalSkillAttachments,
      ...(experimentalMultipartParts !== undefined ? { experimentalMultipartParts } : {}),
    });
    const mode = resolveChatGptWebModelMode(request.modelId, request.options.reasoning, capabilities);
    const measurement = measureCompiledChatGptWebInput(compiled, request.modelId);
    if (!compiled.multipart) {
      assertChatGptWebInputWithinLimits(
        measurement.inputTokens,
        measurement.maxMessageTokens,
        request.modelId,
        mode.effort,
        capabilities,
        measurement.maxMessageChars,
      );
      return true;
    }
    const messages = compiledChatGptWebMessages(compiled);
    const stages = messages.slice(0, -1);
    const maxStageMessageTokens = Math.max(...stages.map(message => estimateTokens(message, request.modelId)));
    const maxStageChars = Math.max(...stages.map(message => message.length));
    const stagingMode = resolveChatGptWebMultipartStagingMode(
      request.modelId,
      capabilities,
      maxStageMessageTokens,
      maxStageChars,
    );
    const finalMessage = messages.at(-1)!;
    assertChatGptWebMultipartInputWithinLimits(
      measurement.inputTokens,
      measurement.maxMessageTokens,
      request.modelId,
      mode.effort,
      capabilities,
      measurement.maxMessageChars,
      compiled.multipart.parts.length,
      {
        stagingEffort: stagingMode.effort,
        maxStageMessageTokens,
        maxStageChars,
        finalMessageTokens: estimateTokens(finalMessage, request.modelId)
          + skillFileTokens(compiled.skillFiles, request.modelId),
        finalMessageChars: finalMessage.length,
        finalImageTokens: estimateChatGptWebImageTokens(compiled),
      },
    );
    return true;
  } catch {
    return false;
  }
}

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

export function recordRepairDuration(
  observedDurationsMs: number[],
  startedAtMs: number,
  completedAtMs: number,
  outcome: "succeeded" | "failed" | "operator_cancelled",
): void {
  if (outcome === "operator_cancelled") return;
  const duration = completedAtMs - startedAtMs;
  if (!Number.isFinite(duration) || duration < 0) return;
  observedDurationsMs.push(duration);
  if (observedDurationsMs.length > 100) observedDurationsMs.shift();
}
