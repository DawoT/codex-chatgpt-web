import { isChatGptWebZeroRiskBackendModel } from "../../chatgpt-web-models";
import { estimateTokens } from "../../lib/token-estimate";
import type { CodexParsedRequest, CodexUsage } from "../../types";
import { selectCompiledChatGptWebTransport } from "./browser/multipart-plan";
import { extractChatGptTurnIdentity } from "./environment";
import { estimateCompiledChatGptWebInputTokens } from "./input-tokens";
import { CHATGPT_WEB_LUNA_MODEL_ID, type ChatGptWebCapabilities, resolveChatGptWebModelMode } from "./model";
import {
  CHATGPT_BIGGER_CONTEXT_PARTS,
  type ChatGptWebMultipartPartCount,
  type CompileChatGptWebPromptOptions,
  type CompiledChatGptWebPrompt,
  compileChatGptWebPrompt,
} from "./prompt";
import type { BrokerToolRequest } from "./turn-broker";

// The real capability has the same length. Keeping it out of usage accounting would make
// estimates differ slightly between the prepared browser prompt and later Codex tool rounds.
const ESTIMATE_TURN_TOKEN = "turn_00000000000000000000000000000000";

export interface ChatGptWebRoundEvidence {
  answer?: string;
  reasoning?: string[];
  toolRequests?: BrokerToolRequest[];
}

function conservativeTextTokens(text: string, modelId: string): number {
  return estimateTokens(text, modelId);
}

export function estimateChatGptWebInputTokens(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  options: CompileChatGptWebPromptOptions = {},
): number {
  const manual = isChatGptWebZeroRiskBackendModel(parsed.modelId);
  const mode = manual
    ? { localTools: true }
    : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  const identity = extractChatGptTurnIdentity(parsed);
  const compiled = compileChatGptWebPrompt(parsed, capabilities, mode.localTools ? ESTIMATE_TURN_TOKEN : undefined, {
    ...options,
    ...(manual ? { manualControl: true as const } : {}),
    captureLunaCheckpoint:
      parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID &&
      !parsed._compactionRequest &&
      Boolean(identity.threadId && identity.turnId),
  });
  return estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId);
}

/** Select inline, two or six using the complete compiled messages, attachments and existing limits. */
export function resolveBiggerContextMultipartParts(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  experimentalSkillAttachments = false,
  forceMultipart = false,
): ChatGptWebMultipartPartCount | undefined {
  if (isChatGptWebZeroRiskBackendModel(parsed.modelId)) {
    throw new Error("Bigger Context is unavailable for ChatGPT Zero Risk");
  }
  if (parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new Error(
      "Bigger Context is unavailable for Luna because its accumulated browser transcript still shares one 28,000-token transport budget",
    );
  }
  const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities, {
    messages: parsed.context.messages,
    compactionRequest: Boolean(parsed._compactionRequest),
  });
  const compiled = selectCompiledChatGptWebTransport(
    (parts): CompiledChatGptWebPrompt =>
      compileChatGptWebPrompt(parsed, capabilities, mode.localTools ? ESTIMATE_TURN_TOKEN : undefined, {
        experimentalMultipartParts: parts,
        experimentalSkillAttachments,
      }),
    { modelId: parsed.modelId, capabilities, requestedMode: mode, compaction: Boolean(parsed._compactionRequest) },
    forceMultipart,
  );
  return compiled.multipart?.parts.length as ChatGptWebMultipartPartCount | undefined;
}

export function biggerContextPartCount(
  inputTokens: number,
  onePartLimit: number,
  _compaction: boolean,
): ChatGptWebMultipartPartCount | undefined {
  if (inputTokens < onePartLimit) return undefined;
  if (inputTokens < onePartLimit * 2) return 2;
  return CHATGPT_BIGGER_CONTEXT_PARTS;
}

function roundEvidenceText(evidence: ChatGptWebRoundEvidence): string {
  return JSON.stringify({
    reasoning: evidence.reasoning ?? [],
    ...(evidence.answer !== undefined ? { answer: evidence.answer } : {}),
    ...(evidence.toolRequests
      ? {
          tool_calls: evidence.toolRequests.map((request) => ({
            call_id: request.callId,
            name: request.wireName,
            ...(request.freeform ? { input: request.input ?? "" } : { arguments: request.arguments ?? {} }),
          })),
        }
      : {}),
  });
}

export function estimateChatGptWebUsage(
  parsed: CodexParsedRequest,
  evidence: ChatGptWebRoundEvidence,
  capabilities: ChatGptWebCapabilities,
  experimentalBiggerContext = false,
  experimentalSkillAttachments = false,
): CodexUsage {
  const inputTokens = estimateChatGptWebInputTokens(parsed, capabilities, {
    experimentalSkillAttachments,
    experimentalMultipartParts: experimentalBiggerContext
      ? resolveBiggerContextMultipartParts(parsed, capabilities, experimentalSkillAttachments)
      : undefined,
  });
  const outputTokens = conservativeTextTokens(roundEvidenceText(evidence), parsed.modelId);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimated: true,
  };
}
