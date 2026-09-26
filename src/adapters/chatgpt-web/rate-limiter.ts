/**
 * Sprint AG: Sliding Window Rate Limiter
 *
 * In-memory per-key rate limiter using a sliding window algorithm.
 * Protects the daemon from abusive clients sending too many requests.
 *
 * Invariants:
 * - Pure in-memory: no disk I/O, no async operations.
 * - Thread-safe by single-threaded JS runtime guarantee.
 * - Old entries are lazily pruned on each check (no background timer needed).
 * - Window size and limit are configurable per instance.
 * - Keys that have never been seen consume no memory.
 * - When the limiter is disabled (limit <= 0), all requests pass through.
 */

export interface RateLimiterOptions {
  /** Maximum number of requests allowed per window. Default: 60. */
  limitPerWindow?: number;
  /** Window size in milliseconds. Default: 60_000 (1 minute). */
  windowMs?: number;
  /** If true, rate limiting is disabled (all requests pass). Default: false. */
  disabled?: boolean;
}

export interface RateLimitResult {
  /** Whether the request is allowed to proceed. */
  allowed: boolean;
  /** How many requests have been made in the current window (including this one). */
  count: number;
  /** The configured limit. */
  limit: number;
  /** Milliseconds until the oldest request falls out of the window. */
  retryAfterMs: number;
}

export class SlidingWindowRateLimiter {
  private readonly limitPerWindow: number;
  private readonly windowMs: number;
  private readonly disabled: boolean;
  /** key → sorted array of timestamps (ms) within the current window */
  private readonly windows = new Map<string, number[]>();
  private totalRejections = 0;

  constructor(options: RateLimiterOptions = {}) {
    this.limitPerWindow = options.limitPerWindow ?? 60;
    this.windowMs = options.windowMs ?? 60_000;
    this.disabled = options.disabled ?? false;
  }

  /**
   * Check if a request for the given key is allowed.
   * If allowed, records the timestamp and returns allowed=true.
   * If rejected, does NOT record the attempt (callers should not retry-loop).
   */
  check(key: string, nowMs: number = Date.now()): RateLimitResult {
    if (this.disabled || this.limitPerWindow <= 0) {
      return { allowed: true, count: 0, limit: this.limitPerWindow, retryAfterMs: 0 };
    }

    const cutoff = nowMs - this.windowMs;
    let timestamps = this.windows.get(key);

    // Lazy prune: remove entries older than the window
    if (timestamps) {
      let pruneIdx = 0;
      while (pruneIdx < timestamps.length && timestamps[pruneIdx]! <= cutoff) {
        pruneIdx++;
      }
      if (pruneIdx > 0) timestamps = timestamps.slice(pruneIdx);
      if (timestamps.length === 0) {
        this.windows.delete(key);
        timestamps = undefined;
      } else {
        this.windows.set(key, timestamps);
      }
    }

    const count = timestamps ? timestamps.length : 0;

    if (count >= this.limitPerWindow) {
      this.totalRejections++;
      const oldestMs = timestamps![0]!;
      const retryAfterMs = Math.max(0, oldestMs + this.windowMs - nowMs);
      return { allowed: false, count, limit: this.limitPerWindow, retryAfterMs };
    }

    // Record this request
    const updated = timestamps ? [...timestamps, nowMs] : [nowMs];
    this.windows.set(key, updated);
    return { allowed: true, count: count + 1, limit: this.limitPerWindow, retryAfterMs: 0 };
  }

  /** Total cumulative rejections since this instance was created. */
  getTotalRejections(): number {
    return this.totalRejections;
  }

  /** Remove all state for a key (useful in tests). */
  resetKey(key: string): void {
    this.windows.delete(key);
  }

  /** Reset all state (tests only). */
  resetAll(): void {
    this.windows.clear();
    this.totalRejections = 0;
  }

  getConfig(): { limitPerWindow: number; windowMs: number; disabled: boolean } {
    return {
      limitPerWindow: this.limitPerWindow,
      windowMs: this.windowMs,
      disabled: this.disabled,
    };
  }
}
