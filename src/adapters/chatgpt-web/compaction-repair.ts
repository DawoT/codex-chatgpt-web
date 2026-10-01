import {
  CHATGPT_WEB_PLATFORM_RESERVE_TOKENS,
  type ChatGptWebAdapterEffort,
  type ChatGptWebBackendModel,
  resolveChatGptWebContextLimits,
  resolveChatGptWebTransportLimits,
} from "../../chatgpt-web-models";
import { estimateTokens } from "../../lib/token-estimate";
import type { CodexParsedRequest } from "../../types";
import {
  assertChatGptWebInputWithinLimits,
  assertChatGptWebMultipartInputWithinLimits,
  resolveChatGptWebMultipartStagingMode,
} from "./browser/staging-limits";
import type { CompactionEvidenceObservation } from "./compaction-evidence";
import { measureCompiledBrowserPayload, measureCompiledChatGptWebInput } from "./input-tokens";
import type { ChatGptWebCapabilities } from "./model";
import { resolveChatGptWebModelMode } from "./model";
import {
  enforcePreflightDeliveryBudget,
  PREFLIGHT_MAX_STAGE_CHAR_LIMIT,
  preparePreflightInput,
} from "./preflight-budget";
import { compileChatGptWebPrompt } from "./prompt";
import { resolveBiggerContextMultipartParts } from "./usage";

export const MAX_COMPACTION_REPAIR_PROMPT_CHARS = PREFLIGHT_MAX_STAGE_CHAR_LIMIT;

export function buildCompactionFallbackRepairPrompt(input: {
  issues: readonly string[];
  originalRequest: string;
  latestRequest: string;
  otherUserRequests: readonly string[];
  priorState: unknown;
  observations: readonly CompactionEvidenceObservation[];
  rejectedDraft: string;
}): string | undefined {
  const observations = [...input.observations];
  let draftLimit = 15_000;
  const render = (): string => {
    const draft =
      input.rejectedDraft.length > draftLimit
        ? `${input.rejectedDraft.slice(0, Math.ceil(draftLimit / 2))}\n[draft excerpt truncated]\n${input.rejectedDraft.slice(-Math.floor(draftLimit / 2))}`
        : input.rejectedDraft;
    return [
      "Repair the previous Codex handoff once. Keep user requirements and observed evidence; do not resume ordinary task work.",
      "Validation issues:",
      ...input.issues.map((issue) => `- ${issue}`),
      "Original user request:",
      JSON.stringify(input.originalRequest),
      "Latest user request:",
      JSON.stringify(input.latestRequest),
      "Other user requests:",
      JSON.stringify(input.otherUserRequests),
      "Previous checkpoint state:",
      JSON.stringify(input.priorState ?? {}),
      "Relevant bridge observations:",
      JSON.stringify(observations),
      "Rejected draft excerpt:",
      draft,
      "Return one faithful corrected handoff. The bridge will normalize its internal format.",
    ].join("\n");
  };
  let prompt = render();
  while (prompt.length > MAX_COMPACTION_REPAIR_PROMPT_CHARS && observations.length > 0) {
    observations.pop();
    prompt = render();
  }
  while (prompt.length > MAX_COMPACTION_REPAIR_PROMPT_CHARS && draftLimit > 0) {
    draftLimit = Math.max(0, draftLimit - 1_000);
    prompt = render();
  }
  return prompt.length <= MAX_COMPACTION_REPAIR_PROMPT_CHARS ? prompt : undefined;
}

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
    const payload = measureCompiledBrowserPayload(compiled, request.modelId);
    const maxStageMessageTokens = Math.max(...payload.messageTokensEstimated.slice(0, -1));
    const maxStageChars = Math.max(...payload.messageChars.slice(0, -1));
    const stagingMode = resolveChatGptWebMultipartStagingMode(
      request.modelId,
      capabilities,
      maxStageMessageTokens,
      maxStageChars,
    );
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
        finalMessageTokens: payload.messageTokensEstimated.at(-1)! + payload.skillFileTokensEstimated,
        finalMessageChars: payload.messageChars.at(-1)!,
        finalImageTokens: payload.imageTokensEstimated,
        isCompaction: request._compactionRequest === true,
      },
      request._compactionRequest === true,
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
  return (
    prompt.length <= MAX_COMPACTION_REPAIR_PROMPT_CHARS &&
    (transport.browserComposerCharLimit === undefined || prompt.length <= transport.browserComposerCharLimit) &&
    (transport.browserMessageTokenLimit === undefined || tokens <= transport.browserMessageTokenLimit) &&
    tokens + CHATGPT_WEB_PLATFORM_RESERVE_TOKENS < context.contextWindow
  );
}

export function shouldRepairCheckpoint(input: {
  remainingMs: number;
  transportFits: boolean;
  observedDurationsMs: readonly number[];
}): boolean {
  if (!input.transportFits) return false;
  const observed = input.observedDurationsMs
    .filter((duration) => Number.isFinite(duration) && duration >= 0)
    .sort((a, b) => a - b);
  const p95 = observed.length > 0 ? observed[Math.ceil(observed.length * 0.95) - 1]! : 0;
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
