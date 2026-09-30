import { describe, expect, it } from "bun:test";
import { submittedTurnFailure } from "../src/adapters/chatgpt-web/adapter/tool-lifecycle";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptTurnDomHealthTracker } from "../src/adapters/chatgpt-web/browser/dom-trackers";
import { ChatGptTurnEventBus } from "../src/adapters/chatgpt-web/browser/turn-events";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import type { ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";

describe("Compaction Event-Driven Liveness & DOM Health Architecture", () => {
  describe("ChatGptTurnDomHealthTracker with Multi-Channel Liveness", () => {
    it("suppresses missing-response detection while multiChannelLivenessActive is true", () => {
      const tracker = new ChatGptTurnDomHealthTracker(1_000, 500);
      const absentWithLiveness = {
        responsePresent: false,
        running: false,
        currentText: "",
        completionActionVisible: false,
        multiChannelLivenessActive: true,
      };

      // Turn starts without response present, but broker or tool liveness is active
      expect(tracker.update(absentWithLiveness, 1_000)).toBeUndefined();
      // Even 30 seconds later, multi-channel liveness holds the missing response window closed
      expect(tracker.update(absentWithLiveness, 30_000)).toBeUndefined();
    });

    it("begins missing-response window only after multiChannelLivenessActive lapses", () => {
      const tracker = new ChatGptTurnDomHealthTracker(1_000, 500);
      const absentWithLiveness = {
        responsePresent: false,
        running: false,
        currentText: "",
        completionActionVisible: false,
        multiChannelLivenessActive: true,
      };

      expect(tracker.update(absentWithLiveness, 1_000)).toBeUndefined();
      expect(tracker.update(absentWithLiveness, 10_000)).toBeUndefined();

      // Liveness ends at t=10_000
      const absentWithoutLiveness = {
        ...absentWithLiveness,
        multiChannelLivenessActive: false,
      };

      expect(tracker.update(absentWithoutLiveness, 10_001)).toBeUndefined();
      expect(tracker.update(absentWithoutLiveness, 10_999)).toBeUndefined();
      // Grace period (1_000ms) elapses at t=11_001
      const error = tracker.update(absentWithoutLiveness, 11_001);
      expect(error).toContain("did not create a response DOM");
    });

    it("preserves sawResponse and reports response DOM disappeared after previous visibility", () => {
      const tracker = new ChatGptTurnDomHealthTracker(1_000, 500);
      const present = {
        responsePresent: true,
        running: true,
        currentText: "Initial progress...",
        completionActionVisible: false,
      };

      // Response observed
      expect(tracker.update(present, 1_000)).toBeUndefined();

      // Compaction starts: DOM disappears temporarily while multi-channel liveness is active
      const absentWithLiveness = {
        responsePresent: false,
        running: false,
        currentText: "",
        completionActionVisible: false,
        multiChannelLivenessActive: true,
      };
      expect(tracker.update(absentWithLiveness, 5_000)).toBeUndefined();

      // If all channels go completely silent and grace elapses:
      const silentAbsent = {
        ...absentWithLiveness,
        multiChannelLivenessActive: false,
      };
      expect(tracker.update(silentAbsent, 6_000)).toBeUndefined();
      expect(tracker.update(silentAbsent, 7_001)).toContain(
        "ChatGPT response DOM disappeared while the browser turn was active",
      );
    });

    it("scales grace period adaptively based on measured domChars to avoid false timeouts on massive DOM", () => {
      const tracker = new ChatGptTurnDomHealthTracker(1_000, 500);
      const smallDomAbsent = {
        responsePresent: false,
        running: false,
        currentText: "",
        completionActionVisible: false,
        domChars: 100,
      };

      // Small DOM should expire right around base grace (1_000ms + 2ms)
      expect(tracker.update(smallDomAbsent, 1_000)).toBeUndefined();
      expect(tracker.update(smallDomAbsent, 2_005)).toContain("did not create a response DOM");

      // Large DOM (500,000 characters from long turn history) adds 10,000ms grace
      const largeDomTracker = new ChatGptTurnDomHealthTracker(1_000, 500);
      const largeDomAbsent = {
        responsePresent: false,
        running: false,
        currentText: "",
        completionActionVisible: false,
        domChars: 500_000,
      };

      expect(largeDomTracker.update(largeDomAbsent, 1_000)).toBeUndefined();
      // At 2,000ms it would have failed with small DOM, but with 500k chars it is still healthy
      expect(largeDomTracker.update(largeDomAbsent, 2_000)).toBeUndefined();
      expect(largeDomTracker.update(largeDomAbsent, 10_000)).toBeUndefined();
      // Expires only after 1_000 + 10_000 = 11_000ms
      expect(largeDomTracker.update(largeDomAbsent, 12_001)).toContain("did not create a response DOM");
    });

    it("multiChannelLivenessActive suppresses empty completion and missing completion action stalls", () => {
      const tracker = new ChatGptTurnDomHealthTracker(1_000, 500, 750);
      const emptyTerminal = {
        responsePresent: true,
        running: false,
        currentText: "",
        completionActionVisible: true,
        multiChannelLivenessActive: true,
      };

      expect(tracker.update(emptyTerminal, 1_000)).toBeUndefined();
      expect(tracker.update(emptyTerminal, 10_000)).toBeUndefined();

      const missingAction = {
        responsePresent: true,
        running: false,
        currentText: "Generating output...",
        completionActionVisible: false,
        multiChannelLivenessActive: true,
      };

      expect(tracker.update(missingAction, 1_000)).toBeUndefined();
      expect(tracker.update(missingAction, 10_000)).toBeUndefined();
    });
  });

  describe("Transparent Error Propagation in submittedTurnFailure", () => {
    it("preserves ChatGptWebAdapterError with chatgpt_browser_dom_unresponsive code without masking", () => {
      const mockSession: Partial<ChatGptTurnSession> = {
        runtime: {
          submission: {
            phase: "accepted",
          },
        } as any,
      };

      const domError = new ChatGptWebAdapterError(
        "ChatGPT response DOM disappeared while the browser turn was active",
        {
          status: 504,
          errorType: "server_error",
          code: "chatgpt_browser_dom_unresponsive",
          retryable: false,
        },
      );

      const result = submittedTurnFailure(mockSession as ChatGptTurnSession, domError);
      expect(result).toBe(domError);
      expect(result).toBeInstanceOf(ChatGptWebAdapterError);
      expect((result as ChatGptWebAdapterError).code).toBe("chatgpt_browser_dom_unresponsive");
      expect(result.message).toContain("ChatGPT response DOM disappeared");
    });

    it("includes root cause detail in fallback submittedTurnFailure when an untyped error occurs", () => {
      const mockSession: Partial<ChatGptTurnSession> = {
        runtime: {
          submission: {
            phase: "accepted",
          },
        } as any,
      };

      const genericError = new Error("Custom transport socket reset");
      const result = submittedTurnFailure(mockSession as ChatGptTurnSession, genericError);

      expect(result).toBeInstanceOf(ChatGptWebAdapterError);
      expect((result as ChatGptWebAdapterError).code).toBe("chatgpt_submitted_turn_failed");
      expect(result.message).toContain("ChatGPT stopped responding after the task started");
      expect(result.message).toContain("Custom transport socket reset");
    });
  });

  describe("Multipart Staging Heartbeat & Event Integration in waitForMultipartAcknowledgement", () => {
    function createMockLocator() {
      const locator: any = {
        filter: () => locator,
        first: () => locator,
        last: () => locator,
        getByText: () => locator,
        getByTestId: () => locator,
        isVisible: async () => false,
        press: async () => {},
        count: async () => 1,
      };
      return locator;
    }

    it("emits periodic heartbeats during multipart stage acknowledgement wait", async () => {
      let heartbeats = 0;
      let iterations = 0;
      const mockLocator = createMockLocator();
      const fakePage = {
        isClosed: () => false,
        locator: () => mockLocator,
      };
      const fakeBinding = {
        locator: mockLocator,
        identity: "turn-1",
      };

      const observe = (ChatGptBrowserWorker.prototype as any).waitForMultipartAcknowledgement;
      const turnEvents = new ChatGptTurnEventBus();

      // Run observation that ticks clock past 5,000ms to verify heartbeat trigger
      const originalNow = Date.now;
      let fakeTime = 1_000_000;
      Date.now = () => fakeTime;

      try {
        await observe.call(
          {
            responseDomSnapshot: async () => {
              iterations += 1;
              fakeTime += 2_600; // 2 iterations will exceed 5,000ms
              return {
                responsePresent: true,
                stoppedThinkingVisible: false,
                visibleText: iterations >= 3 ? "STAGED_OK" : "Staging...",
                completionActionVisible: iterations >= 3,
                fullHtml: "<p>test</p>",
              };
            },
          },
          fakePage,
          fakeBinding,
          {},
          { acknowledgement: "STAGED_OK" },
          undefined,
          undefined,
          undefined,
          undefined,
          turnEvents,
          () => {
            heartbeats += 1;
          },
        );

        expect(heartbeats).toBeGreaterThanOrEqual(1);
        expect(iterations).toBeGreaterThanOrEqual(3);
      } finally {
        Date.now = originalNow;
      }
    });

    it("throws typed ChatGptWebAdapterError with chatgpt_browser_dom_unresponsive on genuine DOM stall", async () => {
      const mockLocator = createMockLocator();
      const fakePage = {
        isClosed: () => false,
        locator: () => mockLocator,
      };
      const fakeBinding = {
        locator: mockLocator,
        identity: "turn-1",
      };

      const observe = (ChatGptBrowserWorker.prototype as any).waitForMultipartAcknowledgement;

      const originalNow = Date.now;
      let fakeTime = 1_000_000;
      Date.now = () => fakeTime;

      try {
        const observationPromise = observe.call(
          {
            responseDomSnapshot: async () => {
              fakeTime += 200_000; // Exceeds CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS (180s)
              return {
                responsePresent: false,
                stoppedThinkingVisible: false,
                visibleText: "",
                completionActionVisible: false,
                fullHtml: "",
              };
            },
          },
          fakePage,
          fakeBinding,
          {},
          { acknowledgement: "STAGED_OK" },
          undefined,
          undefined,
          undefined,
        );

        await expect(observationPromise).rejects.toMatchObject({
          code: "chatgpt_browser_dom_unresponsive",
          status: 504,
          retryable: false,
        });
      } finally {
        Date.now = originalNow;
      }
    });
  });
});
