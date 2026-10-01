import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { chatGptConnectionInterruptedVisible } from "../src/adapters/chatgpt-web/browser/overlays";

test("interruption detection ignores quoted content and hidden duplicates in a real browser", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHATGPT_DOM_TEST_BROWSER ?? "/usr/bin/google-chrome",
    headless: true,
  });
  try {
    const page = await browser.newPage();
    for (const text of [
      "Connection interrupted. Waiting for the full response",
      "Conexión interrumpida. Esperando la respuesta completa",
    ]) {
      await page.setContent(`
        <main>
          <div role="status">${text}</div>
        </main>
      `);
      expect(await chatGptConnectionInterruptedVisible(page)).toBe(true);
    }
    await page.setContent(`
      <main>
        <div role="status">Conexión interrumpida. Esperando la respuesta completa</div>
        <div role="status" hidden>Connection interrupted. Waiting for the full response</div>
      </main>
    `);
    expect(await chatGptConnectionInterruptedVisible(page)).toBe(true);
    await page.setContent(`
      <main>
        <div data-message-author-role="user">
          <div role="status">Connection interrupted</div>
        </div>
        <div class="markdown">
          <blockquote role="status">Conexión interrumpida</blockquote>
        </div>
      </main>
    `);
    expect(await chatGptConnectionInterruptedVisible(page)).toBe(false);
    await page.setContent(`
      <main>
        <p>Connection interrupted</p>
        <div role="status">Normal generation status</div>
        <div role="status" hidden>Conexión interrumpida</div>
      </main>
    `);
    expect(await chatGptConnectionInterruptedVisible(page)).toBe(false);
  } finally {
    await browser.close();
  }
});

test("only a banner belonging to the current assistant turn or the page surface interrupts observation", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHATGPT_DOM_TEST_BROWSER ?? "/usr/bin/google-chrome",
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <article data-turn-id="old">
          <div role="status">Connection interrupted</div>
        </article>
        <article data-turn-id="current">
          <div role="status">Thinking</div>
        </article>
      </main>
    `);
    expect(await chatGptConnectionInterruptedVisible(page, "current")).toBe(false);
    await page.locator('[data-turn-id="current"] [role="status"]').evaluate((element) => {
      element.textContent = "Conexión interrumpida";
    });
    expect(await chatGptConnectionInterruptedVisible(page, "current")).toBe(true);
    await page.setContent(`
      <main>
        <div role="status">Connection interrupted</div>
        <article data-turn-key="current">
          <div data-conversation-role="assistant">Partial answer</div>
        </article>
      </main>
    `);
    expect(await chatGptConnectionInterruptedVisible(page, "group:assistant:current")).toBe(true);
  } finally {
    await browser.close();
  }
});
