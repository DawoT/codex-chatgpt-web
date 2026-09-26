/**
 * Sprint AG: Circuit Breaker for Upstream Calls
 *
 * Protects the daemon from upstream cascade failures by tracking consecutive
 * errors and opening the circuit when too many failures occur, returning
 * immediate 503 responses without attempting upstream calls.
 *
 * States:
 *   CLOSED   → Normal operation. Requests pass through. Errors are counted.
 *   OPEN     → Circuit tripped. All requests get immediate rejection (503).
 *              After `recoveryMs`, transitions to HALF_OPEN.
 *   HALF_OPEN → Probe state. One request is allowed through. If it succeeds,
 *              the circuit closes. If it fails, the circuit re-opens.
 *
 * Invariants:
 * - Pure synchronous state machine. No timers (uses wall clock in check()).
 * - Never throws: all errors are swallowed gracefully.
 * - Thread-safe by single-threaded JS runtime guarantee.
 * - `recordSuccess()` resets consecutive error count and closes the circuit.
 * - `recordError()` increments count; if threshold reached, opens the circuit.
 */

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  /** Number of consecutive errors before opening the circuit. Default: 3. */
  errorThreshold?: number;
  /** Milliseconds to remain OPEN before transitioning to HALF_OPEN. Default: 30_000. */
  recoveryMs?: number;
  /** Name of this circuit (for logging/metrics). */
  name?: string;
}

export interface CircuitBreakerSnapshot {
  name: string;
  state: CircuitState;
  consecutiveErrors: number;
  totalErrors: number;
  totalSuccesses: number;
  totalOpens: number;
  openedAt: number | null;
  recoveryMs: number;
  errorThreshold: number;
}

export class CircuitBreaker {
  private readonly name: string;
  private readonly errorThreshold: number;
  private readonly recoveryMs: number;

  private state: CircuitState = "CLOSED";
  private consecutiveErrors = 0;
  private openedAt: number | null = null;
  private totalErrors = 0;
  private totalSuccesses = 0;
  private totalOpens = 0;

  constructor(options: CircuitBreakerOptions = {}) {
    this.name = options.name ?? "default";
    this.errorThreshold = options.errorThreshold ?? 3;
    this.recoveryMs = options.recoveryMs ?? 30_000;
  }

  /**
   * Returns true if a request is allowed to proceed.
   * Handles OPEN → HALF_OPEN transition based on wall clock.
   */
  isAllowed(nowMs: number = Date.now()): boolean {
    if (this.state === "CLOSED") return true;
    if (this.state === "HALF_OPEN") return false; // Only 1 probe allowed; managed via recordSuccess/recordError
    // OPEN state
    if (this.openedAt !== null && nowMs - this.openedAt >= this.recoveryMs) {
      this.state = "HALF_OPEN";
      return true; // Allow the probe request
    }
    return false;
  }

  /**
   * Record a successful upstream call. Resets error count and closes circuit.
   */
  recordSuccess(): void {
    this.consecutiveErrors = 0;
    this.totalSuccesses++;
    this.state = "CLOSED";
    this.openedAt = null;
  }

  /**
   * Record a failed upstream call. Increments counter and may open circuit.
   */
  recordError(nowMs: number = Date.now()): void {
    this.consecutiveErrors++;
    this.totalErrors++;
    if (this.state === "HALF_OPEN" || (this.state === "CLOSED" && this.consecutiveErrors >= this.errorThreshold)) {
      this.state = "OPEN";
      this.openedAt = nowMs;
      this.totalOpens++;
    }
  }

  /** Returns the current circuit state. */
  getState(): CircuitState {
    return this.state;
  }

  /** Returns numeric state value (0=closed, 1=open, 2=half_open) for Prometheus gauges. */
  getStateNumeric(): number {
    if (this.state === "CLOSED") return 0;
    if (this.state === "OPEN") return 1;
    return 2;
  }

  /** Returns total number of times the circuit has opened. */
  getTotalOpens(): number {
    return this.totalOpens;
  }

  getSnapshot(): CircuitBreakerSnapshot {
    return {
      name: this.name,
      state: this.state,
      consecutiveErrors: this.consecutiveErrors,
      totalErrors: this.totalErrors,
      totalSuccesses: this.totalSuccesses,
      totalOpens: this.totalOpens,
      openedAt: this.openedAt,
      recoveryMs: this.recoveryMs,
      errorThreshold: this.errorThreshold,
    };
  }

  /** Reset all state (tests only). */
  _resetForTest(): void {
    this.state = "CLOSED";
    this.consecutiveErrors = 0;
    this.openedAt = null;
    this.totalErrors = 0;
    this.totalSuccesses = 0;
    this.totalOpens = 0;
  }
}
