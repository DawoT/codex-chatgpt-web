import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import type { Locator } from "playwright-core";
import { extractAttachedPromptText } from "../src/adapters/chatgpt-web/browser/prompt-readback";

/**
 * Drives the real `extractAttachedPromptText` evaluation against a synthetic domino DOM inside a
 * `node:vm` context — the same technique the browser-worker contract tests use. The locator fake
 * serializes the module's browser callback and runs it against the domino element, so the test
 * exercises exactly the code a real Chromium page would.
 */
function dominoComposer(html: string): { composer: Locator; evaluateOptions: unknown[] } {
  const { createWindow } = require("@mixmark-io/domino");
  const window = createWindow(html);
  const element = window.document.querySelector('[data-lexical-editor="true"]');
  const context = createContext({
    document: window.document,
    HTMLElement: window.HTMLElement,
  });
  const evaluateOptions: unknown[] = [];
  const composer = {
    evaluate: async (callback: (...args: unknown[]) => unknown, arg: unknown, options: unknown) => {
      evaluateOptions.push(options);
      return runInContext(`(${callback.toString()})`, context)(element, arg);
    },
  } as unknown as Locator;
  return { composer, evaluateOptions };
}

test("soft breaks between words become newlines and Lexical empty paragraphs survive", async () => {
  const { composer } = dominoComposer(
    '<div data-lexical-editor="true"><p><span>Hello</span><br><span>world</span></p><p><br></p><p>Done</p></div>',
  );
  await expect(extractAttachedPromptText(composer, "Codex Web")).resolves.toBe("Hello\nworld\n\nDone");
});

test("cursor-target selection pills are removed without leaving blank lines", async () => {
  const { composer } = dominoComposer(
    '<div data-lexical-editor="true"><p>Body</p><span data-inline-selection-pill-cursor-target></span><p>End</p></div>',
  );
  // If the pill survived it would contribute an empty line between the two paragraphs.
  await expect(extractAttachedPromptText(composer, "Codex Web")).resolves.toBe("Body\nEnd");
});

test("connector pills matching the app are removed and legitimate user mentions survive", async () => {
  const { composer } = dominoComposer(
    '<div data-lexical-editor="true">' +
      '<span data-id="plugin:123" data-keyword="Codex Web" app-mention-display-name="Codex Web">@Codex Web</span>' +
      '<span data-prompt-link-label="$codex-web">$codex-web</span>' +
      '<span app-mention-display-name="Codex Web">connector</span>' +
      '<span data-prompt-link-label="Codex Web">link</span>' +
      '<span class="Mention-xyz">@codex-web</span>' +
      '<span class="Mention-upper">$Codex Web</span>' +
      '<span class="Mention-user">@cloudflare/workers</span>' +
      "<p>Inspect @cloudflare/workers dependency</p>" +
      "</div>",
  );
  await expect(extractAttachedPromptText(composer, "Codex Web")).resolves.toBe(
    "@cloudflare/workers\nInspect @cloudflare/workers dependency",
  );
});

test("an absent app name removes every connector pill but keeps user text", async () => {
  const { composer } = dominoComposer(
    '<div data-lexical-editor="true">' +
      '<span data-id="plugin:123" data-keyword="Anything">@Anything</span>' +
      '<span class="Mention-x">@some-other-app</span>' +
      "<p>Plain instructions</p>" +
      "</div>",
  );
  await expect(extractAttachedPromptText(composer, undefined)).resolves.toBe("Plain instructions");
});

test("top-level children are joined with newlines and only the start is trimmed", async () => {
  const { composer } = dominoComposer('<div data-lexical-editor="true">  \n<p>Start</p><p>End </p></div>');
  await expect(extractAttachedPromptText(composer, "Codex Web")).resolves.toBe("Start\nEnd ");
});

test("evaluation options carry the requested timeout and abort signal", async () => {
  const { composer, evaluateOptions } = dominoComposer('<div data-lexical-editor="true"><p>Hi</p></div>');
  const controller = new AbortController();
  await extractAttachedPromptText(composer, "Codex Web", { timeoutMs: 20_000, signal: controller.signal });
  expect(evaluateOptions).toEqual([{ timeout: 20_000, signal: controller.signal }]);
});
