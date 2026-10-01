import { expect, test } from "bun:test";
import {
  CHATGPT_CONNECTION_INTERRUPTED_GRACE_MS,
  ChatGptConnectionInterruptionTracker,
  ChatGptTurnDomHealthTracker,
  chatGptUiGenerationIsLive,
} from "../src/adapters/chatgpt-web/browser-worker";

test("a visible Stop button is not liveness evidence while ChatGPT reports an interrupted stream", () => {
  expect(chatGptUiGenerationIsLive(true, false)).toBe(true);
  expect(chatGptUiGenerationIsLive(true, true)).toBe(false);
  expect(chatGptUiGenerationIsLive(false, true)).toBe(false);
});

test("an interrupted stream may recover transiently but fails closed after a bounded quiet grace", () => {
  const tracker = new ChatGptConnectionInterruptionTracker();
  expect(tracker.update({ interrupted: true, corroboratedProgress: false }, 1_000)).toBeUndefined();
  expect(
    tracker.update(
      { interrupted: true, corroboratedProgress: false },
      1_000 + CHATGPT_CONNECTION_INTERRUPTED_GRACE_MS - 1,
    ),
  ).toBeUndefined();
  expect(
    tracker.update({ interrupted: true, corroboratedProgress: false }, 1_000 + CHATGPT_CONNECTION_INTERRUPTED_GRACE_MS),
  ).toContain("connection remained interrupted");

  expect(tracker.update({ interrupted: false, corroboratedProgress: false }, 50_000)).toBeUndefined();
  expect(tracker.update({ interrupted: true, corroboratedProgress: true }, 60_000)).toBeUndefined();
  expect(tracker.update({ interrupted: true, corroboratedProgress: false }, 60_001)).toBeUndefined();
});

test("DOM health does not let a stale Stop button erase stall windows during an interrupted stream", () => {
  const tracker = new ChatGptTurnDomHealthTracker(1_000, 500, 750);
  // A stale Stop button (running=true) must not suppress the missing-response window even while
  // the interrupted-stream banner is visible: the window charges on observed facts, not UI state.
  expect(
    tracker.update(
      {
        responsePresent: true,
        running: true,
        connectionInterrupted: true,
        currentText: "partial answer",
        completionActionVisible: false,
      },
      1_000,
    ),
  ).toBeUndefined();
  const vanishedResponse = {
    responsePresent: false,
    running: true,
    connectionInterrupted: true,
    currentText: "",
    completionActionVisible: false,
  };

  expect(tracker.update(vanishedResponse, 1_001)).toBeUndefined();
  expect(tracker.update(vanishedResponse, 2_000)).toBeUndefined();
  expect(tracker.update(vanishedResponse, 2_001)).toContain("response DOM disappeared");
});

test("DOM health defers the completed-turn-action conclusion to the interruption tracker", () => {
  const tracker = new ChatGptTurnDomHealthTracker(1_000, 500, 750);
  const interrupted = {
    responsePresent: true,
    running: true,
    connectionInterrupted: true,
    currentText: "partial answer",
    completionActionVisible: false,
  };

  // The 60s completion-action window must not preempt the 180s stream grace: while the banner
  // is visible, only corroborated progress or the interruption tracker may conclude the turn.
  expect(tracker.update(interrupted, 1_000)).toBeUndefined();
  expect(tracker.update(interrupted, 60_001)).toBeUndefined();
  const recovered = { ...interrupted, running: false, connectionInterrupted: false };
  expect(tracker.update(recovered, 60_002)).toBeUndefined();
  expect(tracker.update(recovered, 60_002 + 750)).toContain("DOM may have changed");
});
