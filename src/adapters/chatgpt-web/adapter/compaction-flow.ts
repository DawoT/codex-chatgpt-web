import { createHash } from "node:crypto";
import type { AdapterEvent, CodexParsedRequest } from "../../../types";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError } from "../adapter-error";
import type { ChatGptBrowserWorker } from "../browser-worker";
import {
  validateCompactionQuality,
} from "../autonomous-compaction";
import {
  canonicalizeCompactionHandoff,
  existingStructuredCompactionRun,
  MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
  requestRetainedCompactionHandoff,
  runStructuredCompactionOnce,
  settleActiveCompactionSource,
  settleActiveZeroRiskCompactionSource,
} from "../compaction-handoff";
import { chatGptConversationKey } from "../conversation-key";
import { extractChatGptTurnEnvironment, extractChatGptTurnIdentity } from "../environment";
import { CHATGPT_WEB_LUNA_MODEL_ID, type ChatGptWebCapabilities } from "../model";
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
          const armHandoffDeadline = (): void => {
            if (handoffDeadline.signal.aborted) return;
            if (handoffTimer) clearTimeout(handoffTimer);
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
              return canonicalizeCompactionHandoff(parsed, rawSummary);
            } catch (error) {
              fallbackRuntime.cancel(error instanceof Error ? error : new Error(String(error)));
              // The shared owner retains physical settlement independently of this error.
              // Neither a timeout nor operator cancellation can open a competing trace.
              throw error;
            }
          };
          let source: ChatGptTurnSession | undefined;
          let preserveFinalResponse = false;
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
            const summary = canonicalizeCompactionHandoff(parsed, rawSummary);
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
    try {
      const quality = validateCompactionQuality(parsed.context.messages, summary);
      if (!quality.valid) {
        console.warn(`[chatgpt-web] Compaction quality warning: ${quality.missingInvariants.join("; ")}`);
      }
      persistTurnCompaction(environment, parsed.context.messages, summary);
    } catch (checkpointError) {
      console.warn("[chatgpt-web] Failed to record turn checkpoint:", checkpointError);
    }
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
