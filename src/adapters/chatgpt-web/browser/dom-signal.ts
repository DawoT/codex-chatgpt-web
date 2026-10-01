import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";
import { CHATGPT_DOM_REVISION_ATTRIBUTES } from "./dom-trackers";
import {
  resolveAdaptiveObservationProbeTimeoutMs,
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
  /** Estimated DOM characters to adaptively scale the probe watchdog. */
  domChars?: number;
  /** Staged payload character length to adaptively scale the probe watchdog. */
  payloadChars?: number;
  /**
   * Require a fresh mutation even when `afterKey` is omitted. The general wait reads the current
   * key immediately in that case; settle barriers (waitForChatGptDomSettle) set this so a quiet
   * page really waits out its horizon instead of resolving instantly.
   */
  requireMutation?: boolean;
}

/**
 * Calculates adaptive probe watchdog timeout based on horizon and payload / DOM volume.
 * Avoids false timeout errors when Chromium's V8 main thread spends multiple seconds rendering
 * massive React markdown DOM trees (e.g. 135k characters in Bigger Context compaction).
 */
export function resolveDomRevisionProbeTimeoutMs(options: ChatGptDomRevisionWaitOptions = {}): number {
  if (options.observationTimeoutMs !== undefined) return options.observationTimeoutMs;
  const horizonMs = options.horizonMs ?? 500;
  const estimatedChars = Math.max(Number(options.domChars) || 0, Number(options.payloadChars) || 0);
  return horizonMs + resolveAdaptiveObservationProbeTimeoutMs(estimatedChars);
}

export async function waitForChatGptDomRevision(
  page: Page,
  options: ChatGptDomRevisionWaitOptions = {},
): Promise<ChatGptDomRevisionVerdict> {
  const settleMs = options.settleMs ?? 150;
  const horizonMs = options.horizonMs ?? 500;
  if (options.signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
  const waitId = randomUUID();
  let completed = false;
  try {
    const verdict = await withChatGptBrowserObservationTimeout(
      withBrowserTurnAbort(
        page.evaluate(
          ({ attributeFilter, afterKey, settle, horizon, requireMutation, waitId }) =>
            new Promise<{ key: string; revision: number; timedOut: boolean }>((resolve) => {
              type ChatGptDomSignalState = {
                id: string;
                revision: number;
                waiters: Array<() => void>;
                observer: MutationObserver;
                cancellations: Map<string, () => void>;
              };
              const scope = globalThis as typeof globalThis & {
                __CODEX_WEB_GPT_DOM_SIGNAL__?: ChatGptDomSignalState;
              };
              if (!scope.__CODEX_WEB_GPT_DOM_SIGNAL__) {
                let created!: ChatGptDomSignalState;
                const observer = new MutationObserver(() => {
                  created.revision += 1;
                  for (const wake of created.waiters.splice(0)) wake();
                });
                created = {
                  id: `${performance.timeOrigin}:${Math.random().toString(36).slice(2)}`,
                  revision: 0,
                  waiters: [],
                  cancellations: new Map(),
                  observer,
                };
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
                state.cancellations.delete(waitId);
                const index = state.waiters.indexOf(wake);
                if (index >= 0) state.waiters.splice(index, 1);
                if (settleTimer !== undefined) clearTimeout(settleTimer);
                if (horizonTimer !== undefined) clearTimeout(horizonTimer);
                resolve(verdict(timedOut));
              };
              state.cancellations.set(waitId, () => finish(true));
              state.waiters.push(wake);
              horizonTimer = setTimeout(() => finish(true), Math.max(1, horizon));
            }),
          {
            attributeFilter: [...CHATGPT_DOM_REVISION_ATTRIBUTES],
            afterKey: options.afterKey,
            settle: settleMs,
            horizon: horizonMs,
            requireMutation: options.requireMutation === true,
            waitId,
          },
        ),
        options.signal,
      ),
      resolveDomRevisionProbeTimeoutMs(options),
    );
    completed = true;
    return verdict;
  } finally {
    if (!completed) {
      // Release the renderer half of an abort/timeout/race, even when Node already rejected.
      await withChatGptBrowserObservationTimeout(
        page.evaluate((id) => {
          const scope = globalThis as typeof globalThis & {
            __CODEX_WEB_GPT_DOM_SIGNAL__?: { cancellations: Map<string, () => void> };
          };
          scope.__CODEX_WEB_GPT_DOM_SIGNAL__?.cancellations.get(id)?.();
        }, waitId),
        1000,
      ).catch(() => {});
    }
  }
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
    domChars?: number;
    payloadChars?: number;
  } = {},
): Promise<ChatGptDomRevisionVerdict> {
  return waitForChatGptDomRevision(page, {
    afterKey: options.afterKey,
    settleMs: options.settleMs ?? 150,
    horizonMs: options.horizonMs ?? 250,
    signal: options.signal,
    observationTimeoutMs: options.observationTimeoutMs,
    domChars: options.domChars,
    payloadChars: options.payloadChars,
    requireMutation: true,
  });
}
