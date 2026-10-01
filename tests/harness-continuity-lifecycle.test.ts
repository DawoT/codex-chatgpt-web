import { expect, test } from "bun:test";
import { ChatGptTurnEventBus } from "../src/adapters/chatgpt-web/browser/turn-events";
import { CompactionTransactionStore } from "../src/adapters/chatgpt-web/compaction-transaction";
import { ChatGptTextFeed, ChatGptTraceFeed } from "../src/adapters/chatgpt-web/turn-execution/feeds";

test("closed bus rejects even replay and aborted signals cannot consume history", async () => {
  const bus = new ChatGptTurnEventBus({ turnId: "closed" });
  bus.publish({ type: "dom_settled", source: "dom" });
  await expect(bus.waitUntil("dom_settled", undefined, { signal: AbortSignal.abort() })).rejects.toThrow();
  bus.dispose();
  await expect(bus.waitUntil("dom_settled", undefined, { deadlineMs: 5 })).rejects.toThrow("disposed");
  expect(bus.pendingWaiters).toBe(0);
});

test("predicate faults reject only their waiter", async () => {
  const bus = new ChatGptTurnEventBus({ turnId: "predicate" });
  const faulty = bus.waitUntil("dom_settled", () => {
    throw new Error("bad predicate");
  });
  const healthy = bus.waitUntil("dom_settled");
  expect(() => bus.publish({ type: "dom_settled", source: "dom" })).not.toThrow();
  await expect(faulty).rejects.toThrow("bad predicate");
  expect((await healthy).type).toBe("dom_settled");
  expect(bus.pendingWaiters).toBe(0);
  bus.dispose();
});

test("cursor skips previous events and expired cursors require resynchronization", async () => {
  const bus = new ChatGptTurnEventBus({ turnId: "cursor" });
  const first = bus.publish({ type: "dom_settled", source: "dom" });
  const pending = bus.waitUntil("dom_settled", undefined, { afterSequence: first.sequence });
  expect(bus.pendingWaiters).toBe(1);
  const second = bus.publish({ type: "dom_settled", source: "dom" });
  expect((await pending).sequence).toBe(first.sequence + 1);
  expect(second.documentGeneration).toBe(0);
  const rebound = bus.publish({ type: "page_rebound", source: "host" });
  expect(rebound.documentGeneration).toBe(1);
  for (let index = 0; index < 40; index += 1) {
    bus.publish({ type: "response_mutated", source: "dom" });
  }
  await expect(bus.waitUntil("dom_settled", undefined, { afterSequence: first.sequence })).rejects.toThrow(
    "resynchronization",
  );
  bus.dispose();
});

for (const Feed of [ChatGptTextFeed, ChatGptTraceFeed]) {
  test(`${Feed.name} rejects waits after failed close and abort wins queued data`, async () => {
    const feed = new Feed();
    feed.close(new Error("terminal failure"));
    await expect(
      Promise.race([
        feed.wait(),
        Bun.sleep(10).then(() => {
          throw new Error("leaked waiter");
        }),
      ]),
    ).rejects.toThrow("terminal failure");
    await expect(feed.wait(AbortSignal.abort())).rejects.toThrow("aborted");
    await expect(new Feed().wait(AbortSignal.abort())).rejects.toThrow("aborted");
  });

  test(`${Feed.name} resolves waits after normal close without registering resources`, async () => {
    const feed = new Feed();
    feed.close();
    await expect(Promise.race([feed.wait().then(() => "closed"), Bun.sleep(10).then(() => "leaked")])).resolves.toBe(
      "closed",
    );
  });
}

test("submitted but unconsumed handoffs expire and aborted waits cannot consume them", async () => {
  const store = new CompactionTransactionStore();
  const pending = store.begin("unconsumed", 5);
  store.submit(pending.token, pending.handoffId, "summary");
  await Bun.sleep(15);
  await expect(store.wait(pending.token)).rejects.toThrow("expired");
  const aborted = store.begin("aborted", 100);
  store.submit(aborted.token, aborted.handoffId, "summary");
  await expect(store.wait(aborted.token, AbortSignal.abort())).rejects.toThrow("aborted");
  await expect(store.wait(aborted.token)).rejects.toThrow("consumed");
  store.close();
});

test("terminal causes distinguish accepted handoff, cancellation, deadline and transport", async () => {
  const { classifyTurnTermination } = await import("../src/adapters/chatgpt-web/turn-terminal");
  const { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError } = await import(
    "../src/adapters/chatgpt-web/adapter-error"
  );
  const deadline = new ChatGptWebAdapterError("deadline", {
    status: 504,
    errorType: "server_error",
    code: "compaction_handoff_timeout",
    retryable: false,
  });
  expect(
    classifyTurnTermination(
      new DOMException("aborted", "AbortError"),
      AbortSignal.abort(new ChatGptCompactionHandoffAccepted()),
    ),
  ).toBe("handoff_accepted");
  expect(classifyTurnTermination(deadline, AbortSignal.abort(deadline))).toBe("deadline");
  expect(classifyTurnTermination(new DOMException("aborted", "AbortError"), AbortSignal.abort())).toBe(
    "user_cancelled",
  );
  expect(
    classifyTurnTermination(
      new ChatGptWebAdapterError("transport", {
        status: 502,
        errorType: "server_error",
        code: "chatgpt_browser_transport_closed",
        retryable: false,
      }),
    ),
  ).toBe("transport");
  expect(classifyTurnTermination(new Error("Unexpected state"))).toBe("internal_failure");
});
