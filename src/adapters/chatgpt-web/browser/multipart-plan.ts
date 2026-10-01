import { randomUUID } from "node:crypto";
import {
  type CompiledBrowserPayloadMetrics,
  estimateChatGptWebImageTokens,
  measureCompiledBrowserPayload,
  measureCompiledChatGptWebInput,
} from "../input-tokens";
import type { ChatGptWebCapabilities, ChatGptWebModelMode } from "../model";
import {
  type ChatGptWebMultipartStage,
  type CompiledChatGptWebPrompt,
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
} from "../prompt";
import {
  assertChatGptWebInputWithinLimits,
  assertChatGptWebMultipartInputWithinLimits,
  resolveChatGptWebMultipartStagingMode,
} from "./staging-limits";

/** Everything `runBrowserTurn` consumes about the staged (or inline) physical transport. */
export interface ChatGptMultipartPlan {
  /** Transaction identity when the turn uses the multipart transport; undefined when inline. */
  multipartTransactionId: string | undefined;
  /** All payload parts except the last, each wrapped as one acknowledgement-seeking stage. */
  multipartStages: ChatGptWebMultipartStage[] | undefined;
  /** The commit prompt that carries the final part and starts the task. */
  multipartFinalPrompt: string | undefined;
  /** The physical messages this turn submits, in order: stages then the commit prompt. */
  selectedMessages: string[];
  browserPayload: CompiledBrowserPayloadMetrics;
  estimatedInputTokens: number;
  estimatedMessageTokens: number;
  maxMessageChars: number;
  maxStageMessageTokens: number | undefined;
  maxStageChars: number | undefined;
  /** Effort the browser must select before staging submissions; the requested mode when inline. */
  stagingMode: ChatGptWebModelMode;
}

/**
 * Build the staging plan for one browser turn from a compiled prompt.
 *
 * Pure over its inputs except for the freshly drawn multipart transaction identity. The limit
 * assertions run here and throw on violation — refusing to plan a transport the browser cannot
 * carry IS the behavior, and running them keeps every throw at the same point of the turn where
 * the inline staging block used to raise it.
 */
export function buildMultipartPlan(
  prepared: CompiledChatGptWebPrompt,
  params: {
    modelId: string;
    capabilities: ChatGptWebCapabilities;
    requestedMode: ChatGptWebModelMode;
    compaction: boolean;
  },
): ChatGptMultipartPlan {
  const { modelId, capabilities, requestedMode, compaction } = params;
  const multipartTransactionId = prepared.multipart ? `ctx_${randomUUID().replaceAll("-", "")}` : undefined;
  const multipartStages =
    prepared.multipart && multipartTransactionId
      ? prepared.multipart.parts
          .slice(0, -1)
          .map((payload, index) =>
            formatChatGptWebMultipartStage(
              payload,
              multipartTransactionId,
              index + 1,
              prepared.multipart!.parts.length,
            ),
          )
      : undefined;
  const multipartFinalPrompt =
    prepared.multipart && multipartTransactionId
      ? formatChatGptWebMultipartCommit(prepared.multipart, multipartTransactionId)
      : undefined;
  const selectedMessages =
    multipartStages && multipartFinalPrompt
      ? [...multipartStages.map((stage) => stage.text), multipartFinalPrompt]
      : [prepared.text];
  const browserPayload = measureCompiledBrowserPayload(prepared, modelId, selectedMessages);
  const {
    inputTokens: estimatedInputTokens,
    maxMessageTokens: estimatedMessageTokens,
    maxMessageChars,
  } = measureCompiledChatGptWebInput(prepared, modelId, browserPayload);
  const maxStageMessageTokens = multipartStages
    ? Math.max(...browserPayload.messageTokensEstimated.slice(0, -1))
    : undefined;
  const maxStageChars = multipartStages ? Math.max(...multipartStages.map((stage) => stage.text.length)) : undefined;
  const stagingMode = multipartStages
    ? resolveChatGptWebMultipartStagingMode(modelId, capabilities, maxStageMessageTokens!, maxStageChars!)
    : requestedMode;
  if (prepared.multipart) {
    assertChatGptWebMultipartInputWithinLimits(
      estimatedInputTokens,
      estimatedMessageTokens,
      modelId,
      requestedMode.effort,
      capabilities,
      maxMessageChars,
      prepared.multipart.parts.length,
      multipartStages && multipartFinalPrompt && maxStageMessageTokens !== undefined && maxStageChars !== undefined
        ? {
            stagingEffort: stagingMode.effort,
            maxStageMessageTokens,
            maxStageChars,
            finalMessageTokens: browserPayload.messageTokensEstimated.at(-1)! + browserPayload.skillFileTokensEstimated,
            finalMessageChars: multipartFinalPrompt.length,
            finalImageTokens: estimateChatGptWebImageTokens(prepared),
            isCompaction: compaction,
          }
        : undefined,
      compaction,
    );
  } else {
    assertChatGptWebInputWithinLimits(
      estimatedInputTokens,
      estimatedMessageTokens,
      modelId,
      requestedMode.effort,
      capabilities,
      maxMessageChars,
    );
  }
  return {
    multipartTransactionId,
    multipartStages,
    multipartFinalPrompt,
    selectedMessages,
    browserPayload,
    estimatedInputTokens,
    estimatedMessageTokens,
    maxMessageChars,
    maxStageMessageTokens,
    maxStageChars,
    stagingMode,
  };
}
