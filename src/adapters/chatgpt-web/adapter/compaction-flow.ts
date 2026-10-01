import { createHash } from "node:crypto";
import { CHATGPT_WEB_INSTANT_COMPOSER_CHAR_LIMIT, type ChatGptWebBackendModel } from "../../../chatgpt-web-models";
import { COMPACT_PROMPT, compactionDraftText, extractStructuredCompactionHandoff } from "../../../responses/compaction";
import type { AdapterEvent, CodexParsedRequest } from "../../../types";
import { ChatGptWebAdapterError } from "../adapter-error";
import { validateCompactionQuality } from "../autonomous-compaction";
import { ChatGptBrowserObservationTimeoutError } from "../browser/suspension-clock";
import type { ChatGptBrowserWorker } from "../browser-worker";
import { acceptedCompactionEpoch } from "../compaction-continuation";
import {
  boundedCompactionRepairObservations,
  buildCompactionEvidenceIndex,
  selectCompactionRepairEvidence,
} from "../compaction-evidence";
import {
  existingStructuredCompactionRun,
  MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
  ORIGINAL_USER_REQUEST_MARKER,
  requestRetainedCompactionHandoff,
  runStructuredCompactionOnce,
  settleActiveCompactionSource,
  settleActiveZeroRiskCompactionSource,
} from "../compaction-handoff";
import {
  type CompactionRoute,
  checkpointIssueCodes,
  checkpointStructuralDiagnostic,
  logCompactionEvent,
} from "../compaction-observability";
import { type CompactionCheckpointInspection, CompactionCheckpointPolicy } from "../compaction-policy";
import {
  buildCompactionFallbackRepairPrompt,
  checkpointCompiledRepairFits,
  checkpointRepairPromptFits,
  recordRepairDuration,
  shouldRepairCheckpoint,
} from "../compaction-repair";
import { chatGptConversationKey } from "../conversation-key";
import {
  extractChatGptCompactionSourceRevision,
  type extractChatGptTurnEnvironment,
  extractChatGptTurnIdentity,
} from "../environment";
import { type ChatGptWebCapabilities, resolveChatGptWebModelMode } from "../model";
import { structuredCompactionRepairInstruction } from "../native-compaction-control";
import { chatGptWebTurnRetryPolicy } from "../retry-policy";
import type { SessionActorManager } from "../session-actor";
import type { TurnBroker, TurnBrokerOwner } from "../turn-broker";
import {
  type ChatGptTurnRuntime,
  type ChatGptTurnSession,
  chatGptCompactionSourceExecutionKey,
  chatGptThreadOwnershipKey,
  chatGptTurnExecutionKey,
  chatGptTurnSessions,
} from "../turn-execution";
import { estimateChatGptWebUsage } from "../usage";
import { persistTurnCompaction } from "../workspace-persistence";
import { withAbort } from "./cancellation";
import { CompactionBrowserRunner } from "./compaction-browser-runner";
import { CompactionCheckpointTransaction } from "./compaction-checkpoint";
import {
  compactionControlPolicy,
  initialCompactionRoute,
  isHeavyCompactionTurn,
  retainedCompactionStrategy,
} from "./compaction-policy";
import { emitBrowserCompletion } from "./events";

export { HEAVY_TURN_TOOL_CALL_THRESHOLD, isHeavyCompactionTurn } from "./compaction-policy";
export const DEFAULT_COMPACTION_TOTAL_BUDGET_MS = 4 * 60_000;

const observedRepairDurationsMs: number[] = [];
const persistedStructuredRunRoots = new WeakMap<Promise<string>, string>();

function logCheckpointValidation(
  summary: string,
  quality: ReturnType<typeof validateCompactionQuality>,
  repaired: boolean,
  traceId: string,
): void {
  const format = checkpointStructuralDiagnostic(compactionDraftText(summary));
  const missingState = !format.usableUnfencedBlock;
  console.info(
    `[chatgpt-web] checkpoint_validation ${JSON.stringify({
      valid: quality.valid,
      missingCount: quality.missingInvariants.length,
      missingState,
      repaired,
      traceId,
      issueCodes: checkpointIssueCodes(quality.missingInvariants),
      ...format,
    })}`,
  );
}

function checkpointText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      part &&
      typeof part === "object" &&
      !Array.isArray(part) &&
      (part.type === "text" || part.type === "input_text") &&
      typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
}

function compactionSessionId(parsed: CodexParsedRequest): string {
  return extractChatGptTurnIdentity(parsed).threadId ?? "";
}

function repairObservations(parsed: CodexParsedRequest, query: string, limit = 6) {
  const selected = selectCompactionRepairEvidence(
    buildCompactionEvidenceIndex(parsed.context.messages, compactionSessionId(parsed)),
    query,
    limit,
  );
  return boundedCompactionRepairObservations(selected);
}

/** Legacy internal entry points now preserve evidence; transport preflight owns rejection. */
export const FALLBACK_COMPACTION_TRUNCATION_LIMIT = CHATGPT_WEB_INSTANT_COMPOSER_CHAR_LIMIT - 500;

export function truncateOversizedMessagesForFallbackCompaction(
  messages: CodexParsedRequest["context"]["messages"],
): CodexParsedRequest["context"]["messages"] {
  return messages;
}

export function truncateOversizedContextForFallbackCompaction(parsed: CodexParsedRequest): CodexParsedRequest {
  return parsed;
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
  sessionActorManager?: SessionActorManager;
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
    sessionActorManager,
  } = ctx;

  const controlPolicy = compactionControlPolicy({
    modelId: parsed.modelId,
    localToolsEnabled: configuredCapabilities.localToolsEnabled,
    manualRequest,
    retainedLauncherDescriptor,
    hasStructuredBroker: structuredBroker !== undefined,
  });

  if (controlPolicy === "unavailable") {
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

  if (controlPolicy === "structured") {
    const compactionNativeIdentity = extractChatGptTurnIdentity(parsed);
    const compactionExecutionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
    const compactedSourceExecutionKey = `${executionNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`;
    const handoffTraceId = createHash("sha256").update(`${compactionExecutionKey}:handoff`).digest("hex").slice(0, 12);
    const compactionTraceId = createHash("sha256").update(compactionExecutionKey).digest("hex").slice(0, 12);
    const actorSessionId = `${executionNamespace}:${chatGptThreadOwnershipKey(parsed)}`;
    const actorTurnId = compactionNativeIdentity.turnId;
    const checkpointOperationId = `checkpoint:${compactionTraceId}`;
    const checkpoint = new CompactionCheckpointTransaction(
      sessionActorManager,
      actorSessionId,
      actorTurnId,
      checkpointOperationId,
    );
    const startedAt = Date.now();
    let route: CompactionRoute = "unknown";
    const record = (
      phase: Parameters<typeof logCompactionEvent>[0]["phase"],
      outcome: Parameters<typeof logCompactionEvent>[0]["outcome"],
      details: Partial<Omit<Parameters<typeof logCompactionEvent>[0], "traceId" | "phase" | "outcome" | "route">> = {},
    ): void =>
      logCompactionEvent({
        traceId: compactionTraceId,
        handoffTraceId,
        phase,
        outcome,
        route,
        elapsedMs: Date.now() - startedAt,
        ...details,
      });
    const recordValidation = (
      summary: string,
      quality: ReturnType<typeof validateCompactionQuality>,
      repaired: boolean,
    ): void => {
      logCheckpointValidation(summary, quality, repaired, compactionTraceId);
      record("validated", quality.valid ? "succeeded" : "rejected", {
        attempt: repaired ? 2 : 1,
        issueCodes: checkpointIssueCodes(quality.missingInvariants),
        ...(quality.valid
          ? { requirementCount: extractStructuredCompactionHandoff(summary).state?.requirements?.length ?? 0 }
          : {}),
      });
    };
    const freshCompactionTraceId = `${handoffTraceId}_${freshConversationPerTurn ? "fresh" : "fallback"}`;
    const revisionScopeKey = JSON.stringify([
      compactionNativeIdentity.threadId,
      compactionNativeIdentity.turnId,
      acceptedCompactionEpoch(parsed, compactionNativeIdentity) ?? "initial",
    ]);
    const runningSummary = existingStructuredCompactionRun(compactionExecutionKey);
    const recoveredCheckpoint = checkpoint.recovery();
    if (!runningSummary && recoveredCheckpoint && recoveredCheckpoint.state !== "accepted") {
      emit({
        type: "error",
        message:
          recoveredCheckpoint.state === "rejected"
            ? "Context checkpoint was rejected; retry compaction with a new native turn"
            : "Context checkpoint needs reconciliation before another browser submission",
        status: 409,
        errorType: "invalid_request_error",
        code:
          recoveredCheckpoint.state === "rejected"
            ? "context_checkpoint_validation_failed"
            : "compaction_reconciliation_required",
        retryable: false,
      });
      return true;
    }
    await checkpoint.transition("compaction_prepared");
    let sharedSummary =
      runningSummary ??
      (recoveredCheckpoint?.state === "accepted" ? Promise.resolve(recoveredCheckpoint.summary) : undefined);
    if (!sharedSummary) {
      record("prepared", "pending");
      sharedSummary = runStructuredCompactionOnce(
        compactionExecutionKey,
        {
          ownerKey: `${executionNamespace}:${chatGptThreadOwnershipKey(parsed)}`,
          revisionScopeKey,
          traceIds: [compactionTraceId, handoffTraceId, freshCompactionTraceId, `${freshCompactionTraceId}_repair`],
          ...(compactionNativeIdentity.threadId ? { nativeThreadId: compactionNativeIdentity.threadId } : {}),
          ...(compactionNativeIdentity.turnId ? { nativeTurnId: compactionNativeIdentity.turnId } : {}),
        },
        async (operatorSignal, retainOwnershipUntil) => {
          const handoffTimeoutMs = Math.min(
            timeoutMs ?? DEFAULT_COMPACTION_TOTAL_BUDGET_MS,
            MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
          );
          const globalDeadlineAt = Date.now() + handoffTimeoutMs;
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
          const armHandoffDeadline = (extendMs?: number): void => {
            if (handoffDeadline.signal.aborted) return;
            if (handoffTimer) clearTimeout(handoffTimer);
            const now = Date.now();
            let remainingMs = Math.max(0, globalDeadlineAt - now);
            if (extendMs && remainingMs > 0) {
              remainingMs = Math.min(remainingMs + extendMs, MAX_COMPACTION_HANDOFF_TIMEOUT_MS);
            }
            if (remainingMs <= 0) {
              handoffDeadline.abort(handoffTimeoutError);
              return;
            }
            handoffDeadlineAt = now + remainingMs;
            handoffTimer = setTimeout(() => handoffDeadline.abort(handoffTimeoutError), remainingMs);
            handoffTimer.unref?.();
          };
          armHandoffDeadline();
          const operationSignal = AbortSignal.any([operatorSignal, handoffDeadline.signal]);
          const browserRunner = new CompactionBrowserRunner(retainOwnershipUntil, operationSignal);
          const sourceConversationKey = chatGptConversationKey(parsed, executionNamespace);
          const checkpointPolicy = new CompactionCheckpointPolicy(parsed, compactionSessionId(parsed));
          const runFreshCompaction = async (reason: string): Promise<string> => {
            route = freshConversationPerTurn ? "fresh" : "fallback";
            record("prepared", "pending", { reasonCode: reason });
            // Fresh compaction is bounded by the global compaction budget
            armHandoffDeadline();
            // Preserve every record. The compiler stages losslessly or fails before acceptance.
            const fallbackParsed = parsed;
            const fallbackRuntime = startRuntime(
              fallbackParsed,
              manualRequest ? environment : undefined,
              freshCompactionTraceId,
              turnCapabilities,
              {
                onCompactionProgress: () => armHandoffDeadline(30_000),
                onHeartbeat: () => emit({ type: "heartbeat" }),
              },
            );
            return browserRunner.run(fallbackRuntime, async (rawSummary) => {
              record("received", "succeeded", { attempt: 1 });
              // Keep empty output in the validation/repair path; a fabricated draft
              // can never satisfy the structured checkpoint validator.
              let { summary, quality } = checkpointPolicy.inspect(rawSummary);
              recordValidation(summary, quality, false);
              if (!quality.valid && !manualRequest && checkpointPolicy.canRepair) {
                const previousCheckpoint = parsed.context.messages.findLast(
                  (message) => message.role === "user" && message.origin === "compaction_summary",
                );
                const priorState = previousCheckpoint
                  ? extractStructuredCompactionHandoff(checkpointText(previousCheckpoint.content)).state
                  : null;
                const originalRequest = originalRequestFromCanonicalSummary(summary);
                const latestRequest = checkpointText(extractChatGptCompactionSourceRevision(parsed).content);
                const checkpointIndex = previousCheckpoint
                  ? parsed.context.messages.lastIndexOf(previousCheckpoint)
                  : -1;
                const otherUserRequests = [
                  ...new Set(
                    parsed.context.messages
                      .slice(checkpointIndex + 1)
                      .filter((message) => message.role === "user" && message.origin !== "codex_skill")
                      .map((message) => checkpointText(message.content))
                      .filter(
                        (value) =>
                          value && value !== COMPACT_PROMPT && value !== originalRequest && value !== latestRequest,
                      ),
                  ),
                ];
                const repairPrompt = buildCompactionFallbackRepairPrompt({
                  issues: quality.missingInvariants,
                  originalRequest,
                  latestRequest,
                  otherUserRequests,
                  priorState,
                  observations: repairObservations(
                    parsed,
                    `${quality.missingInvariants.join(" ")} ${rawSummary.slice(0, 15_000)}`,
                  ),
                  rejectedDraft: rawSummary,
                });
                const repairParsed: CodexParsedRequest = {
                  ...parsed,
                  context: {
                    messages: [{ role: "user", content: repairPrompt ?? "", timestamp: Date.now() }],
                  },
                };
                if (
                  shouldRepairCheckpoint({
                    remainingMs: handoffDeadlineAt - Date.now(),
                    transportFits:
                      repairPrompt !== undefined &&
                      checkpointCompiledRepairFits(repairParsed, turnCapabilities, {
                        experimentalBiggerContext,
                        experimentalSkillAttachments,
                      }),
                    observedDurationsMs: observedRepairDurationsMs,
                  })
                ) {
                  record("repair_started", "pending", { attempt: 2 });
                  const repairStarted = Date.now();
                  const repairRuntime = startRuntime(
                    repairParsed,
                    undefined,
                    `${freshCompactionTraceId}_repair`,
                    turnCapabilities,
                    { onHeartbeat: () => emit({ type: "heartbeat" }) },
                  );
                  let repairOutcome: "succeeded" | "failed" = "failed";
                  try {
                    const inspection = await checkpointPolicy.repair(rawSummary, () =>
                      browserRunner.run(repairRuntime, (repaired) => {
                        record("received", "succeeded", { attempt: 2 });
                        return repaired;
                      }),
                    );
                    repairOutcome = "succeeded";
                    summary = inspection.summary;
                    quality = inspection.quality;
                    recordValidation(summary, quality, true);
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
            });
          };
          let source: ChatGptTurnSession | undefined;
          let preserveFinalResponse = false;
          let repairAttempted = false;
          try {
            const initialRoute = initialCompactionRoute({
              freshConversationPerTurn,
              heavyTurn: isHeavyCompactionTurn(parsed.context.messages),
            });
            if (initialRoute === "configured_fresh_conversation") {
              // Full native history is the compaction input. Release an unfinished
              // browser/tool owner before rebuilding it, but keep a committed final
              // replayable if it won the native compaction race.
              const previous = chatGptTurnSessions.find(compactedSourceExecutionKey);
              const settlement =
                previous?.settledOutcome()?.type === "final"
                  ? previous.physicalSettlement
                  : chatGptTurnSessions.retireAndWait(compactedSourceExecutionKey).then(() => {});
              retainOwnershipUntil(settlement);
              await withAbort(settlement, operationSignal);
              return await runFreshCompaction("configured_fresh_conversation");
            }
            if (initialRoute === "heavy_turn_fast_path") {
              console.info(
                "[chatgpt-web] compaction_heavy_turn_fast_path: Bypassing bloated retained session directly to clean fresh compaction",
              );
              const previous = chatGptTurnSessions.find(compactedSourceExecutionKey);
              const settlement =
                previous?.settledOutcome()?.type === "final"
                  ? previous.physicalSettlement
                  : chatGptTurnSessions.retireAndWait(compactedSourceExecutionKey).then(() => {});
              retainOwnershipUntil(settlement);
              await withAbort(settlement, operationSignal);
              return await runFreshCompaction("heavy_turn_fast_path");
            }
            // The previous compaction may already have detached the retained head while
            // its browser/helper is still unwinding. Do not inspect that old epoch or
            // decide to open a fresh fallback until physical release has completed.
            if (sourceConversationKey) {
              await chatGptTurnSessions.waitForConversationRetirement(sourceConversationKey, operationSignal);
            }
            source = sourceConversationKey
              ? chatGptTurnSessions.findConversationHead(sourceConversationKey)
              : undefined;
            if (!source) {
              source = chatGptTurnSessions.find(compactedSourceExecutionKey);
            }
            preserveFinalResponse = !source?.isActive() && source?.settledOutcome()?.type === "final";
            const retainedKey = source?.conversationKey();
            if (!source || !retainedKey) {
              const pendingSource = chatGptTurnSessions.find(compactedSourceExecutionKey);
              if (pendingSource?.isActive()) {
                const settlement = chatGptTurnSessions.retireAndWait(compactedSourceExecutionKey).then(() => {});
                retainOwnershipUntil(settlement);
                await withAbort(settlement, operationSignal);
              }
              return await runFreshCompaction("source_unavailable_before_handoff");
            }
            let rawSummary: string;
            const strategy = retainedCompactionStrategy({
              manualRequest,
              sourceActive: source.isActive(),
              sourceMode: source.runtime.mode,
            });
            if (strategy === "zero-risk-tools") {
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
            } else if (strategy === "zero-risk-completed") {
              if (source.isActive()) {
                const outcome = await withAbort(source.browserOutcome, operationSignal);
                if (outcome.type === "error") throw outcome.error;
                await withAbort(source.physicalSettlement, operationSignal);
                preserveFinalResponse = true;
              }
              rawSummary = await runFreshCompaction("zero_risk_source_already_completed");
            } else if (strategy === "retained-tools") {
              route = "retained";
              const settlement = await settleActiveCompactionSource(parsed, source, structuredBroker!, operationSignal);
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
              route = "retained";
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
            if (route === "retained") record("received", "succeeded", { attempt: 1 });
            let { summary, quality } = checkpointPolicy.inspect(rawSummary);
            recordValidation(summary, quality, false);
            if (!quality.valid && !manualRequest && structuredBroker && checkpointPolicy.canRepair) {
              const probeObservations = repairObservations(
                parsed,
                `${quality.missingInvariants.join(" ")} ${summary}`,
                6,
              );
              let probe = structuredCompactionRepairInstruction(
                {
                  token: `control_${"0".repeat(32)}`,
                  handoffId: `handoff_${"0".repeat(32)}`,
                },
                quality.missingInvariants,
                probeObservations,
              );
              const effort = resolveChatGptWebModelMode(
                parsed.modelId,
                parsed.options.reasoning,
                configuredCapabilities,
              ).effort;
              while (
                !checkpointRepairPromptFits(
                  probe,
                  parsed.modelId as ChatGptWebBackendModel,
                  effort,
                  configuredCapabilities,
                ) &&
                probeObservations.length > 0
              ) {
                probeObservations.pop();
                probe = structuredCompactionRepairInstruction(
                  {
                    token: `control_${"0".repeat(32)}`,
                    handoffId: `handoff_${"0".repeat(32)}`,
                  },
                  quality.missingInvariants,
                  probeObservations,
                );
              }
              const transportFits = checkpointRepairPromptFits(
                probe,
                parsed.modelId as ChatGptWebBackendModel,
                effort,
                configuredCapabilities,
              );
              if (
                shouldRepairCheckpoint({
                  remainingMs: handoffDeadlineAt - Date.now(),
                  transportFits,
                  observedDurationsMs: observedRepairDurationsMs,
                })
              ) {
                repairAttempted = true;
                record("repair_started", "pending", { attempt: 2 });
                const repairStarted = Date.now();
                let repaired: CompactionCheckpointInspection;
                let repairOutcome: "succeeded" | "failed" = "failed";
                try {
                  repaired = await checkpointPolicy.repair(rawSummary, () =>
                    requestRetainedCompactionHandoff(
                      worker,
                      parsed,
                      source!,
                      structuredBroker,
                      configuredCapabilities,
                      `${handoffTraceId}_repair`,
                      operationSignal,
                      handoffDeadlineAt - Date.now(),
                      quality.missingInvariants,
                      summary,
                    ),
                  );
                  record("received", "succeeded", { attempt: 2 });
                  repairOutcome = "succeeded";
                } finally {
                  recordRepairDuration(
                    observedRepairDurationsMs,
                    repairStarted,
                    Date.now(),
                    operatorSignal.aborted ? "operator_cancelled" : repairOutcome,
                  );
                }
                summary = repaired.summary;
                quality = repaired.quality;
                recordValidation(summary, quality, true);
              }
            }
            if (!quality.valid) {
              throw new ChatGptWebAdapterError(
                "Context checkpoint failed validation; original history remains available",
                {
                  status: 409,
                  errorType: "invalid_response_error",
                  code: "context_checkpoint_validation_failed",
                  retryable: false,
                },
              );
            }
            if (operationSignal.aborted) throw operationSignal.reason;
            await checkpoint.receiveAndValidate(summary);
            try {
              const persisted = await checkpoint.persist(
                () => persistTurnCompaction(environment, parsed.context.messages, summary),
                undefined,
                operationSignal,
              );
              record("persisted", persisted ? "succeeded" : "skipped", { localPersisted: persisted });
              if (persisted && environment?.cwd && sharedSummary) {
                persistedStructuredRunRoots.set(sharedSummary, environment.cwd);
              }
            } catch {
              if (operationSignal.aborted) throw operationSignal.reason;
              throw new ChatGptWebAdapterError(
                "Context checkpoint could not be persisted; original history remains available",
                {
                  status: 500,
                  errorType: "server_error",
                  code: "context_checkpoint_persistence_failed",
                  retryable: false,
                },
              );
            }
            if (operationSignal.aborted) throw operationSignal.reason;
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
            if (
              repairAttempted ||
              (error instanceof ChatGptWebAdapterError &&
                (error.code === "context_checkpoint_validation_failed" ||
                  error.code === "context_checkpoint_persistence_failed"))
            )
              throw error;
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
            if (!operationSignal.aborted && !operatorSignal.aborted) {
              const code =
                handoffError instanceof ChatGptWebAdapterError
                  ? handoffError.code
                  : handoffError instanceof AggregateError && handoffError.errors[0] instanceof ChatGptWebAdapterError
                    ? (handoffError.errors[0] as ChatGptWebAdapterError).code
                    : "retained_handoff_failed";
              const reason =
                code === "compaction_source_unavailable"
                  ? "source_disappeared_before_handoff"
                  : `retained_handoff_failed_${code}`;
              return await runFreshCompaction(reason);
            }
            throw handoffError;
          } finally {
            if (handoffTimer) clearTimeout(handoffTimer);
          }
        },
      );
    }
    emit({ type: "heartbeat" });
    const compactionHeartbeatTimer = setInterval(() => {
      emit({ type: "heartbeat" });
    }, 5_000);
    compactionHeartbeatTimer.unref?.();
    let summary: string;
    try {
      summary = await withAbort(sharedSummary, incoming.abortSignal);
    } catch (error) {
      if (incoming.abortSignal?.aborted && error instanceof DOMException && error.name === "AbortError") {
        // The observer detached; the shared exact compaction round continues and remains
        // available to a canonical reconnect without a second browser submission.
        throw error;
      }
      const handoffError = error instanceof Error ? error : new Error(String(error));
      const upstreamError = handoffError instanceof ChatGptWebAdapterError ? handoffError : undefined;
      await checkpoint.rejectIfOpen();
      const isObservationTimeout =
        handoffError instanceof ChatGptBrowserObservationTimeoutError ||
        (handoffError as { code?: string }).code === "browser_dom_observation_timeout";
      const errorCode =
        upstreamError?.code ?? (isObservationTimeout ? "browser_dom_observation_timeout" : "compaction_handoff_failed");
      record("failed", "failed", {
        reasonCode: errorCode,
      });
      const message =
        upstreamError?.message ||
        (isObservationTimeout ? handoffError.message : undefined) ||
        "ChatGPT did not complete the context handoff. Retry the task.";
      if (message !== handoffError.message) {
        // The client-facing event masks arbitrary error text (it can carry workspace secrets);
        // the operator still needs the raw cause in the server log.
        console.error(`[chatgpt-web] compaction handoff failed (${errorCode}): ${handoffError.message}`);
      }
      emit({
        type: "error",
        message,
        status: upstreamError?.status ?? (isObservationTimeout ? 504 : 409),
        errorType: upstreamError?.errorType ?? (isObservationTimeout ? "server_error" : "invalid_request_error"),
        code: errorCode,
        // Compaction retry remains an explicit operator decision even when its source
        // failure was retryable; preserve the cause without opening a new retry loop.
        retryable: false,
      });
      return true;
    } finally {
      clearInterval(compactionHeartbeatTimer);
    }
    const rejectCheckpoint = async (reason: string): Promise<boolean> => {
      await checkpoint.rejectIfOpen();
      record("failed", "rejected", { reasonCode: "context_checkpoint_validation_failed" });
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
      quality = validateCompactionQuality(parsed.context.messages, summary, {
        requireStructured: true,
        evidenceSessionId: compactionSessionId(parsed),
      });
    } catch {
      return await rejectCheckpoint("validator could not inspect the source history");
    }
    recordValidation(summary, quality, false);
    if (!quality.valid) {
      await checkpoint.transition("compaction_received", summary);
      return await rejectCheckpoint(quality.missingInvariants.join("; "));
    }
    await checkpoint.receiveAndValidate(summary);
    let localPersisted: boolean;
    try {
      localPersisted = await checkpoint.persist(
        () =>
          persistedStructuredRunRoots.has(sharedSummary) &&
          persistedStructuredRunRoots.get(sharedSummary) === environment?.cwd
            ? true
            : persistTurnCompaction(environment, parsed.context.messages, summary),
        (persisted) => record("persisted", persisted ? "succeeded" : "skipped", { localPersisted: persisted }),
        incoming.abortSignal,
      );
    } catch {
      if (incoming.abortSignal?.aborted) return true;
      record("failed", "failed", { reasonCode: "context_checkpoint_persistence_failed" });
      emit({
        type: "error",
        message: "Context checkpoint could not be persisted; original history remains available",
        status: 500,
        errorType: "server_error",
        code: "context_checkpoint_persistence_failed",
        retryable: false,
      });
      return true;
    }
    if (incoming.abortSignal?.aborted) return true;
    await checkpoint.transition("compaction_accepted");
    record("accepted", "succeeded", { localPersisted });
    const checkpointState = extractStructuredCompactionHandoff(summary).state!;
    for (const achievement of checkpointState.verifiedAchievements ?? []) {
      if (typeof achievement !== "string") {
        emit({
          type: "milestone",
          kind: "verified_achievement",
          result: achievement.result,
          evidence: achievement.evidence,
          nextStep: checkpointState.nextActions[0]!,
        });
        continue;
      }
      const evidenceMarker = /\bevidence\s*:\s*/i.exec(achievement);
      if (!evidenceMarker) continue;
      const result = achievement
        .slice(0, evidenceMarker.index)
        .replace(/[\s—–:-]+$/, "")
        .trim();
      const evidence = achievement.slice(evidenceMarker.index + evidenceMarker[0].length).trim();
      emit({
        type: "milestone",
        kind: "verified_achievement",
        result,
        evidence,
        nextStep: checkpointState.nextActions[0]!,
      });
    }
    emit({
      type: "milestone",
      kind: "checkpoint_completed",
      result: "Checkpoint validated",
      evidence: "structured_state_and_source_invariants",
      nextStep: checkpointState.nextActions[0]!,
    });
    emit({ type: "text_delta", text: summary, phase: "final_answer" });
    emitBrowserCompletion(
      { type: "final", answer: summary },
      estimateChatGptWebUsage(
        parsed,
        { answer: summary, reasoning: [] },
        turnCapabilities,
        experimentalBiggerContext,
        experimentalSkillAttachments,
      ),
      emit,
    );
    record("delivered", "succeeded", { localPersisted });
    chatGptWebTurnRetryPolicy.clear(retryKey);
    return true;
  }

  const responseExecutionKey = `${executionNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`;
  await chatGptTurnSessions.retireAndWait(responseExecutionKey, incoming.abortSignal);
  return false;
}
