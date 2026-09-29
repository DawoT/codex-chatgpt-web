import { expect, test } from "bun:test";
import { ChatGptTurnCompletionFsm } from "../src/adapters/chatgpt-web/browser/turn-completion-fsm";

type Observation = Parameters<ChatGptTurnCompletionFsm["observe"]>[0];

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    responsePresent: false,
    completionReady: false,
    externalToolCallsInFlight: false,
    externalProgressLive: false,
    ...overrides,
  };
}

test("starts awaiting the response and waits for a signal while the answer subtree is missing", () => {
  const fsm = new ChatGptTurnCompletionFsm({ fenced: false });
  const decision = fsm.observe(observation());
  expect(fsm.phase).toBe("awaiting_response");
  expect(decision).toMatchObject({ phase: "awaiting_response", changed: false, action: "wait_for_signal" });
});

test("a live external progress pause while the response is hidden keeps waiting without a verdict", () => {
  const fsm = new ChatGptTurnCompletionFsm({ fenced: false });
  fsm.observe(observation({ responsePresent: true }));
  const decision = fsm.observe(observation({ externalProgressLive: true }));
  expect(decision).toMatchObject({ phase: "awaiting_response", changed: true, action: "wait_for_signal" });
});

test("mounting the response transitions to streaming", () => {
  const fsm = new ChatGptTurnCompletionFsm({ fenced: false });
  const decision = fsm.observe(observation({ responsePresent: true }));
  expect(decision).toMatchObject({ phase: "streaming", changed: true, action: "wait_for_signal" });
  expect(fsm.observe(observation({ responsePresent: true })).changed).toBe(false);
});

test("tool calls in flight move streaming into tool_pending and back", () => {
  const fsm = new ChatGptTurnCompletionFsm({ fenced: false });
  fsm.observe(observation({ responsePresent: true }));
  expect(fsm.observe(observation({ responsePresent: true, externalToolCallsInFlight: true })).phase).toBe(
    "tool_pending",
  );
  expect(fsm.observe(observation({ responsePresent: true })).phase).toBe("streaming");
});

test("without a completion fence, completion readiness finishes the turn", () => {
  const fsm = new ChatGptTurnCompletionFsm({ fenced: false });
  fsm.observe(observation({ responsePresent: true }));
  const decision = fsm.observe(observation({ responsePresent: true, completionReady: true }));
  expect(decision).toMatchObject({ phase: "completed", changed: true, action: "finish" });
});

test("a fenced turn walks begin → fresh read → commit and only then finishes", () => {
  const fsm = new ChatGptTurnCompletionFsm({ fenced: true });
  const ready = observation({ responsePresent: true, completionReady: true });
  fsm.observe(observation({ responsePresent: true }));
  expect(fsm.observe(ready)).toMatchObject({ phase: "settling", changed: true, action: "fence_begin" });
  // begin() is in flight; the loop must not re-enter it.
  expect(fsm.observe(ready)).toMatchObject({ phase: "settling", changed: false, action: "wait_for_signal" });
  fsm.fenceAccepted();
  expect(fsm.observe(ready)).toMatchObject({ phase: "settling", changed: false, action: "fresh_read" });
  expect(fsm.observe(ready)).toMatchObject({ phase: "settling", changed: false, action: "fence_commit" });
  fsm.fenceCommitted(true);
  expect(fsm.observe(ready)).toMatchObject({ phase: "completed", changed: true, action: "finish" });
});

test("a rejected fence commit returns to settling and asks for begin again", () => {
  const fsm = new ChatGptTurnCompletionFsm({ fenced: true });
  const ready = observation({ responsePresent: true, completionReady: true });
  fsm.observe(observation({ responsePresent: true }));
  fsm.observe(ready);
  fsm.fenceAccepted();
  fsm.observe(ready);
  fsm.observe(ready);
  fsm.fenceCommitted(false);
  expect(fsm.observe(ready)).toMatchObject({ phase: "settling", changed: false, action: "fence_begin" });
});

test("a fence begin that the broker cannot grant returns to idle and is attempted again", () => {
  const fsm = new ChatGptTurnCompletionFsm({ fenced: true });
  const ready = observation({ responsePresent: true, completionReady: true });
  fsm.observe(observation({ responsePresent: true }));
  expect(fsm.observe(ready)).toMatchObject({ action: "fence_begin" });
  fsm.fenceBeginUnavailable();
  expect(fsm.observe(ready)).toMatchObject({ phase: "settling", changed: false, action: "fence_begin" });
});

test("completion readiness dropping mid-fence resets the fence to a fresh begin", () => {
  const fsm = new ChatGptTurnCompletionFsm({ fenced: true });
  fsm.observe(observation({ responsePresent: true }));
  fsm.observe(observation({ responsePresent: true, completionReady: true }));
  expect(fsm.observe(observation({ responsePresent: true, externalToolCallsInFlight: true })).phase).toBe(
    "tool_pending",
  );
  expect(fsm.observe(observation({ responsePresent: true, completionReady: true }))).toMatchObject({
    phase: "settling",
    action: "fence_begin",
  });
});

test("a hidden response during live progress while settling suspends without discarding the fence", () => {
  const fsm = new ChatGptTurnCompletionFsm({ fenced: true });
  const ready = observation({ responsePresent: true, completionReady: true });
  fsm.observe(observation({ responsePresent: true }));
  fsm.observe(ready);
  fsm.fenceAccepted();
  const suspended = fsm.observe(observation({ externalProgressLive: true }));
  expect(suspended).toMatchObject({ phase: "awaiting_response", action: "wait_for_signal" });
  expect(fsm.observe(ready)).toMatchObject({ phase: "settling", action: "fresh_read" });
});

test("completion readiness on the very first observation still routes through settling, not a skipped path", () => {
  const unfenced = new ChatGptTurnCompletionFsm({ fenced: false });
  expect(unfenced.observe(observation({ responsePresent: true, completionReady: true }))).toMatchObject({
    phase: "completed",
    changed: true,
    action: "finish",
  });
  const fenced = new ChatGptTurnCompletionFsm({ fenced: true });
  expect(fenced.observe(observation({ responsePresent: true, completionReady: true }))).toMatchObject({
    phase: "settling",
    changed: true,
    action: "fence_begin",
  });
});

test("compactionHandoffObserved transitions to completed from any phase", () => {
  const fsmFromAwaiting = new ChatGptTurnCompletionFsm({ fenced: true });
  const d1 = fsmFromAwaiting.compactionHandoffObserved();
  expect(d1).toMatchObject({ phase: "completed", from: "awaiting_response", changed: true, action: "finish" });
  expect(fsmFromAwaiting.phase).toBe("completed");

  const fsmFromStreaming = new ChatGptTurnCompletionFsm({ fenced: false });
  fsmFromStreaming.observe(observation({ responsePresent: true }));
  const d2 = fsmFromStreaming.compactionHandoffObserved();
  expect(d2).toMatchObject({ phase: "completed", from: "streaming", changed: true, action: "finish" });

  const fsmFromTool = new ChatGptTurnCompletionFsm({ fenced: false });
  fsmFromTool.observe(observation({ responsePresent: true, externalToolCallsInFlight: true }));
  const d3 = fsmFromTool.compactionHandoffObserved();
  expect(d3).toMatchObject({ phase: "completed", from: "tool_pending", changed: true, action: "finish" });

  const fsmFromSettling = new ChatGptTurnCompletionFsm({ fenced: true });
  fsmFromSettling.observe(observation({ responsePresent: true, completionReady: true }));
  const d4 = fsmFromSettling.compactionHandoffObserved();
  expect(d4).toMatchObject({ phase: "completed", from: "settling", changed: true, action: "finish" });

  const d5 = fsmFromSettling.compactionHandoffObserved();
  expect(d5).toMatchObject({ phase: "completed", from: "completed", changed: false, action: "finish" });
});
