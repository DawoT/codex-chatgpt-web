import { expect, test } from "bun:test";
import {
  ChatGptTextFeed,
  ChatGptTraceFeed,
  type ChatGptTurnRuntime,
  ChatGptTurnSessions,
} from "../src/adapters/chatgpt-web/turn-execution";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function controlledRuntime(conversationKey?: string, releaseRetainedConversation?: () => Promise<void>) {
  const browser = deferred<string>();
  const physical = deferred<void>();
  const controller = new AbortController();
  let cancellations = 0;
  controller.signal.addEventListener(
    "abort",
    () => {
      browser.reject(controller.signal.reason);
    },
    { once: true },
  );
  const runtime: ChatGptTurnRuntime = {
    mode: "read-only",
    browser: browser.promise,
    physicalSettlement: physical.promise,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey,
    releaseRetainedConversation,
    cancel: (reason) => {
      cancellations += 1;
      controller.abort(reason);
    },
  };
  return { runtime, browser, physical, controller, cancellations: () => cancellations };
}

test("duplicate execution retirement cancels once and shares physical settlement", async () => {
  const sessions = new ChatGptTurnSessions(60_000, 256);
  const turn = controlledRuntime("conversation");
  const session = sessions.getOrCreate("execution", () => turn.runtime, "trace", "owner");
  let completions = 0;
  const first = sessions.retireAndWait("execution").then((retired) => {
    completions += 1;
    return retired;
  });
  const duplicate = sessions.retireAndWait("execution").then((retired) => {
    completions += 1;
    return retired;
  });

  expect(turn.controller.signal.aborted).toBe(true);
  expect(turn.cancellations()).toBe(1);
  expect(sessions.find("execution")).toBeUndefined();
  expect(sessions.findConversationHead("conversation")).toBeUndefined();
  await session.browserOutcome;
  expect(completions).toBe(0);

  turn.physical.resolve();
  expect(await Promise.all([first, duplicate])).toEqual([true, true]);
  expect(completions).toBe(2);
  await expect(sessions.retireAndWait("execution")).resolves.toBe(false);
});

test("owner replacement waits for retired execution physical settlement", async () => {
  const sessions = new ChatGptTurnSessions(60_000, 256);
  const oldTurn = controlledRuntime();
  const old = sessions.getOrCreate("old", () => oldTurn.runtime, "old_trace", "owner");
  const retirement = sessions.retireAndWait("old");
  const nextTurn = controlledRuntime();
  let starts = 0;
  const replacement = sessions.getOrCreateAfterOwnerRetirement("new", "owner", () => {
    starts += 1;
    return nextTurn.runtime;
  });

  await old.browserOutcome;
  expect(old.isPhysicallySettled()).toBe(false);
  expect(starts).toBe(0);
  expect(oldTurn.cancellations()).toBe(1);
  oldTurn.physical.resolve();
  await retirement;
  const next = await replacement;
  expect(next).not.toBe(old);
  expect(starts).toBe(1);
  nextTurn.browser.resolve("replacement answer");
  nextTurn.physical.resolve();
  await Promise.all([next.browserOutcome, next.physicalSettlement]);
});

test("a logically complete owner still blocks replacement without cancellation", async () => {
  const sessions = new ChatGptTurnSessions(60_000, 256);
  const oldTurn = controlledRuntime();
  const old = sessions.getOrCreate("old-final", () => oldTurn.runtime, "old_trace", "owner");
  oldTurn.browser.resolve("committed answer");
  await old.browserOutcome;
  const nextTurn = controlledRuntime();
  let starts = 0;
  const replacement = sessions.getOrCreateAfterOwnerRetirement("next-final", "owner", () => {
    starts += 1;
    return nextTurn.runtime;
  });
  expect(starts).toBe(0);
  expect(oldTurn.controller.signal.aborted).toBe(false);
  expect(oldTurn.cancellations()).toBe(0);
  oldTurn.physical.resolve();
  const next = await replacement;
  expect(starts).toBe(1);
  expect(old.settledOutcome()).toEqual({ type: "final", answer: "committed answer" });
  nextTurn.browser.resolve("next answer");
  nextTurn.physical.resolve();
  await Promise.all([next.browserOutcome, next.physicalSettlement]);
});

test("physical rejection clears execution, owner and conversation retirement gates", async () => {
  const sessions = new ChatGptTurnSessions(60_000, 256);
  const turn = controlledRuntime("conversation");
  const session = sessions.getOrCreate("failing", () => turn.runtime, "trace", "owner");
  const retirement = sessions.retireAndWait("failing");
  const failure = new Error("helper teardown rejected");
  turn.physical.reject(failure);
  await expect(retirement).rejects.toBe(failure);
  await session.browserOutcome;
  await expect(sessions.waitForRetirement("failing")).resolves.toBeUndefined();
  await expect(sessions.retireAndWait("failing")).resolves.toBe(false);
  await expect(sessions.waitForConversationRetirement("conversation")).resolves.toBeUndefined();

  const nextTurn = controlledRuntime("conversation");
  const next = await sessions.getOrCreateAfterOwnerRetirement("failing", "owner", () => nextTurn.runtime);
  expect(next).not.toBe(session);
  nextTurn.browser.resolve("recovered");
  nextTurn.physical.resolve();
  await Promise.all([next.browserOutcome, next.physicalSettlement]);
  expect(await sessions.retireConversationAndWait("conversation")).toBe(1);
});

test("conversation retirement waits for every physical owner and releases exactly once", async () => {
  const sessions = new ChatGptTurnSessions(60_000, 256);
  let releases = 0;
  const release = async () => {
    releases += 1;
  };
  const firstTurn = controlledRuntime("shared_conversation", release);
  const secondTurn = controlledRuntime("shared_conversation", release);
  const first = sessions.getOrCreate("first", () => firstTurn.runtime, "first_trace", "first_owner");
  const second = sessions.getOrCreate("second", () => secondTurn.runtime, "second_trace", "second_owner");
  const retirement = sessions.retireConversationAndWait("shared_conversation");
  const duplicate = sessions.retireConversationAndWait("shared_conversation");
  await Promise.all([first.browserOutcome, second.browserOutcome]);
  expect(firstTurn.controller.signal.aborted).toBe(true);
  expect(secondTurn.controller.signal.aborted).toBe(true);
  expect(sessions.findConversationHead("shared_conversation")).toBeUndefined();
  expect(releases).toBe(0);
  firstTurn.physical.resolve();
  await first.physicalSettlement;
  expect(releases).toBe(0);
  secondTurn.physical.resolve();
  expect(await Promise.all([retirement, duplicate])).toEqual([2, 0]);
  expect(releases).toBe(1);
  expect(await sessions.retireConversationAndWait("shared_conversation")).toBe(0);
  expect(releases).toBe(1);
});

test("conversation retirement preserves an already committed final response for exact replay", async () => {
  const sessions = new ChatGptTurnSessions(60_000, 256);
  let releases = 0;
  const turn = controlledRuntime("final_conversation", async () => {
    releases += 1;
  });
  const session = sessions.getOrCreate("original", () => turn.runtime);
  turn.browser.resolve("ordinary final answer");
  await session.browserOutcome;
  const retirement = sessions.retireConversationPreservingFinalResponse("final_conversation", session, "compacted");
  expect(sessions.find("original")).toBeUndefined();
  expect(sessions.find("compacted")).toBe(session);
  expect(sessions.findConversationHead("final_conversation")).toBeUndefined();
  expect(session.conversationKey()).toBeUndefined();
  expect(turn.cancellations()).toBe(0);
  expect(releases).toBe(0);
  turn.physical.resolve();
  expect(await retirement).toBe(1);
  expect(releases).toBe(1);
  expect(
    sessions.getOrCreate("compacted", () => {
      throw new Error("A committed final response must be replayed without another browser");
    }),
  ).toBe(session);
  expect(session.settledOutcome()).toEqual({ type: "final", answer: "ordinary final answer" });
});

test("disconnecting an observer leaves shared retirement tracked until physical cleanup", async () => {
  const sessions = new ChatGptTurnSessions(60_000, 256);
  const turn = controlledRuntime();
  const session = sessions.getOrCreate("observed", () => turn.runtime);
  const retirement = sessions.retireAndWait("observed");
  const observer = new AbortController();
  const disconnected = sessions.retireAndWait("observed", observer.signal);
  observer.abort();
  await expect(disconnected).rejects.toMatchObject({ name: "AbortError" });
  expect(turn.cancellations()).toBe(1);
  expect(session.isPhysicallySettled()).toBe(false);
  turn.physical.resolve();
  await expect(retirement).resolves.toBe(true);
  await session.browserOutcome;
  await expect(sessions.retireAndWait("observed")).resolves.toBe(false);
});

test("injected registry clock expires terminal replay after its TTL", async () => {
  let now = 1_000;
  const sessions = new ChatGptTurnSessions(100, 256, () => now);
  const turn = controlledRuntime();
  const session = sessions.getOrCreate("terminal", () => turn.runtime);
  turn.browser.resolve("completed");
  turn.physical.resolve();
  await Promise.all([session.browserOutcome, session.physicalSettlement]);

  now = 1_101;
  expect(sessions.activeCount()).toBe(0);
  expect(sessions.find("terminal")).toBeUndefined();
});

test("injected registry clock keeps the TTL boundary and refreshes replay on touch", async () => {
  let now = 1_000;
  const sessions = new ChatGptTurnSessions(100, 256, () => now);
  const turn = controlledRuntime();
  const session = sessions.getOrCreate("terminal", () => turn.runtime);
  turn.browser.resolve("completed");
  turn.physical.resolve();
  await Promise.all([session.browserOutcome, session.physicalSettlement]);

  now = 1_100;
  sessions.activeCount();
  expect(sessions.find("terminal")).toBe(session);
  now = 1_200;
  sessions.activeCount();
  expect(sessions.find("terminal")).toBe(session);
  now = 1_301;
  sessions.activeCount();
  expect(sessions.find("terminal")).toBeUndefined();
});

test("injected registry clock never expires an active browser execution", async () => {
  let now = 1_000;
  const sessions = new ChatGptTurnSessions(100, 256, () => now);
  const turn = controlledRuntime();
  const session = sessions.getOrCreate("active", () => turn.runtime);
  now = 10_000;
  expect(sessions.activeCount()).toBe(1);
  expect(sessions.find("active")).toBe(session);
  expect(turn.controller.signal.aborted).toBe(false);
  turn.browser.resolve("finished after TTL");
  turn.physical.resolve();
  await Promise.all([session.browserOutcome, session.physicalSettlement]);
});
