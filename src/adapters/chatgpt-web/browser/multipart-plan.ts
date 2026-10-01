import { randomUUID } from "node:crypto";
import { ChatGptWebAdapterError } from "../adapter-error";
import {
  type CompiledBrowserPayloadMetrics,
  estimateChatGptWebImageTokens,
  measureCompiledBrowserPayload,
  measureCompiledChatGptWebInput,
} from "../input-tokens";
import type { ChatGptWebCapabilities, ChatGptWebModelMode } from "../model";
import { PREFLIGHT_MAX_STAGE_CHAR_LIMIT, PREFLIGHT_SAFE_INLINE_CHAR_LIMIT } from "../preflight-budget";
import {
  type ChatGptWebMultipartStage,
  type CompiledChatGptWebPrompt,
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
} from "../prompt";
import { multipartTransportManifest } from "../prompt/record-fragments";
import type { ChatGptWebMultipartPartCount } from "../prompt/types";
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
    /** Negotiated host/helper wire capabilities; never infer these from model/account support. */
    helperCapabilities?: readonly string[];
  },
): ChatGptMultipartPlan {
  const { modelId, capabilities, requestedMode, compaction } = params;
  if (prepared.multipart) {
    const transport = multipartTransportManifest(prepared.multipart.parts);
    if (transport) {
      for (const required of transport.requiredHelperCapabilities) {
        if (!params.helperCapabilities?.includes(required)) {
          throw new Error(`Multipart transport requires helper capability ${required} before Send`);
        }
      }
      if (JSON.stringify(prepared.multipart.transport) !== JSON.stringify(transport)) {
        throw new Error("Multipart fragment transport manifest is missing or incompatible");
      }
    }
  }
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

/** Select from fully compiled physical payloads. Capability enables transport; it never forces six. */
export function selectCompiledChatGptWebTransport(
  compile: (parts?: ChatGptWebMultipartPartCount) => CompiledChatGptWebPrompt,
  params: {
    modelId: string;
    capabilities: ChatGptWebCapabilities;
    requestedMode: ChatGptWebModelMode;
    compaction: boolean;
    /** Existing model ceiling for automatic transport without an expanded context capability. */
    totalContextTokenLimit?: number;
  },
  forceMultipart = false,
): CompiledChatGptWebPrompt {
  let lastError: unknown;
  const candidates: (ChatGptWebMultipartPartCount | undefined)[] = forceMultipart ? [2, 6] : [undefined, 2, 6];
  for (const parts of candidates) {
    try {
      const compiled = compile(parts);
      // Planning on the compiler host validates encoding support here; the real helper must
      // negotiate independently and provide its own capabilities to buildMultipartPlan before Send.
      const plan = buildMultipartPlan(compiled, {
        ...params,
        helperCapabilities: compiled.multipart?.transport?.requiredHelperCapabilities,
      });
      if (params.totalContextTokenLimit !== undefined && plan.estimatedInputTokens >= params.totalContextTokenLimit) {
        throw new ChatGptWebAdapterError(
          "The complete history exceeds the existing model context ceiling; no history was discarded.",
          {
            status: 400,
            errorType: "invalid_request_error",
            code: "context_length_exceeded",
            retryable: false,
          },
        );
      }
      const safeChars = compiled.multipart ? PREFLIGHT_MAX_STAGE_CHAR_LIMIT : PREFLIGHT_SAFE_INLINE_CHAR_LIMIT;
      if (plan.maxMessageChars > safeChars) {
        throw new ChatGptWebAdapterError(
          `Compiled transport exceeds the ${safeChars.toLocaleString("en-US")}-character safe browser boundary; no history was discarded.`,
          {
            status: 400,
            errorType: "invalid_request_error",
            code: "context_length_exceeded",
            retryable: false,
          },
        );
      }
      return compiled;
    } catch (error) {
      if (!(error instanceof ChatGptWebAdapterError) && !(error instanceof RangeError)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}
