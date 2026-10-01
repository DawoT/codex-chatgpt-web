import { expect, test } from "bun:test";
import { CompactionBrowserRunner } from "../src/adapters/chatgpt-web/adapter/compaction-browser-runner";
import { ChatGptTextFeed, ChatGptTraceFeed, type ChatGptTurnRuntime } from "../src/adapters/chatgpt-web/turn-execution";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const browser = deferred<string>();
  const physical = deferred<void>();
  const cancellations: Error[] = [];
  const retained: Promise<void>[] = [];
  const controller = new AbortController();
  const runtime: ChatGptTurnRuntime = {
    mode: "read-only",
    browser: browser.promise,
    physicalSettlement: physical.promise,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: (reason) => {
      if (reason) cancellations.push(reason);
    },
  };
  const runner = new CompactionBrowserRunner((settlement) => retained.push(settlement), controller.signal);
  return { browser, physical, cancellations, retained, controller, runtime, runner };
}

test("checkpoint consumption waits for physical cleanup after the logical answer", async () => {
  const f = fixture();
  let consumed = false;
  const result = f.runner.run(f.runtime, (answer) => {
    consumed = true;
    return `${answer}:validated`;
  });
  expect(f.retained).toEqual([f.physical.promise]);
  f.browser.resolve("checkpoint");
  await f.browser.promise;
  expect(consumed).toBe(false);
  f.physical.resolve();
  expect(await result).toBe("checkpoint:validated");
  expect(f.cancellations).toEqual([]);
});

test("logical failure cancels once and keeps physical settlement owned", async () => {
  const f = fixture();
  const failure = new Error("uncertain Send outcome");
  const result = f.runner.run(f.runtime, () => {
    throw new Error("A failed browser must not consume a checkpoint");
  });
  f.browser.reject(failure);
  await expect(result).rejects.toBe(failure);
  expect(f.cancellations).toEqual([failure]);
  expect(f.retained).toEqual([f.physical.promise]);
  f.physical.resolve();
});

test("physical failure prevents consuming a successful logical answer", async () => {
  const f = fixture();
  const failure = new Error("surface release failed");
  let consumed = false;
  const result = f.runner.run(f.runtime, () => {
    consumed = true;
  });
  f.browser.resolve("checkpoint");
  await f.browser.promise;
  f.physical.reject(failure);
  await expect(result).rejects.toBe(failure);
  expect(consumed).toBe(false);
  expect(f.cancellations).toEqual([failure]);
});

test("validation failure cancels the completed runtime without retrying Send", async () => {
  const f = fixture();
  const failure = new Error("checkpoint rejected");
  const result = f.runner.run(f.runtime, () => {
    throw failure;
  });
  f.browser.resolve("invalid checkpoint");
  f.physical.resolve();
  await expect(result).rejects.toBe(failure);
  expect(f.cancellations).toEqual([failure]);
  expect(f.retained).toHaveLength(1);
});

test("operator cancellation ends observation while retaining physical cleanup", async () => {
  const f = fixture();
  const result = f.runner.run(f.runtime, (answer) => answer);
  f.controller.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(f.cancellations).toHaveLength(1);
  expect(f.retained).toEqual([f.physical.promise]);
  f.browser.resolve("late answer");
  f.physical.resolve();
});
