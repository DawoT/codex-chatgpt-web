/**
 * Sprint AE: Runtime Metrics Collector & Observability
 *
 * Provides atomic counters for daemon health, turn throughput, spooling activity,
 * janitor health, and structured error logging. Exposes Prometheus-compatible
 * text format via serializePrometheusMetrics() and a JSON admin snapshot via
 * buildAdminStatus().
 *
 * Invariants:
 * - All counter increments are synchronous and non-throwing.
 * - Prometheus output uses gauge/counter semantics (no histograms for simplicity).
 * - Alerting hooks fire when janitor consecutive_errors >= JANITOR_ALERT_THRESHOLD (2).
 * - This module is side-effect-free at import time (no timers, no global I/O).
 */

export interface RuntimeMetricsSnapshot {
  /** Monotonic counter: total turns received (all outcomes) */
  turns_total: number;
  /** Monotonic counter: turns that completed successfully */
  turns_success: number;
  /** Monotonic counter: turns that ended in error */
  turns_error: number;
  /** Gauge: currently active HTTP turns */
  turns_active: number;
  /** Monotonic counter: total bytes written to spooler files */
  spooler_bytes_written: number;
  /** Monotonic counter: total spooler files written */
  spooler_files_written: number;
  /** Monotonic counter: total bytes freed by spooler TTL/FIFO GC */
  spooler_bytes_freed: number;
  /** Monotonic counter: total files pruned by session janitor across all runs */
  janitor_files_pruned: number;
  /** Monotonic counter: total bytes reclaimed by session janitor across all runs */
  janitor_bytes_reclaimed: number;
  /** Monotonic counter: total janitor run invocations */
  janitor_runs_total: number;
  /** Monotonic counter: janitor runs that encountered an error */
  janitor_runs_error: number;
  /** Gauge: consecutive janitor runs that ended in error (resets on success) */
  janitor_consecutive_errors: number;
  /** Monotonic counter: total checkpoints written */
  checkpoints_written: number;
  /** Monotonic counter: total successful compactions */
  compactions_total: number;
  /** Monotonic counter: structured errors logged (all severity levels) */
  structured_errors_total: number;
  /** Monotonic counter: requests rejected by the rate limiter */
  rate_limit_rejections: number;
  /** Monotonic counter: total times the circuit breaker has opened */
  circuit_breaker_opens: number;
  /** Gauge: current circuit breaker state (0=closed, 1=open, 2=half-open) */
  circuit_breaker_state: number;
  /** Monotonic counter: upstream errors recorded (all non-success upstream calls) */
  upstream_errors: number;
  /** ISO 8601 timestamp when this snapshot was taken */
  snapshot_at: string;
}

export interface StructuredLogEntry {
  error_code: string;
  severity: "critical" | "high" | "medium" | "low";
  context: string;
  message: string;
  stack_digest?: string;
  recorded_at: string;
}

export interface RuntimeAlert {
  alert_id: string;
  severity: "critical" | "warning";
  message: string;
  detected_at: string;
}

const JANITOR_ALERT_THRESHOLD = 2;
const MAX_ERROR_LOG_ENTRIES = 100;

class RuntimeMetricsCollector {
  private _turnsTotal = 0;
  private _turnsSuccess = 0;
  private _turnsError = 0;
  private _turnsActive = 0;
  private _spoolerBytesWritten = 0;
  private _spoolerFilesWritten = 0;
  private _spoolerBytesFreed = 0;
  private _janitorFilesPruned = 0;
  private _janitorBytesReclaimed = 0;
  private _janitorRunsTotal = 0;
  private _janitorRunsError = 0;
  private _janitorConsecutiveErrors = 0;
  private _checkpointsWritten = 0;
  private _compactionsTotal = 0;
  private _structuredErrorsTotal = 0;
  private _rateLimitRejections = 0;
  private _circuitBreakerOpens = 0;
  private _circuitBreakerState = 0; // 0=closed, 1=open, 2=half-open
  private _upstreamErrors = 0;
  private readonly _errorLog: StructuredLogEntry[] = [];

  // --- Turn counters ---

  recordTurnStart(): void {
    this._turnsTotal++;
    this._turnsActive++;
  }

  recordTurnSuccess(): void {
    this._turnsSuccess++;
    if (this._turnsActive > 0) this._turnsActive--;
  }

  recordTurnError(): void {
    this._turnsError++;
    if (this._turnsActive > 0) this._turnsActive--;
  }

  /** Override the gauge directly (e.g. from live httpTurns.count()) */
  setActiveTurns(count: number): void {
    this._turnsActive = count >= 0 ? count : 0;
  }

  // --- Spooler counters ---

  recordSpoolerWrite(bytes: number): void {
    this._spoolerBytesWritten += bytes;
    this._spoolerFilesWritten++;
  }

  recordSpoolerGc(bytesFreed: number): void {
    this._spoolerBytesFreed += bytesFreed;
  }

  // --- Janitor counters ---

  recordJanitorRun(opts: { filesPruned: number; bytesReclaimed: number; error: boolean }): void {
    this._janitorRunsTotal++;
    this._janitorFilesPruned += opts.filesPruned;
    this._janitorBytesReclaimed += opts.bytesReclaimed;
    if (opts.error) {
      this._janitorRunsError++;
      this._janitorConsecutiveErrors++;
    } else {
      this._janitorConsecutiveErrors = 0;
    }
  }

  // --- Compaction / checkpoint counters ---

  recordCheckpointWritten(): void {
    this._checkpointsWritten++;
  }

  recordCompaction(): void {
    this._compactionsTotal++;
  }

  // --- Sprint AG: Rate limiter & circuit breaker counters ---

  recordRateLimitRejection(): void {
    this._rateLimitRejections++;
  }

  recordCircuitBreakerOpen(): void {
    this._circuitBreakerOpens++;
    this._circuitBreakerState = 1;
  }

  /** Set current circuit breaker state gauge: 0=closed, 1=open, 2=half-open */
  setCircuitBreakerState(state: 0 | 1 | 2): void {
    this._circuitBreakerState = state;
  }

  recordUpstreamError(): void {
    this._upstreamErrors++;
  }


  // --- Structured error logging ---

  logStructuredError(entry: Omit<StructuredLogEntry, "recorded_at">): void {
    this._structuredErrorsTotal++;
    const full: StructuredLogEntry = { ...entry, recorded_at: new Date().toISOString() };
    this._errorLog.push(full);
    // Rolling window: keep only last MAX_ERROR_LOG_ENTRIES
    if (this._errorLog.length > MAX_ERROR_LOG_ENTRIES) {
      this._errorLog.splice(0, this._errorLog.length - MAX_ERROR_LOG_ENTRIES);
    }
  }

  /** Returns the most recent N error log entries (latest first) */
  getRecentErrors(n = 10): StructuredLogEntry[] {
    return this._errorLog.slice(-n).reverse();
  }

  // --- Alerts ---

  getAlerts(): RuntimeAlert[] {
    const alerts: RuntimeAlert[] = [];
    if (this._janitorConsecutiveErrors >= JANITOR_ALERT_THRESHOLD) {
      alerts.push({
        alert_id: "janitor_consecutive_errors",
        severity: this._janitorConsecutiveErrors >= 5 ? "critical" : "warning",
        message: `Session janitor has failed ${this._janitorConsecutiveErrors} consecutive run(s). Check last_error in /healthz session_janitor section.`,
        detected_at: new Date().toISOString(),
      });
    }
    return alerts;
  }

  // --- Snapshot ---

  getSnapshot(): RuntimeMetricsSnapshot {
    return {
      turns_total: this._turnsTotal,
      turns_success: this._turnsSuccess,
      turns_error: this._turnsError,
      turns_active: this._turnsActive,
      spooler_bytes_written: this._spoolerBytesWritten,
      spooler_files_written: this._spoolerFilesWritten,
      spooler_bytes_freed: this._spoolerBytesFreed,
      janitor_files_pruned: this._janitorFilesPruned,
      janitor_bytes_reclaimed: this._janitorBytesReclaimed,
      janitor_runs_total: this._janitorRunsTotal,
      janitor_runs_error: this._janitorRunsError,
      janitor_consecutive_errors: this._janitorConsecutiveErrors,
      checkpoints_written: this._checkpointsWritten,
      compactions_total: this._compactionsTotal,
      structured_errors_total: this._structuredErrorsTotal,
      rate_limit_rejections: this._rateLimitRejections,
      circuit_breaker_opens: this._circuitBreakerOpens,
      circuit_breaker_state: this._circuitBreakerState,
      upstream_errors: this._upstreamErrors,
      snapshot_at: new Date().toISOString(),
    };
  }

  // --- Prometheus text format ---

  serializePrometheusMetrics(prefix = "codex_chatgpt_web"): string {
    const s = this.getSnapshot();
    const lines: string[] = [];

    const gauge = (name: string, help: string, value: number) => {
      lines.push(`# HELP ${prefix}_${name} ${help}`);
      lines.push(`# TYPE ${prefix}_${name} gauge`);
      lines.push(`${prefix}_${name} ${value}`);
    };

    const counter = (name: string, help: string, value: number) => {
      lines.push(`# HELP ${prefix}_${name} ${help}`);
      lines.push(`# TYPE ${prefix}_${name} counter`);
      lines.push(`${prefix}_${name}_total ${value}`);
    };

    counter("turns", "Total number of turns received", s.turns_total);
    counter("turns_success", "Total number of turns completed successfully", s.turns_success);
    counter("turns_error", "Total number of turns that ended in error", s.turns_error);
    gauge("turns_active", "Currently active HTTP turns", s.turns_active);
    counter("spooler_bytes_written", "Total bytes written to spooler files", s.spooler_bytes_written);
    counter("spooler_files_written", "Total spooler files written", s.spooler_files_written);
    counter("spooler_bytes_freed", "Total bytes freed by spooler GC", s.spooler_bytes_freed);
    counter("janitor_files_pruned", "Total rollout files pruned by session janitor", s.janitor_files_pruned);
    counter("janitor_bytes_reclaimed", "Total bytes reclaimed by session janitor", s.janitor_bytes_reclaimed);
    counter("janitor_runs", "Total session janitor run invocations", s.janitor_runs_total);
    counter("janitor_runs_error", "Total session janitor runs that encountered an error", s.janitor_runs_error);
    gauge("janitor_consecutive_errors", "Consecutive session janitor runs that ended in error", s.janitor_consecutive_errors);
    counter("checkpoints_written", "Total checkpoints written to .agents/checkpoints/", s.checkpoints_written);
    counter("compactions", "Total successful context compactions", s.compactions_total);
    counter("structured_errors", "Total structured errors logged", s.structured_errors_total);
    counter("rate_limit_rejections", "Total requests rejected by the rate limiter", s.rate_limit_rejections);
    counter("circuit_breaker_opens", "Total times the circuit breaker transitioned to OPEN", s.circuit_breaker_opens);
    gauge("circuit_breaker_state", "Current circuit breaker state (0=closed, 1=open, 2=half-open)", s.circuit_breaker_state);
    counter("upstream_errors", "Total upstream call errors recorded", s.upstream_errors);

    // Trailing newline required by Prometheus text format
    return lines.join("\n") + "\n";
  }

  /** Build a unified admin status JSON snapshot */
  buildAdminStatus(opts: {
    daemonPid: number;
    version: string;
    mode: string;
    uptimeMs: number;
    janitorStats?: Record<string, unknown>;
    tunnelStats?: Record<string, unknown>;
    sessionCount?: number;
    sessionBytes?: number;
  }): Record<string, unknown> {
    const snap = this.getSnapshot();
    const alerts = this.getAlerts();
    return {
      status: alerts.some(a => a.severity === "critical") ? "degraded" : alerts.length > 0 ? "warning" : "ok",
      daemon: {
        pid: opts.daemonPid,
        version: opts.version,
        mode: opts.mode,
        uptime_seconds: opts.uptimeMs / 1_000,
      },
      metrics: snap,
      alerts,
      janitor: opts.janitorStats ?? null,
      tunnel: opts.tunnelStats ?? null,
      session_store: {
        files: opts.sessionCount ?? null,
        bytes: opts.sessionBytes ?? null,
      },
      recent_errors: this.getRecentErrors(5),
    };
  }

  /** Reset all counters — only for use in tests */
  _resetForTest(): void {
    this._turnsTotal = 0;
    this._turnsSuccess = 0;
    this._turnsError = 0;
    this._turnsActive = 0;
    this._spoolerBytesWritten = 0;
    this._spoolerFilesWritten = 0;
    this._spoolerBytesFreed = 0;
    this._janitorFilesPruned = 0;
    this._janitorBytesReclaimed = 0;
    this._janitorRunsTotal = 0;
    this._janitorRunsError = 0;
    this._janitorConsecutiveErrors = 0;
    this._checkpointsWritten = 0;
    this._compactionsTotal = 0;
    this._structuredErrorsTotal = 0;
    this._rateLimitRejections = 0;
    this._circuitBreakerOpens = 0;
    this._circuitBreakerState = 0;
    this._upstreamErrors = 0;
    this._errorLog.splice(0);
  }
}

/** Singleton metrics collector — import and use anywhere in the server */
export const runtimeMetrics = new RuntimeMetricsCollector();
