import { describe, expect, test } from "bun:test";
import { chatGptExternalProgressSuppressesDomHealth } from "../src/adapters/chatgpt-web/browser/dom-trackers";
import {
  isMultiChannelLivenessActive,
  type MultiChannelLivenessSnapshot,
  resolveAdaptiveObservationProbeTimeoutMs,
} from "../src/adapters/chatgpt-web/browser/suspension-clock";
import { chatGptExternalToolCallsAreInFlight } from "../src/adapters/chatgpt-web/turn-progress";

describe("Sprint 1: Event-Driven DOM Liveness & Dynamic Probe Horizon", () => {
  describe("resolveAdaptiveObservationProbeTimeoutMs", () => {
    test("returns baseline timeout for clean / small DOM", () => {
      const timeout = resolveAdaptiveObservationProbeTimeoutMs(0, 0);
      expect(timeout).toBeGreaterThanOrEqual(6_000);
      expect(timeout).toBeLessThanOrEqual(7_000);
    });

    test("scales dynamically with DOM size to prevent false timeouts on large turn histories", () => {
      // For 460k chars (Agent 1 size), probe budget should expand ~9,200ms above base
      const timeout460k = resolveAdaptiveObservationProbeTimeoutMs(460_000, 0);
      expect(timeout460k).toBeGreaterThanOrEqual(15_000);
      expect(timeout460k).toBeLessThanOrEqual(20_000);

      // For 1M chars (Agent 2 size), probe budget should expand ~20,000ms above base
      const timeout1M = resolveAdaptiveObservationProbeTimeoutMs(1_000_000, 0);
      expect(timeout1M).toBeGreaterThanOrEqual(25_000);
      expect(timeout1M).toBeLessThanOrEqual(30_000);
    });

    test("caps maximum probe timeout at safe ceiling (30s)", () => {
      const timeoutHuge = resolveAdaptiveObservationProbeTimeoutMs(5_000_000, 0);
      expect(timeoutHuge).toBe(30_000);
    });

    test("maintains a minimum safe floor of 6,000ms even when tools are active", () => {
      const timeoutWithTools = resolveAdaptiveObservationProbeTimeoutMs(0, 5);
      expect(timeoutWithTools).toBeGreaterThanOrEqual(6_000);
    });
  });

  describe("Multi-channel event-driven liveness", () => {
    test("declares active when tool calls are actively in flight", () => {
      const snapshot: MultiChannelLivenessSnapshot = {
        activeToolCalls: 2,
        inFlightCalls: true,
        lastBrokerEventAt: Date.now() - 120_000, // old event, but tool in flight
      };
      expect(isMultiChannelLivenessActive(snapshot)).toBe(true);
    });

    test("declares active when recent broker event arrived within silence threshold", () => {
      const now = 1_000_000;
      const snapshot: MultiChannelLivenessSnapshot = {
        activeToolCalls: 0,
        inFlightCalls: false,
        lastBrokerEventAt: now - 30_000, // 30s ago (< 90s)
      };
      expect(isMultiChannelLivenessActive(snapshot, now)).toBe(true);
    });

    test("declares active when recent DOM mutation arrived within silence threshold", () => {
      const now = 1_000_000;
      const snapshot: MultiChannelLivenessSnapshot = {
        activeToolCalls: 0,
        inFlightCalls: false,
        lastDomMutationAt: now - 45_000, // 45s ago (< 90s)
      };
      expect(isMultiChannelLivenessActive(snapshot, now)).toBe(true);
    });

    test("declares deadman switch triggered only after catastrophic silence across all channels (>90s)", () => {
      const now = 1_000_000;
      const snapshot: MultiChannelLivenessSnapshot = {
        activeToolCalls: 0,
        inFlightCalls: false,
        lastBrokerEventAt: now - 95_000,
        lastDomMutationAt: now - 100_000,
        lastNetworkChunkAt: now - 110_000,
      };
      expect(isMultiChannelLivenessActive(snapshot, now)).toBe(false);
    });
  });

  describe("External progress suppression of DOM timeout faults", () => {
    test("suppresses DOM timeout when tool calls are in flight", () => {
      const progress = {
        activeToolCalls: 1,
        lastDeliveredCallId: "call_test_123",
        lastCompletedCallId: undefined,
        lastProgressAt: Date.now() - 5_000,
        lastToolBatchRevision: 1,
        acknowledgedToolBatchRevision: 0,
      };
      expect(chatGptExternalToolCallsAreInFlight(progress)).toBe(true);
      expect(chatGptExternalProgressSuppressesDomHealth(progress, Date.now())).toBe(true);
    });
  });
});
