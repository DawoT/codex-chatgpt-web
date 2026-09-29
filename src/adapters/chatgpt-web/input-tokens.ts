import { CHATGPT_WEB_PLATFORM_RESERVE_TOKENS, chatGptWebImageTokenReserve } from "../../chatgpt-web-models";
import { estimateTokens } from "../../lib/token-estimate";
import { formatChatGptWebMultipartCommit, formatChatGptWebMultipartStage } from "./prompt/multipart";
import type { CompiledChatGptWebPrompt } from "./prompt/types";
import { skillFileTokens } from "./skill-attachments";

/**
 * The Free/Luna product accepted measured browser inputs at 25,400 and 28,547 estimated tokens,
 * but rejected the same shape at 32,283 before producing a response. This is a ChatGPT browser
 * transport boundary, not Luna's model context window, and applies to normal and checkpoint turns.
 */
export const CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET = 28_000;

const TOKEN_ESTIMATE_TRANSACTION = `ctx_${"0".repeat(32)}`;

export function compiledChatGptWebMessages(compiled: CompiledChatGptWebPrompt): string[] {
  if (!compiled.multipart) return [compiled.text];
  return [
    ...compiled.multipart.parts
      .slice(0, -1)
      .map(
        (payload, index) =>
          formatChatGptWebMultipartStage(
            payload,
            TOKEN_ESTIMATE_TRANSACTION,
            index + 1,
            compiled.multipart!.parts.length,
          ).text,
      ),
    formatChatGptWebMultipartCommit(compiled.multipart, TOKEN_ESTIMATE_TRANSACTION),
  ];
}

/** Physical browser payload only. These are estimates, never provider cache/billing observations. */
export interface CompiledBrowserPayloadMetrics {
  messageCount: number;
  messageChars: number[];
  messageBytes: number[];
  messageTokensEstimated: number[];
  skillFileCount: number;
  skillFileBytes: number;
  skillFileTokensEstimated: number;
  imageCount: number;
  imageTokensEstimated: number;
  cacheReadTokens: null;
}

export function measureCompiledBrowserPayload(
  compiled: CompiledChatGptWebPrompt,
  modelId: string,
  submittedMessages: readonly string[] = compiledChatGptWebMessages(compiled),
): CompiledBrowserPayloadMetrics {
  const messages = submittedMessages;
  if (messages.length !== (compiled.multipart?.parts.length ?? 1)) {
    throw new RangeError("Browser payload message count does not match the selected transport");
  }
  return {
    messageCount: messages.length,
    messageChars: messages.map((message) => message.length),
    messageBytes: messages.map((message) => Buffer.byteLength(message, "utf8")),
    messageTokensEstimated: messages.map((message) => estimateTokens(message, modelId)),
    skillFileCount: compiled.skillFiles?.length ?? 0,
    skillFileBytes: (compiled.skillFiles ?? []).reduce((sum, file) => sum + Buffer.byteLength(file.text, "utf8"), 0),
    skillFileTokensEstimated: skillFileTokens(compiled.skillFiles, modelId),
    imageCount: compiled.images.length,
    imageTokensEstimated: estimateChatGptWebImageTokens(compiled),
    cacheReadTokens: null,
  };
}

/** Emits only aggregate quantities after semantic acceptance of a physical browser message. */
export function acceptedBrowserPayloadMetric(
  payload: CompiledBrowserPayloadMetrics,
  messageIndex: number,
): {
  stage: number;
  stageCount: number;
  textChars: number;
  textBytes: number;
  textTokensEstimated: number;
  skillFileCount: number;
  skillFileBytes: number;
  skillFileTokensEstimated: number;
  imageCount: number;
  imageTokensEstimated: number;
  cacheReadTokens: null;
} {
  if (!Number.isSafeInteger(messageIndex) || messageIndex < 0 || messageIndex >= payload.messageCount) {
    throw new RangeError("Accepted browser message index is invalid");
  }
  const finalMessage = messageIndex === payload.messageCount - 1;
  return {
    stage: messageIndex + 1,
    stageCount: payload.messageCount,
    textChars: payload.messageChars[messageIndex]!,
    textBytes: payload.messageBytes[messageIndex]!,
    textTokensEstimated: payload.messageTokensEstimated[messageIndex]!,
    skillFileCount: finalMessage ? payload.skillFileCount : 0,
    skillFileBytes: finalMessage ? payload.skillFileBytes : 0,
    skillFileTokensEstimated: finalMessage ? payload.skillFileTokensEstimated : 0,
    imageCount: finalMessage ? payload.imageCount : 0,
    imageTokensEstimated: finalMessage ? payload.imageTokensEstimated : 0,
    cacheReadTokens: null,
  };
}

export function createBrowserPayloadAcceptanceRecorder(
  payload: CompiledBrowserPayloadMetrics,
  context: { retainedConversation: boolean; compaction: boolean },
  record: (metric: ReturnType<typeof acceptedBrowserPayloadMetric> & typeof context) => void,
): (messageIndex: number) => void {
  const accepted = new Set<number>();
  return (messageIndex) => {
    const metric = acceptedBrowserPayloadMetric(payload, messageIndex);
    if (accepted.has(messageIndex)) return;
    accepted.add(messageIndex);
    try {
      record({ ...metric, ...context });
    } catch {
      // Optional diagnostics must not turn an accepted Send into a replayable failure.
    }
  };
}

export function compiledChatGptWebMaxMessageChars(compiled: CompiledChatGptWebPrompt): number {
  return Math.max(...compiledChatGptWebMessages(compiled).map((message) => message.length));
}

/** Tokens present in the one visible browser message, excluding hidden product/tool reserves. */
export function estimateCompiledChatGptWebMessageTokens(compiled: CompiledChatGptWebPrompt, modelId: string): number {
  const messages = compiledChatGptWebMessages(compiled);
  return Math.max(
    ...messages.map(
      (message, index) =>
        estimateTokens(message, modelId) +
        (index === messages.length - 1 ? skillFileTokens(compiled.skillFiles, modelId) : 0),
    ),
  );
}

export function estimateCompiledChatGptWebInputTokens(compiled: CompiledChatGptWebPrompt, modelId: string): number {
  return measureCompiledChatGptWebInput(compiled, modelId).inputTokens;
}

/** Request-local metrics: tokenize each visible message once for total and maximum. */
export function measureCompiledChatGptWebInput(
  compiled: CompiledChatGptWebPrompt,
  modelId: string,
  payload?: CompiledBrowserPayloadMetrics,
): { inputTokens: number; maxMessageTokens: number; maxMessageChars: number } {
  const imageTokens = payload?.imageTokensEstimated ?? estimateChatGptWebImageTokens(compiled);
  const messages = payload ? undefined : compiledChatGptWebMessages(compiled);
  const counts = payload?.messageTokensEstimated ?? messages!.map((message) => estimateTokens(message, modelId));
  const attachments = payload?.skillFileTokensEstimated ?? skillFileTokens(compiled.skillFiles, modelId);
  const messageTokens = counts.reduce((total, count) => total + count, 0);
  const acknowledgementTokens = compiled.multipart
    ? compiled.multipart.parts
        .slice(0, -1)
        .reduce(
          (total, payload, index) =>
            total +
            estimateTokens(
              formatChatGptWebMultipartStage(
                payload,
                TOKEN_ESTIMATE_TRANSACTION,
                index + 1,
                compiled.multipart!.parts.length,
              ).acknowledgement,
              modelId,
            ),
          0,
        )
    : 0;
  return {
    inputTokens:
      CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + messageTokens + acknowledgementTokens + imageTokens + attachments,
    maxMessageTokens: Math.max(
      ...counts.map((count, index) => count + (index === counts.length - 1 ? attachments : 0)),
    ),
    maxMessageChars: Math.max(...(payload?.messageChars ?? messages!.map((message) => message.length))),
  };
}

export function estimateChatGptWebImageTokens(compiled: CompiledChatGptWebPrompt): number {
  return compiled.images.reduce((total, image) => total + chatGptWebImageTokenReserve(image.detail), 0);
}
