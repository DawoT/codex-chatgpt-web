import { CHATGPT_WEB_PLATFORM_RESERVE_TOKENS, chatGptWebImageTokenReserve } from "../../chatgpt-web-models";
import { skillFileTokens } from "./skill-attachments";
import { estimateTokens } from "../../lib/token-estimate";
import {
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
} from "./prompt/multipart";
import type { CompiledChatGptWebPrompt } from "./prompt/types";

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
    ...compiled.multipart.parts.slice(0, -1).map((payload, index) => (
      formatChatGptWebMultipartStage(
        payload,
        TOKEN_ESTIMATE_TRANSACTION,
        index + 1,
        compiled.multipart!.parts.length,
      ).text
    )),
    formatChatGptWebMultipartCommit(compiled.multipart, TOKEN_ESTIMATE_TRANSACTION),
  ];
}

export function compiledChatGptWebMaxMessageChars(compiled: CompiledChatGptWebPrompt): number {
  return Math.max(...compiledChatGptWebMessages(compiled).map(message => message.length));
}

/** Tokens present in the one visible browser message, excluding hidden product/tool reserves. */
export function estimateCompiledChatGptWebMessageTokens(
  compiled: CompiledChatGptWebPrompt,
  modelId: string,
): number {
  const messages = compiledChatGptWebMessages(compiled);
  return Math.max(...messages.map((message, index) => estimateTokens(message, modelId)
    + (index === messages.length - 1 ? skillFileTokens(compiled.skillFiles, modelId) : 0)));
}

export function estimateCompiledChatGptWebInputTokens(
  compiled: CompiledChatGptWebPrompt,
  modelId: string,
): number {
  return measureCompiledChatGptWebInput(compiled, modelId).inputTokens;
}

/** Request-local metrics: tokenize each visible message once for total and maximum. */
export function measureCompiledChatGptWebInput(
  compiled: CompiledChatGptWebPrompt,
  modelId: string,
): { inputTokens: number; maxMessageTokens: number; maxMessageChars: number } {
  const imageTokens = estimateChatGptWebImageTokens(compiled);
  const messages = compiledChatGptWebMessages(compiled);
  const counts = messages.map(message => estimateTokens(message, modelId));
  const attachments = skillFileTokens(compiled.skillFiles, modelId);
  const messageTokens = counts.reduce((total, count) => total + count, 0);
  const acknowledgementTokens = compiled.multipart
    ? compiled.multipart.parts.slice(0, -1).reduce((total, payload, index) => total + estimateTokens(
      formatChatGptWebMultipartStage(
        payload,
        TOKEN_ESTIMATE_TRANSACTION,
        index + 1,
        compiled.multipart!.parts.length,
      ).acknowledgement,
      modelId,
    ), 0)
    : 0;
  return {
    inputTokens: CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + messageTokens + acknowledgementTokens + imageTokens + attachments,
    maxMessageTokens: Math.max(...counts.map((count, index) => count + (index === counts.length - 1 ? attachments : 0))),
    maxMessageChars: Math.max(...messages.map(message => message.length)),
  };
}

export function estimateChatGptWebImageTokens(compiled: CompiledChatGptWebPrompt): number {
  return compiled.images.reduce(
    (total, image) => total + chatGptWebImageTokenReserve(image.detail),
    0,
  );
}
