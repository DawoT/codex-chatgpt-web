import { expect, test } from "bun:test";
import {
  type ChatGptTurnEvent,
  ChatGptTurnEventBus,
  ChatGptTurnEventWaitTimeoutError,
} from "../src/adapters/chatgpt-web/browser/turn-events";

function bus(turnId = "turn-1") {
  return new ChatGptTurnEventBus({ sessionId: "session-1", surfaceId: "surface-1", turnId });
}

test("waitUntil resolves with the first matching event published after the wait starts", async () => {
  const events = bus();
  const pending = events.waitUntil("turn_inserted_detected");
  expect(events.pendingWaiters).toBe(1);
  events.publish({ type: "response_mutated", source: "dom" });
  expect(events.pendingWaiters).toBe(1);
  events.publish({ type: "turn_inserted_detected", source: "dom" });
  const resolved: ChatGptTurnEvent = await pending;
  expect(resolved.type).toBe("turn_inserted_detected");
  expect(resolved.at).toBeGreaterThan(0);
  expect(events.pendingWaiters).toBe(0);
});

test("waitUntil replays the earliest matching event already in history instead of hanging", async () => {
  const events = bus();
  events.publish({ type: "turn_inserted_detected", source: "dom" });
  events.publish({ type: "response_mutated", source: "dom" });
  const resolved = await events.waitUntil("turn_inserted_detected");
  expect(resolved.type).toBe("turn_inserted_detected");
  const earliest = events.publish({ type: "dom_settled", source: "dom" });
  events.publish({ type: "dom_settled", source: "dom" });
  expect((await events.waitUntil("dom_settled")).at).toBe(earliest.at);
});

test("waitUntil honors predicates and keeps waiting for a non-matching event", async () => {
  const events = bus();
  const pending = events.waitUntil("stop_button_visibility_changed", (event) => event.visible);
  events.publish({ type: "stop_button_visibility_changed", source: "dom", visible: false });
  expect(events.pendingWaiters).toBe(1);
  events.publish({ type: "stop_button_visibility_changed", source: "dom", visible: true });
  await expect(pending).resolves.toMatchObject({ visible: true });
});

test("waitUntil stamps the publish time when the event omits it", async () => {
  const events = bus();
  events.publish({ type: "external_progress_advanced", source: "external_progress", revision: 3 });
  const event = await events.waitUntil("external_progress_advanced");
  expect(event.source).toBe("external_progress");
  expect(event.at).toBeGreaterThan(0);
});

test("waitUntil rejects with ChatGptTurnEventWaitTimeoutError when the deadline expires", async () => {
  const events = bus();
  const pending = events.waitUntil("completion_action_changed", undefined, { deadlineMs: 30 });
  await expect(pending).rejects.toBeInstanceOf(ChatGptTurnEventWaitTimeoutError);
  expect(events.pendingWaiters).toBe(0);
});

test("waitUntil rejects with AbortError for an aborted signal, before and during the wait", async () => {
  const events = bus();
  const controller = new AbortController();
  controller.abort();
  await expect(events.waitUntil("response_mutated", undefined, { signal: controller.signal })).rejects.toThrow(
    DOMException,
  );
  const during = new AbortController();
  const pending = events.waitUntil("response_mutated", undefined, { signal: during.signal });
  setTimeout(() => during.abort(), 20);
  await expect(pending).rejects.toThrow(DOMException);
  expect(events.pendingWaiters).toBe(0);
});

test("dispose rejects every pending waiter and later publishes are inert", async () => {
  const events = bus();
  const first = events.waitUntil("response_mutated");
  const second = events.waitUntil("network_submission_observed");
  events.dispose();
  await expect(first).rejects.toThrow(/disposed/);
  await expect(second).rejects.toThrow(/disposed/);
  expect(events.pendingWaiters).toBe(0);
  expect(() => events.publish({ type: "response_mutated", source: "dom" })).not.toThrow();
});

test("scopes are isolated: publishing on one turn's bus never wakes another turn's waiters", async () => {
  const mine = bus("turn-a");
  const theirs = bus("turn-b");
  const pending = mine.waitUntil("response_mutated");
  theirs.publish({ type: "response_mutated", source: "dom" });
  expect(mine.pendingWaiters).toBe(1);
  mine.publish({ type: "response_mutated", source: "dom" });
  await pending;
  theirs.dispose();
  mine.dispose();
});

test("history is bounded so a long turn cannot accumulate unbounded event memory", async () => {
  const events = bus();
  for (let index = 0; index < 500; index += 1) {
    events.publish({ type: "response_mutated", source: "dom" });
  }
  const resolved = await events.waitUntil("response_mutated");
  expect(resolved.type).toBe("response_mutated");
  events.dispose();
});

test("waitUntil handles observation_faulted, page_rebound, and phase_changed events", async () => {
  const events = bus();
  const faultPending = events.waitUntil("observation_faulted");
  const reboundPending = events.waitUntil("page_rebound");
  const phasePending = events.waitUntil("phase_changed", (event) => event.to === "settling");

  events.publish({ type: "observation_faulted", source: "host", message: "renderer dropped frame" });
  events.publish({ type: "page_rebound", source: "host" });
  events.publish({ type: "phase_changed", source: "host", from: "streaming", to: "tool_pending" });
  events.publish({ type: "phase_changed", source: "host", from: "tool_pending", to: "settling" });

  const fault = await faultPending;
  expect(fault.type).toBe("observation_faulted");
  expect(fault.message).toBe("renderer dropped frame");

  const rebound = await reboundPending;
  expect(rebound.type).toBe("page_rebound");

  const phase = await phasePending;
  expect(phase.type).toBe("phase_changed");
  expect(phase.from).toBe("tool_pending");
  expect(phase.to).toBe("settling");
  events.dispose();
});

test("waitUntil handles compaction_handoff_observed and connector_pill_mounted events", async () => {
  const events = bus();
  const compactionPending = events.waitUntil("compaction_handoff_observed");
  const pillPending = events.waitUntil("connector_pill_mounted");

  events.publish({ type: "compaction_handoff_observed", source: "host" });
  events.publish({ type: "connector_pill_mounted", source: "dom" });

  const compaction = await compactionPending;
  expect(compaction.type).toBe("compaction_handoff_observed");
  expect(compaction.source).toBe("host");
  expect(compaction.at).toBeGreaterThan(0);

  const pill = await pillPending;
  expect(pill.type).toBe("connector_pill_mounted");
  expect(pill.source).toBe("dom");
  expect(pill.at).toBeGreaterThan(0);

  events.dispose();
});
