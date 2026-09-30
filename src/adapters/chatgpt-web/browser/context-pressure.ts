import type { Page } from "playwright-core";
import { withChatGptBrowserObservationTimeout } from "./suspension-clock";

export class ChatGptPageDomObserver {
  private readonly lastMeasurementByPage = new WeakMap<Page, number>();

  constructor(private readonly minimumGapMs = 5_000) {}

  async measure(
    page: Page,
    changed: boolean,
    observationStarted: number,
    pressure: () => ChatGptBrowserContextPressure,
    now = performance.now(),
  ): Promise<void> {
    if (!changed || now - (this.lastMeasurementByPage.get(page) ?? -Infinity) < this.minimumGapMs) return;
    this.lastMeasurementByPage.set(page, now);
    const probeStarted = performance.now();
    const domChars = await withChatGptBrowserObservationTimeout(
      page.evaluate(() => document.documentElement?.innerHTML.length ?? 0),
    );
    if (typeof domChars !== "number") return;
    pressure().recordObservation({
      domChars,
      elapsedMs: Math.max(now - observationStarted, performance.now() - probeStarted),
    });
  }
}

export const CHATGPT_BROWSER_DOM_COMPACTION_CHAR_LIMIT = 600_000;
export const CHATGPT_BROWSER_DOM_CEILING_CHAR_LIMIT = 800_000;
export const CHATGPT_BROWSER_SLOW_OBSERVATION_MS = 5_000;
export const CHATGPT_BROWSER_SLOW_OBSERVATION_STREAK = 2;

export const CHATGPT_OPTIMAL_TOOL_BURST_LIMIT = 50;
export const CHATGPT_YIELD_TOOL_BURST_LIMIT = 65;
export const CHATGPT_CEILING_TOOL_BURST_LIMIT = 70;
export const CHATGPT_TOKEN_SATURATION_CEILING = 55_000;

export type ChatGptBrowserContextPressureReason = "slow_observations";

export interface RiskAssessment {
  riskScore: number; // 0.00 to 1.00
  domPressureRatio: number; // 0.00 to 1.00
  toolBurstRatio: number; // 0.00 to 1.00
  tokenPressureRatio: number; // 0.00 to 1.00
  yieldRecommended: boolean; // riskScore >= 0.70
  compactionUrgent: boolean; // riskScore >= 0.85
  continuousToolCallsCount: number;
}

export interface PredictiveRiskInput {
  continuousToolCallsCount?: number;
  domChars?: number;
  estimatedTokens?: number;
}

/**
 * Calculates predictive context saturation risk R(t) in [0.0, 1.0].
 * Calibrated against empirical production telemetry:
 * - Optimal zone (N <= 50 tools, DOM < 450k): R < 0.60
 * - Completion window (50 < N <= 65 tools): 0.60 <= R < 0.85, yieldRecommended = true
 * - Saturation ceiling (N >= 70 tools or DOM >= 800k): R >= 0.85, compactionUrgent = true
 */
export function calculatePredictiveContextRisk(input: PredictiveRiskInput): RiskAssessment {
  const tools = Math.max(0, input.continuousToolCallsCount ?? 0);
  const dom = Math.max(0, input.domChars ?? 0);
  const tokens = Math.max(0, input.estimatedTokens ?? 0);

  // Tool burst ratio calibrated against empirical golden boundary
  let toolBurstRatio = 0;
  if (tools <= CHATGPT_OPTIMAL_TOOL_BURST_LIMIT) {
    toolBurstRatio = (tools / CHATGPT_OPTIMAL_TOOL_BURST_LIMIT) * 0.6;
  } else if (tools <= CHATGPT_YIELD_TOOL_BURST_LIMIT) {
    const progress =
      (tools - CHATGPT_OPTIMAL_TOOL_BURST_LIMIT) / (CHATGPT_YIELD_TOOL_BURST_LIMIT - CHATGPT_OPTIMAL_TOOL_BURST_LIMIT);
    toolBurstRatio = 0.6 + progress * 0.2;
  } else {
    const progress = Math.min(
      1.0,
      (tools - CHATGPT_YIELD_TOOL_BURST_LIMIT) / (CHATGPT_CEILING_TOOL_BURST_LIMIT - CHATGPT_YIELD_TOOL_BURST_LIMIT),
    );
    toolBurstRatio = 0.8 + progress * 0.2;
  }

  const domPressureRatio = Math.min(1.0, dom / CHATGPT_BROWSER_DOM_CEILING_CHAR_LIMIT);
  const tokenPressureRatio = Math.min(1.0, tokens / CHATGPT_TOKEN_SATURATION_CEILING);

  const riskScore = Math.min(1.0, Math.max(toolBurstRatio, domPressureRatio, tokenPressureRatio));

  return {
    riskScore: Number(riskScore.toFixed(4)),
    domPressureRatio: Number(domPressureRatio.toFixed(4)),
    toolBurstRatio: Number(toolBurstRatio.toFixed(4)),
    tokenPressureRatio: Number(tokenPressureRatio.toFixed(4)),
    yieldRecommended: riskScore >= 0.7,
    compactionUrgent: riskScore >= 0.85,
    continuousToolCallsCount: tools,
  };
}

export interface ChatGptBrowserContextPressureSnapshot {
  compactionRequired: boolean;
  recoveryRequired: boolean;
  watchDomSize: boolean;
  reason?: ChatGptBrowserContextPressureReason;
  observedDomChars: number;
  consecutiveSlowObservations: number;
  continuousToolCallsCount: number;
  estimatedTokens: number;
  riskAssessment: RiskAssessment;
}

export class ChatGptBrowserContextPressure {
  private observedDomChars = 0;
  private consecutiveSlowObservations = 0;
  private reason?: ChatGptBrowserContextPressureReason;
  private recoveryRequired = false;
  private recovered = false;
  private continuousToolCallsCount = 0;
  private estimatedTokens = 0;

  recordToolCallCompleted(): void {
    this.continuousToolCallsCount += 1;
  }

  recordTokens(tokens: number): void {
    if (Number.isFinite(tokens) && tokens > this.estimatedTokens) {
      this.estimatedTokens = tokens;
    }
  }

  calculateRisk(): RiskAssessment {
    return calculatePredictiveContextRisk({
      continuousToolCallsCount: this.continuousToolCallsCount,
      domChars: this.observedDomChars,
      estimatedTokens: this.estimatedTokens,
    });
  }

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
      continuousToolCallsCount: this.continuousToolCallsCount,
      estimatedTokens: this.estimatedTokens,
      riskAssessment: this.calculateRisk(),
    };
  }

  reset(): void {
    this.observedDomChars = 0;
    this.consecutiveSlowObservations = 0;
    this.reason = undefined;
    this.recoveryRequired = false;
    this.recovered = false;
    this.continuousToolCallsCount = 0;
    this.estimatedTokens = 0;
  }
}
