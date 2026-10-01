import type { ChatGptTurnEventBus } from "./turn-events";

/** Arm the bus before reading a snapshot; every losing waiter has the same cancellation scope. */
export async function waitForChatGptTurnWake(
  bus: ChatGptTurnEventBus,
  observe: (signal: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const abort = new AbortController();
  const scoped = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  const options = { signal: scoped, afterSequence: bus.cursor };
  const waiters = [
    bus.waitUntil("network_submission_observed", undefined, options),
    bus.waitUntil("external_progress_advanced", undefined, options),
    bus.waitUntil("response_mutated", undefined, options),
    bus.waitUntil("page_rebound", undefined, options),
    bus.waitUntil("compaction_handoff_observed", undefined, options),
  ];
  let observation: Promise<void> | undefined;
  try {
    observation = observe(scoped);
    await Promise.race([...waiters, observation]);
  } finally {
    abort.abort();
    await Promise.allSettled([...waiters, ...(observation ? [observation] : [])]);
  }
}
