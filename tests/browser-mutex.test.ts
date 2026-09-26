import { describe, expect, it } from "bun:test";
import { InteractiveBrowserTurnMutex } from "../src/adapters/chatgpt-web/browser-mutex";

describe("InteractiveBrowserTurnMutex", () => {
  it("grants immediate lock when uncontended and tracks current traceId", async () => {
    const mutex = new InteractiveBrowserTurnMutex();
    expect(mutex.isLocked()).toBe(false);
    expect(mutex.currentTraceId()).toBeUndefined();

    const lock = await mutex.acquire("turn-1");
    expect(mutex.isLocked()).toBe(true);
    expect(mutex.currentTraceId()).toBe("turn-1");

    lock.release();
    expect(mutex.isLocked()).toBe(false);
    expect(mutex.currentTraceId()).toBeUndefined();
  });

  it("queues concurrent acquire requests and grants them in FIFO order upon release", async () => {
    const mutex = new InteractiveBrowserTurnMutex();
    const order: string[] = [];

    const lock1 = await mutex.acquire("turn-1");
    order.push("acquired-1");

    const p2 = mutex.acquire("turn-2").then(lock => {
      order.push("acquired-2");
      return lock;
    });

    const p3 = mutex.acquire("turn-3").then(lock => {
      order.push("acquired-3");
      return lock;
    });

    expect(mutex.waitingCount()).toBe(2);
    expect(order).toEqual(["acquired-1"]);

    lock1.release();
    const lock2 = await p2;
    expect(order).toEqual(["acquired-1", "acquired-2"]);
    expect(mutex.currentTraceId()).toBe("turn-2");

    lock2.release();
    const lock3 = await p3;
    expect(order).toEqual(["acquired-1", "acquired-2", "acquired-3"]);
    expect(mutex.currentTraceId()).toBe("turn-3");

    lock3.release();
    expect(mutex.isLocked()).toBe(false);
    expect(mutex.waitingCount()).toBe(0);
  });

  it("handles abort signals on queued waiters without breaking the queue", async () => {
    const mutex = new InteractiveBrowserTurnMutex();
    const lock1 = await mutex.acquire("turn-1");

    const abortController = new AbortController();
    const p2 = mutex.acquire("turn-2", abortController.signal);
    const p3 = mutex.acquire("turn-3");

    expect(mutex.waitingCount()).toBe(2);

    // Abort turn-2
    abortController.abort();
    await expect(p2).rejects.toThrow("Interactive browser turn acquire aborted");
    expect(mutex.waitingCount()).toBe(1);

    // Release turn-1 -> turn-3 should immediately acquire
    lock1.release();
    const lock3 = await p3;
    expect(mutex.currentTraceId()).toBe("turn-3");
    lock3.release();
    expect(mutex.isLocked()).toBe(false);
  });

  it("rejects immediately if signal is already aborted", async () => {
    const mutex = new InteractiveBrowserTurnMutex();
    const signal = AbortSignal.abort();
    await expect(mutex.acquire("turn-aborted", signal)).rejects.toThrow("Interactive browser turn acquire aborted");
    expect(mutex.isLocked()).toBe(false);
  });

  it("safely handles duplicate release calls without double-releasing", async () => {
    const mutex = new InteractiveBrowserTurnMutex();
    const lock1 = await mutex.acquire("turn-1");
    const p2 = mutex.acquire("turn-2");

    lock1.release();
    lock1.release(); // duplicate

    const lock2 = await p2;
    expect(mutex.currentTraceId()).toBe("turn-2");
    lock2.release();
    expect(mutex.isLocked()).toBe(false);
  });
});
