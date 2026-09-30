import type { Locator, Page } from "playwright-core";
import { CHATGPT_STOP_BUTTON_SELECTOR, chatGptAssistantTurnSelector } from "../../../chatgpt-session";
import { chatGptBrowserTabClosedError } from "../adapter-error";
import { type ChatGptTurnProgressReader, chatGptExternalProgressIsLive } from "../turn-progress";
import {
  type ChatGptCompletionTracker,
  type ChatGptResponseDomCache,
  type ChatGptResponseDomSnapshot,
  type ChatGptSubmissionEvidence,
  chatGptExternalProgressSuppressesDomHealth,
  chatGptNewTurnIdentity,
  chatGptReboundTurnIdentity,
} from "./dom-trackers";
import { throwIfChatGptRateLimitDialog, throwIfChatGptSessionFailureAlert } from "./overlays";
import type {
  ChatGptSubmissionBaseline,
  ChatGptSubmissionDomCache,
  ChatGptSubmissionDomState,
} from "./submission-observer";
import {
  CHATGPT_RESPONSE_DOM_GRACE_MS,
  ChatGptBrowserObservationTimeoutError,
  isMultiChannelLivenessActive,
  MAX_CHATGPT_BROWSER_PAGE_REBINDS,
  withBrowserTurnAbort,
  withChatGptBrowserObservationTimeout,
} from "./suspension-clock";
import type { ChatGptTurnEventBus } from "./turn-events";

export interface ChatGptSubmissionObservationRecovery {
  page: Page;
  baseline: ChatGptSubmissionBaseline;
}

export type ChatGptObservationRecovery = (
  attempt: number,
  cause: ChatGptBrowserObservationTimeoutError,
  baseline: ChatGptSubmissionBaseline,
  abortSignal?: AbortSignal,
) => Promise<ChatGptSubmissionObservationRecovery>;

export interface ChatGptAssistantTurnBinding {
  identity: string;
  locator: Locator;
  acceptedTurnIdentities: readonly string[];
  /** User turn identities at the time of binding (for detecting new user turns in the new UI) */
  acceptedUserIdentities?: readonly string[];
}

/**
 * Dispatch surface the turn observation diagnostics rely on through their `this`.
 * The worker owns the DOM observation primitives and lends them to the borrowed
 * prototype dispatch, so stubs installed on the worker instance or on
 * `ChatGptBrowserWorker.prototype` keep steering every internal call.
 */
export interface ChatGptTurnDiagnosticsHost {
  submissionDomState(
    page: Page,
    cache?: ChatGptSubmissionDomCache,
    signal?: AbortSignal,
  ): Promise<ChatGptSubmissionDomState>;
  waitForTurnDomOrExternalProgress(
    page: Page,
    afterProgressRevision: number,
    externalProgress?: ChatGptTurnProgressReader,
    signal?: AbortSignal,
  ): Promise<void>;
  waitForTurnDomRevisionOrExternalProgress(
    page: Page,
    afterDomKey: string | undefined,
    afterProgressRevision: number,
    externalProgress?: ChatGptTurnProgressReader,
    signal?: AbortSignal,
  ): Promise<string>;
  responseDomSnapshot(responseTurn: Locator, cache?: ChatGptResponseDomCache): Promise<ChatGptResponseDomSnapshot>;
  waitForSubmissionAccepted(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    signal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    initialToolBatchRevision?: number,
    completionTracker?: ChatGptCompletionTracker,
  ): Promise<ChatGptSubmissionEvidence>;
}

export class TurnDiagnostics {
  async waitForNewAssistantTurn(
    this: ChatGptTurnDiagnosticsHost,
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    deadline: number | undefined,
    signal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    graceMs: number = CHATGPT_RESPONSE_DOM_GRACE_MS,
    completionTracker?: ChatGptCompletionTracker,
    recoverObservation?: ChatGptObservationRecovery,
    turnEvents?: ChatGptTurnEventBus,
  ): Promise<ChatGptAssistantTurnBinding> {
    let observationPage = page;
    let observationBaseline = baseline;
    let recoveryAttempts = 0;
    let domSignalKey: string | undefined;
    let responseDeadline = Math.min(deadline ?? Number.POSITIVE_INFINITY, Date.now() + graceMs);
    for (;;) {
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      if (observationPage.isClosed()) throw chatGptBrowserTabClosedError();
      let progress = externalProgress?.snapshot();
      if (progress?.lastProgressAt !== undefined) {
        responseDeadline = Math.min(
          deadline ?? Number.POSITIVE_INFINITY,
          Math.max(responseDeadline, progress.lastProgressAt + graceMs),
        );
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new Error("ChatGPT web turn timed out");
      }
      await throwIfChatGptSessionFailureAlert(observationPage);
      await throwIfChatGptRateLimitDialog(observationPage);
      let state: ChatGptSubmissionDomState;
      try {
        state = await this.submissionDomState(observationPage, observationBaseline.domCache, signal);
      } catch (error) {
        const latestProgress = externalProgress?.snapshot();
        const isRunning = await observationPage
          .locator(CHATGPT_STOP_BUTTON_SELECTOR)
          .last()
          .isVisible()
          .catch(() => false);
        const multiChannelLivenessActive = isMultiChannelLivenessActive({
          lastBrokerEventAt: latestProgress?.lastProgressAt,
          activeToolCalls: latestProgress?.activeToolCalls,
          inFlightCalls: latestProgress?.claimed,
        });
        if (
          chatGptExternalProgressIsLive(latestProgress, Date.now(), graceMs) ||
          isRunning ||
          multiChannelLivenessActive
        ) {
          const prevKey = domSignalKey;
          domSignalKey = await this.waitForTurnDomRevisionOrExternalProgress(
            observationPage,
            domSignalKey,
            latestProgress?.revision ?? 0,
            externalProgress,
            signal,
          );
          if (domSignalKey !== prevKey) {
            turnEvents?.publish({ type: "response_mutated", source: "dom" });
          }
          continue;
        }
        if (error instanceof ChatGptBrowserObservationTimeoutError && recoverObservation) {
          recoveryAttempts += 1;
          if (recoveryAttempts > MAX_CHATGPT_BROWSER_PAGE_REBINDS) {
            throw new Error(
              `ChatGPT accepted the message, but its DOM remained unresponsive after ${MAX_CHATGPT_BROWSER_PAGE_REBINDS} same-page rebinds`,
              { cause: error },
            );
          }
          const recovered = await recoverObservation(recoveryAttempts, error, observationBaseline, signal);
          turnEvents?.publish({ type: "page_rebound", source: "host" });
          observationPage = recovered.page;
          observationBaseline = recovered.baseline;
          continue;
        }
        if (!chatGptExternalProgressIsLive(latestProgress, Date.now(), graceMs)) throw error;
        const prevKey = domSignalKey;
        domSignalKey = await this.waitForTurnDomRevisionOrExternalProgress(
          observationPage,
          domSignalKey,
          latestProgress?.revision ?? 0,
          externalProgress,
          signal,
        );
        if (domSignalKey !== prevKey) {
          turnEvents?.publish({ type: "response_mutated", source: "dom" });
        }
        continue;
      }
      recoveryAttempts = 0;
      // A tool batch can arrive while the DOM probe is in flight. Read progress again before
      // acknowledging its boundary; the pre-probe snapshot can otherwise leave the broker waiting
      // despite this exact iteration having successfully observed the page.
      progress = externalProgress?.snapshot();
      const identity = chatGptNewTurnIdentity(observationBaseline.initialTurnIdentities, state.responseIdentities);
      if (
        progress &&
        externalProgress &&
        completionTracker?.needsToolBatchObservation(progress.lastToolBatchRevision)
      ) {
        let boundaryText = "";
        try {
          boundaryText = identity
            ? (
                await withChatGptBrowserObservationTimeout(
                  this.responseDomSnapshot(observationPage.locator(chatGptAssistantTurnSelector(identity)), {}),
                  3_000,
                )
              ).visibleText
            : "";
        } catch {
          boundaryText = "";
        }
        completionTracker.observeToolBatch(progress.lastToolBatchRevision, boundaryText);
        await externalProgress.acknowledgeToolBatch(progress.lastToolBatchRevision);
      }
      if (identity) {
        turnEvents?.publish({ type: "turn_inserted_detected", source: "dom" });
        return {
          identity,
          locator: observationPage.locator(chatGptAssistantTurnSelector(identity)),
          acceptedTurnIdentities: state.turnIdentities,
        };
      }
      // The power UI can expose Stop for a long reasoning phase before mounting any assistant
      // node. Fresh generation evidence extends only DOM grace, never the caller's deadline.
      if (state.visibleStopButtonCount > 0) {
        turnEvents?.publish({ type: "stop_button_visibility_changed", source: "dom", visible: true });
        responseDeadline = Math.min(deadline ?? Number.POSITIVE_INFINITY, Date.now() + graceMs);
      }
      // A delayed renderer wake can cross the grace while the assistant appears. Only a fresh
      // observation can prove it is still missing; the explicit turn deadline remains above.
      if (Date.now() >= responseDeadline && !chatGptExternalProgressSuppressesDomHealth(progress, Date.now())) {
        throw new Error("ChatGPT accepted the message but did not expose its assistant turn in the DOM");
      }
      const prevKey = domSignalKey;
      domSignalKey = await this.waitForTurnDomRevisionOrExternalProgress(
        observationPage,
        domSignalKey,
        progress?.revision ?? 0,
        externalProgress,
        signal,
      );
      if (domSignalKey !== prevKey) {
        turnEvents?.publish({ type: "response_mutated", source: "dom" });
      }
    }
  }

  async reconcileAssistantTurnBinding(
    this: ChatGptTurnDiagnosticsHost,
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    binding: ChatGptAssistantTurnBinding,
    signal?: AbortSignal,
  ): Promise<ChatGptAssistantTurnBinding> {
    const boundCount = await withChatGptBrowserObservationTimeout(
      withBrowserTurnAbort(binding.locator.count(), signal),
    );
    if (boundCount === 1) return binding;
    if (boundCount > 1) {
      throw new Error(`ChatGPT exposed ${boundCount} DOM nodes for the bound assistant turn`);
    }
    const state = await this.submissionDomState(page, baseline.domCache, signal);
    const acceptedTurns = new Set(binding.acceptedTurnIdentities);
    const identity = chatGptReboundTurnIdentity(
      baseline.initialTurnIdentities,
      binding.identity,
      state.responseIdentities,
    );
    const newUsers = state.userIdentities.filter((identity) => !acceptedTurns.has(identity));
    if (newUsers.length > 0) {
      // Activity can unmount the accepted user group while it renders a temporary
      // assistant group. Its return must match the ID that acknowledged Send. If no
      // user ID was observed then, require the entire submitted text instead. A
      // surviving old group or any competing new turn remains foreign.
      const user = newUsers[0]!;
      const replacement =
        identity &&
        newUsers.length === 1 &&
        binding.identity.startsWith("group:assistant:") &&
        user.startsWith("group:user:") &&
        identity === `group:assistant:${user.slice("group:user:".length)}` &&
        !state.turnIdentities.includes(binding.identity) &&
        state.turnIdentities.every((turn) => acceptedTurns.has(turn) || turn === user || turn === identity);
      let matches = false;
      if (replacement) {
        const locator = page.locator(chatGptAssistantTurnSelector(identity!));
        matches = baseline.acceptedUserIdentity
          ? user === baseline.acceptedUserIdentity
          : Boolean(baseline.submittedText) &&
            (await withChatGptBrowserObservationTimeout(
              withBrowserTurnAbort(
                locator.evaluate((group, submitted) => {
                  const bubbles = group.querySelectorAll<HTMLElement>("[data-user-message-bubble]");
                  const contents =
                    bubbles.length === 1
                      ? bubbles[0]!.querySelectorAll<HTMLElement>("[data-search-result-target]")
                      : [];
                  const normalize = (text: string) => text.replace(/\r\n?/g, "\n");
                  // The bubble also contains Show more and accessibility spacing. Only its
                  // observed message-content target represents the submitted prompt.
                  return contents.length === 1 && normalize(contents[0]!.innerText) === normalize(submitted);
                }, baseline.submittedText!),
                signal,
              ),
            ));
        if (matches) {
          const response = await this.responseDomSnapshot(locator, {});
          matches = response.responsePresent && response.completionActionVisible;
        }
      }
      if (!matches) throw new Error("ChatGPT opened another user turn while the bound assistant response was detached");
    }
    if (!identity || identity === binding.identity) {
      return {
        ...binding,
        acceptedTurnIdentities: state.turnIdentities,
      };
    }
    return {
      identity,
      locator: page.locator(chatGptAssistantTurnSelector(identity)),
      acceptedTurnIdentities: state.turnIdentities,
    };
  }

  async waitForSubmissionAcceptedWithRecovery(
    this: ChatGptTurnDiagnosticsHost,
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    abortSignal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    initialToolBatchRevision = externalProgress?.snapshot().lastToolBatchRevision ?? 0,
    completionTracker?: ChatGptCompletionTracker,
    recoverObservation?: ChatGptObservationRecovery,
  ): Promise<ChatGptSubmissionEvidence> {
    let observationPage = page;
    let observationBaseline = baseline;
    let recoveryAttempts = 0;
    let domSignalKey: string | undefined;
    for (;;) {
      try {
        const evidence = await this.waitForSubmissionAccepted(
          observationPage,
          observationBaseline,
          abortSignal,
          externalProgress,
          initialToolBatchRevision,
          completionTracker,
        );
        return evidence;
      } catch (error) {
        if (!(error instanceof ChatGptBrowserObservationTimeoutError)) throw error;
        const latestProgress = externalProgress?.snapshot();
        const isRunning =
          typeof observationPage?.locator === "function"
            ? await observationPage
                .locator(CHATGPT_STOP_BUTTON_SELECTOR)
                .last()
                .isVisible()
                .catch(() => false)
            : false;
        const multiChannelLivenessActive = isMultiChannelLivenessActive({
          lastBrokerEventAt: latestProgress?.lastProgressAt,
          activeToolCalls: latestProgress?.activeToolCalls,
          inFlightCalls: latestProgress?.claimed,
        });
        if (
          latestProgress?.claimed ||
          isRunning ||
          multiChannelLivenessActive ||
          chatGptExternalProgressIsLive(latestProgress, Date.now(), CHATGPT_RESPONSE_DOM_GRACE_MS)
        ) {
          if (typeof this.waitForTurnDomRevisionOrExternalProgress === "function") {
            domSignalKey = await this.waitForTurnDomRevisionOrExternalProgress(
              observationPage,
              domSignalKey,
              latestProgress?.revision ?? 0,
              externalProgress,
              abortSignal,
            );
          } else {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          continue;
        }
        if (!recoverObservation) throw error;
        recoveryAttempts += 1;
        if (recoveryAttempts > MAX_CHATGPT_BROWSER_PAGE_REBINDS) {
          throw new Error(
            `ChatGPT submission DOM remained unresponsive after ${MAX_CHATGPT_BROWSER_PAGE_REBINDS} same-page rebinds`,
            { cause: error },
          );
        }
        const recovered = await recoverObservation(recoveryAttempts, error, observationBaseline, abortSignal);
        observationPage = recovered.page;
        observationBaseline = recovered.baseline;
      }
    }
  }
}
