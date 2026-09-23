export type SessionStatus = "authenticated" | "warning_near_expiry" | "expired" | "unknown";

export interface SessionHealthReport {
  status: SessionStatus;
  expires_at: number | null;
  seconds_remaining: number | null;
  warning_near_expiry: boolean;
  last_probe_at: number | null;
  last_probe_ok: boolean | null;
  last_error: string | null;
  watchdog_active: boolean;
  refresh_success_count: number;
  refresh_failure_count: number;
}

export class SessionExpiredPreflightError extends Error {
  readonly code = "session_expired_preflight";
  readonly status = 401;
  readonly retryable = false;

  constructor(message: string = "ChatGPT web session has expired or is invalid. Re-authentication required.") {
    super(message);
    this.name = "SessionExpiredPreflightError";
  }
}

export class SessionHealthGuard {
  private status: SessionStatus = "unknown";
  private expiresAt: number | null = null;
  private lastProbeAt: number | null = null;
  private lastProbeOk: boolean | null = null;
  private lastError: string | null = null;
  private readonly warningThresholdSeconds: number;
  private watchdogTimer?: ReturnType<typeof setInterval>;
  private refreshInProgress = false;
  private refreshSuccessCount = 0;
  private refreshFailureCount = 0;

  constructor(warningThresholdSeconds: number = 300) {
    this.warningThresholdSeconds = warningThresholdSeconds;
  }

  recordProbe(success: boolean, expiresAt?: number | null, error?: string | null): void {
    this.lastProbeAt = Date.now();
    this.lastProbeOk = success;
    if (expiresAt !== undefined) {
      this.expiresAt = expiresAt;
    }
    if (error !== undefined) {
      this.lastError = error;
    }

    if (!success) {
      this.status = "expired";
      return;
    }

    this.status = "authenticated";
    this.recomputeStatus();
  }

  recordExplicitExpiry(errorMsg: string = "ChatGPT session expired"): void {
    this.status = "expired";
    this.lastProbeAt = Date.now();
    this.lastProbeOk = false;
    this.lastError = errorMsg;
  }

  recordAuthenticationSuccess(expiresAt?: number | null): void {
    this.status = "authenticated";
    this.lastProbeAt = Date.now();
    this.lastProbeOk = true;
    this.lastError = null;
    if (expiresAt !== undefined) {
      this.expiresAt = expiresAt;
    }
    this.recomputeStatus();
  }

  private recomputeStatus(): void {
    if (this.expiresAt === null) {
      return;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const remaining = this.expiresAt - nowSeconds;

    if (remaining <= 0) {
      this.status = "expired";
    } else if (remaining <= this.warningThresholdSeconds) {
      this.status = "warning_near_expiry";
    } else {
      this.status = "authenticated";
    }
  }

  startWatchdog(
    intervalMs: number = 60_000,
    probeFn?: () => Promise<{ success: boolean; expiresAt?: number | null; error?: string | null }>,
    refreshFn?: () => Promise<boolean>,
  ): void {
    this.stopWatchdog();
    this.watchdogTimer = setInterval(async () => {
      if (probeFn) {
        try {
          const res = await probeFn();
          this.recordProbe(res.success, res.expiresAt, res.error);
        } catch (err) {
          this.recordProbe(false, undefined, err instanceof Error ? err.message : String(err));
        }
      } else {
        this.recomputeStatus();
      }

      if (
        (this.status === "warning_near_expiry" || this.status === "expired") &&
        refreshFn &&
        !this.refreshInProgress
      ) {
        this.refreshInProgress = true;
        try {
          const ok = await refreshFn();
          if (ok) {
            this.refreshSuccessCount += 1;
            this.status = "authenticated";
            this.lastError = null;
          } else {
            this.refreshFailureCount += 1;
          }
        } catch {
          this.refreshFailureCount += 1;
        } finally {
          this.refreshInProgress = false;
        }
      }
    }, intervalMs);
  }

  stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  isWatchdogActive(): boolean {
    return this.watchdogTimer !== undefined;
  }

  assertCanRunTurn(): void {
    this.recomputeStatus();
    if (this.status === "expired") {
      throw new SessionExpiredPreflightError(
        this.lastError ?? "ChatGPT web session has expired. Please log in again to continue.",
      );
    }
  }

  getStats(): SessionHealthReport {
    this.recomputeStatus();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const secondsRemaining = this.expiresAt !== null ? Math.max(0, this.expiresAt - nowSeconds) : null;
    return {
      status: this.status,
      expires_at: this.expiresAt,
      seconds_remaining: secondsRemaining,
      warning_near_expiry: this.status === "warning_near_expiry",
      last_probe_at: this.lastProbeAt,
      last_probe_ok: this.lastProbeOk,
      last_error: this.lastError,
      watchdog_active: this.isWatchdogActive(),
      refresh_success_count: this.refreshSuccessCount,
      refresh_failure_count: this.refreshFailureCount,
    };
  }

  reset(): void {
    this.stopWatchdog();
    this.status = "unknown";
    this.expiresAt = null;
    this.lastProbeAt = null;
    this.lastProbeOk = null;
    this.lastError = null;
    this.refreshInProgress = false;
    this.refreshSuccessCount = 0;
    this.refreshFailureCount = 0;
  }
}

export const sessionHealthGuard = new SessionHealthGuard();
