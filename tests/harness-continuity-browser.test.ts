import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { chromium, type Page } from "playwright-core";
import { waitForChatGptDomRevision } from "../src/adapters/chatgpt-web/browser/dom-signal";
import { ChatGptTurnEventBus } from "../src/adapters/chatgpt-web/browser/turn-events";

// Exercises the renderer resource, not merely the rejected Node promise.
test("abort releases the renderer waiter before its five-second horizon", async () => {
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<main id="conversation">Quiet</main>');
    const first = await waitForChatGptDomRevision(page);
    const controller = new AbortController();
    const waiting = waitForChatGptDomRevision(page, {
      afterKey: first.key,
      horizonMs: 5000,
      signal: controller.signal,
    });
    await page.waitForFunction(() => {
      const state = (globalThis as unknown as Record<string, { waiters: unknown[] }>).__CODEX_WEB_GPT_DOM_SIGNAL__;
      return state?.waiters.length === 1;
    });
    controller.abort();
    await expect(waiting).rejects.toThrow("aborted");
    const resources = await page.evaluate(() => {
      const state = (globalThis as unknown as Record<string, { waiters: unknown[] }>).__CODEX_WEB_GPT_DOM_SIGNAL__;
      return state?.waiters.length;
    });
    expect(resources).toBe(0);
  } finally {
    await browser.close();
  }
});

test("rebind detaches the previous page listener and preserves turn identity", async () => {
  const { ChatGptTurnPageBinding } = await import("../src/adapters/chatgpt-web/browser/turn-page-binding");
  const bus = new ChatGptTurnEventBus({ turnId: "stable-turn" });
  const previous = new EventEmitter();
  const next = new EventEmitter();
  const binding = new ChatGptTurnPageBinding(bus);
  binding.bind(previous as unknown as Page);
  expect(previous.listenerCount("response")).toBe(1);
  binding.bind(next as unknown as Page);
  expect(previous.listenerCount("response")).toBe(0);
  expect(next.listenerCount("response")).toBe(1);
  const cursor = bus.cursor;
  previous.emit("response", { url: () => "https://chatgpt.com/backend-api/conversation", status: () => 200 });
  expect(bus.cursor).toBe(cursor);
  next.emit("response", { url: () => "https://chatgpt.com/backend-api/conversation", status: () => 200 });
  expect(bus.exportHistory().at(-1)?.documentGeneration).toBe(1);
  expect(bus.scope.turnId).toBe("stable-turn");
  binding.dispose();
  expect(next.listenerCount("response")).toBe(0);
  bus.dispose();
});

test("bus subscribes before observing and network wake cancels the losing observation", async () => {
  const { waitForChatGptTurnWake } = await import("../src/adapters/chatgpt-web/browser/turn-wake");
  const bus = new ChatGptTurnEventBus({ turnId: "wake" });
  let cancelled = false;
  await waitForChatGptTurnWake(bus, async (signal) => {
    expect(bus.pendingWaiters).toBeGreaterThan(0);
    return new Promise<void>((resolve) => {
      signal.addEventListener(
        "abort",
        () => {
          cancelled = true;
          resolve();
        },
        { once: true },
      );
      bus.publish({ type: "network_submission_observed", source: "network", status: 200 });
    });
  });
  expect(cancelled).toBe(true);
  expect(bus.pendingWaiters).toBe(0);
  bus.dispose();
});
