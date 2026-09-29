import type { TaskRuntimeRecord } from "./background-task-types";

/** One timer and completion subscriptions; no polling or log IO while waiting. */
export async function waitForTaskRecords(
  records: TaskRuntimeRecord[],
  waitMs: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error("Invalid task wait duration");
  if (waitMs === 0 || records.every((record) => record.closed)) return;
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      for (const record of records) record.completionWaiters.delete(onCompletion);
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(signal?.reason);
    };
    const onCompletion = () => {
      if (records.every((record) => record.closed)) finish();
    };
    timer = setTimeout(finish, Math.min(waitMs, 90_000));
    for (const record of records) {
      if (!record.closed) record.completionWaiters.add(onCompletion);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
