import type { Browser } from "playwright-core";

export const CHATGPT_RESPONSE_DOM_GRACE_MS = 60_000;
/**
 * How long a staged Bigger Context part may take to produce its assistant turn. A staged part is two
 * orders of magnitude larger than an ordinary prompt and ChatGPT reads all of it before answering.
 * No MCP activity exists while that inert part is being ingested, so the response grace matches
 * the bounded staged-send budget.
 */
export const CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS = 180_000;
export const CHATGPT_EMPTY_RESPONSE_GRACE_MS = 10_000;
export const CHATGPT_COMPLETION_ACTION_GRACE_MS = 60_000;
export const CHATGPT_COMPLETION_SETTLE_MS = 2_000;

export const browserStageTimeouts = {
  browserPage: 60_000,
  temporaryChatPreparation: 150_000,
  effortSelection: 120_000,
  promptAttachment: 60_000,
  fileAttachment: 120_000,
  send: 180_000,
  // A Bigger Context stage posts a much larger payload onto a conversation that already holds the
  // earlier parts. This budget covers ChatGPT accepting the submission, not just the click.
  multipartStageSend: 180_000,
  // Staging asks for one transaction-bound acknowledgement, not an open-ended model answer.
  multipartStageAcknowledgement: CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS,
} as const;

/**
 * Detects that this process was suspended (system sleep) by watching for gaps in a steady tick.
 * On Apple Silicon the monotonic clock keeps advancing through sleep, so elapsed time alone cannot
 * distinguish "the stage really took 15 minutes" from "the machine slept for 14 of them" — and a
 * stage budget charged for slept time cancels turns that never got their budget awake.
 */
export class ChatGptSuspensionClock {
  private suspendedTotalMs = 0;
  private lastTickAt: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly tickIntervalMs = 1_000,
    private readonly gapThresholdMs = 5_000,
  ) {
    this.lastTickAt = Date.now();
  }

  start(): void {
    if (this.timer) return;
    this.lastTickAt = Date.now();
    this.timer = setInterval(() => this.tick(Date.now()), this.tickIntervalMs);
    this.timer.unref?.();
  }

  /** Exposed for tests; production ticks come from the interval above. */
  tick(now: number): void {
    const gap = now - this.lastTickAt;
    this.lastTickAt = now;
    if (gap >= this.gapThresholdMs) this.suspendedTotalMs += gap - this.tickIntervalMs;
  }

  suspendedMs(): number {
    return this.suspendedTotalMs;
  }
}

export const chatGptSuspensionClock = new ChatGptSuspensionClock();

/**
 * How much of a stage budget remains once slept time is refunded. Zero means the stage really
 * consumed its budget while awake and the timeout stands.
 */
export function remainingStageBudgetMs(timeoutMs: number, elapsedMs: number, suspendedMs: number): number {
  const awakeMs = elapsedMs - suspendedMs;
  if (awakeMs >= timeoutMs) return 0;
  return Math.max(250, timeoutMs - awakeMs);
}

export const CHATGPT_BROWSER_OBSERVATION_BASE_PROBE_TIMEOUT_MS = 6_000;
export const CHATGPT_BROWSER_OBSERVATION_MAX_PROBE_TIMEOUT_MS = 30_000;
export const CATASTROPHIC_SILENCE_THRESHOLD_MS = 90_000;

export const CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS =
  Number(process.env.CODEX_CHATGPT_BROWSER_PROBE_TIMEOUT_MS) || 5_000;
export const MAX_CHATGPT_BROWSER_PAGE_REBINDS = 2;

export interface MultiChannelLivenessSnapshot {
  lastBrokerEventAt?: number;
  lastDomMutationAt?: number;
  lastNetworkChunkAt?: number;
  activeToolCalls?: number;
  inFlightCalls?: boolean;
}

/**
 * Multi-channel event-driven liveness evaluation.
 * A turn is conclusively alive if:
 * 1. Tool calls are actively in flight or activeToolCalls > 0.
 * 2. Any channel (Broker MCP, DOM Mutation, Network Chunk) emitted an event within the silence threshold.
 * Catastrophic failure is only declared after complete multi-channel silence (>90s).
 */
export function isMultiChannelLivenessActive(
  snapshot: MultiChannelLivenessSnapshot,
  now = Date.now(),
  silenceThresholdMs = CATASTROPHIC_SILENCE_THRESHOLD_MS,
): boolean {
  if ((snapshot.activeToolCalls ?? 0) > 0 || snapshot.inFlightCalls) {
    return true;
  }
  const lastEvent = Math.max(
    snapshot.lastBrokerEventAt ?? 0,
    snapshot.lastDomMutationAt ?? 0,
    snapshot.lastNetworkChunkAt ?? 0,
  );
  if (lastEvent === 0) return false;
  return now - lastEvent < silenceThresholdMs;
}

/**
 * Calculates adaptive probe timeout horizon based on HTML DOM character size.
 * T_probe(chars) = max(6000, min(30000, 6000 + floor(chars / 50)))
 */
export function resolveAdaptiveObservationProbeTimeoutMs(domChars: number, _activeToolCalls = 0): number {
  const chars = Math.max(0, Number.isFinite(domChars) ? domChars : 0);
  const baseMs = Math.max(
    CHATGPT_BROWSER_OBSERVATION_BASE_PROBE_TIMEOUT_MS,
    CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS,
  );
  const dynamicMs = baseMs + Math.floor(chars / 50);
  return Math.min(CHATGPT_BROWSER_OBSERVATION_MAX_PROBE_TIMEOUT_MS, dynamicMs);
}

export class ChatGptBrowserObservationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`ChatGPT browser DOM observation did not respond within ${timeoutMs}ms`);
    this.name = "ChatGptBrowserObservationTimeoutError";
  }
}

export async function withChatGptBrowserObservationTimeout<T>(
  operation: Promise<T>,
  timeoutMs = CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ChatGptBrowserObservationTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function connectAfterClosingBrowserConnection<T>(
  previousConnection: Pick<Browser, "close"> | undefined,
  connect: () => Promise<T>,
): Promise<T> {
  if (previousConnection) await previousConnection.close();
  return connect();
}

export const CHATGPT_MIN_OPERATIONAL_VIEWPORT = Object.freeze({ width: 320, height: 240 });

export const CHATGPT_COMPOSER_DOCUMENT_END_KEY = process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End";
export const CHATGPT_COMPOSER_SELECT_ALL_KEY = process.platform === "darwin" ? "Meta+A" : "Control+A";

export function throwIfPromptAttachmentAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("ChatGPT prompt attachment aborted", "AbortError");
}

export function withBrowserTurnAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
  }
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = () => {
      void promise.catch(() => {});
      rejectPromise(new DOMException("ChatGPT web turn aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolvePromise, rejectPromise).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}
