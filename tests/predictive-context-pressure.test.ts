import { describe, expect, test } from "bun:test";
import {
  ChatGptBrowserContextPressure,
  calculatePredictiveContextRisk,
} from "../src/adapters/chatgpt-web/browser/context-pressure";

describe("Sprint 2: Predictive Risk Formula R(t) & Context Pressure", () => {
  describe("calculatePredictiveContextRisk", () => {
    test("returns low risk (R < 0.60) in the optimal working zone (N <= 50 tools, DOM < 450k)", () => {
      // 20 tools, 200k DOM chars, 15k tokens
      const risk = calculatePredictiveContextRisk({
        continuousToolCallsCount: 20,
        domChars: 200_000,
        estimatedTokens: 15_000,
      });

      expect(risk.riskScore).toBeLessThan(0.6);
      expect(risk.yieldRecommended).toBe(false);
      expect(risk.compactionUrgent).toBe(false);
    });

    test("accurately assesses Agent 1 empirical data (75 tools, 463k DOM chars)", () => {
      // Agent 1 completed 75 tools cleanly but reached the golden upper boundary
      const risk = calculatePredictiveContextRisk({
        continuousToolCallsCount: 75,
        domChars: 462_964,
        estimatedTokens: 38_000,
      });

      expect(risk.toolBurstRatio).toBeGreaterThanOrEqual(0.85);
      expect(risk.yieldRecommended).toBe(true);
      expect(risk.compactionUrgent).toBe(true);
    });

    test("recommends graceful yield (R >= 0.70) in the completion window (50 < N <= 65 tools)", () => {
      const risk58 = calculatePredictiveContextRisk({
        continuousToolCallsCount: 58,
        domChars: 350_000,
        estimatedTokens: 25_000,
      });

      expect(risk58.riskScore).toBeGreaterThanOrEqual(0.7);
      expect(risk58.yieldRecommended).toBe(true);
      expect(risk58.compactionUrgent).toBe(false);
    });

    test("flags urgent compaction (R >= 0.85) when approaching dangerous 70+ tool mark", () => {
      const risk70 = calculatePredictiveContextRisk({
        continuousToolCallsCount: 70,
        domChars: 450_000,
        estimatedTokens: 35_000,
      });

      expect(risk70.riskScore).toBeGreaterThanOrEqual(0.85);
      expect(risk70.yieldRecommended).toBe(true);
      expect(risk70.compactionUrgent).toBe(true);
    });

    test("saturates risk if DOM exceeds 800k chars regardless of tool count", () => {
      const riskDomHeavy = calculatePredictiveContextRisk({
        continuousToolCallsCount: 10,
        domChars: 850_000,
        estimatedTokens: 10_000,
      });

      expect(riskDomHeavy.domPressureRatio).toBe(1.0);
      expect(riskDomHeavy.riskScore).toBe(1.0);
      expect(riskDomHeavy.compactionUrgent).toBe(true);
    });
  });

  describe("ChatGptBrowserContextPressure integration", () => {
    test("tracks continuous tool calls and updates risk assessment dynamically", () => {
      const pressure = new ChatGptBrowserContextPressure();

      for (let i = 0; i < 30; i++) {
        pressure.recordToolCallCompleted();
      }

      let assessment = pressure.calculateRisk();
      expect(assessment.continuousToolCallsCount).toBe(30);
      expect(assessment.yieldRecommended).toBe(false);

      for (let i = 0; i < 30; i++) {
        pressure.recordToolCallCompleted();
      }

      assessment = pressure.calculateRisk();
      expect(assessment.continuousToolCallsCount).toBe(60);
      expect(assessment.yieldRecommended).toBe(true);

      const snapshot = pressure.snapshot();
      expect(snapshot.riskAssessment.yieldRecommended).toBe(true);
    });

    test("propagates urgent predictive risk into compactionRequired", () => {
      const pressure = new ChatGptBrowserContextPressure();
      for (let i = 0; i < 70; i++) {
        pressure.recordToolCallCompleted();
      }

      const snapshot = pressure.snapshot();
      expect(snapshot.riskAssessment.compactionUrgent).toBe(true);
      expect(snapshot.compactionRequired).toBe(true);
    });

    test("reset clears continuous tool call counter and risk score", () => {
      const pressure = new ChatGptBrowserContextPressure();
      for (let i = 0; i < 60; i++) {
        pressure.recordToolCallCompleted();
      }
      expect(pressure.calculateRisk().yieldRecommended).toBe(true);

      pressure.reset();
      const after = pressure.calculateRisk();
      expect(after.continuousToolCallsCount).toBe(0);
      expect(after.riskScore).toBeLessThan(0.1);
      expect(after.yieldRecommended).toBe(false);
    });

    test("a viable fresh prompt does not force native compaction solely from the remote retention heuristic", () => {
      const pressure = new ChatGptBrowserContextPressure();
      pressure.beginResponse(50_000, false);
      expect(pressure.snapshot().riskAssessment.compactionUrgent).toBe(true);
      expect(pressure.snapshot().compactionRequired).toBe(false);
    });
  });
});
