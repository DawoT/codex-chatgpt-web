import type { Locator, Page } from "playwright-core";
import {
  CHATGPT_CONNECTOR_NAME,
  DEV_CHATGPT_CONNECTOR_NAME,
  LEGACY_CHATGPT_CONNECTOR_NAMES,
  legacyChatGptConnectorMigrationMessage,
} from "../../../config";
import {
  withBrowserTurnAbort,
  withChatGptBrowserObservationTimeout,
} from "./suspension-clock";

/**
 * Resolves the composer locator matching an active connector control by appName or its slug.
 */
export function chatGptSelectedConnectorControl(
  composer: Locator,
  appName: string,
): Locator {
  const slug = appName.toLowerCase().replace(/\s+/g, "-");
  return composer
    .locator(
      `[data-id^="plugin:"][data-keyword=${JSON.stringify(appName)}], `
      + `[app-mention-display-name=${JSON.stringify(appName)}], `
      + `[data-prompt-link-label=${JSON.stringify(`$${slug}`)}]`
    )
    .filter({ visible: true });
}

/**
 * Checks whether the requested connector is currently selected in the ChatGPT composer.
 * Fails closed if multiple duplicate selections are present.
 */
export async function chatGptConnectorIsSelected(
  composer: Locator,
  appName: string,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  const selected = chatGptSelectedConnectorControl(composer, appName);
  const keywords = await withBrowserTurnAbort(
    withChatGptBrowserObservationTimeout(selected.evaluateAll(elements => (
      elements.map(element => element.getAttribute("data-keyword")
        || element.getAttribute("app-mention-display-name")
        || element.getAttribute("data-prompt-link-label")
        || "")
    ))),
    abortSignal,
  );
  const slug = `$${appName.toLowerCase().replace(/\s+/g, "-")}`;
  const exactMatches = keywords.filter(k => k === appName || k === slug).length;
  if (exactMatches > 1) {
    throw new Error(`ChatGPT composer exposed duplicate ${JSON.stringify(appName)} connector selections`);
  }
  return exactMatches === 1;
}

/**
 * Reads row titles currently rendered in the ChatGPT connector mention dropdown menu.
 * Returns empty array if non-abort error occurs while querying.
 */
export async function chatGptConnectorMentionRowTitles(
  menuRows: Locator,
  abortSignal?: AbortSignal,
): Promise<string[]> {
  let texts: string[];
  try {
    texts = await withBrowserTurnAbort(
      withChatGptBrowserObservationTimeout(menuRows.filter({ visible: true }).allInnerTexts()),
      abortSignal,
    );
  } catch (error) {
    if (abortSignal?.aborted) throw error;
    texts = [];
  }
  return texts
    .map(text => (text.split("\n")[0] ?? "").replace(/\s+/g, " ").trim())
    .filter(title => title.length > 0);
}

export interface ChatGptConnectorMentionFailureOptions {
  appName?: string;
  abortSignal?: AbortSignal;
  page?: Page;
  fetchRowTitles?: (menuRows: Locator, abortSignal?: AbortSignal) => Promise<string[]>;
}

/**
 * Formats diagnostic failure message when attempting to trigger or select a ChatGPT connector mention.
 */
export async function chatGptConnectorMentionFailure(
  menuRows: Locator,
  triggerAttempts: number,
  options?: ChatGptConnectorMentionFailureOptions,
): Promise<string> {
  const abortSignal = options?.abortSignal;
  const page = options?.page;
  const appName = options?.appName ?? CHATGPT_CONNECTOR_NAME;

  let isMentionMenuOpen = true;
  if (page && typeof page.locator === "function") {
    try {
      const container = page.locator(
        '[role="listbox"], [data-testid="mention-menu"], [data-radix-popper-content-wrapper], div.__menu, [class*="suggestionMenu"], .composer-home-top-menu'
      );
      if (typeof container?.count === "function") {
        isMentionMenuOpen = (await container.count().catch(() => 0)) > 0;
      }
    } catch {
      isMentionMenuOpen = true;
    }
  }

  const titles = isMentionMenuOpen
    ? (options?.fetchRowTitles
        ? await options.fetchRowTitles(menuRows, abortSignal)
        : await chatGptConnectorMentionRowTitles(menuRows, abortSignal))
    : [];

  if (titles.length === 0 || !isMentionMenuOpen) {
    return `ChatGPT connector menu did not open after ${triggerAttempts} complete mention trigger attempt(s)`;
  }
  if (appName === CHATGPT_CONNECTOR_NAME && titles.includes(DEV_CHATGPT_CONNECTOR_NAME)) {
    return `ChatGPT exposes the isolated DEV connector ${JSON.stringify(DEV_CHATGPT_CONNECTOR_NAME)},`
      + ` but production requires a separate connector named ${JSON.stringify(CHATGPT_CONNECTOR_NAME)};`
      + ` create ${JSON.stringify(CHATGPT_CONNECTOR_NAME)} against the production tunnel and leave the DEV connector unchanged`;
  }
  if (appName === CHATGPT_CONNECTOR_NAME && !titles.includes(CHATGPT_CONNECTOR_NAME)) {
    const legacyName = LEGACY_CHATGPT_CONNECTOR_NAMES.find(name => titles.includes(name));
    if (legacyName) return legacyChatGptConnectorMigrationMessage(legacyName);
  }
  return `ChatGPT connector menu opened but exposed no row named ${JSON.stringify(appName)}`
    + ` after ${triggerAttempts} complete mention trigger attempt(s)`
    + `; create a connector with that exact name before retrying`;
}
