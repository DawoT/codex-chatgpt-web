import type { Locator, Page } from "playwright-core";
import { CHATGPT_COMPOSER_SELECTOR } from "../../../chatgpt-session";
import {
  CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS,
  CHATGPT_COMPOSER_SELECT_ALL_KEY,
  throwIfPromptAttachmentAborted,
  withBrowserTurnAbort,
  withChatGptBrowserObservationTimeout,
} from "./suspension-clock";
import { dismissAllChatGptOverlays } from "./overlays";
import {
  CHATGPT_UI_SETTLE_MS,
  pressChatGptPersonalizationEscape,
  runChatGptPersonalizationCleanup,
  waitForChatGptPersonalizationPoll,
} from "./personalization";
import { chatGptConnectorIsSelected } from "./connectors";

const CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS = 10_000;

/**
 * Resolves the currently active, visible ChatGPT composer.
 * Fails closed if 0 or >1 composers are visible after timeout.
 * Periodically attempts safe overlay dismissal if the composer appears obscured.
 */
export async function chatGptActiveComposer(
  page: Page,
  timeoutMs = 30_000,
  abortSignal?: AbortSignal,
): Promise<Locator> {
  const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
  const deadline = Date.now() + timeoutMs;
  let count = 0;
  let lastOverlayDismissalAttemptAt = 0;
  while (Date.now() < deadline) {
    throwIfPromptAttachmentAborted(abortSignal);
    count = await withBrowserTurnAbort(
      withChatGptBrowserObservationTimeout(
        composers.count(),
        Math.max(1, Math.min(CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS, deadline - Date.now())),
      ),
      abortSignal,
    );
    if (count === 1) return composers.first();
    // Periodically attempt overlay dismissal if composer is obscured
    if (count === 0 && (Date.now() - lastOverlayDismissalAttemptAt) >= 1_500) {
      lastOverlayDismissalAttemptAt = Date.now();
      await dismissAllChatGptOverlays(page).catch(() => 0);
    }
    await withBrowserTurnAbort(
      new Promise(resolveSleep => setTimeout(resolveSleep, 50)),
      abortSignal,
    );
  }
  throw new Error(
    "ChatGPT composer is unavailable. Reload ChatGPT and retry the task.",
    { cause: new Error(`Visible ChatGPT composer count was ${count}`) },
  );
}

export interface ChatGptClearComposerOptions {
  appName: string;
  activeComposer?: (page: Page, timeoutMs?: number, abortSignal?: AbortSignal) => Promise<Locator>;
  connectorIsSelected?: (composer: Locator, abortSignal?: AbortSignal) => Promise<boolean>;
}

/**
 * Resets the ChatGPT composer state: presses escape, focuses, selects all, backspaces,
 * and asserts that the composer is completely empty with no connector selected.
 */
export async function chatGptClearComposerState(
  page: Page,
  options: ChatGptClearComposerOptions,
): Promise<void> {
  const resolveActiveComposer = options.activeComposer ?? ((p, t, s) => chatGptActiveComposer(p, t, s));
  const checkConnectorSelected = options.connectorIsSelected
    ?? ((c, s) => chatGptConnectorIsSelected(c, options.appName, s));

  await runChatGptPersonalizationCleanup(async (deadline, signal) => {
    await pressChatGptPersonalizationEscape(page, deadline, signal);
    const timeoutMs = Math.max(1, deadline - Date.now());
    const composer = await resolveActiveComposer(page, timeoutMs, signal);
    await composer.focus({
      signal,
      timeout: Math.max(1, Math.min(CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS, deadline - Date.now())),
    });
    await composer.press(CHATGPT_COMPOSER_SELECT_ALL_KEY, {
      signal,
      timeout: Math.max(1, Math.min(CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS, deadline - Date.now())),
    });
    await composer.press("Backspace", {
      signal,
      timeout: Math.max(1, Math.min(CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS, deadline - Date.now())),
    });
    await waitForChatGptPersonalizationPoll(CHATGPT_UI_SETTLE_MS, signal);
    const settledComposer = await resolveActiveComposer(page, Math.max(1, deadline - Date.now()), signal);
    const remainingMs = Math.max(1, deadline - Date.now());
    const remainingText = await settledComposer.evaluate(
      element => element.textContent?.trim() ?? "",
      undefined,
      { timeout: remainingMs, signal },
    );
    const connectorSelected = await checkConnectorSelected(settledComposer, signal);
    if (remainingText.length > 0 || connectorSelected) {
      throw new Error(
        `ChatGPT connector cleanup did not produce an empty composer`
        + ` (visibleCharacters=${remainingText.length}, connectorSelected=${connectorSelected})`,
      );
    }
  });
}
