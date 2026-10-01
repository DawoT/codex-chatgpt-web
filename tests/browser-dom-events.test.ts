import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import {
  waitForElementAttribute,
  waitForElementText,
  waitForSliderValue,
} from "../src/adapters/chatgpt-web/browser/dom-events";
import { fakeLocator, fakePage } from "./fixtures/browser-fakes";

async function waitUntilElementObserverArmed(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const scope = globalThis as typeof globalThis & {
      __CODEX_WEB_GPT_ELEMENT_WAITS__?: Map<string, unknown>;
    };
    return (scope.__CODEX_WEB_GPT_ELEMENT_WAITS__?.size ?? 0) > 0;
  });
}

const BROWSER_PATH = process.env.CHATGPT_DOM_TEST_BROWSER ?? "/usr/bin/google-chrome";

test("waitForElementAttribute resolves immediately when attribute already matches", async () => {
  const browser = await chromium.launch({ executablePath: BROWSER_PATH, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="target" aria-expanded="false">Content</div>');
    const target = page.locator("#target");

    const t0 = Date.now();
    await waitForElementAttribute(target, "aria-expanded", "false", 1_000);
    expect(Date.now() - t0).toBeLessThan(100);
  } finally {
    await browser.close();
  }
});

test("waitForElementAttribute resolves via MutationObserver when attribute mutates asynchronously", async () => {
  const browser = await chromium.launch({ executablePath: BROWSER_PATH, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="target" aria-expanded="true">Content</div>');
    const target = page.locator("#target");
    let settled = false;
    const pending = waitForElementAttribute(target, "aria-expanded", "false", 2_000).then(() => {
      settled = true;
    });
    await waitUntilElementObserverArmed(page);
    expect(settled).toBeFalse();
    await target.evaluate((element) => element.setAttribute("aria-expanded", "false"));
    await pending;
    expect(settled).toBeTrue();
    expect(await target.getAttribute("aria-expanded")).toBe("false");
  } finally {
    await browser.close();
  }
});

test("waitForElementAttribute throws when timeout expires without matching mutation", async () => {
  const browser = await chromium.launch({ executablePath: BROWSER_PATH, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="target" aria-expanded="true">Content</div>');
    const target = page.locator("#target");

    await expect(waitForElementAttribute(target, "aria-expanded", "false", 150)).rejects.toThrow(/Timeout/);
    expect(await target.getAttribute("aria-expanded")).toBe("true");
    expect(
      await page.evaluate(() => {
        const scope = globalThis as typeof globalThis & {
          __CODEX_WEB_GPT_ELEMENT_WAITS__?: Map<string, unknown>;
        };
        return scope.__CODEX_WEB_GPT_ELEMENT_WAITS__?.size ?? 0;
      }),
    ).toBe(0);
  } finally {
    await browser.close();
  }
});

test("waitForSliderValue resolves immediately when slider already has the target value", async () => {
  const browser = await chromium.launch({ executablePath: BROWSER_PATH, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<span role="slider" aria-valuenow="2" aria-valuemin="0" aria-valuemax="4"></span>');
    const slider = page.locator('[role="slider"]');

    const t0 = Date.now();
    await waitForSliderValue(slider, 2, 1_000);
    expect(Date.now() - t0).toBeLessThan(100);
  } finally {
    await browser.close();
  }
});

test("waitForSliderValue resolves via MutationObserver when slider value changes", async () => {
  const browser = await chromium.launch({ executablePath: BROWSER_PATH, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<span role="slider" aria-valuenow="1" aria-valuemin="0" aria-valuemax="4"></span>');
    const slider = page.locator('[role="slider"]');
    const pending = waitForSliderValue(slider, 2, 2_000);
    await waitUntilElementObserverArmed(page);
    expect(await slider.getAttribute("aria-valuenow")).toBe("1");
    await slider.evaluate((element) => element.setAttribute("aria-valuenow", "2"));
    await pending;
    expect(await slider.getAttribute("aria-valuenow")).toBe("2");
  } finally {
    await browser.close();
  }
});

test("waitForElementText resolves via MutationObserver when innerText changes", async () => {
  const browser = await chromium.launch({ executablePath: BROWSER_PATH, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<button id="btn">Thinking effort</button>');
    const btn = page.locator("#btn");
    const pending = waitForElementText(btn, "High", 2_000);
    await waitUntilElementObserverArmed(page);
    expect(await btn.innerText()).toBe("Thinking effort");
    await btn.evaluate((element) => {
      element.textContent = "High";
    });
    await pending;
    expect(await btn.innerText()).toBe("High");
  } finally {
    await browser.close();
  }
});

test("element attribute and text waits release their observers on abort", async () => {
  const browser = await chromium.launch({ executablePath: BROWSER_PATH, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<button id="target" aria-expanded="true">Old</button>');
    for (const kind of ["attribute", "text", "immediate-attribute", "immediate-text"]) {
      const controller = new AbortController();
      const pending = kind.endsWith("attribute")
        ? waitForElementAttribute(page.locator("#target"), "aria-expanded", "false", 1500, controller.signal)
        : waitForElementText(page.locator("#target"), "New", 1500, controller.signal);
      const observed = pending.then(
        () => "resolved",
        (error: Error) => error.name,
      );
      if (!kind.startsWith("immediate")) await waitUntilElementObserverArmed(page);
      controller.abort();
      expect(await Promise.race([observed, Bun.sleep(200).then(() => "surviving")])).toBe("AbortError");
      expect(
        await page.evaluate(() => {
          const scope = globalThis as typeof globalThis & { __CODEX_WEB_GPT_ELEMENT_WAITS__?: Map<string, unknown> };
          return scope.__CODEX_WEB_GPT_ELEMENT_WAITS__?.size ?? 0;
        }),
      ).toBe(0);
    }
  } finally {
    await browser.close();
  }
});

test("abort during ElementHandle acquisition handoff disposes the acquired handle", async () => {
  const controller = new AbortController();
  let disposals = 0;
  const handle = {
    dispose: async () => {
      disposals += 1;
    },
    evaluate: async () => {},
  };
  const locator = fakeLocator({ page: () => fakePage() });
  Reflect.set(locator, "elementHandle", () => Promise.resolve(handle));
  const pending = waitForElementAttribute(locator, "aria-expanded", "false", 1000, controller.signal);
  queueMicrotask(() => controller.abort());
  await expect(pending).rejects.toThrow("aborted");
  expect(disposals).toBe(1);
});
