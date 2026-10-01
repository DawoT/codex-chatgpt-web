import { describe, expect, test } from "bun:test";
import { ChatGptTurnCompletionFsm } from "../src/adapters/chatgpt-web/browser/turn-completion-fsm";
import type { BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker/types";
import {
  gracefulYieldNoticeText,
  injectGracefulYieldNoticeIfRecommended,
  isUrgentCompactionNotice,
  shouldInjectGracefulYieldNotice,
} from "../src/adapters/chatgpt-web/turn-broker/yield-notice";

describe("Sprint 3: Graceful Yielding Protocol & Compaction Handoff", () => {
  describe("Graceful Yield Advisory Generator", () => {
    test("does not inject advisory notice during optimal working zone (< 50 tools)", () => {
      expect(shouldInjectGracefulYieldNotice(1)).toBe(false);
      expect(shouldInjectGracefulYieldNotice(30)).toBe(false);
      expect(shouldInjectGracefulYieldNotice(49)).toBe(false);
    });

    test("activates graceful yield notice in completion window (50 <= N <= 70 tools)", () => {
      expect(shouldInjectGracefulYieldNotice(50)).toBe(true);
      expect(shouldInjectGracefulYieldNotice(58)).toBe(true);
      expect(shouldInjectGracefulYieldNotice(65)).toBe(true);
      expect(shouldInjectGracefulYieldNotice(70)).toBe(true);

      const notice50 = gracefulYieldNoticeText(50);
      expect(notice50).toContain("50 actions completed");
      expect(notice50).not.toContain("so context compaction can run");
      expect(isUrgentCompactionNotice(50)).toBe(false);
    });

    test("large tool bursts advise a phase boundary without claiming context exhaustion", () => {
      expect(isUrgentCompactionNotice(70)).toBe(false);
      expect(isUrgentCompactionNotice(75)).toBe(false);

      const urgentNotice = gracefulYieldNoticeText(75);
      expect(urgentNotice).not.toContain("prevent tab crash");
      expect(urgentNotice).toContain("75 actions");
    });

    test("an explicit compaction requirement reaches the model even after one completed tool", () => {
      const result = injectGracefulYieldNoticeIfRecommended({ content: [] }, 1, true);
      expect(result.content).toHaveLength(1);
      expect((result.content[0] as { text: string }).text).toContain("compaction");
      expect(isUrgentCompactionNotice(1, true)).toBe(true);
    });

    test("injects notice into BrokerToolResult content cleanly without mutating original payload", () => {
      const originalResult: BrokerToolResult = {
        content: [{ type: "text", text: "Successfully edited file.ts" }],
        isError: false,
      };

      // Before threshold
      const untouched = injectGracefulYieldNoticeIfRecommended(originalResult, 45);
      expect(untouched.content.length).toBe(1);

      // At threshold (55 tools)
      const advised = injectGracefulYieldNoticeIfRecommended(originalResult, 55);
      expect(advised.content.length).toBe(2);
      expect(advised.content[0]).toEqual({ type: "text", text: "Successfully edited file.ts" });
      expect((advised.content[1] as { text: string }).text).toContain("55 actions completed");
      expect(originalResult.content.length).toBe(1); // immutability preserved
    });
  });

  describe("TurnCompletionFsm with Graceful Yield", () => {
    test("FSM supports completion when yieldRecommended is active", () => {
      const fsm = new ChatGptTurnCompletionFsm({ fenced: true });

      // Model finishes generating after receiving yield notice
      const decision = fsm.observe({
        responsePresent: true,
        completionReady: true,
        externalToolCallsInFlight: false,
        externalProgressLive: false,
        yieldRecommended: true,
      });

      expect(decision.phase).toBe("settling");
      expect(decision.action).toBe("fence_begin");

      fsm.fenceAccepted();
      const freshReadDecision = fsm.observe({
        responsePresent: true,
        completionReady: true,
        externalToolCallsInFlight: false,
        externalProgressLive: false,
        yieldRecommended: true,
      });
      expect(freshReadDecision.action).toBe("fresh_read");

      const commitDecision = fsm.observe({
        responsePresent: true,
        completionReady: true,
        externalToolCallsInFlight: false,
        externalProgressLive: false,
        yieldRecommended: true,
      });
      expect(commitDecision.action).toBe("fence_commit");

      fsm.fenceCommitted(true);
      const finalDecision = fsm.observe({
        responsePresent: true,
        completionReady: true,
        externalToolCallsInFlight: false,
        externalProgressLive: false,
      });
      expect(finalDecision.phase).toBe("completed");
      expect(finalDecision.action).toBe("finish");
    });

    test("FSM transitions cleanly to completed when compaction handoff is observed", () => {
      const fsm = new ChatGptTurnCompletionFsm({ fenced: true });
      const decision = fsm.compactionHandoffObserved();
      expect(decision.phase).toBe("completed");
      expect(decision.action).toBe("finish");
      expect(fsm.phase).toBe("completed");
    });
  });
});
