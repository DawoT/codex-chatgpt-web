import type { Page } from "playwright-core";
import { CHATGPT_DOM_REVISION_ATTRIBUTES } from "./dom-trackers";
import {
  CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS,
  withBrowserTurnAbort,
  withChatGptBrowserObservationTimeout,
} from "./suspension-clock";

/**
 * Event-driven DOM wake signal for turn observation.
 *
 * The observation loops used to sleep on a fixed beat (250 ms) and re-probe the page whether or
 * not anything had changed. This primitive inverts that: it evaluates one promise in the page that
 * resolves the moment the conversation DOM mutates in a qualifying way (same attribute filter as
 * the revision observers), so a wake costs zero latency and a quiet page costs no evaluations.
 */

export interface ChatGptDomRevisionVerdict {
  /** Observer identity plus revision (`${observerId}:${revision}`), comparable across waits. */
  key: string;
  revision: number;
  /** True when the horizon elapsed without a qualifying mutation; never an exception. */
  timedOut: boolean;
}

export interface ChatGptDomRevisionWaitOptions {
  /**
   * Key returned by a previous wait. The promise resolves as soon as the live key differs —
   * either because the document mutated or because it was replaced (navigation produces a fresh
   * observer identity). Omit it to read the current key without waiting.
   */
  afterKey?: string;
  /** Quiet time after the first mutation batch before the wake is delivered (default 150 ms). */
  settleMs?: number;
  /** Longest quiet wait before a `timedOut` verdict is returned (default 500 ms). */
  horizonMs?: number;
  signal?: AbortSignal;
  /**
   * Node-side watchdog for a renderer that never settles the in-page promise. It exceeds the
   * horizon so a healthy quiet page is never mistaken for a dead one; when it fires, callers run
   * their existing unresponsive-page recovery (page rebind) instead of hanging.
   */
  observationTimeoutMs?: number;
  /**
   * Require a fresh mutation even when `afterKey` is omitted. The general wait reads the current
   * key immediately in that case; settle barriers (waitForChatGptDomSettle) set this so a quiet
   * page really waits out its horizon instead of resolving instantly.
   */
  requireMutation?: boolean;
}

export async function waitForChatGptDomRevision(
  page: Page,
  options: ChatGptDomRevisionWaitOptions = {},
): Promise<ChatGptDomRevisionVerdict> {
  const settleMs = options.settleMs ?? 150;
  const horizonMs = options.horizonMs ?? 500;
  if (typeof page?.evaluate !== "function") {
    await withBrowserTurnAbort(
      new Promise((resolve) => setTimeout(resolve, Math.min(settleMs, horizonMs))),
      options.signal,
    );
    return { key: "stub:0", revision: 0, timedOut: false };
  }
  return withChatGptBrowserObservationTimeout(
    withBrowserTurnAbort(
      page.evaluate(
        ({ attributeFilter, afterKey, settle, horizon, requireMutation }) =>
          new Promise<{ key: string; revision: number; timedOut: boolean }>((resolve) => {
            type ChatGptDomSignalState = {
              id: string;
              revision: number;
              waiters: Array<() => void>;
              observer: MutationObserver;
            };
            const scope = globalThis as typeof globalThis & {
              __CODEX_WEB_GPT_DOM_SIGNAL__?: ChatGptDomSignalState;
            };
            if (!scope.__CODEX_WEB_GPT_DOM_SIGNAL__) {
              const created: ChatGptDomSignalState = {
                id: `${performance.timeOrigin}:${Math.random().toString(36).slice(2)}`,
                revision: 0,
                waiters: [],
                observer: undefined as unknown as MutationObserver,
              };
              created.observer = new MutationObserver(() => {
                created.revision += 1;
                for (const wake of created.waiters.splice(0)) wake();
              });
              created.observer.observe(document.documentElement, {
                subtree: true,
                childList: true,
                characterData: true,
                attributes: true,
                attributeFilter,
              });
              scope.__CODEX_WEB_GPT_DOM_SIGNAL__ = created;
            }
            const state = scope.__CODEX_WEB_GPT_DOM_SIGNAL__;
            const verdict = (timedOut: boolean) => ({
              key: `${state.id}:${state.revision}`,
              revision: state.revision,
              timedOut,
            });
            const liveKey = `${state.id}:${state.revision}`;
            if (afterKey !== undefined && afterKey !== liveKey) {
              resolve(verdict(false));
              return;
            }
            if (afterKey === undefined && !requireMutation) {
              resolve(verdict(false));
              return;
            }
            let settled = false;
            let settleTimer: ReturnType<typeof setTimeout> | undefined;
            let horizonTimer: ReturnType<typeof setTimeout> | undefined;
            const wake = () => {
              if (settleTimer !== undefined) return;
              // Let one React mutation batch finish before delivering the wake.
              settleTimer = setTimeout(() => finish(false), settle);
            };
            const finish = (timedOut: boolean) => {
              if (settled) return;
              settled = true;
              const index = state.waiters.indexOf(wake);
              if (index >= 0) state.waiters.splice(index, 1);
              if (settleTimer !== undefined) clearTimeout(settleTimer);
              if (horizonTimer !== undefined) clearTimeout(horizonTimer);
              resolve(verdict(timedOut));
            };
            state.waiters.push(wake);
            horizonTimer = setTimeout(() => finish(true), Math.max(1, horizon));
          }),
        {
          attributeFilter: [...CHATGPT_DOM_REVISION_ATTRIBUTES],
          afterKey: options.afterKey,
          settle: settleMs,
          horizon: horizonMs,
          requireMutation: options.requireMutation === true,
        },
      ),
      options.signal,
    ),
    options.observationTimeoutMs ?? horizonMs + CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS,
  );
}

/**
 * Pure settle barrier over the revision signal: resolve once the DOM has mutated and stayed quiet
 * for `settleMs`, or return a `timedOut` verdict after `horizonMs`. Replaces the fixed-sleep
 * "let the UI settle" pattern with an event-gated one. Unlike the general wait, a missing
 * `afterKey` waits for a fresh mutation instead of reading the current key.
 */
export async function waitForChatGptDomSettle(
  page: Page,
  options: {
    afterKey?: string;
    settleMs?: number;
    horizonMs?: number;
    signal?: AbortSignal;
    observationTimeoutMs?: number;
  } = {},
): Promise<ChatGptDomRevisionVerdict> {
  return waitForChatGptDomRevision(page, {
    afterKey: options.afterKey,
    settleMs: options.settleMs ?? 150,
    horizonMs: options.horizonMs ?? 250,
    signal: options.signal,
    observationTimeoutMs: options.observationTimeoutMs,
    requireMutation: true,
  });
}
