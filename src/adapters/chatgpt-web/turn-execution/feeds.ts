import type { ChatGptTraceEvent, TextWaiter, TraceWaiter } from "./types";

export class ChatGptTraceFeed {
  private readonly queued: ChatGptTraceEvent[] = [];
  private readonly waiters = new Set<TraceWaiter>();

  private closed = false;
  private closeReason?: Error;

  get pendingWaiters(): number {
    return this.waiters.size;
  }

  push(event: ChatGptTraceEvent): void {
    const normalized = event.continuation ? event.text : event.text.trim();
    if (this.closed || !normalized) return;
    const normalizedEvent = { ...event, text: normalized };
    this.queued.push(normalizedEvent);
    if (this.waiters.size === 0) return;
    const currentWaiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of currentWaiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve();
    }
  }

  drain(): ChatGptTraceEvent[] {
    return this.queued.splice(0);
  }

  close(reason?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    if (this.waiters.size === 0) return;
    const currentWaiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of currentWaiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (reason) waiter.reject(reason);
      else waiter.resolve();
    }
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new DOMException("trace wait aborted", "AbortError"));
    if (this.closed && this.closeReason) return Promise.reject(this.closeReason);
    if (this.closed || this.queued.length > 0) return Promise.resolve();
    return new Promise<void>((resolveWait, rejectWait) => {
      const waiter: TraceWaiter = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters.delete(waiter);
          rejectWait(new DOMException("trace wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }
}

/** Append-only browser Markdown feed. Waiters are notifications; `drain` owns consumption. */
export class ChatGptTextFeed {
  private readonly queued: string[] = [];
  private readonly waiters = new Set<TextWaiter>();
  private text = "";

  private closed = false;
  private closeReason?: Error;

  get pendingWaiters(): number {
    return this.waiters.size;
  }

  push(delta: string): void {
    if (this.closed || !delta) return;
    this.text += delta;
    this.queued.push(delta);
    if (this.waiters.size === 0) return;
    const currentWaiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of currentWaiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve();
    }
  }

  drain(): string[] {
    return this.queued.splice(0);
  }

  close(reason?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    if (this.waiters.size === 0) return;
    const currentWaiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of currentWaiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (reason) waiter.reject(reason);
      else waiter.resolve();
    }
  }

  value(): string {
    return this.text;
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new DOMException("text wait aborted", "AbortError"));
    if (this.closed && this.closeReason) return Promise.reject(this.closeReason);
    if (this.closed || this.queued.length > 0) return Promise.resolve();
    return new Promise<void>((resolveWait, rejectWait) => {
      const waiter: TextWaiter = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters.delete(waiter);
          rejectWait(new DOMException("text wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }
}
