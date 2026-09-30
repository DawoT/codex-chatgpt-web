import type { Locator, Page } from "playwright-core";
import {
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
  CHATGPT_USER_TURN_SELECTOR,
  chatGptAssistantTurnSelector,
} from "../../../chatgpt-session";
import { type ChatGptTurnProgressReader, chatGptExternalProgressIsLive } from "../turn-progress";
import { waitForChatGptDomRevision, waitForChatGptDomSettle } from "./dom-signal";
import {
  CHATGPT_DOM_REVISION_ATTRIBUTES,
  type ChatGptCompletionTracker,
  type ChatGptResponseDomCache,
  type ChatGptResponseDomSnapshot,
  type ChatGptSubmissionEvidence,
  chatGptNewTurnIdentity,
  chatGptSubmissionEvidence,
} from "./dom-trackers";
import { throwIfChatGptRateLimitDialog, throwIfChatGptSessionFailureAlert } from "./overlays";
import {
  CHATGPT_RESPONSE_DOM_GRACE_MS,
  ChatGptBrowserObservationTimeoutError,
  isMultiChannelLivenessActive,
  throwIfPromptAttachmentAborted,
  withBrowserTurnAbort,
  withChatGptBrowserObservationTimeout,
} from "./suspension-clock";

export { CHATGPT_DOM_REVISION_ATTRIBUTES } from "./dom-trackers";

export interface ChatGptSubmissionBaseline {
  userTurns: Locator;
  responseTurns: Locator;
  initialTurnIdentities: readonly string[];
  domCache: ChatGptSubmissionDomCache;
  submittedText?: string;
  acceptedUserIdentity?: string;
}

export interface ChatGptSubmissionDomState {
  userTurnCount: number;
  assistantTurnCount: number;
  visibleStopButtonCount: number;
  turnIdentities: string[];
  userIdentities: string[];
  responseIdentities: string[];
}

export interface ChatGptSubmissionDomCache {
  key?: string;
  snapshot?: ChatGptSubmissionDomState;
  fullScans?: number;
  cacheHits?: number;
}

/**
 * Dispatch surface the submission observation methods rely on through their `this`.
 * The bodies keep the original open recursion (`this.submissionDomState(...)`, ...),
 * so hosts that stub or override one member keep steering every internal call.
 */
export interface ChatGptSubmissionObserverHost {
  waitForTurnDomMutation(page: Page, timeoutMs?: number): Promise<void>;
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
  waitForSubmissionAccepted(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    signal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    initialToolBatchRevision?: number,
    completionTracker?: ChatGptCompletionTracker,
  ): Promise<ChatGptSubmissionEvidence>;
  submissionDomState(
    page: Page,
    cache?: ChatGptSubmissionDomCache,
    signal?: AbortSignal,
  ): Promise<ChatGptSubmissionDomState>;
  currentSubmissionEvidence(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    signal?: AbortSignal,
  ): Promise<ChatGptSubmissionEvidence | undefined>;
  currentSubmissionAnswerText(page: Page, baseline: ChatGptSubmissionBaseline, signal?: AbortSignal): Promise<string>;
  captureSubmissionBaseline(page: Page, submittedText?: string): Promise<ChatGptSubmissionBaseline>;
  responseDomSnapshot(locator: Locator, cache?: ChatGptResponseDomCache): Promise<ChatGptResponseDomSnapshot>;
}

export class SubmissionObserver {
  async waitForTurnDomMutation(this: ChatGptSubmissionObserverHost, page: Page, timeoutMs = 250): Promise<void> {
    // Generalized settle barrier over the shared in-page revision signal: resolve once the DOM
    // mutated and stayed quiet for the settle window, or return after the horizon. The signal's
    // singleton observer replaces the throwaway per-call observer this barrier used to install.
    await waitForChatGptDomSettle(page, { settleMs: 150, horizonMs: timeoutMs });
  }

  async waitForTurnDomOrExternalProgress(
    this: ChatGptSubmissionObserverHost,
    page: Page,
    afterProgressRevision: number,
    externalProgress?: ChatGptTurnProgressReader,
    signal?: AbortSignal,
  ): Promise<void> {
    const domMutation = this.waitForTurnDomMutation(page);
    if (!externalProgress) {
      await withBrowserTurnAbort(domMutation, signal);
      return;
    }
    const progressWaitAbort = new AbortController();
    const progressSignal = signal ? AbortSignal.any([progressWaitAbort.signal, signal]) : progressWaitAbort.signal;
    try {
      await withBrowserTurnAbort(
        Promise.race([
          domMutation,
          externalProgress.waitForChange(afterProgressRevision, progressSignal).then(() => undefined),
        ]),
        signal,
      );
    } finally {
      progressWaitAbort.abort();
    }
  }

  /**
   * Event-driven successor of `waitForTurnDomOrExternalProgress`: instead of a fixed 250 ms
   * mutation barrier, the DOM half is the in-page revision long-poll, which resolves the moment
   * the conversation mutates. Returns the latest DOM signal key so the caller can re-arm the next
   * wait; when external progress wins the race the key is unchanged and the pending signal
   * settles itself within its horizon.
   */
  async waitForTurnDomRevisionOrExternalProgress(
    this: ChatGptSubmissionObserverHost,
    page: Page,
    afterDomKey: string | undefined,
    afterProgressRevision: number,
    externalProgress?: ChatGptTurnProgressReader,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.waitForTurnDomOrExternalProgress !== SubmissionObserver.prototype.waitForTurnDomOrExternalProgress) {
      await this.waitForTurnDomOrExternalProgress(page, afterProgressRevision, externalProgress, signal);
      return afterDomKey ?? "legacy-stub";
    }
    let domKey = afterDomKey;
    const domSignal = waitForChatGptDomRevision(page, {
      afterKey: afterDomKey,
      settleMs: 150,
      horizonMs: 250,
      signal,
    });
    if (!externalProgress) return (await domSignal).key;
    const trackedKey = domSignal.then((verdict) => {
      domKey = verdict.key;
    });
    const progressWaitAbort = new AbortController();
    const progressSignal = signal ? AbortSignal.any([progressWaitAbort.signal, signal]) : progressWaitAbort.signal;
    try {
      await Promise.race([
        trackedKey,
        externalProgress.waitForChange(afterProgressRevision, progressSignal).then(() => undefined),
      ]);
    } finally {
      progressWaitAbort.abort();
    }
    // The signal had not delivered yet, so the next wait fast-paths on the first mutation and
    // refreshes the key; an empty placeholder never matches a live key.
    return domKey ?? afterDomKey ?? "";
  }

  async waitForSubmissionAccepted(
    this: ChatGptSubmissionObserverHost,
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    signal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    initialToolBatchRevision = externalProgress?.snapshot().lastToolBatchRevision ?? 0,
    completionTracker?: ChatGptCompletionTracker,
  ): Promise<ChatGptSubmissionEvidence> {
    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    let domSignalKey: string | undefined;
    for (;;) {
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      const progress = externalProgress?.snapshot();
      if (
        progress &&
        externalProgress &&
        completionTracker?.needsToolBatchObservation(progress.lastToolBatchRevision)
      ) {
        const boundaryText = await this.currentSubmissionAnswerText(page, baseline, signal);
        completionTracker.observeToolBatch(progress.lastToolBatchRevision, boundaryText);
        await externalProgress.acknowledgeToolBatch(progress.lastToolBatchRevision);
      }
      if (progress && (progress.claimed || progress.lastToolBatchRevision > initialToolBatchRevision))
        return "mcp_tool_call";
      await throwIfChatGptSessionFailureAlert(page);
      await throwIfChatGptRateLimitDialog(page);
      // Until the new response is bound, last() can still be a historical failed answer.
      // Response errors are checked against the bound current turn in the observation loops.
      let evidence: ChatGptSubmissionEvidence | undefined;
      if (externalProgress) {
        const progressWaitAbort = new AbortController();
        const progressSignal = signal ? AbortSignal.any([progressWaitAbort.signal, signal]) : progressWaitAbort.signal;
        try {
          const observed = await withBrowserTurnAbort(
            Promise.race([
              this.currentSubmissionEvidence(page, baseline, signal)
                .then((value) => ({ kind: "dom" as const, value }))
                .catch((error) => {
                  if (error instanceof ChatGptBrowserObservationTimeoutError) {
                    return { kind: "dom_timeout" as const, error };
                  }
                  throw error;
                }),
              externalProgress
                .waitForChange(progress?.revision ?? 0, progressSignal)
                .then(() => ({ kind: "external" as const })),
            ]),
            signal,
          );
          if (observed.kind === "external") continue;
          if (observed.kind === "dom_timeout") {
            const latestProgress = externalProgress.snapshot();
            const isRunning =
              typeof page?.locator === "function"
                ? await page
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
              latestProgress.claimed ||
              isRunning ||
              multiChannelLivenessActive ||
              chatGptExternalProgressIsLive(latestProgress, Date.now(), CHATGPT_RESPONSE_DOM_GRACE_MS)
            ) {
              continue;
            }
            throw observed.error;
          }
          evidence = observed.value;
        } finally {
          progressWaitAbort.abort();
        }
      } else {
        try {
          evidence = await this.currentSubmissionEvidence(page, baseline, signal);
        } catch (error) {
          if (error instanceof ChatGptBrowserObservationTimeoutError) {
            const isRunning =
              typeof page?.locator === "function"
                ? await page
                    .locator(CHATGPT_STOP_BUTTON_SELECTOR)
                    .last()
                    .isVisible()
                    .catch(() => false)
                : false;
            if (isRunning) {
              evidence = undefined;
            } else {
              throw error;
            }
          } else {
            throw error;
          }
        }
      }
      if (evidence) return evidence;
      domSignalKey = await this.waitForTurnDomRevisionOrExternalProgress(
        page,
        domSignalKey,
        progress?.revision ?? 0,
        externalProgress,
        signal,
      );
    }
  }

  async submissionDomState(
    this: ChatGptSubmissionObserverHost,
    page: Page,
    cache?: ChatGptSubmissionDomCache,
    signal?: AbortSignal,
  ): Promise<ChatGptSubmissionDomState> {
    throwIfPromptAttachmentAborted(signal);
    const observed = await withChatGptBrowserObservationTimeout(
      withBrowserTurnAbort(
        page.evaluate(
          (options) => {
            type ObserverState = { id: string; revision: number; observer: MutationObserver };
            const scope = globalThis as typeof globalThis & {
              __CODEX_WEB_GPT_TURN_OBSERVER__?: ObserverState;
            };
            const observerState = (scope.__CODEX_WEB_GPT_TURN_OBSERVER__ ??= (() => {
              const state: ObserverState = {
                id: `${performance.timeOrigin}:${Math.random().toString(36).slice(2)}`,
                revision: 0,
                observer: undefined as unknown as MutationObserver,
              };
              state.observer = new MutationObserver(() => {
                state.revision += 1;
              });
              state.observer.observe(document.documentElement, {
                subtree: true,
                childList: true,
                characterData: true,
                attributes: true,
                attributeFilter: options.attributeFilter,
              });
              return state;
            })());
            const observerKey = `${observerState.id}:${observerState.revision}`;
            if (options.knownKey === observerKey) return { key: observerKey };
            const identities = (elements: Element[], attribute: string): string[] => {
              const values = elements.map((element) => element.getAttribute(attribute));
              if (values.some((value) => typeof value !== "string" || value.trim().length === 0)) {
                throw new Error(`ChatGPT conversation turn has no stable ${attribute} identity`);
              }
              const typed = values as string[];
              if (new Set(typed).size !== typed.length) {
                throw new Error("ChatGPT exposed duplicate conversation turn identities");
              }
              return typed;
            };
            const visible = (element: Element): boolean => {
              const candidate = element as HTMLElement;
              if (!candidate.isConnected) return false;
              if (typeof candidate.checkVisibility === "function") {
                return candidate.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
              }
              const style = getComputedStyle(candidate);
              const bounds = candidate.getBoundingClientRect();
              return style.visibility !== "hidden" && (bounds.width > 0 || bounds.height > 0);
            };
            // data-testid contains a display index: ChatGPT can renumber it while the same turn lives.
            // Virtualization removes a turn's section, but retains its outer identity container.
            // New ChatGPT UI (2025+) uses data-turn-key instead of data-turn-id-container.
            // It uses data-chatgpt-search-unit-key (ending in ":user"/":assistant") for individual turns,
            // and data-chatgpt-selection-message-id for the stable UUID identity of assistant messages.

            const containers = [...document.querySelectorAll("[data-turn-id-container]")].filter(
              (element) =>
                !element.closest?.("[data-turn-key]") &&
                element.parentElement?.closest("[data-turn-id-container]")?.getAttribute("data-turn-id-container") !==
                  element.getAttribute("data-turn-id-container"),
            );
            const turnIdentities = identities(containers, "data-turn-id-container");
            const legacyTurns = (selector: string) =>
              [...document.querySelectorAll(selector)].filter(
                (element) => element.getAttribute("data-turn-key") == null && !element.closest?.("[data-turn-key]"),
              );
            const userIdentities = identities(legacyTurns(options.userTurnSelector), "data-turn-id");
            const responseIdentities = identities(legacyTurns(options.assistantTurnSelector), "data-turn-id");
            const knownTurns = new Set(turnIdentities);
            if ([...userIdentities, ...responseIdentities].some((identity) => !knownTurns.has(identity))) {
              throw new Error("ChatGPT conversation turn has no matching identity container");
            }
            const groups = [...document.querySelectorAll("[data-turn-key]")];
            const groupKeys = identities(groups, "data-turn-key");
            groups.forEach((group, index) => {
              const user = `group:user:${groupKeys[index]}`;
              const assistant = `group:assistant:${groupKeys[index]}`;
              // Keep both logical roles in the baseline even when virtualization unmounts their
              // contents. Remounting an old answer must never acknowledge a new submission.
              turnIdentities.push(user, assistant);
              if (group.querySelector("[data-user-message-bubble]")) userIdentities.push(user);
              if (group.querySelector('[data-conversation-role="assistant"], [data-chatgpt-agent-turn-start]'))
                responseIdentities.push(assistant);
            });

            return {
              key: observerKey,
              snapshot: {
                userTurnCount: userIdentities.length,
                assistantTurnCount: responseIdentities.length,
                visibleStopButtonCount: [...document.querySelectorAll(options.stopButtonSelector)].filter(visible)
                  .length,
                turnIdentities,
                userIdentities,
                responseIdentities,
              },
            };
          },
          {
            userTurnSelector: CHATGPT_USER_TURN_SELECTOR,
            assistantTurnSelector: CHATGPT_ASSISTANT_TURN_SELECTOR,
            stopButtonSelector: CHATGPT_STOP_BUTTON_SELECTOR,
            knownKey: cache?.key,
            attributeFilter: [...CHATGPT_DOM_REVISION_ATTRIBUTES],
          },
        ),
        signal,
      ),
    );
    const snapshot = observed.snapshot ?? cache?.snapshot;
    if (!snapshot) throw new Error("ChatGPT turn DOM revision cache has no baseline snapshot");
    if (observed.snapshot && cache) {
      cache.key = observed.key;
      cache.snapshot = observed.snapshot;
      cache.fullScans = (cache.fullScans ?? 0) + 1;
    } else if (!observed.snapshot && cache?.snapshot) {
      cache.cacheHits = (cache.cacheHits ?? 0) + 1;
    }
    return snapshot;
  }

  async currentSubmissionEvidence(
    this: ChatGptSubmissionObserverHost,
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    signal?: AbortSignal,
  ): Promise<ChatGptSubmissionEvidence | undefined> {
    const state = await this.submissionDomState(page, baseline.domCache, signal);
    const evidence = chatGptSubmissionEvidence({
      initialTurnIdentities: baseline.initialTurnIdentities,
      userIdentities: state.userIdentities,
      responseIdentities: state.responseIdentities,
      generationRunning: state.visibleStopButtonCount > 0,
    });
    if (evidence === "user_turn") {
      // Activity can temporarily replace this group before the assistant is mounted.
      // Preserve the identity that acknowledged Send, independently of rendered text.
      const identity = chatGptNewTurnIdentity(baseline.initialTurnIdentities, state.userIdentities)!;
      if (baseline.acceptedUserIdentity && baseline.acceptedUserIdentity !== identity) {
        throw new Error("ChatGPT changed the user turn that acknowledged the submission");
      }
      baseline.acceptedUserIdentity = identity;
    }
    return evidence;
  }

  async currentSubmissionAnswerText(
    this: ChatGptSubmissionObserverHost,
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      const state = await this.submissionDomState(page, baseline.domCache, signal);
      const identity = chatGptNewTurnIdentity(baseline.initialTurnIdentities, state.responseIdentities);
      if (!identity) return "";
      const locator = page.locator(chatGptAssistantTurnSelector(identity));
      return (await withChatGptBrowserObservationTimeout(this.responseDomSnapshot(locator, {}), 3_000)).visibleText;
    } catch {
      return "";
    }
  }

  async captureSubmissionBaseline(
    this: ChatGptSubmissionObserverHost,
    page: Page,
    submittedText?: string,
  ): Promise<ChatGptSubmissionBaseline> {
    const userTurns = page.locator(CHATGPT_USER_TURN_SELECTOR);
    const responseTurns = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR);
    const domCache: ChatGptSubmissionDomCache = {};
    const state = await this.submissionDomState(page, domCache);
    return {
      userTurns,
      responseTurns,
      initialTurnIdentities: state.turnIdentities,
      domCache,
      submittedText,
    };
  }
}
