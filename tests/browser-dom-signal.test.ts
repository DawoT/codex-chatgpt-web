import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { chromium, type Page } from "playwright-core";
import { waitForChatGptDomRevision, waitForChatGptDomSettle } from "../src/adapters/chatgpt-web/browser/dom-signal";
import { ChatGptBrowserObservationTimeoutError } from "../src/adapters/chatgpt-web/browser/suspension-clock";

const BROWSER_PATH = process.env.CHATGPT_DOM_TEST_BROWSER ?? "/usr/bin/google-chrome";

async function withPage<T>(html: string, run: (page: Page) => Promise<T>): Promise<T> {
  const browser = await chromium.launch({ executablePath: BROWSER_PATH, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    return await run(page);
  } finally {
    await browser.close();
  }
}

test("waitForChatGptDomRevision returns the current key immediately without an afterKey", async () => {
  await withPage('<div id="target" class="idle">Content</div>', async (page) => {
    const t0 = Date.now();
    const verdict = await waitForChatGptDomRevision(page);
    expect(Date.now() - t0).toBeLessThan(100);
    expect(verdict.timedOut).toBe(false);
    expect(verdict.key).toContain(":");
    expect(verdict.revision).toBeGreaterThanOrEqual(0);
  });
});

test("waitForChatGptDomRevision wakes as soon as a qualifying mutation happens", async () => {
  await withPage(
    `<div id="target" class="idle">Content</div>
     <script>setTimeout(() => { document.getElementById("target").className = "streaming"; }, 80);</script>`,
    async (page) => {
      const first = await waitForChatGptDomRevision(page);
      const t0 = Date.now();
      const verdict = await waitForChatGptDomRevision(page, { afterKey: first.key, horizonMs: 2_000 });
      const elapsed = Date.now() - t0;
      expect(verdict.timedOut).toBe(false);
      expect(verdict.revision).toBeGreaterThan(first.revision);
      expect(elapsed).toBeGreaterThanOrEqual(70);
      expect(elapsed).toBeLessThan(800);
    },
  );
});

test("waitForChatGptDomRevision resolves immediately when the live key already differs from afterKey", async () => {
  await withPage('<div id="target" class="mutated-earlier">Content</div>', async (page) => {
    const t0 = Date.now();
    const verdict = await waitForChatGptDomRevision(page, { afterKey: "stale-document:0" });
    expect(Date.now() - t0).toBeLessThan(100);
    expect(verdict.timedOut).toBe(false);
  });
});

test("waitForChatGptDomRevision ignores mutations outside the revision attribute filter", async () => {
  await withPage(
    `<div id="target" class="idle">Content</div>
     <script>setTimeout(() => { document.getElementById("target").setAttribute("data-noise", "1"); }, 60);</script>`,
    async (page) => {
      const first = await waitForChatGptDomRevision(page);
      const t0 = Date.now();
      const verdict = await waitForChatGptDomRevision(page, { afterKey: first.key, horizonMs: 300 });
      const elapsed = Date.now() - t0;
      expect(verdict.timedOut).toBe(true);
      expect(verdict.revision).toBe(first.revision);
      expect(elapsed).toBeGreaterThanOrEqual(280);
      expect(elapsed).toBeLessThan(1_000);
    },
  );
});

test("waitForChatGptDomRevision settles one mutation batch before delivering the wake", async () => {
  await withPage(
    `<div id="target" class="idle">Content</div>
     <script>
       setTimeout(() => { document.getElementById("target").className = "streaming"; }, 60);
       setTimeout(() => { document.getElementById("target").dataset.testid = "answer"; }, 110);
     </script>`,
    async (page) => {
      const first = await waitForChatGptDomRevision(page);
      const t0 = Date.now();
      const verdict = await waitForChatGptDomRevision(page, { afterKey: first.key, horizonMs: 2_000 });
      const elapsed = Date.now() - t0;
      expect(verdict.timedOut).toBe(false);
      // Both batched bumps must land in the delivered revision, not just the first one.
      expect(verdict.revision - first.revision).toBeGreaterThanOrEqual(2);
      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(elapsed).toBeLessThan(1_000);
    },
  );
});

test("waitForChatGptDomRevision rejects with AbortError when the signal fires", async () => {
  await withPage('<div id="target" class="idle">Content</div>', async (page) => {
    const first = await waitForChatGptDomRevision(page);
    const controller = new AbortController();
    const pending = waitForChatGptDomRevision(page, {
      afterKey: first.key,
      horizonMs: 5_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toThrow(DOMException);
  });
});

test("the in-page signal state persists across waits as a single document singleton", async () => {
  let constructions = 0;
  const context = createContext({
    performance: { timeOrigin: 7 },
    document: { documentElement: {} },
    MutationObserver: class {
      constructor(_callback: () => void) {
        constructions += 1;
      }
      observe() {}
    },
    setTimeout: (callback: () => void) => {
      callback();
      return 0;
    },
    clearTimeout: () => {},
  });
  const page = {
    evaluate: async (callback: (...args: unknown[]) => unknown, options: unknown) =>
      runInContext(`(${callback.toString()})`, context)(options),
  } as unknown as Page;
  const first = await waitForChatGptDomRevision(page);
  expect(first.timedOut).toBe(false);
  expect(constructions).toBe(1);
  const second = await waitForChatGptDomRevision(page, { afterKey: first.key, horizonMs: 250 });
  expect(second.timedOut).toBe(true);
  expect(second.key).toBe(first.key);
  expect(second.revision).toBe(first.revision);
  expect(constructions).toBe(1);
});

test("waitForChatGptDomSettle waits out the horizon on a quiet page even without an afterKey", async () => {
  await withPage('<div id="target" class="idle">Content</div>', async (page) => {
    const t0 = Date.now();
    const verdict = await waitForChatGptDomSettle(page, { horizonMs: 250 });
    const elapsed = Date.now() - t0;
    expect(verdict.timedOut).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(240);
    expect(elapsed).toBeLessThan(1_000);
  });
});

test("waitForChatGptDomSettle resolves after a mutation plus its settle window", async () => {
  await withPage(
    `<div id="target" class="idle">Content</div>
     <script>setTimeout(() => { document.getElementById("target").className = "streaming"; }, 60);</script>`,
    async (page) => {
      const t0 = Date.now();
      const verdict = await waitForChatGptDomSettle(page, { horizonMs: 2_000 });
      const elapsed = Date.now() - t0;
      expect(verdict.timedOut).toBe(false);
      // Mutation at ~60ms plus the 150ms settle window.
      expect(elapsed).toBeGreaterThanOrEqual(180);
      expect(elapsed).toBeLessThan(1_000);
    },
  );
});

test("a renderer that never settles raises the observation timeout instead of hanging", async () => {
  const page = { evaluate: async () => new Promise(() => {}) } as unknown as Page;
  await expect(waitForChatGptDomRevision(page, { horizonMs: 100, observationTimeoutMs: 50 })).rejects.toThrow(
    ChatGptBrowserObservationTimeoutError,
  );
});
