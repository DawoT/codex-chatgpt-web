import { assertChatGptPromptAttachments } from "../adapters/chatgpt-web/browser/payloads";
import {
  assertChatGptWebInputWithinLimits,
  assertChatGptWebMultipartInputWithinLimits,
  resolveChatGptWebMultipartStagingMode,
} from "../adapters/chatgpt-web/browser/staging-limits";
import { measureCompiledBrowserPayload, measureCompiledChatGptWebInput } from "../adapters/chatgpt-web/input-tokens";
import { enforceMissionHeadroom } from "../adapters/chatgpt-web/mission-headroom";
import {
  CHATGPT_WEB_LUNA_MODEL_ID,
  type ChatGptWebCapabilities,
  resolveChatGptWebModelMode,
} from "../adapters/chatgpt-web/model";
import { enforcePreflightDeliveryBudget, preparePreflightInput } from "../adapters/chatgpt-web/preflight-budget";
import { compileChatGptWebPrompt } from "../adapters/chatgpt-web/prompt";
import { resolveBiggerContextMultipartParts } from "../adapters/chatgpt-web/usage";
import type { AppConfig } from "../config";
import type { CodexParsedRequest } from "../types";

// The broker issues opaqueId("host_turn"): 32 base64url characters after this prefix.
const HOST_PREFLIGHT_TOKEN = "host_turn_Ab3xK9qRm2Vt7Yp4Nc8Fd5Hs0Jw6Ze1L";

/** Reject a fresh host turn that the selected browser transport cannot carry. */
export function assertFirstHostPromptWithinLimits(parsed: CodexParsedRequest, config: AppConfig): void {
  const capabilities: ChatGptWebCapabilities = {
    localToolsEnabled: true,
    solAvailable: config.solAvailable,
    extraHighAvailable: config.extraHighAvailable === true,
    proAvailable: config.proAvailable === true,
  };
  const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  const { input, verdict } = preparePreflightInput(parsed, capabilities, {
    experimentalBiggerContext: config.experimentalBiggerContext === true,
  });
  enforcePreflightDeliveryBudget(input, verdict);
  const multipartParts =
    config.experimentalBiggerContext || verdict.actionRequired === "promote_multipart"
      ? resolveBiggerContextMultipartParts(
          input,
          capabilities,
          config.experimentalSkillAttachments === true,
          verdict.actionRequired === "promote_multipart",
        )
      : undefined;
  const compiled = compileChatGptWebPrompt(input, capabilities, mode.localTools ? HOST_PREFLIGHT_TOKEN : undefined, {
    captureLunaCheckpoint: parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID,
    experimentalSkillAttachments: config.experimentalSkillAttachments === true,
    ...(multipartParts !== undefined ? { experimentalMultipartParts: multipartParts } : {}),
    conversationalFreedom: config.promptStyle?.conversationalFreedom !== false,
  });
  enforceMissionHeadroom(input, compiled, mode.effort, capabilities);
  assertChatGptPromptAttachments(compiled);
  const metrics = measureCompiledChatGptWebInput(compiled, parsed.modelId);
  if (!compiled.multipart) {
    assertChatGptWebInputWithinLimits(
      metrics.inputTokens,
      metrics.maxMessageTokens,
      parsed.modelId,
      mode.effort,
      capabilities,
      metrics.maxMessageChars,
    );
    return;
  }
  const payload = measureCompiledBrowserPayload(compiled, parsed.modelId);
  const maxStageTokens = Math.max(...payload.messageTokensEstimated.slice(0, -1));
  const maxStageChars = Math.max(...payload.messageChars.slice(0, -1));
  const stagingMode = resolveChatGptWebMultipartStagingMode(
    parsed.modelId,
    capabilities,
    maxStageTokens,
    maxStageChars,
  );
  assertChatGptWebMultipartInputWithinLimits(
    metrics.inputTokens,
    metrics.maxMessageTokens,
    parsed.modelId,
    mode.effort,
    capabilities,
    metrics.maxMessageChars,
    compiled.multipart.parts.length,
    {
      stagingEffort: stagingMode.effort,
      maxStageMessageTokens: maxStageTokens,
      maxStageChars,
      finalMessageTokens: payload.messageTokensEstimated.at(-1)! + payload.skillFileTokensEstimated,
      finalMessageChars: payload.messageChars.at(-1)!,
      finalImageTokens: payload.imageTokensEstimated,
    },
  );
}
