import { type CodexParsedRequest, type CodexToolResultMessage, namespacedToolName } from "../../../types";
import { ChatGptWebAdapterError } from "../adapter-error";
import type { BrokerToolRequest } from "../turn-broker";
import type { ChatGptTurnSession } from "../turn-execution";

export function submittedTurnFailure(session: ChatGptTurnSession, error: unknown): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const phase = session.runtime.submission?.phase;
  if (normalized instanceof ChatGptWebAdapterError && (!normalized.retryable || !phase || phase === "prepared"))
    return normalized;
  if (
    phase === "prepared" &&
    /^ChatGPT browser stage timed out: (?:send|multipart_stage_\d+_send)$/.test(normalized.message)
  ) {
    return new ChatGptWebAdapterError("ChatGPT did not accept the prompt before Send activation. Retry this turn.", {
      status: 504,
      errorType: "server_error",
      code: "chatgpt_submission_not_accepted",
      retryable: true,
      cause: normalized,
    });
  }
  if (!phase || phase === "prepared") return normalized;
  const ambiguous = phase === "send_activated";
  const detail = normalized.message ? ` (${normalized.message})` : "";
  return new ChatGptWebAdapterError(
    ambiguous
      ? `ChatGPT did not confirm that the prompt was sent${detail}. Check the ChatGPT tab before continuing.`
      : `ChatGPT stopped responding after the task started${detail}. Check the ChatGPT tab before continuing.`,
    {
      status: 502,
      errorType: "server_error",
      code: ambiguous ? "chatgpt_submission_ambiguous" : "chatgpt_submitted_turn_failed",
      retryable: false,
      cause: normalized,
    },
  );
}

export function currentToolResults(parsed: CodexParsedRequest, session: ChatGptTurnSession): CodexToolResultMessage[] {
  const byId = new Map<string, CodexToolResultMessage>();
  for (const message of parsed.context.messages) {
    if (message.role !== "toolResult" || !session.hasOutstanding(message.toolCallId)) continue;
    if (byId.has(message.toolCallId))
      throw new Error(`Codex returned duplicate results for tool call ${message.toolCallId}`);
    byId.set(message.toolCallId, message);
  }
  return [...byId.values()];
}

export function validateBatchTools(parsed: CodexParsedRequest, requests: BrokerToolRequest[]): void {
  const available = new Set((parsed.context.tools ?? []).map((tool) => namespacedToolName(tool.namespace, tool.name)));
  for (const request of requests) {
    if (!available.has(request.wireName)) {
      throw new Error(`ChatGPT requested a tool that the active Codex round did not advertise: ${request.wireName}`);
    }
  }
}
