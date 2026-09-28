export const CHATGPT_BROWSER_DOM_COMPACTION_CHAR_LIMIT = 600_000;
export const CHATGPT_BROWSER_SLOW_OBSERVATION_MS = 5_000;
export const CHATGPT_BROWSER_SLOW_OBSERVATION_STREAK = 2;

export type ChatGptBrowserContextPressureReason = "slow_observations";

export interface ChatGptBrowserContextPressureSnapshot {
  compactionRequired: boolean;
  recoveryRequired: boolean;
  watchDomSize: boolean;
  reason?: ChatGptBrowserContextPressureReason;
  observedDomChars: number;
  consecutiveSlowObservations: number;
}

export class ChatGptBrowserContextPressure {
  private observedDomChars = 0;
  private consecutiveSlowObservations = 0;
  private reason?: ChatGptBrowserContextPressureReason;
  private recoveryRequired = false;
  private recovered = false;

  recordObservation(observation: { domChars: number; elapsedMs: number }): void {
    if (!Number.isFinite(observation.domChars) || observation.domChars < 0) {
      throw new Error("ChatGPT browser DOM observation size must be finite and non-negative");
    }
    if (!Number.isFinite(observation.elapsedMs) || observation.elapsedMs < 0) {
      throw new Error("ChatGPT browser DOM observation latency must be finite and non-negative");
    }
    this.observedDomChars = observation.domChars;
    if (observation.elapsedMs < CHATGPT_BROWSER_SLOW_OBSERVATION_MS) {
      this.consecutiveSlowObservations = 0;
      this.recoveryRequired = false;
      this.recovered = false;
      this.reason = undefined;
      return;
    }
    this.consecutiveSlowObservations += 1;
    if (this.recovered) {
      this.reason = "slow_observations";
    } else if (this.consecutiveSlowObservations >= CHATGPT_BROWSER_SLOW_OBSERVATION_STREAK) {
      this.recoveryRequired = true;
    }
  }

  recordRecovery(): void {
    if (!this.recoveryRequired) return;
    this.recoveryRequired = false;
    this.recovered = true;
    this.consecutiveSlowObservations = 0;
  }

  snapshot(): ChatGptBrowserContextPressureSnapshot {
    return {
      compactionRequired: this.reason !== undefined,
      recoveryRequired: this.recoveryRequired,
      watchDomSize: this.observedDomChars > CHATGPT_BROWSER_DOM_COMPACTION_CHAR_LIMIT,
      ...(this.reason ? { reason: this.reason } : {}),
      observedDomChars: this.observedDomChars,
      consecutiveSlowObservations: this.consecutiveSlowObservations,
    };
  }

  reset(): void {
    this.observedDomChars = 0;
    this.consecutiveSlowObservations = 0;
    this.reason = undefined;
    this.recoveryRequired = false;
    this.recovered = false;
  }
}
