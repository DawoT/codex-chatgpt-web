/**
 * ChatGPT Web concurrency is deliberately bounded. Every active Codex turn owns a real
 * browser document in the signed-in account, so unbounded fan-out would create account-level
 * traffic that is indistinguishable from spam.
 */
export const MAX_CHATGPT_BROWSER_TABS = 5;

/**
 * Maximum concurrent subagent turns permitted simultaneously.
 * With 1 root orchestrator + up to 2 subagents, at most 3 browser tabs are active,
 * leaving 2 headroom slots for system operations (compaction, verification, recovery)
 * within the hard MAX_CHATGPT_BROWSER_TABS = 5 limit.
 */
export const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 2;

/**
 * Maximum time a subagent is allowed to wait in the semaphore queue before timing out.
 */
export const DEFAULT_SUBAGENT_QUEUE_TIMEOUT_MS = 120_000;

export interface SubagentGovernorStatus {
  active: number;
  queued: number;
  available: number;
  maxConcurrent: number;
}

export class SubagentConcurrencyGovernor {
  private activeCount = 0;
  private readonly waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
    signal?: AbortSignal;
    cleanup?: () => void;
  }> = [];

  constructor(
    readonly maxConcurrent: number = DEFAULT_MAX_CONCURRENT_SUBAGENTS,
    readonly queueTimeoutMs: number = DEFAULT_SUBAGENT_QUEUE_TIMEOUT_MS,
  ) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error("maxConcurrent must be a positive integer");
    }
  }

  get active(): number {
    return this.activeCount;
  }

  get queued(): number {
    return this.waiters.length;
  }

  get available(): number {
    return Math.max(0, this.maxConcurrent - this.activeCount);
  }

  get status(): SubagentGovernorStatus {
    return {
      active: this.active,
      queued: this.queued,
      available: this.available,
      maxConcurrent: this.maxConcurrent,
    };
  }

  async acquire(signal?: AbortSignal, timeoutMs?: number): Promise<() => void> {
    if (signal?.aborted) {
      throw new DOMException("Subagent execution aborted", "AbortError");
    }

    if (this.activeCount < this.maxConcurrent) {
      this.activeCount++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.activeCount = Math.max(0, this.activeCount - 1);
        this.dispatchNext();
      };
    }

    const waitTimeout = timeoutMs ?? this.queueTimeoutMs;

    return new Promise<() => void>((resolve, reject) => {
      let settled = false;

      const waiter: {
        resolve: (release: () => void) => void;
        reject: (error: Error) => void;
        timer?: ReturnType<typeof setTimeout>;
        signal?: AbortSignal;
        cleanup?: () => void;
      } = {
        resolve: (release) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(release);
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
        signal,
      };

      const cleanup = () => {
        if (waiter.timer) {
          clearTimeout(waiter.timer);
          waiter.timer = undefined;
        }
        if (signal && onAbort) {
          signal.removeEventListener("abort", onAbort);
        }
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
      };
      waiter.cleanup = cleanup;

      const onAbort = () => {
        waiter.reject(new DOMException("Subagent execution aborted while waiting for an available browser slot", "AbortError"));
      };

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      if (waitTimeout > 0 && Number.isFinite(waitTimeout)) {
        waiter.timer = setTimeout(() => {
          waiter.reject(new Error(
            `Subagent concurrency limit reached (${this.maxConcurrent} active). ` +
            `Waited ${Math.round(waitTimeout / 1000)}s for an available browser tab slot without success.`,
          ));
        }, waitTimeout);
      }

      this.waiters.push(waiter);
    });
  }

  private dispatchNext(): void {
    while (this.waiters.length > 0 && this.activeCount < this.maxConcurrent) {
      const next = this.waiters.shift();
      if (!next) break;

      this.activeCount++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.activeCount = Math.max(0, this.activeCount - 1);
        this.dispatchNext();
      };

      next.resolve(release);
    }
  }

  /**
   * Reset / clear all waiting entries (e.g. on shutdown).
   */
  clear(reason = new Error("Subagent governor was reset")): void {
    const pending = this.waiters.splice(0);
    for (const waiter of pending) {
      waiter.reject(reason);
    }
    this.activeCount = 0;
  }
}

export const defaultSubagentGovernor = new SubagentConcurrencyGovernor();
