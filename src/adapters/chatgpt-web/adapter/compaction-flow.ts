import { createHash } from "node:crypto";
import type { AdapterEvent, CodexParsedRequest, CodexToolCall } from "../../../types";
import { COMPACT_PROMPT, extractStructuredCompactionHandoff } from "../../../responses/compaction";
import { type ChatGptWebBackendModel } from "../../../chatgpt-web-models";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError } from "../adapter-error";
import {
  checkpointCompiledRepairFits,
  checkpointRepairPromptFits,
  recordRepairDuration,
  shouldRepairCheckpoint,
} from "../compaction-repair";
import type { ChatGptBrowserWorker } from "../browser-worker";
import {
  validateCompactionQuality,
} from "../autonomous-compaction";
import {
  canonicalizeCompactionHandoff,
  existingStructuredCompactionRun,
  MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
  ORIGINAL_USER_REQUEST_MARKER,
  requestRetainedCompactionHandoff,
  runStructuredCompactionOnce,
  settleActiveCompactionSource,
  settleActiveZeroRiskCompactionSource,
} from "../compaction-handoff";
import { chatGptConversationKey } from "../conversation-key";
import { extractChatGptCompactionSourceRevision, extractChatGptTurnEnvironment, extractChatGptTurnIdentity } from "../environment";
import { CHATGPT_WEB_LUNA_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "../model";
import { structuredCompactionRepairInstruction } from "../native-compaction-control";
import { chatGptWebTurnRetryPolicy } from "../retry-policy";
import { TurnBroker, type TurnBrokerOwner } from "../turn-broker";
import {
  chatGptCompactionSourceExecutionKey,
  chatGptThreadOwnershipKey,
  chatGptTurnExecutionKey,
  chatGptTurnSessions,
  type ChatGptTurnRuntime,
  type ChatGptTurnSession,
} from "../turn-execution";
import { estimateChatGptWebUsage } from "../usage";
import { persistTurnCompaction } from "../workspace-persistence";
import { withAbort } from "./cancellation";
import { emitBrowserCompletion } from "./events";

const observedRepairDurationsMs: number[] = [];

function checkpointText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap(part => part && typeof part === "object" && !Array.isArray(part)
    && (part.type === "text" || part.type === "input_text") && typeof part.text === "string"
    ? [part.text]
    : []).join("\n");
}

function recentRepairObservations(parsed: CodexParsedRequest): Array<{
  toolCallId: string;
  toolName: string;
  isError: boolean;
  command?: string;
  output: string;
  outputSha256?: string;
}> {
  return parsed.context.messages.filter(message => message.role === "toolResult")
    .slice(-4)
    .map(message => {
      const output = checkpointText(message.content);
      const call = parsed.context.messages.find(prior => prior.role === "assistant"
        && prior.content.some(part => part.type === "toolCall" && part.id === message.toolCallId));
      const command = call?.role === "assistant"
        ? call.content.find((part): part is CodexToolCall => part.type === "toolCall"
          && part.id === message.toolCallId)?.arguments.cmd
        : undefined;
      return {
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        isError: message.isError,
        ...(typeof command === "string" && command.length <= 200 ? { command } : {}),
        output: output.length <= 1_200
          ? output
          : `${output.slice(0, 600)}\n[output excerpt; recover full text from toolCallId]\n${output.slice(-600)}`,
        ...(output.length > 1_200
          ? { outputSha256: createHash("sha256").update(output).digest("hex") }
          : {}),
      };
    });
}

function originalRequestFromCanonicalSummary(summary: string): string {
  const marker = `\n${ORIGINAL_USER_REQUEST_MARKER}\n`;
  const start = summary.lastIndexOf(marker);
  if (start < 0) return "";
  const raw = summary.slice(start + marker.length).split("\n", 1)[0];
  try {
    const record: unknown = JSON.parse(raw!);
    return record && typeof record === "object" && "text" in record && typeof record.text === "string"
      ? record.text
      : "";
  } catch {
    return "";
  }
}

export interface CompactionFlowContext {
  worker: ChatGptBrowserWorker;
  parsed: CodexParsedRequest;
  incoming: { headers: Headers; abortSignal?: AbortSignal };
  emit: (event: AdapterEvent) => void;
  configuredCapabilities: ChatGptWebCapabilities;
  turnCapabilities: ChatGptWebCapabilities;
  manualRequest: boolean;
  retainedLauncherDescriptor: string | undefined;
  structuredBroker: TurnBroker | undefined;
  broker: TurnBrokerOwner;
  executionNamespace: string;
  timeoutMs: number | undefined;
  freshConversationPerTurn: boolean;
  experimentalBiggerContext: boolean | undefined;
  experimentalSkillAttachments: boolean | undefined;
  retryKey: string;
  environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined;
  startRuntime: (
    parsed: CodexParsedRequest,
    environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined,
    traceId: string,
    turnCapabilities: ChatGptWebCapabilities,
    hooks?: { onCompactionProgress?: () => void; onHeartbeat?: () => void },
  ) => ChatGptTurnRuntime;
}

export async function executeCompactionFlow(ctx: CompactionFlowContext): Promise<boolean> {
  const {
    worker,
    parsed,
    incoming,
    emit,
    configuredCapabilities,
    turnCapabilities,
    manualRequest,
    retainedLauncherDescriptor,
    structuredBroker,
    broker,
    executionNamespace,
    timeoutMs,
    freshConversationPerTurn,
    experimentalBiggerContext,
    experimentalSkillAttachments,
    retryKey,
    environment,
    startRuntime,
  } = ctx;

  const structuredCompactionRequired = parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID
    && configuredCapabilities.localToolsEnabled;

  if (structuredCompactionRequired
    && (!retainedLauncherDescriptor || (!manualRequest && !structuredBroker))) {
    emit({
      type: "error",
      message: manualRequest
        ? "Zero Risk could not resume the active ChatGPT conversation for context handoff. Retry the task from the Launcher."
        : "ChatGPT could not resume the active conversation for context handoff. Retry the task.",
      status: 409,
      errorType: "invalid_request_error",
      code: "compaction_control_unavailable",
      retryable: false,
    });
    return true;
  }

  if (structuredCompactionRequired) {
    const compactionExecutionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
    const compactedSourceExecutionKey = `${executionNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`;
    const handoffTraceId = createHash("sha256")
      .update(`${compactionExecutionKey}:handoff`)
      .digest("hex")
      .slice(0, 12);
    const compactionTraceId = createHash("sha256")
      .update(compactionExecutionKey)
      .digest("hex")
      .slice(0, 12);
    const freshCompactionTraceId = `${handoffTraceId}_${freshConversationPerTurn ? "fresh" : "fallback"}`;
    const compactionNativeIdentity = extractChatGptTurnIdentity(parsed);
    let sharedSummary = existingStructuredCompactionRun(compactionExecutionKey);
    if (!sharedSummary) {
      sharedSummary = runStructuredCompactionOnce(
        compactionExecutionKey,
        {
          ownerKey: `${executionNamespace}:${chatGptThreadOwnershipKey(parsed)}`,
          traceIds: [
            compactionTraceId,
            handoffTraceId,
            freshCompactionTraceId,
            `${freshCompactionTraceId}_repair`,
          ],
          ...(compactionNativeIdentity.threadId
            ? { nativeThreadId: compactionNativeIdentity.threadId }
            : {}),
          ...(compactionNativeIdentity.turnId
            ? { nativeTurnId: compactionNativeIdentity.turnId }
            : {}),
        },
        async (operatorSignal, retainOwnershipUntil) => {
          const handoffTimeoutMs = Math.min(
            timeoutMs ?? MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
            MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
          );
          const handoffDeadline = new AbortController();
          const handoffTimeoutError = new ChatGptWebAdapterError(
            `ChatGPT compaction did not fully settle within ${handoffTimeoutMs}ms`,
            {
              status: 409,
              errorType: "invalid_request_error",
              code: "compaction_handoff_timeout",
              retryable: false,
            },
          );
          let handoffTimer: ReturnType<typeof setTimeout> | undefined;
          let handoffDeadlineAt = 0;
          const armHandoffDeadline = (): void => {
            if (handoffDeadline.signal.aborted) return;
            if (handoffTimer) clearTimeout(handoffTimer);
            handoffDeadlineAt = Date.now() + handoffTimeoutMs;
            handoffTimer = setTimeout(
              () => handoffDeadline.abort(handoffTimeoutError),
              handoffTimeoutMs,
            );
            handoffTimer.unref?.();
          };
          armHandoffDeadline();
          const operationSignal = AbortSignal.any([operatorSignal, handoffDeadline.signal]);
          const sourceConversationKey = chatGptConversationKey(parsed, executionNamespace);
          const runFreshCompaction = async (reason: string): Promise<string> => {
            if (freshConversationPerTurn) console.info("[chatgpt-web] compaction uses configured fresh conversation mode");
            else console.warn(`[chatgpt-web] retained compaction fallback=${reason}`);
            // Fresh compaction is a bounded phase. Each exact multipart acknowledgement
            // and the final accepted compact prompt re-arms the five-minute liveness budget;
            // transport time cannot consume the model-generation window.
            armHandoffDeadline();
            const fallbackRuntime = startRuntime(
              parsed,
              manualRequest ? environment : undefined,
              freshCompactionTraceId,
              turnCapabilities,
              { onCompactionProgress: armHandoffDeadline, onHeartbeat: () => emit({ type: "heartbeat" }) },
            );
            retainOwnershipUntil(fallbackRuntime.physicalSettlement);
            try {
              const rawSummary = await withAbort(fallbackRuntime.browser, operationSignal);
              await withAbort(fallbackRuntime.physicalSettlement, operationSignal);
              // Keep empty output in the validation/repair path; a fabricated draft
              // can never satisfy the structured checkpoint validator.
              let summary = canonicalizeCompactionHandoff(
                parsed,
                rawSummary.trim() ? rawSummary : "Empty checkpoint draft",
              );
              let quality = validateCompactionQuality(parsed.context.messages, summary, { requireStructured: true });
              console.info(`[chatgpt-web] checkpoint_validation valid=${quality.valid} missingCount=${quality.missingInvariants.length} repaired=false`);
              if (!quality.valid && !manualRequest) {
                const previousCheckpoint = parsed.context.messages.findLast(message => message.role === "user"
                  && message.origin === "compaction_summary");
                const priorState = previousCheckpoint
                  ? extractStructuredCompactionHandoff(checkpointText(previousCheckpoint.content)).state
                  : null;
                const originalRequest = originalRequestFromCanonicalSummary(summary);
                const latestRequest = checkpointText(extractChatGptCompactionSourceRevision(parsed).content);
                const checkpointIndex = previousCheckpoint
                  ? parsed.context.messages.lastIndexOf(previousCheckpoint)
                  : -1;
                const otherUserRequests = [...new Set(parsed.context.messages.slice(checkpointIndex + 1)
                  .filter(message => message.role === "user" && message.origin !== "codex_skill")
                  .map(message => checkpointText(message.content))
                  .filter(value => value && value !== COMPACT_PROMPT
                    && value !== originalRequest && value !== latestRequest))];
                const repairPrompt = [
                  "Repair the previous context checkpoint exactly once. This is a correction, not a new task turn.",
                  "Return one complete version 2 <compaction_state> checkpoint with all still-open requirements, verified evidence, blockers, decisions, and one next action.",
                  "Do not claim verification without an observed result. Do not call tools or redo the original task.",
                  "Validation issues:",
                  ...quality.missingInvariants.map(issue => `- ${issue}`),
                  "Original user request:",
                  JSON.stringify(originalRequest),
                  "Latest user request:",
                  JSON.stringify(latestRequest),
                  "Other user requests since previous checkpoint:",
                  JSON.stringify(otherUserRequests),
                  "Previous mission checkpoint state:",
                  JSON.stringify(priorState ?? {}),
                  "Recent observed tool results (do not infer success from an error or an excerpt):",
                  JSON.stringify(recentRepairObservations(parsed)),
                  "Rejected draft:",
                  rawSummary,
                ].join("\n");
                const repairParsed: CodexParsedRequest = {
                  ...parsed,
                  context: {
                    messages: [
                      { role: "user", content: repairPrompt, timestamp: Date.now() },
                    ],
                  },
                };
                if (shouldRepairCheckpoint({
                  remainingMs: handoffDeadlineAt - Date.now(),
                  transportFits: checkpointCompiledRepairFits(repairParsed, turnCapabilities, {
                    experimentalBiggerContext,
                    experimentalSkillAttachments,
                  }),
                  observedDurationsMs: observedRepairDurationsMs,
                })) {
                  const repairStarted = Date.now();
                  const repairRuntime = startRuntime(
                    repairParsed,
                    undefined,
                    `${freshCompactionTraceId}_repair`,
                    turnCapabilities,
                    { onHeartbeat: () => emit({ type: "heartbeat" }) },
                  );
                  retainOwnershipUntil(repairRuntime.physicalSettlement);
                  let repairOutcome: "succeeded" | "failed" = "failed";
                  try {
                    const repaired = await withAbort(repairRuntime.browser, operationSignal);
                    await withAbort(repairRuntime.physicalSettlement, operationSignal);
                    repairOutcome = "succeeded";
                    summary = canonicalizeCompactionHandoff(
                      parsed,
                      repaired.trim() ? repaired : "Empty checkpoint draft",
                    );
                    quality = validateCompactionQuality(parsed.context.messages, summary, { requireStructured: true });
                    console.info(`[chatgpt-web] checkpoint_validation valid=${quality.valid} missingCount=${quality.missingInvariants.length} repaired=true`);
                  } catch (error) {
                    repairRuntime.cancel(error instanceof Error ? error : new Error(String(error)));
                    throw error;
                  } finally {
                    recordRepairDuration(
                      observedRepairDurationsMs,
                      repairStarted,
                      Date.now(),
                      operatorSignal.aborted ? "operator_cancelled" : repairOutcome,
                    );
                  }
                }
              }
              return summary;
            } catch (error) {
              fallbackRuntime.cancel(error instanceof Error ? error : new Error(String(error)));
              // The shared owner retains physical settlement independently of this error.
              // Neither a timeout nor operator cancellation can open a competing trace.
              throw error;
            }
          };
          let source: ChatGptTurnSession | undefined;
          let preserveFinalResponse = false;
          let repairAttempted = false;
          try {
            if (freshConversationPerTurn) {
              // Full native history is the compaction input. Release an unfinished
              // browser/tool owner before rebuilding it, but keep a committed final
              // replayable if it won the native compaction race.
              const previous = chatGptTurnSessions.find(compactedSourceExecutionKey);
              const settlement = previous?.settledOutcome()?.type === "final"
                ? previous.physicalSettlement
                : chatGptTurnSessions.retireAndWait(compactedSourceExecutionKey).then(() => {});
              retainOwnershipUntil(settlement);
              await withAbort(settlement, operationSignal);
              return await runFreshCompaction("configured_fresh_conversation");
            }
            // The previous compaction may already have detached the retained head while
            // its browser/helper is still unwinding. Do not inspect that old epoch or
            // decide to open a fresh fallback until physical release has completed.
            if (sourceConversationKey) {
              await chatGptTurnSessions.waitForConversationRetirement(
                sourceConversationKey,
                operationSignal,
              );
            }
            source = sourceConversationKey
              ? chatGptTurnSessions.findConversationHead(sourceConversationKey)
              : undefined;
            preserveFinalResponse = !source?.isActive()
              && source?.settledOutcome()?.type === "final";
            const retainedKey = source?.conversationKey();
            if (!source || !retainedKey) {
              return await runFreshCompaction("source_unavailable_before_handoff");
            }
            let rawSummary: string;
            if (manualRequest && source.isActive() && source.runtime.mode === "tools") {
              const zeroRiskSummary = await settleActiveZeroRiskCompactionSource(
                parsed,
                source,
                broker,
                operationSignal,
              );
              if (zeroRiskSummary === undefined) {
                preserveFinalResponse = true;
                rawSummary = await runFreshCompaction("zero_risk_source_had_no_compaction_boundary");
              } else {
                rawSummary = zeroRiskSummary;
              }
            } else if (manualRequest) {
              if (source.isActive()) {
                const outcome = await withAbort(source.browserOutcome, operationSignal);
                if (outcome.type === "error") throw outcome.error;
                await withAbort(source.physicalSettlement, operationSignal);
                preserveFinalResponse = true;
              }
              rawSummary = await runFreshCompaction("zero_risk_source_already_completed");
            } else if (source.isActive() && source.runtime.mode === "tools") {
              const settlement = await settleActiveCompactionSource(
                parsed,
                source,
                structuredBroker!,
                operationSignal,
              );
              preserveFinalResponse = !settlement.compactionInstructionDelivered;
              rawSummary = await requestRetainedCompactionHandoff(
                worker,
                parsed,
                source,
                structuredBroker!,
                configuredCapabilities,
                handoffTraceId,
                operationSignal,
                handoffTimeoutMs,
              );
            } else {
              if (source.isActive()) {
                const outcome = await withAbort(source.browserOutcome, operationSignal);
                if (outcome.type === "error") throw outcome.error;
                await withAbort(source.physicalSettlement, operationSignal);
                preserveFinalResponse = true;
              }
              rawSummary = await requestRetainedCompactionHandoff(
                worker,
                parsed,
                source,
                structuredBroker!,
                configuredCapabilities,
                handoffTraceId,
                operationSignal,
                handoffTimeoutMs,
              );
            }
            let summary = canonicalizeCompactionHandoff(
              parsed,
              rawSummary.trim() ? rawSummary : "Empty checkpoint draft",
            );
            let quality = validateCompactionQuality(parsed.context.messages, summary, { requireStructured: true });
            console.info(`[chatgpt-web] checkpoint_validation valid=${quality.valid} missingCount=${quality.missingInvariants.length} repaired=false`);
            if (!quality.valid && !manualRequest && structuredBroker) {
              const probe = structuredCompactionRepairInstruction({
                token: `control_${"0".repeat(32)}`,
                handoffId: `handoff_${"0".repeat(32)}`,
              }, quality.missingInvariants);
              const effort = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, configuredCapabilities).effort;
              const transportFits = checkpointRepairPromptFits(
                probe,
                parsed.modelId as ChatGptWebBackendModel,
                effort,
                configuredCapabilities,
              );
              if (shouldRepairCheckpoint({
                remainingMs: handoffDeadlineAt - Date.now(),
                transportFits,
                observedDurationsMs: observedRepairDurationsMs,
              })) {
                repairAttempted = true;
                const repairStarted = Date.now();
                let repaired: string;
                let repairOutcome: "succeeded" | "failed" = "failed";
                try {
                  repaired = await requestRetainedCompactionHandoff(
                    worker,
                    parsed,
                    source,
                    structuredBroker,
                    configuredCapabilities,
                    `${handoffTraceId}_repair`,
                    operationSignal,
                    handoffDeadlineAt - Date.now(),
                    quality.missingInvariants,
                  );
                  repairOutcome = "succeeded";
                } finally {
                  recordRepairDuration(
                    observedRepairDurationsMs,
                    repairStarted,
                    Date.now(),
                    operatorSignal.aborted ? "operator_cancelled" : repairOutcome,
                  );
                }
                summary = canonicalizeCompactionHandoff(
                  parsed,
                  repaired.trim() ? repaired : "Empty checkpoint draft",
                );
                quality = validateCompactionQuality(parsed.context.messages, summary, { requireStructured: true });
                console.info(`[chatgpt-web] checkpoint_validation valid=${quality.valid} missingCount=${quality.missingInvariants.length} repaired=true`);
              }
            }
            if (!quality.valid) {
              throw new ChatGptWebAdapterError("Context checkpoint failed validation; original history remains available", {
                status: 409,
                errorType: "invalid_response_error",
                code: "context_checkpoint_validation_failed",
                retryable: false,
              });
            }
            await withAbort(
              preserveFinalResponse
                ? chatGptTurnSessions.retireConversationPreservingFinalResponse(
                  retainedKey,
                  source,
                  compactedSourceExecutionKey,
                )
                : chatGptTurnSessions.retireConversationAndWait(retainedKey),
              operationSignal,
            );
            return summary;
          } catch (error) {
            if (repairAttempted || (error instanceof ChatGptWebAdapterError
              && error.code === "context_checkpoint_validation_failed")) throw error;
            const retainedKey = source?.conversationKey();
            if (!retainedKey) throw error;
            let handoffError = error instanceof Error ? error : new Error(String(error));
            try {
              // Operator cancellation ends the logical compaction, but cancel-all must not
              // acknowledge until the retained browser/helper owner has physically retired.
              await (preserveFinalResponse
                ? chatGptTurnSessions.retireConversationPreservingFinalResponse(
                  retainedKey,
                  source!,
                  compactedSourceExecutionKey,
                )
                : chatGptTurnSessions.retireConversationAndWait(retainedKey));
            } catch (retirementError) {
              handoffError = new AggregateError(
                [handoffError, retirementError instanceof Error ? retirementError : new Error(String(retirementError))],
                "Structured compaction failed and its retained conversation could not be retired",
              );
            }
            if (handoffError instanceof ChatGptWebAdapterError
              && handoffError.code === "compaction_source_unavailable") {
              return await runFreshCompaction("source_disappeared_before_handoff");
            }
            throw handoffError;
          } finally {
            if (handoffTimer) clearTimeout(handoffTimer);
          }
        },
      );
    }
    emit({ type: "heartbeat" });
    let summary: string;
    try {
      summary = await withAbort(sharedSummary, incoming.abortSignal);
    } catch (error) {
      if (incoming.abortSignal?.aborted
        && error instanceof DOMException
        && error.name === "AbortError") {
        // The observer detached; the shared exact compaction round continues and remains
        // available to a canonical reconnect without a second browser submission.
        throw error;
      }
      const handoffError = error instanceof Error ? error : new Error(String(error));
      console.error("[chatgpt-web] structured context handoff failed:", handoffError);
      const upstreamError = handoffError instanceof ChatGptWebAdapterError ? handoffError : undefined;
      emit({
        type: "error",
        message: upstreamError?.message ?? "ChatGPT did not complete the context handoff. Retry the task.",
        status: upstreamError?.status ?? 409,
        errorType: upstreamError?.errorType ?? "invalid_request_error",
        code: upstreamError?.code ?? "compaction_handoff_failed",
        // Compaction retry remains an explicit operator decision even when its source
        // failure was retryable; preserve the cause without opening a new retry loop.
        retryable: false,
      });
      return true;
    }
    const rejectCheckpoint = (reason: string): boolean => {
      emit({
        type: "milestone",
        kind: "intervention_required",
        result: "Checkpoint rejected",
        evidence: "context_checkpoint_validation_failed",
        nextStep: "Review the checkpoint and retry compaction explicitly",
      });
      emit({
        type: "error",
        message: `Context checkpoint failed validation: ${reason}`,
        status: 409,
        errorType: "invalid_response_error",
        code: "context_checkpoint_validation_failed",
        retryable: false,
      });
      return true;
    };
    let quality: ReturnType<typeof validateCompactionQuality>;
    try {
      quality = validateCompactionQuality(parsed.context.messages, summary, { requireStructured: true });
    } catch {
      return rejectCheckpoint("validator could not inspect the source history");
    }
    if (!quality.valid) return rejectCheckpoint(quality.missingInvariants.join("; "));
    console.info(`[chatgpt-web] checkpoint_validation valid=true missingCount=0 accepted=true`);
    try {
      persistTurnCompaction(environment, parsed.context.messages, summary);
    } catch (checkpointError) {
      console.warn("[chatgpt-web] Failed to record turn checkpoint:", checkpointError);
    }
    const checkpoint = extractStructuredCompactionHandoff(summary).state!;
    for (const achievement of checkpoint.verifiedAchievements ?? []) {
      const evidenceMarker = /\bevidence\s*:\s*/i.exec(achievement);
      if (!evidenceMarker) continue;
      const result = achievement.slice(0, evidenceMarker.index).replace(/[\s—–:-]+$/, "").trim();
      const evidence = achievement.slice(evidenceMarker.index + evidenceMarker[0].length).trim();
      emit({
        type: "milestone",
        kind: "verified_achievement",
        result,
        evidence,
        nextStep: checkpoint.nextActions[0]!,
      });
    }
    emit({
      type: "milestone",
      kind: "checkpoint_completed",
      result: "Checkpoint validated",
      evidence: "structured_state_and_source_invariants",
      nextStep: checkpoint.nextActions[0]!,
    });
    emit({ type: "text_delta", text: summary, phase: "final_answer" });
    emitBrowserCompletion(
      { type: "final", answer: summary },
      estimateChatGptWebUsage(parsed, { answer: summary, reasoning: [] }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
      emit,
    );
    chatGptWebTurnRetryPolicy.clear(retryKey);
    return true;
  }

  const responseExecutionKey = `${executionNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`;
  await chatGptTurnSessions.retireAndWait(responseExecutionKey, incoming.abortSignal);
  return false;
}
