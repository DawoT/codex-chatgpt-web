import { describe, expect, test } from "bun:test";
import type { Locator, Page } from "playwright-core";
import {
  chatGptActiveComposer,
  chatGptClearComposerState,
} from "../src/adapters/chatgpt-web/browser/composer";

describe("chatGptActiveComposer", () => {
  test("returns the first composer when exactly one visible composer exists", async () => {
    const mockComposer = { isComposer: true };
    const page = {
      locator: () => ({
        filter: () => ({
          count: async () => 1,
          first: () => mockComposer,
        }),
      }),
    } as unknown as Page;

    const composer = await chatGptActiveComposer(page, 1_000);
    expect(composer).toBe(mockComposer as unknown as Locator);
  });

  test("throws error when no composer becomes visible within timeout", async () => {
    const page = {
      locator: () => ({
        filter: () => ({
          count: async () => 0,
          first: () => ({}),
        }),
      }),
    } as unknown as Page;

    await expect(chatGptActiveComposer(page, 100)).rejects.toThrow(
      "ChatGPT composer is unavailable. Reload ChatGPT and retry the task.",
    );
  });

  test("throws error when visible count was greater than 1", async () => {
    const page = {
      locator: () => ({
        filter: () => ({
          count: async () => 2,
          first: () => ({}),
        }),
      }),
    } as unknown as Page;

    let thrownError: unknown;
    try {
      await chatGptActiveComposer(page, 100);
    } catch (err) {
      thrownError = err;
    }
    expect(thrownError).toBeDefined();
    expect((thrownError as Error).message).toContain("ChatGPT composer is unavailable");
    expect(String((thrownError as { cause?: Error }).cause)).toContain("Visible ChatGPT composer count was 2");
  });

  test("aborts immediately when abortSignal is already aborted", async () => {
    const page = {
      locator: () => ({
        filter: () => ({
          count: async () => 1,
          first: () => ({}),
        }),
      }),
    } as unknown as Page;

    const controller = new AbortController();
    controller.abort(new DOMException("ChatGPT prompt attachment aborted", "AbortError"));

    await expect(
      chatGptActiveComposer(page, 1_000, controller.signal),
    ).rejects.toThrow("ChatGPT prompt attachment aborted");
  });
});

describe("chatGptClearComposerState", () => {
  test("focuses, clears text, and verifies empty composer", async () => {
    const actions: string[] = [];
    const mockComposer = {
      focus: async () => { actions.push("focus"); },
      press: async (key: string) => { actions.push(`press:${key}`); },
      evaluate: async () => "",
    } as unknown as Locator;

    const page = {
      locator: () => ({
        press: async () => {},
      }),
    } as unknown as Page;

    await chatGptClearComposerState(page, {
      appName: "Codex Native2",
      activeComposer: async () => mockComposer,
      connectorIsSelected: async () => false,
    });

    expect(actions).toContain("focus");
    expect(actions).toContain("press:Backspace");
  });

  test("throws error when composer retains visible characters after cleanup", async () => {
    const mockComposer = {
      focus: async () => {},
      press: async () => {},
      evaluate: async () => "residual text",
    } as unknown as Locator;

    const page = {
      locator: () => ({
        press: async () => {},
      }),
    } as unknown as Page;

    await expect(
      chatGptClearComposerState(page, {
        appName: "Codex Native2",
        activeComposer: async () => mockComposer,
        connectorIsSelected: async () => false,
      }),
    ).rejects.toThrow("ChatGPT connector cleanup did not produce an empty composer");
  });

  test("throws error when connector remains selected after cleanup", async () => {
    const mockComposer = {
      focus: async () => {},
      press: async () => {},
      evaluate: async () => "",
    } as unknown as Locator;

    const page = {
      locator: () => ({
        press: async () => {},
      }),
    } as unknown as Page;

    await expect(
      chatGptClearComposerState(page, {
        appName: "Codex Native2",
        activeComposer: async () => mockComposer,
        connectorIsSelected: async () => true,
      }),
    ).rejects.toThrow("ChatGPT connector cleanup did not produce an empty composer");
  });
});
