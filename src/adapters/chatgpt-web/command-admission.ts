interface PendingAdmission {
  grant: () => void;
}

/** A lease is held until process close, including while termination is pending. */
export class CommandAdmission {
  private active = 0;
  private readonly queue: PendingAdmission[] = [];

  constructor(
    private readonly capacity: number,
    private readonly maxQueued = capacity,
    private readonly waitMs = 5000,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1
      || !Number.isSafeInteger(maxQueued) || maxQueued < 0
      || !Number.isSafeInteger(waitMs) || waitMs < 1) {
      throw new RangeError("Invalid command admission limits");
    }
  }

  async acquire(signal?: AbortSignal, wait = true): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active < this.capacity) return this.lease();
    if (!wait || this.queue.length >= this.maxQueued) {
      throw new Error(`Command capacity exhausted (maxConcurrent=${this.capacity}, maxQueued=${this.maxQueued}); no command was started.`);
    }
    return new Promise<() => void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        const index = this.queue.indexOf(pending);
        if (index >= 0) this.queue.splice(index, 1);
      };
      const abort = () => {
        cleanup();
        reject(signal?.reason ?? new Error("Command admission cancelled"));
      };
      const pending: PendingAdmission = {
        grant: () => {
          cleanup();
          resolve(this.lease());
        },
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Command admission timed out; no command was started."));
      }, this.waitMs);
      this.queue.push(pending);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  private lease(): () => void {
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.queue[0]?.grant();
    };
  }
}
