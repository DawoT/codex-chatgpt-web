import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import {
  waitForElementAttribute,
  waitForElementText,
  waitForSliderValue,
} from "../src/adapters/chatgpt-web/browser/dom-events";

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
    await page.setContent(`
      <div id="target" aria-expanded="true">Content</div>
      <script>
        setTimeout(() => {
          document.getElementById("target").setAttribute("aria-expanded", "false");
        }, 80);
      </script>
    `);
    const target = page.locator("#target");

    const t0 = Date.now();
    await waitForElementAttribute(target, "aria-expanded", "false", 2_000);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(elapsed).toBeLessThan(500);
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

    await expect(waitForElementAttribute(target, "aria-expanded", "false", 150)).rejects.toThrow(
      /Timeout waiting for attribute aria-expanded/,
    );
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
    await page.setContent(`
      <span role="slider" aria-valuenow="1" aria-valuemin="0" aria-valuemax="4"></span>
      <script>
        setTimeout(() => {
          document.querySelector('[role="slider"]').setAttribute("aria-valuenow", "2");
        }, 60);
      </script>
    `);
    const slider = page.locator('[role="slider"]');

    const t0 = Date.now();
    await waitForSliderValue(slider, 2, 2_000);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(500);
  } finally {
    await browser.close();
  }
});

test("waitForElementText resolves via MutationObserver when innerText changes", async () => {
  const browser = await chromium.launch({ executablePath: BROWSER_PATH, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <button id="btn">Thinking effort</button>
      <script>
        setTimeout(() => {
          document.getElementById("btn").textContent = "High";
        }, 70);
      </script>
    `);
    const btn = page.locator("#btn");

    const t0 = Date.now();
    await waitForElementText(btn, "High", 2_000);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(60);
    expect(elapsed).toBeLessThan(500);
    expect(await btn.innerText()).toBe("High");
  } finally {
    await browser.close();
  }
});
