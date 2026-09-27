import type { AppConfig } from "../config";
import type { CodexParsedRequest } from "../types";
import { estimateTokens } from "../lib/token-estimate";
import { CHATGPT_WEB_LUNA_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "../adapters/chatgpt-web/model";
import { preparePreflightInput } from "../adapters/chatgpt-web/preflight-budget";
import { resolveBiggerContextMultipartParts } from "../adapters/chatgpt-web/usage";
import { compileChatGptWebPrompt, formatChatGptWebMultipartCommit, formatChatGptWebMultipartStage } from "../adapters/chatgpt-web/prompt";
import { estimateChatGptWebImageTokens, measureCompiledChatGptWebInput } from "../adapters/chatgpt-web/input-tokens";
import { skillFileTokens } from "../adapters/chatgpt-web/skill-attachments";
import { assertChatGptPromptAttachments } from "../adapters/chatgpt-web/browser/payloads";
import {
  assertChatGptWebInputWithinLimits,
  assertChatGptWebMultipartInputWithinLimits,
  resolveChatGptWebMultipartStagingMode,
} from "../adapters/chatgpt-web/browser/staging-limits";

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
  const multipartParts = config.experimentalBiggerContext || verdict.actionRequired === "promote_multipart"
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
  });
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
  const transaction = `ctx_${"0".repeat(32)}`;
  const stages = compiled.multipart.parts.slice(0, -1).map((payload, index) => formatChatGptWebMultipartStage(
    payload,
    transaction,
    index + 1,
    compiled.multipart!.parts.length,
  ));
  const final = formatChatGptWebMultipartCommit(compiled.multipart, transaction);
  const maxStageTokens = Math.max(...stages.map(stage => estimateTokens(stage.text, parsed.modelId)));
  const maxStageChars = Math.max(...stages.map(stage => stage.text.length));
  const stagingMode = resolveChatGptWebMultipartStagingMode(parsed.modelId, capabilities, maxStageTokens, maxStageChars);
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
      finalMessageTokens: estimateTokens(final, parsed.modelId) + skillFileTokens(compiled.skillFiles, parsed.modelId),
      finalMessageChars: final.length,
      finalImageTokens: estimateChatGptWebImageTokens(compiled),
    },
  );
}
