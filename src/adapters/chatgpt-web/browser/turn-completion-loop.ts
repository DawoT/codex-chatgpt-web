import type { Locator, Page } from "playwright-core";
import {
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
  CHATGPT_USER_TURN_SELECTOR,
  chatGptAssistantTurnSelector,
} from "../../../chatgpt-session";
import {
  ChatGptWebAdapterError,
  chatGptBrowserTabClosedError,
  chatGptStoppedThinkingError,
  chatGptStreamInterruptedError,
} from "../adapter-error";
import type { BrowserTurn } from "../browser-worker";
import { ChatGptMarkdownBuffer, ChatGptMarkdownConsistencyError, inspectCompactionResponseSurface } from "../markdown";
import { ChatGptLunaCheckpointStream } from "../rolling-checkpoint";
import type { ChatGptTurnProgressReader } from "../turn-progress";
import type { ResolvedBrowserConfig } from "./config";
import type { ChatGptBrowserContextPressure } from "./context-pressure";
import type { ChatGptBrowserDiagnostics } from "./diagnostics";
import { waitForChatGptDomSettle } from "./dom-signal";
import {
  type ChatGptCompletionTracker,
  ChatGptConnectionInterruptionTracker,
  type ChatGptResponseDomCache,
  type ChatGptResponseDomSnapshot,
  ChatGptTurnDomHealthTracker,
  ChatGptVisibleTraceTracker,
  MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS,
} from "./dom-trackers";
import {
  CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS,
  chatGptConnectionInterruptedVisible,
  resolveChatGptToolConfirmation,
  throwIfChatGptSessionFailureAlert,
  throwIfChatGptTerminalErrorAlert,
} from "./overlays";
import type { ChatGptSubmissionBaseline } from "./submission-observer";
import {
  ChatGptBrowserObservationTimeoutError,
  MAX_CHATGPT_BROWSER_PAGE_REBINDS,
  resolveAdaptiveObservationProbeTimeoutMs,
  withChatGptBrowserObservationTimeout,
} from "./suspension-clock";
import { ChatGptTurnCompletionFsm } from "./turn-completion-fsm";
import type { ChatGptAssistantTurnBinding } from "./turn-diagnostics";
import type { ChatGptTurnEventBus } from "./turn-events";
import { chatGptUiGenerationIsLive, type resolveTurnLivenessSignals } from "./turn-liveness";
import { waitForChatGptTurnWake } from "./turn-wake";

export interface TurnCompletionLoopDeps {
  classifyLiveness: typeof resolveTurnLivenessSignals;
  config: Pick<ResolvedBrowserConfig, "appName" | "autoApproveToolCalls">;
  responseDomSnapshot(locator: Locator, cache?: ChatGptResponseDomCache): Promise<ChatGptResponseDomSnapshot>;
  reconcileAssistantTurnBinding(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    current: ChatGptAssistantTurnBinding,
    signal?: AbortSignal,
  ): Promise<ChatGptAssistantTurnBinding>;
  waitForTurnDomRevisionOrExternalProgress(
    page: Page,
    domKey: string | undefined,
    progressRevision: number,
    progress?: ChatGptTurnProgressReader,
    signal?: AbortSignal,
  ): Promise<string>;
  stalledTurnDiagnostic(page: Page, locator: Locator): Promise<string>;
  rebindLauncherPage(attempt: number, cause: Error, signal?: AbortSignal): Promise<Page>;
}

export interface TurnCompletionInput {
  turn: BrowserTurn;
  page: Page;
  submissionBaseline: ChatGptSubmissionBaseline;
  responseTurn: ChatGptAssistantTurnBinding;
  launcherSurfaceId?: string;
  deadline?: number;
  localTools: boolean;
  completionTracker: ChatGptCompletionTracker;
  contextPressure: ChatGptBrowserContextPressure;
  diagnostics: Pick<ChatGptBrowserDiagnostics, "capture">;
  turnEvents: ChatGptTurnEventBus;
}

/** Observes one submitted turn. Connection ownership and final persistence stay with the worker. */
export class TurnCompletionLoop {
  constructor(private readonly deps: TurnCompletionLoopDeps) {}

  async run(input: TurnCompletionInput): Promise<{ text: string; cache: ChatGptResponseDomCache }> {
    const { turn, launcherSurfaceId, deadline, completionTracker, contextPressure, diagnostics, turnEvents } = input;
    let { page, submissionBaseline, responseTurn } = input;
    let lastHeartbeat = 0;
    let finalText = "";
    let sawRunning = false;
    let loggedCompletionWait = false;
    let capturedResponse = false;
    const sentAt = Date.now();
    const visibleTrace = new ChatGptVisibleTraceTracker();
    const markdownBuffer = new ChatGptMarkdownBuffer(undefined, {
      adaptive: true,
      proseStabilityMs: 350,
      toolStabilityMs: 0,
      compactionCheckpoint: turn.compaction === true,
    });
    const checkpointStream = turn.captureLunaCheckpoint ? new ChatGptLunaCheckpointStream() : undefined;
    const emitMarkdownDelta = (delta: string): void => {
      const visible = checkpointStream ? checkpointStream.push(delta) : delta;
      if (visible) turn.onTextDelta(visible);
    };
    const throwMarkdownConsistencyError = (error: unknown): never => {
      if (!(error instanceof ChatGptMarkdownConsistencyError)) throw error;
      if (error.diagnostic) {
        console.error(
          `[chatgpt-web] browser turn ${turn.traceId} Markdown conflict: ${JSON.stringify(error.diagnostic)}`,
        );
      }
      throw new ChatGptWebAdapterError(error.message, {
        status: 502,
        errorType: "server_error",
        code: "browser_stream_inconsistent",
        retryable: false,
      });
    };
    const domHealthTracker = new ChatGptTurnDomHealthTracker();
    const connectionInterruptionTracker = new ChatGptConnectionInterruptionTracker();
    const responseDomCache: ChatGptResponseDomCache = {};
    let consecutiveObservationRebinds = 0;
    let internalObservationFaults = 0;
    let observedThisIteration = false;
    let fenceRevision: number | undefined;
    const completionFsm = new ChatGptTurnCompletionFsm({ fenced: turn.completionFence !== undefined });
    let domSignalKey: string | undefined;
    let lastRunning: boolean | undefined;
    let lastCompletionActionVisible: boolean | undefined;
    let lastResponseEvidence: string | undefined;
    const readUiGenerationState = async (): Promise<{
      stopVisible: boolean;
      connectionInterrupted: boolean;
      running: boolean;
    }> => {
      const [stopVisible, connectionInterrupted] = await Promise.all([
        page
          .locator(CHATGPT_STOP_BUTTON_SELECTOR)
          .last()
          .isVisible()
          .catch(() => false),
        chatGptConnectionInterruptedVisible(page, responseTurn.identity),
      ]);
      return {
        stopVisible,
        connectionInterrupted,
        running: chatGptUiGenerationIsLive(stopVisible, connectionInterrupted),
      };
    };
    const assertConnectionInterruptionWithinGrace = (
      connectionInterrupted: boolean,
      signals: {
        externalProgressLive: boolean;
        externalToolCallsInFlight: boolean;
        multiChannelLivenessActive: boolean;
      },
      now = Date.now(),
      responseAdvanced = false,
    ): void => {
      const interruptionError = connectionInterruptionTracker.update(
        {
          interrupted: connectionInterrupted,
          corroboratedProgress:
            signals.externalProgressLive ||
            signals.externalToolCallsInFlight ||
            signals.multiChannelLivenessActive ||
            responseAdvanced,
        },
        now,
      );
      if (interruptionError) throw chatGptStreamInterruptedError();
    };
    // The wake between completion iterations: the next DOM mutation or external progress
    // advance, with the horizon bounding how often ceilings are re-checked on a quiet page.
    const waitForTurnSignal = async (): Promise<void> => {
      const previousKey = domSignalKey;
      await waitForChatGptTurnWake(
        turnEvents,
        async (signal) => {
          const progressRev = turn.externalProgress?.snapshot().revision ?? 0;
          domSignalKey = await this.deps.waitForTurnDomRevisionOrExternalProgress(
            page,
            domSignalKey,
            progressRev,
            turn.externalProgress,
            signal,
          );
          const newProgressRev = turn.externalProgress?.snapshot().revision ?? 0;
          if (newProgressRev > progressRev) {
            turnEvents.publish({
              type: "external_progress_advanced",
              source: "external_progress",
              revision: newProgressRev,
            });
          }
          if (domSignalKey !== previousKey) {
            turnEvents.publish({ type: "response_mutated", source: "dom" });
          }
        },
        turn.abortSignal,
      );
    };
    const recoverStalledResponsePage = async (error: ChatGptBrowserObservationTimeoutError): Promise<void> => {
      const currentProgress = turn.externalProgress?.snapshot();
      const {
        externalProgressLive: currentProgressLive,
        externalToolCallsInFlight: currentCallsInFlight,
        multiChannelLivenessActive,
      } = this.deps.classifyLiveness(currentProgress, Date.now());
      const uiState = await readUiGenerationState();
      assertConnectionInterruptionWithinGrace(uiState.connectionInterrupted, {
        externalProgressLive: currentProgressLive,
        externalToolCallsInFlight: currentCallsInFlight,
        multiChannelLivenessActive,
      });
      if (currentProgressLive || currentCallsInFlight || uiState.running || multiChannelLivenessActive) {
        console.warn(
          `[chatgpt-web] browser turn ${turn.traceId} DOM observation probe timed out while generation or external progress is active; deferring without rebind or failure`,
        );
        await waitForTurnSignal();
        return;
      }
      if (!launcherSurfaceId) {
        if (!page.isClosed()) {
          console.warn(
            `[chatgpt-web] browser turn ${turn.traceId} DOM observation probe timed out on non-launcher surface; page still open, retrying with brief backoff`,
          );
          await waitForTurnSignal();
          return;
        }
        throw new ChatGptWebAdapterError(
          "ChatGPT browser DOM observation timed out and this page has no recovery lease",
          {
            status: 504,
            errorType: "server_error",
            code: "chatgpt_browser_dom_unresponsive",
            retryable: false,
            cause: error,
          },
        );
      }
      consecutiveObservationRebinds += 1;
      if (consecutiveObservationRebinds > MAX_CHATGPT_BROWSER_PAGE_REBINDS) {
        throw new ChatGptWebAdapterError(
          `ChatGPT browser DOM remained unresponsive after ${MAX_CHATGPT_BROWSER_PAGE_REBINDS} same-page rebinds`,
          {
            status: 504,
            errorType: "server_error",
            code: "chatgpt_browser_dom_unresponsive",
            retryable: false,
            cause: error,
          },
        );
      }
      try {
        page = await this.deps.rebindLauncherPage(consecutiveObservationRebinds, error, turn.abortSignal);
      } catch (recoveryError) {
        if (turn.abortSignal?.aborted) throw recoveryError;
        throw new ChatGptWebAdapterError("ChatGPT browser page recovery failed after a stalled DOM observation", {
          status: 504,
          errorType: "server_error",
          code: "chatgpt_browser_dom_unresponsive",
          retryable: false,
          cause: recoveryError,
        });
      }
      submissionBaseline = {
        ...submissionBaseline,
        userTurns: page.locator(CHATGPT_USER_TURN_SELECTOR),
        responseTurns: page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR),
        domCache: {},
      };
      responseTurn = {
        ...responseTurn,
        locator: page.locator(chatGptAssistantTurnSelector(responseTurn.identity)),
      };
      responseDomCache.key = undefined;
      responseDomCache.snapshot = undefined;
      await diagnostics.capture(page, "response-page-rebound");
    };
    for (;;) {
      // The heartbeat is a consumer callback, so it stays outside the observation-fault region:
      // a defect in the caller must not be retried as though the page could not be read.
      if (Date.now() - lastHeartbeat >= 10_000) {
        turn.onHeartbeat?.();
        lastHeartbeat = Date.now();
      }
      try {
        observedThisIteration = false;
        if (page.isClosed()) {
          throw chatGptBrowserTabClosedError();
        }
        if (turn.abortSignal?.aborted) {
          const stop = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last();
          if (await stop.isVisible().catch(() => false)) await stop.press("Enter").catch(() => {});
          throw new DOMException("ChatGPT web turn aborted", "AbortError");
        }
        if (deadline !== undefined && Date.now() >= deadline) {
          throw new ChatGptWebAdapterError("ChatGPT web turn timed out", {
            status: 504,
            errorType: "server_error",
            code: "chatgpt_turn_timeout",
            retryable: false,
          });
        }
        await throwIfChatGptSessionFailureAlert(page);
        await throwIfChatGptTerminalErrorAlert(responseTurn.locator);

        if (
          input.localTools &&
          (await resolveChatGptToolConfirmation(
            page,
            this.deps.config.appName,
            this.deps.config.autoApproveToolCalls,
            turn.abortSignal,
            CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS,
            () => diagnostics.capture(page, "tool-confirmation-visible"),
          ))
        ) {
          internalObservationFaults = 0;
          // The dialog just resolved; let its React teardown settle before re-observing.
          await waitForChatGptDomSettle(page, { signal: turn.abortSignal });
          turnEvents.publish({ type: "dom_settled", source: "dom" });
          continue;
        }

        const currentDomChars = contextPressure.snapshot().observedDomChars ?? 0;
        const activeTools = turn.externalProgress?.snapshot().activeToolCalls ?? 0;
        const responseProbeTimeoutMs = resolveAdaptiveObservationProbeTimeoutMs(currentDomChars, activeTools);
        let snapshot: ChatGptResponseDomSnapshot;
        try {
          snapshot = await withChatGptBrowserObservationTimeout(
            this.deps.responseDomSnapshot(responseTurn.locator, responseDomCache),
            responseProbeTimeoutMs,
          );
        } catch (error) {
          if (!(error instanceof ChatGptBrowserObservationTimeoutError)) throw error;
          const currentProgress = turn.externalProgress?.snapshot();
          const {
            externalProgressLive: currentProgressLive,
            externalToolCallsInFlight: currentCallsInFlight,
            multiChannelLivenessActive,
          } = this.deps.classifyLiveness(currentProgress, Date.now());
          const uiState = await readUiGenerationState();
          assertConnectionInterruptionWithinGrace(uiState.connectionInterrupted, {
            externalProgressLive: currentProgressLive,
            externalToolCallsInFlight: currentCallsInFlight,
            multiChannelLivenessActive,
          });
          if (currentProgressLive || currentCallsInFlight || uiState.running || multiChannelLivenessActive) {
            console.warn(
              `[chatgpt-web] browser turn ${turn.traceId} DOM observation probe exceeded ${responseProbeTimeoutMs}ms but generation or external progress is active; suppressing false timeout and deferring observation`,
            );
            await waitForTurnSignal();
            continue;
          }
          await recoverStalledResponsePage(error);
          continue;
        }
        if (!snapshot.responsePresent && (await responseTurn.locator.count()) !== 1) {
          try {
            const rebound = await withChatGptBrowserObservationTimeout(
              this.deps.reconcileAssistantTurnBinding(page, submissionBaseline, responseTurn, turn.abortSignal),
            );
            if (rebound.identity !== responseTurn.identity) {
              responseTurn = rebound;
              responseDomCache.key = undefined;
              responseDomCache.snapshot = undefined;
              snapshot = await withChatGptBrowserObservationTimeout(
                this.deps.responseDomSnapshot(responseTurn.locator, responseDomCache),
                responseProbeTimeoutMs,
              );
            }
          } catch (error) {
            if (!(error instanceof ChatGptBrowserObservationTimeoutError) || !launcherSurfaceId) throw error;
            const currentProgress = turn.externalProgress?.snapshot();
            const {
              externalProgressLive: currentProgressLive,
              externalToolCallsInFlight: currentCallsInFlight,
              multiChannelLivenessActive,
            } = this.deps.classifyLiveness(currentProgress, Date.now());
            const uiState = await readUiGenerationState();
            assertConnectionInterruptionWithinGrace(uiState.connectionInterrupted, {
              externalProgressLive: currentProgressLive,
              externalToolCallsInFlight: currentCallsInFlight,
              multiChannelLivenessActive,
            });
            if (currentCallsInFlight || currentProgressLive || uiState.running || multiChannelLivenessActive) {
              console.warn(
                `[chatgpt-web] browser turn ${turn.traceId} DOM observation probe timed out while generation or tools are active; continuing observation without rebind`,
              );
              await waitForTurnSignal();
              continue;
            }
            await recoverStalledResponsePage(error);
            continue;
          }
        }
        if (snapshot.stoppedThinkingVisible) throw chatGptStoppedThinkingError();
        if (snapshot.responsePresent) consecutiveObservationRebinds = 0;
        // The page was read successfully, so the fault budget is genuinely consecutive even when
        // this iteration goes on to `continue` for a rebind, confirmation, or liveness pause.
        internalObservationFaults = 0;
        observedThisIteration = true;
        // Liveness may postpone a verdict, never waive it: once activity goes stale the DOM alone
        // decides, so a tool call that never returns cannot hold a turn with no explicit deadline open forever.
        const externalProgressSnapshot = turn.externalProgress?.snapshot();
        if (
          turn.externalProgress &&
          externalProgressSnapshot &&
          completionTracker.needsToolBatchObservation(externalProgressSnapshot.lastToolBatchRevision)
        ) {
          completionTracker.observeToolBatch(externalProgressSnapshot.lastToolBatchRevision, snapshot.visibleText);
          await turn.externalProgress.acknowledgeToolBatch(externalProgressSnapshot.lastToolBatchRevision);
          contextPressure.recordToolCallCompleted();
        }
        const { externalProgressLive, externalToolCallsInFlight, multiChannelLivenessActive } =
          this.deps.classifyLiveness(externalProgressSnapshot, Date.now());
        if (!snapshot.responsePresent && (externalProgressLive || multiChannelLivenessActive)) {
          // Current-turn MCP activity proves that ChatGPT is still executing even if its renderer
          // temporarily cannot expose the response subtree. DOM remains authoritative for text and
          // completion; this only prevents a live turn from being misclassified as vanished.
          domHealthTracker.clearMissingResponse();
          await waitForTurnSignal();
          continue;
        }
        const uiState = await readUiGenerationState();
        // Status labels can change with renderer timers even when the response stream is quiet.
        // Only answer/commentary content changes corroborate progress from this DOM projection.
        const responseEvidence = snapshot.responsePresent
          ? JSON.stringify([
              snapshot.visibleText,
              snapshot.traceBlocks
                .filter((block) => block.kind === "commentary" && !block.uiControl)
                .map((block) => block.text),
            ])
          : undefined;
        const responseAdvanced =
          responseEvidence !== undefined &&
          lastResponseEvidence !== undefined &&
          responseEvidence !== lastResponseEvidence;
        if (responseEvidence !== undefined) lastResponseEvidence = responseEvidence;
        assertConnectionInterruptionWithinGrace(
          uiState.connectionInterrupted,
          { externalProgressLive, externalToolCallsInFlight, multiChannelLivenessActive },
          Date.now(),
          responseAdvanced,
        );
        if (uiState.stopVisible !== lastRunning) {
          lastRunning = uiState.stopVisible;
          turnEvents.publish({ type: "stop_button_visibility_changed", source: "dom", visible: uiState.stopVisible });
        }
        if (uiState.stopVisible) sawRunning = true;
        if (snapshot.responsePresent) {
          if (!capturedResponse) {
            capturedResponse = true;
            await diagnostics.capture(page, "response-visible");
          }
          const textDelta = (() => {
            try {
              return markdownBuffer.observe(snapshot.markdownSegments);
            } catch (error) {
              return throwMarkdownConsistencyError(error);
            }
          })();
          for (const trace of visibleTrace.observe(snapshot.traceBlocks, snapshot.completionActionVisible)) {
            if (trace.kind === "commentary") turn.onCommentary?.(trace.text, trace.continuation === true);
            else turn.onReasoningSummary?.(trace.text, trace.continuation === true);
          }
          if (textDelta) emitMarkdownDelta(textDelta);
          const domError = domHealthTracker.update({
            responsePresent: snapshot.responsePresent,
            running: uiState.stopVisible,
            connectionInterrupted: uiState.connectionInterrupted,
            currentText: snapshot.visibleText,
            completionActionVisible: snapshot.completionActionVisible,
            externalProgressLive,
            multiChannelLivenessActive: multiChannelLivenessActive || responseAdvanced,
            domChars: snapshot.fullHtml.length || snapshot.visibleText.length,
          });
          if (domError) {
            throw new ChatGptWebAdapterError(domError, {
              status: 504,
              errorType: "server_error",
              code: "chatgpt_browser_dom_unresponsive",
              retryable: false,
              cause: new Error(domError),
            });
          }
          const completionReady = completionTracker.update({
            responsePresent: snapshot.responsePresent,
            running: uiState.stopVisible || uiState.connectionInterrupted,
            currentText: snapshot.visibleText,
            currentHtml: snapshot.fullHtml,
            completionActionVisible: snapshot.completionActionVisible,
            externalToolCallsInFlight,
          });
          if (snapshot.completionActionVisible !== lastCompletionActionVisible) {
            lastCompletionActionVisible = snapshot.completionActionVisible;
            turnEvents.publish({
              type: "completion_action_changed",
              source: "dom",
              visible: snapshot.completionActionVisible,
            });
          }
          if (!completionReady) fenceRevision = undefined;
          const decision = completionFsm.observe({
            responsePresent: snapshot.responsePresent,
            completionReady,
            externalToolCallsInFlight,
            externalProgressLive,
            yieldRecommended: contextPressure.calculateRisk().yieldRecommended,
          });
          if (decision.changed) {
            turnEvents.publish({ type: "phase_changed", source: "host", from: decision.from, to: decision.phase });
          }
          if (decision.action === "fence_begin") {
            const revision = await turn.completionFence!.begin();
            if (revision === undefined) {
              completionFsm.fenceBeginUnavailable();
              await waitForTurnSignal();
              continue;
            }
            completionFsm.fenceAccepted();
            fenceRevision = revision;
            // The fence revision is captured after this DOM projection. Force one fresh read
            // before commit so an MCP activity that just settled cannot disappear between a
            // stale cached completion and the broker's terminal decision.
            responseDomCache.key = undefined;
            responseDomCache.snapshot = undefined;
            await waitForTurnSignal();
            continue;
          }
          if (decision.action === "fresh_read") {
            // The snapshot this iteration just observed is the fresh read (the cache was
            // invalidated before the previous wake); re-decide on the next iteration.
            continue;
          }
          if (decision.action === "fence_commit") {
            if (!(await turn.completionFence!.commit(fenceRevision!))) {
              completionFsm.fenceCommitted(false);
              fenceRevision = undefined;
              responseDomCache.key = undefined;
              responseDomCache.snapshot = undefined;
              await waitForTurnSignal();
              continue;
            }
            completionFsm.fenceCommitted(true);
            turnEvents.publish({ type: "phase_changed", source: "host", from: "settling", to: "completed" });
          }
          if (completionReady && decision.action !== "wait_for_signal") {
            if (snapshot.visibleText === "api_tool unavailable") {
              throw new Error("ChatGPT selected mode rejected the Codex Native MCP tool (api_tool unavailable)");
            }
            const final = (() => {
              try {
                return markdownBuffer.finish();
              } catch (error) {
                if (error instanceof ChatGptMarkdownConsistencyError) {
                  console.warn(
                    `[chatgpt-web] browser turn ${turn.traceId} recovered from Markdown completion conflict (${error.diagnostic?.reason ?? error.message}); completing turn cleanly`,
                    error.diagnostic,
                  );
                  return markdownBuffer.forceFinish();
                }
                return throwMarkdownConsistencyError(error);
              }
            })();
            if (turn.compaction) {
              console.info(
                `[chatgpt-web] browser turn ${turn.traceId} checkpoint_surface ` +
                  JSON.stringify(inspectCompactionResponseSurface(snapshot, final.markdown)),
              );
            }
            if (!final.markdown && snapshot.visibleText) {
              throw new Error("ChatGPT completed with visible text that could not be serialized as Markdown");
            }
            if (final.delta) emitMarkdownDelta(final.delta);
            if (checkpointStream) {
              const completed = checkpointStream.finishOptional(snapshot.visibleText);
              if (completed.visibleRemainder) turn.onTextDelta(completed.visibleRemainder);
              if (completed.captured) turn.onLunaCheckpoint!(completed.captured);
              else
                console.warn(
                  `[chatgpt-web] browser turn ${turn.traceId} completed without a Luna rolling checkpoint; preserving full native history`,
                );
              finalText = completed.answer;
            } else {
              finalText = final.markdown;
            }
            break;
          }
          if (!completionReady && !loggedCompletionWait && Date.now() - sentAt >= 60_000) {
            loggedCompletionWait = true;
            await diagnostics.capture(page, "response-stalled-60s");
            const diagnostic = await this.deps.stalledTurnDiagnostic(page, responseTurn.locator).catch((error) =>
              JSON.stringify({
                diagnosticError: error instanceof Error ? error.message : String(error),
              }),
            );
            console.warn(
              `[chatgpt-web] waiting for completed-turn evidence (running=${uiState.running}, sawRunning=${sawRunning}, textChars=${snapshot.visibleText.length}, completionActionVisible=${snapshot.completionActionVisible}, ui=${diagnostic})`,
            );
          }
        } else {
          const domError = domHealthTracker.update({
            responsePresent: false,
            running: uiState.stopVisible,
            connectionInterrupted: uiState.connectionInterrupted,
            currentText: "",
            completionActionVisible: false,
            externalProgressLive,
            multiChannelLivenessActive,
          });
          if (domError) {
            throw new ChatGptWebAdapterError(domError, {
              status: 504,
              errorType: "server_error",
              code: "chatgpt_browser_dom_unresponsive",
              retryable: false,
              cause: new Error(domError),
            });
          }
        }
        await waitForTurnSignal();
      } catch (error) {
        // Only a defect in this worker is retried here. Every deliberate signal — adapter errors,
        // aborts, closed tabs, DOM-health verdicts — still fails the turn immediately.
        // Retry only faults raised while reading the page. Once observation succeeded, a
        // TypeError belongs to a consumer - Markdown buffering, text/trace callbacks, checkpoint
        // capture - and retrying it would rerun an iteration whose side effects already happened.
        if (!(error instanceof TypeError) || observedThisIteration) throw error;
        internalObservationFaults += 1;
        if (internalObservationFaults > MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS) {
          throw new Error(
            `ChatGPT browser observation failed ${internalObservationFaults} times in a row: ${error.message}`,
            { cause: error },
          );
        }
        console.warn(
          `[chatgpt-web] browser turn ${turn.traceId} tolerated internal observation fault` +
            ` ${internalObservationFaults}/${MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS}: ${error.message}`,
        );
        await diagnostics.capture(page, "internal-observation-fault");
        responseDomCache.key = undefined;
        responseDomCache.snapshot = undefined;
        turnEvents.publish({ type: "observation_faulted", source: "host", message: error.message });
        await waitForChatGptDomSettle(page);
        turnEvents.publish({ type: "dom_settled", source: "dom" });
      }
    }
    return { text: finalText, cache: responseDomCache };
  }
}
