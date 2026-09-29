import { TurnBrokerRequestError, TurnBrokerStateError } from "./errors";
import type { SafeTurnControl, SafeWaiter, TurnChannel } from "./types";

export function assertSafeNonce(safe: SafeTurnControl, surfaceNonce: string): void {
  if (safe.surfaceNonce !== surfaceNonce)
    throw new TurnBrokerRequestError("Zero Risk local browser binding does not match this turn");
}

export function activateSafeTurn(channel: TurnChannel, safe: SafeTurnControl): void {
  if (safe.state !== "awaiting_start" || !safe.launcherSent || !safe.connectorStarted) return;
  safe.state = "running";
  // The setup window may be bounded, but a turn authorized by the user and bound by the
  // Zero Risk connector remains live until completion, cancellation, or runtime shutdown.
  delete channel.environment.expiresAt;
  resolveSafeWaiters(safe.startWaiters, undefined);
}

export function assertSafeHarnessRunning(channel: TurnChannel, allowCompaction = false): void {
  const safe = channel.safe;
  if (!safe) return;
  if (safe.state === "awaiting_start") {
    if (!safe.launcherSent)
      throw new TurnBrokerStateError("Zero Risk turn is waiting for the user's Sent confirmation");
    throw new TurnBrokerRequestError(
      "Zero Risk request is not connected yet. Call codex_turn_start with its request_id first",
    );
  }
  if (safe.state !== "running") throw new TurnBrokerStateError("Zero Risk turn is already terminal");
  if (channel.compactionRequested && !allowCompaction) {
    throw new TurnBrokerStateError("Zero Risk turn is awaiting completion for Codex context compaction");
  }
}

export function waitForSafeState<T>(
  waiters: Set<SafeWaiter<T>>,
  signal: AbortSignal | undefined,
  abortMessage: string,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(new DOMException(abortMessage, "AbortError"));
  return new Promise<T>((resolveWait, rejectWait) => {
    const waiter: SafeWaiter<T> = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
    if (signal) {
      waiter.onAbort = () => {
        waiters.delete(waiter);
        rejectWait(new DOMException(abortMessage, "AbortError"));
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    waiters.add(waiter);
  });
}

export function resolveSafeWaiters<T>(waiters: Set<SafeWaiter<T>>, value: T): void {
  for (const waiter of waiters) {
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve(value);
  }
  waiters.clear();
}

export function rejectSafeWaiters<T>(waiters: Set<SafeWaiter<T>>, error: Error): void {
  for (const waiter of waiters) {
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.reject(error);
  }
  waiters.clear();
}
