import { describe, expect, test } from "bun:test";
import type { Locator, Page } from "playwright-core";
import {
  CHATGPT_CONNECTOR_NAME,
  DEV_CHATGPT_CONNECTOR_NAME,
} from "../src/config";
import {
  chatGptSelectedConnectorControl,
  chatGptConnectorIsSelected,
  chatGptConnectorMentionRowTitles,
  chatGptConnectorMentionFailure,
} from "../src/adapters/chatgpt-web/browser/connectors";

describe("chatGptSelectedConnectorControl", () => {
  test("constructs locator with exact appName and slugified prompt link label", () => {
    let capturedSelector = "";
    let filteredVisible = false;

    const composer = {
      locator: (selector: string) => {
        capturedSelector = selector;
        return {
          filter: (options: { visible?: boolean }) => {
            filteredVisible = Boolean(options.visible);
            return { capturedSelector, filteredVisible };
          },
        };
      },
    } as unknown as Locator;

    const control = chatGptSelectedConnectorControl(composer, "Codex Web Dev");
    expect(capturedSelector).toContain('[data-keyword="Codex Web Dev"]');
    expect(capturedSelector).toContain('[app-mention-display-name="Codex Web Dev"]');
    expect(capturedSelector).toContain('[data-prompt-link-label="$codex-web-dev"]');
    expect(filteredVisible).toBe(true);
    expect(control).toBeDefined();
  });
});

describe("chatGptConnectorIsSelected", () => {
  function createMockComposer(attributesList: Record<string, string | null>[]) {
    return {
      locator: () => ({
        filter: () => ({
          evaluateAll: async (fn: (elements: Array<{ getAttribute: (name: string) => string | null }>) => unknown[]) => {
            const mockElements = attributesList.map(attrs => ({
              getAttribute: (name: string) => attrs[name] ?? null,
            }));
            return fn(mockElements);
          },
        }),
      }),
    } as unknown as Locator;
  }

  test("returns true when an element matches via data-keyword", async () => {
    const composer = createMockComposer([
      { "data-keyword": "Codex Native2" },
    ]);
    const selected = await chatGptConnectorIsSelected(composer, "Codex Native2");
    expect(selected).toBe(true);
  });

  test("returns true when an element matches via app-mention-display-name", async () => {
    const composer = createMockComposer([
      { "app-mention-display-name": "Codex Native2" },
    ]);
    const selected = await chatGptConnectorIsSelected(composer, "Codex Native2");
    expect(selected).toBe(true);
  });

  test("returns true when an element matches via data-prompt-link-label slug", async () => {
    const composer = createMockComposer([
      { "data-prompt-link-label": "$codex-native2" },
    ]);
    const selected = await chatGptConnectorIsSelected(composer, "Codex Native2");
    expect(selected).toBe(true);
  });

  test("returns false when no element matches", async () => {
    const composer = createMockComposer([
      { "data-keyword": "Other Tool" },
    ]);
    const selected = await chatGptConnectorIsSelected(composer, "Codex Native2");
    expect(selected).toBe(false);
  });

  test("throws error when duplicate matching selections exist", async () => {
    const composer = createMockComposer([
      { "data-keyword": "Codex Native2" },
      { "app-mention-display-name": "Codex Native2" },
    ]);
    await expect(
      chatGptConnectorIsSelected(composer, "Codex Native2"),
    ).rejects.toThrow('ChatGPT composer exposed duplicate "Codex Native2" connector selections');
  });

  test("rejects when abortSignal is already aborted", async () => {
    const composer = createMockComposer([
      { "data-keyword": "Codex Native2" },
    ]);
    const controller = new AbortController();
    controller.abort(new Error("turn aborted"));
    await expect(
      chatGptConnectorIsSelected(composer, "Codex Native2", controller.signal),
    ).rejects.toThrow("turn aborted");
  });
});

describe("chatGptConnectorMentionRowTitles", () => {
  test("extracts first lines and trims whitespace", async () => {
    const menuRows = {
      filter: () => ({
        allInnerTexts: async () => [
          "Codex Native2\nDeveloper Assistant",
          "  Python Interpreter  \nRun code",
          "",
          "   \nDetails",
        ],
      }),
    } as unknown as Locator;

    const titles = await chatGptConnectorMentionRowTitles(menuRows);
    expect(titles).toEqual(["Codex Native2", "Python Interpreter"]);
  });

  test("returns empty array when allInnerTexts throws non-abort error", async () => {
    const menuRows = {
      filter: () => ({
        allInnerTexts: async () => {
          throw new Error("Element detached");
        },
      }),
    } as unknown as Locator;

    const titles = await chatGptConnectorMentionRowTitles(menuRows);
    expect(titles).toEqual([]);
  });

  test("re-throws error when abortSignal is aborted", async () => {
    const controller = new AbortController();
    const abortErr = new Error("aborted");
    controller.abort(abortErr);

    const menuRows = {
      filter: () => ({
        allInnerTexts: async () => {
          throw new Error("Element detached");
        },
      }),
    } as unknown as Locator;

    await expect(
      chatGptConnectorMentionRowTitles(menuRows, controller.signal),
    ).rejects.toThrow();
  });
});

describe("chatGptConnectorMentionFailure", () => {
  test("reports menu did not open when page mention container count is 0", async () => {
    const page = {
      locator: () => ({
        count: async () => 0,
      }),
    } as unknown as Page;

    const menuRows = {
      filter: () => ({
        allInnerTexts: async () => ["Codex Native2"],
      }),
    } as unknown as Locator;

    const message = await chatGptConnectorMentionFailure(menuRows, 2, { page });
    expect(message).toBe("ChatGPT connector menu did not open after 2 complete mention trigger attempt(s)");
  });

  test("reports menu did not open when titles is empty even if container found", async () => {
    const page = {
      locator: () => ({
        count: async () => 1,
      }),
    } as unknown as Page;

    const menuRows = {
      filter: () => ({
        allInnerTexts: async () => [],
      }),
    } as unknown as Locator;

    const message = await chatGptConnectorMentionFailure(menuRows, 3, { page });
    expect(message).toBe("ChatGPT connector menu did not open after 3 complete mention trigger attempt(s)");
  });

  test("distinguishes DEV connector when appName is CHATGPT_CONNECTOR_NAME", async () => {
    const menuRows = {
      filter: () => ({
        allInnerTexts: async () => [DEV_CHATGPT_CONNECTOR_NAME],
      }),
    } as unknown as Locator;

    const message = await chatGptConnectorMentionFailure(menuRows, 1, {
      appName: CHATGPT_CONNECTOR_NAME,
    });
    expect(message).toContain(`isolated DEV connector ${JSON.stringify(DEV_CHATGPT_CONNECTOR_NAME)}`);
    expect(message).toContain(`separate connector named ${JSON.stringify(CHATGPT_CONNECTOR_NAME)}`);
  });

  test("reports legacy migration error when legacy connector found", async () => {
    const menuRows = {
      filter: () => ({
        allInnerTexts: async () => ["Codex Native"],
      }),
    } as unknown as Locator;

    const message = await chatGptConnectorMentionFailure(menuRows, 1, {
      appName: CHATGPT_CONNECTOR_NAME,
    });
    expect(message).toContain('Legacy ChatGPT connector "Codex Native" was found');
    expect(message).toContain('do not rename or refresh "Codex Native"');
  });

  test("reports missing connector row for custom appName", async () => {
    const menuRows = {
      filter: () => ({
        allInnerTexts: async () => ["Other Tool", "Web Search"],
      }),
    } as unknown as Locator;

    const message = await chatGptConnectorMentionFailure(menuRows, 3, {
      appName: "Custom Assistant",
    });
    expect(message).toBe(
      'ChatGPT connector menu opened but exposed no row named "Custom Assistant" after 3 complete mention trigger attempt(s); create a connector with that exact name before retrying',
    );
  });

  test("supports custom fetchRowTitles override", async () => {
    const message = await chatGptConnectorMentionFailure({} as Locator, 2, {
      appName: "My Tool",
      fetchRowTitles: async () => ["Row A", "Row B"],
    });
    expect(message).toContain('exposed no row named "My Tool" after 2 complete mention trigger attempt(s)');
  });
});
