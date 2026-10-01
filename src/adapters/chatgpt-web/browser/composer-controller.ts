import type { Locator, Page } from "playwright-core";
import {
  assertAuthenticatedChatGptPage,
  assertNewChatPage,
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_USER_TURN_SELECTOR,
  chatGptNewChatUrl,
} from "../../../chatgpt-session";
import { CHATGPT_CONNECTOR_NAME, DEV_CHATGPT_CONNECTOR_NAME, LEGACY_CHATGPT_CONNECTOR_NAMES } from "../../../config";
import type { CompiledChatGptWebPrompt } from "../prompt";
import { chatGptActiveComposer, chatGptClearComposerState, chatGptReuseCleanConnector } from "./composer";
import type { ResolvedBrowserConfig } from "./config";
import {
  CHATGPT_ATTACHMENT_INPUT_SELECTOR,
  CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
  CHATGPT_MENTION_MENU_ROWS_SELECTOR,
  chatGptConnectorIsSelected,
  chatGptConnectorMentionFailure,
  chatGptConnectorMentionRowTitles,
  chatGptRowIsHighlighted,
  chatGptSelectedConnectorControl,
} from "./connectors";
import { waitForChatGptDomRevision, waitForChatGptDomSettle } from "./dom-signal";
import { chatGptConnectorAttachmentMode } from "./dom-trackers";
import {
  ChatGptPromptAttachmentIntegrityError,
  dismissAllChatGptOverlays,
  dismissChatGptTemporaryChatOnboarding,
  throwIfChatGptRateLimitDialog,
  throwIfChatGptSessionFailureAlert,
} from "./overlays";
import { chatGptPromptFilePayloads, insertPlainTextIntoComposer, setChatGptThinkMode } from "./payloads";
import {
  ChatGptPersistentBrowserStateError,
  chatGptConnectorUnavailableError,
  ensureChatGptPersonalizedConnectorAccess,
} from "./personalization";
import { promptEquivalentPrefixLength, promptTextEquivalent } from "./prompt-equivalence";
import { extractAttachedPromptText } from "./prompt-readback";
import {
  CHATGPT_COMPOSER_DOCUMENT_END_KEY,
  throwIfPromptAttachmentAborted,
  withBrowserTurnAbort,
  withChatGptBrowserObservationTimeout,
} from "./suspension-clock";
import type { ChatGptTurnEventBus } from "./turn-events";

export const MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS = 3;
const CHATGPT_CONNECTOR_MENTION_QUERY = "@codex";

export interface ChatGptConnectorAttemptBudget {
  triggerAttempts: number;
}

export class ChatGptConnectorCatalogStaleError extends Error {
  constructor(
    readonly appName: string,
    readonly triggerAttempts: number,
  ) {
    super(`ChatGPT connector catalog is missing ${JSON.stringify(appName)}`);
    this.name = "ChatGptConnectorCatalogStaleError";
  }
}

/**
 * Dependencies the composer/connector/attachment flow borrows from the worker, injected at
 * construction: the resolved browser configuration (connector identity). Prompt readback is
 * composed from the pure prompt-readback module and prompt equivalence from its pure module;
 * every other member is the controller's own method and recurses through `this` directly.
 */
export interface ComposerControllerDeps {
  readonly config: ResolvedBrowserConfig;
}

export class ComposerController {
  constructor(private readonly deps: ComposerControllerDeps) {}

  async activeComposer(page: Page, timeoutMs = 30_000, abortSignal?: AbortSignal): Promise<Locator> {
    return chatGptActiveComposer(page, timeoutMs, abortSignal);
  }

  /** Read back the prompt currently attached to the active composer. */
  async attachedPromptText(page: Page, abortSignal?: AbortSignal): Promise<string> {
    const composer = await this.activeComposer(page, 30_000, abortSignal);
    return extractAttachedPromptText(composer, this.deps.config?.appName, {
      timeoutMs: 20_000,
      signal: abortSignal,
    });
  }

  /** Prepare a new conversation; account inspection still uses an empty Temporary Chat. */
  async prepareChatSurface(
    page: Page,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    useSavedChats = false,
  ): Promise<Locator> {
    // Launcher verification refreshes its owned page before attaching Playwright so a newly added
    // connector is present in the catalog. Navigating again here destroys that freshly hydrated
    // document and made the first verification race a second SPA bootstrap. A leased turn starts on
    // about:blank and therefore still performs exactly one navigation through this same method.
    const targetUrl = chatGptNewChatUrl(useSavedChats);
    const existingTurnsPresent =
      page.url() === targetUrl &&
      (await (async () => {
        try {
          const u = page.locator(CHATGPT_USER_TURN_SELECTOR);
          const a = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR);
          const userCount = typeof u?.count === "function" ? await u.count().catch(() => 0) : 0;
          const assistantCount = typeof a?.count === "function" ? await a.count().catch(() => 0) : 0;
          return userCount > 0 || assistantCount > 0;
        } catch {
          return false;
        }
      })());
    if (page.url() !== targetUrl || existingTurnsPresent) {
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await captureDiagnostic?.(
        useSavedChats ? "saved-chat-navigation-complete" : "temporary-chat-navigation-complete",
      );
    }
    const initialDismissed = await dismissAllChatGptOverlays(page, { captureDiagnostic }).catch(() => 0);
    if (initialDismissed > 0) {
      await captureDiagnostic?.("overlays-dismissed-before-composer");
    }
    // A failed page read is not evidence of an expired login. Preserve the actual
    // observation error; the authenticated-session check below owns login failures.
    const composer = await this.activeComposer(page);
    const postDismissed = await dismissAllChatGptOverlays(page, { captureDiagnostic }).catch(() => 0);
    if (postDismissed > 0 || (!useSavedChats && (await dismissChatGptTemporaryChatOnboarding(page)))) {
      await captureDiagnostic?.("temporary-chat-onboarding-dismissed");
    }
    await captureDiagnostic?.("composer-ready");
    await throwIfChatGptSessionFailureAlert(page);
    await assertAuthenticatedChatGptPage(page);
    await assertNewChatPage(page, useSavedChats);
    await captureDiagnostic?.("session-verified");
    if (typeof page.evaluate === "function") {
      await page
        .evaluate(() => {
          try {
            const desc = Object.getOwnPropertyDescriptor(Document.prototype, "title");
            if (desc?.set && !(desc.set as { __clamped?: boolean }).__clamped) {
              const originalSet = desc.set;
              const clampedSet = function (this: Document, value: string) {
                const clamped = typeof value === "string" && value.length > 200 ? `${value.slice(0, 197)}...` : value;
                return originalSet.call(this, clamped);
              };
              (clampedSet as { __clamped?: boolean }).__clamped = true;
              Object.defineProperty(document, "title", {
                get: desc.get,
                set: clampedSet,
                configurable: true,
              });
            }
            const clampTitleElement = () => {
              const titleEl = document.querySelector("title");
              if (titleEl && (titleEl.textContent?.length ?? 0) > 200) {
                titleEl.textContent = `${titleEl.textContent!.slice(0, 197)}...`;
              }
            };
            clampTitleElement();
            const globalAny = globalThis as typeof globalThis & { __TITLE_OBSERVER_ATTACHED__?: boolean };
            if (!globalAny.__TITLE_OBSERVER_ATTACHED__) {
              globalAny.__TITLE_OBSERVER_ATTACHED__ = true;
              const titleObserver = new MutationObserver(() => clampTitleElement());
              const target = document.querySelector("title") || document.head;
              if (target) {
                titleObserver.observe(target, { childList: true, characterData: true, subtree: true });
              }
            }
            for (const el of document.querySelectorAll('[contenteditable="true"], textarea')) {
              el.setAttribute("spellcheck", "false");
              el.setAttribute("autocorrect", "off");
              el.setAttribute("autocapitalize", "off");
            }
          } catch {}
        })
        .catch(() => {});
    }
    return composer;
  }

  async assertPromptAttached(page: Page, prompt: string, abortSignal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + 10_000;
    let observed = "";
    let domKey: string | undefined;
    for (;;) {
      throwIfPromptAttachmentAborted(abortSignal);
      observed = await this.attachedPromptText(page, abortSignal);
      throwIfPromptAttachmentAborted(abortSignal);
      if (promptTextEquivalent(prompt, observed)) return;
      if (Date.now() >= deadline) break;
      // React commits the prompt asynchronously; wake on the composer's next qualifying mutation
      // instead of re-reading on a fixed 200 ms beat. Text edits always bump the revision.
      const verdict = await waitForChatGptDomRevision(page, {
        afterKey: domKey,
        settleMs: 150,
        horizonMs: 200,
        signal: abortSignal,
      });
      domKey = verdict.key;
    }
    throwIfPromptAttachmentAborted(abortSignal);
    const commonPrefix = promptEquivalentPrefixLength(prompt, observed);
    throw new ChatGptPromptAttachmentIntegrityError(
      `ChatGPT composer did not preserve the complete prompt (expectedChars=${prompt.length}, actualChars=${observed.length}, commonPrefixChars=${commonPrefix})`,
    );
  }

  selectedConnectorControl(composer: Locator): Locator {
    return chatGptSelectedConnectorControl(composer, this.deps.config.appName);
  }

  async connectorIsSelected(composer: Locator, abortSignal?: AbortSignal): Promise<boolean> {
    return chatGptConnectorIsSelected(composer, this.deps.config.appName, abortSignal);
  }

  async connectorMentionRowTitles(menuRows: Locator, abortSignal?: AbortSignal): Promise<string[]> {
    return chatGptConnectorMentionRowTitles(menuRows, abortSignal);
  }

  async connectorMentionFailure(
    menuRows: Locator,
    triggerAttempts: number,
    abortSignal?: AbortSignal,
    page?: Page,
  ): Promise<string> {
    return chatGptConnectorMentionFailure(menuRows, triggerAttempts, {
      appName: this.deps.config?.appName,
      abortSignal,
      page,
      fetchRowTitles: (rows, signal) => this.connectorMentionRowTitles(rows, signal),
    });
  }

  async clearChatGptComposerState(page: Page): Promise<void> {
    return chatGptClearComposerState(page, {
      appName: this.deps.config?.appName,
      activeComposer: (p, t, s) => this.activeComposer(p, t, s),
      connectorIsSelected: (c, s) => this.connectorIsSelected(c, s),
    });
  }

  async selectConnector(
    page: Page,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    catalogRefreshAvailable = false,
    attemptBudget: ChatGptConnectorAttemptBudget = { triggerAttempts: 0 },
    abortSignal?: AbortSignal,
    hasExistingTurns = false,
    turnEvents?: ChatGptTurnEventBus,
  ): Promise<Locator> {
    const capture = async (checkpoint: string): Promise<void> => {
      throwIfPromptAttachmentAborted(abortSignal);
      await withBrowserTurnAbort(captureDiagnostic?.(checkpoint) ?? Promise.resolve(), abortSignal);
      throwIfPromptAttachmentAborted(abortSignal);
    };
    let composer: Locator;
    const menuRows = page.locator(CHATGPT_MENTION_MENU_ROWS_SELECTOR);
    const appResult = menuRows.filter({
      has: page.getByText(this.deps.config.appName, { exact: true }),
    });
    const pageUrl = page.url();
    const isTemporaryChat = Boolean(
      pageUrl && new URL(pageUrl, "https://chatgpt.com").searchParams.get("temporary-chat") === "true",
    );
    if (isTemporaryChat && !hasExistingTurns)
      await ensureChatGptPersonalizedConnectorAccess(
        page,
        capture,
        async (personalizationSignal) => {
          let proofResult: boolean | undefined;
          let proofError: unknown;
          try {
            composer = await this.activeComposer(page, 30_000, personalizationSignal);
            await composer.fill("", {
              signal: personalizationSignal,
              timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
            });
            if (typeof page?.bringToFront === "function") {
              await page.bringToFront().catch(() => {});
            }
            await composer.focus({
              signal: personalizationSignal,
              timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
            });
            await waitForChatGptDomSettle(page, { signal: personalizationSignal, horizonMs: 250 });
            await composer.pressSequentially(CHATGPT_CONNECTOR_MENTION_QUERY, {
              delay: 25,
              signal: personalizationSignal,
              timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
            });
            await capture("personalization-proof-mention-triggered");
            try {
              await appResult.waitFor({ state: "visible", timeout: 2_500, signal: personalizationSignal });
              proofResult = true;
              await capture("personalization-proof-menu-visible");
            } catch (error) {
              if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
              proofResult = false;
              await capture("personalization-proof-menu-missing");
              const mention = await composer.evaluate(
                (element) => ({
                  text:
                    element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
                      ? element.value
                      : (element.textContent ?? ""),
                  focused: element === document.activeElement,
                }),
                undefined,
                { timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS, signal: personalizationSignal },
              );
              if (mention.text !== CHATGPT_CONNECTOR_MENTION_QUERY) {
                throw new ChatGptPromptAttachmentIntegrityError(
                  `ChatGPT did not preserve the connector mention (expectedChars=${CHATGPT_CONNECTOR_MENTION_QUERY.length}, actualChars=${mention.text.length}, focused=${mention.focused})`,
                );
              }
            }
          } catch (error) {
            proofError = error;
          }
          try {
            await this.clearChatGptComposerState(page);
          } catch (cleanupError) {
            throw new ChatGptPersistentBrowserStateError(
              proofError !== undefined ? [proofError, cleanupError] : [cleanupError],
              "ChatGPT connector proof did not leave a verified empty composer",
            );
          }
          if (proofError !== undefined) throw proofError;
          return proofResult === true;
        },
        abortSignal,
      );
    try {
      composer = await this.activeComposer(page, 30_000, abortSignal);
      if (await this.connectorIsSelected(composer, abortSignal)) {
        const reusable = await chatGptReuseCleanConnector(
          page,
          {
            readPrompt: (p, signal) => this.attachedPromptText(p, signal),
            clear: (p) => this.clearChatGptComposerState(p),
          },
          abortSignal,
        );
        if (reusable) {
          await capture("connector-already-selected");
          return composer;
        }
        composer = await this.activeComposer(page, 30_000, abortSignal);
      }
      await composer.fill("", { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });

      let firstMenuCaptured = false;
      while (attemptBudget.triggerAttempts < MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS) {
        attemptBudget.triggerAttempts += 1;
        composer = await this.activeComposer(page, 30_000, abortSignal);
        await composer.fill("", { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
        if (typeof page?.bringToFront === "function") {
          await page.bringToFront().catch(() => {});
        }
        await composer.focus({ signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
        await waitForChatGptDomSettle(page, { signal: abortSignal, horizonMs: 250 });
        await composer.pressSequentially(CHATGPT_CONNECTOR_MENTION_QUERY, {
          delay: 25,
          signal: abortSignal,
          timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
        });
        if (!firstMenuCaptured) {
          firstMenuCaptured = true;
          await capture("connector-mention-triggered");
        }
        try {
          await appResult.waitFor({
            state: "visible",
            timeout: 2_500,
            signal: abortSignal,
          });
          await capture("connector-menu-visible");
          break;
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
          const visibleRows = await this.connectorMentionRowTitles(menuRows, abortSignal);
          const knownIdentityMismatch =
            this.deps.config.appName === CHATGPT_CONNECTOR_NAME &&
            (visibleRows.includes(DEV_CHATGPT_CONNECTOR_NAME) ||
              LEGACY_CHATGPT_CONNECTOR_NAMES.some((name) => visibleRows.includes(name)));
          if (knownIdentityMismatch) {
            await capture("connector-menu-missing");
            throw chatGptConnectorUnavailableError(
              await this.connectorMentionFailure(menuRows, attemptBudget.triggerAttempts, abortSignal, page),
            );
          }
          if (
            catalogRefreshAvailable &&
            visibleRows.length > 0 &&
            !visibleRows.includes(this.deps.config.appName) &&
            attemptBudget.triggerAttempts < MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS
          ) {
            throw new ChatGptConnectorCatalogStaleError(this.deps.config.appName, attemptBudget.triggerAttempts);
          }
          if (attemptBudget.triggerAttempts >= MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS) {
            await capture("connector-menu-missing");
            throw chatGptConnectorUnavailableError(
              await this.connectorMentionFailure(menuRows, attemptBudget.triggerAttempts, abortSignal, page),
            );
          }
        }
      }
      const exactResultCount = await withBrowserTurnAbort(
        withChatGptBrowserObservationTimeout(appResult.count()),
        abortSignal,
      );
      if (exactResultCount !== 1) {
        throw chatGptConnectorUnavailableError(
          `ChatGPT connector menu did not expose one exact ${JSON.stringify(this.deps.config.appName)} row` +
            ` after ${attemptBudget.triggerAttempts} complete mention trigger attempt(s)`,
        );
      }
      // Hidden launcher maintenance keeps a 1x1 Chromium viewport, so pointer activation cannot
      // reach this menu. Require the exact row to own ChatGPT's keyboard highlight first;
      // otherwise move the menu highlight until it does. Keep
      // focus on the composer, activate through the menu's real keyboard owner, then prove the exact
      // selected connector pill below.
      const rowHighlighted = async () =>
        chatGptRowIsHighlighted(appResult, abortSignal, CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS);
      if (!(await rowHighlighted())) {
        const visibleRowCount = await withBrowserTurnAbort(
          withChatGptBrowserObservationTimeout(menuRows.filter({ visible: true }).count()),
          abortSignal,
        );
        for (let step = 0; step < visibleRowCount && !(await rowHighlighted()); step += 1) {
          await composer.press("ArrowDown", {
            signal: abortSignal,
            timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
          });
        }
      }
      if (!(await rowHighlighted())) {
        throw new Error(`ChatGPT connector menu could not highlight ${JSON.stringify(this.deps.config.appName)}`);
      }
      await composer.press("Enter", {
        signal: abortSignal,
        timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
      });
      await capture("connector-choice-activated");
      // Selecting a connector replaces the Lexical composer subtree. Resolve the active composer
      // again instead of returning the pre-selection locator, otherwise the real turn can focus a
      // detached/hidden editor even though verification just succeeded.
      const selectedComposer = await this.activeComposer(page, 30_000, abortSignal);
      const selectedConnector = this.selectedConnectorControl(selectedComposer);
      await selectedConnector.waitFor({
        state: "visible",
        timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
        signal: abortSignal,
      });
      turnEvents?.publish({ type: "connector_pill_mounted", source: "dom" });
      if (!(await this.connectorIsSelected(selectedComposer, abortSignal))) {
        throw new Error(
          `ChatGPT composer did not select ${JSON.stringify(this.deps.config?.appName ?? CHATGPT_CONNECTOR_NAME)} connector`,
        );
      }
      await capture("connector-selected");
      return selectedComposer;
    } catch (error) {
      try {
        await this.clearChatGptComposerState(page);
      } catch (cleanupError) {
        throw new ChatGptPersistentBrowserStateError(
          [error, cleanupError],
          "ChatGPT connector selection failed and its composer state could not be cleared",
        );
      }
      throw error;
    }
  }

  async attachPrompt(
    page: Page,
    prompt: string,
    localTools: boolean,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    abortSignal?: AbortSignal,
    catalogRefreshAvailable = false,
    connectorAttemptBudget?: ChatGptConnectorAttemptBudget,
    reuseConnector = false,
    requireThink = false,
    turnEvents?: ChatGptTurnEventBus,
  ): Promise<void> {
    prompt = prompt.replace(/\r\n|\r/g, "\n");
    throwIfPromptAttachmentAborted(abortSignal);
    await throwIfChatGptRateLimitDialog(page);
    throwIfPromptAttachmentAborted(abortSignal);
    const connectorMode = chatGptConnectorAttachmentMode(localTools, reuseConnector);
    let composerMutationStarted = false;
    try {
      if (connectorMode === "none") {
        const composer = await this.activeComposer(page, 30_000, abortSignal);
        // Playwright's multiline fill maps through an input action that ChatGPT's Lexical editor can
        // collapse to the first paragraph on the launcher-owned Electron surface. Clear separately,
        // then transport the complete text through the browser's plain-text editing command.
        composerMutationStarted = true;
        await composer.fill("", { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
        await composer.focus({ signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
        if (requireThink) {
          await setChatGptThinkMode(composer.locator("xpath=ancestor::form[1]"), true, captureDiagnostic, abortSignal);
        }
        await this.insertPromptText(page, prompt, abortSignal);
        await this.assertPromptAttached(page, prompt, abortSignal);
        return;
      }
      let userTurnCount = 0;
      try {
        if (typeof page?.locator === "function") {
          const userTurns = page.locator(CHATGPT_USER_TURN_SELECTOR);
          if (userTurns && typeof userTurns.count === "function") {
            userTurnCount = await userTurns.count().catch(() => 0);
          }
        }
      } catch {
        userTurnCount = 0;
      }
      let selectedComposer: Locator;
      if (connectorMode === "retained") {
        const composer = await this.activeComposer(page, 30_000, abortSignal);
        const alreadyBound = await this.connectorIsSelected(composer, abortSignal);
        const cleanBinding =
          alreadyBound &&
          (await chatGptReuseCleanConnector(
            page,
            {
              readPrompt: (p, signal) => this.attachedPromptText(p, signal),
              clear: async (p) => {
                composerMutationStarted = true;
                await this.clearChatGptComposerState(p);
              },
            },
            abortSignal,
          ));
        selectedComposer = cleanBinding
          ? composer
          : await this.selectConnector(
              page,
              captureDiagnostic,
              catalogRefreshAvailable,
              connectorAttemptBudget,
              abortSignal,
              userTurnCount > 0,
              turnEvents,
            );
      } else {
        selectedComposer = await this.selectConnector(
          page,
          captureDiagnostic,
          catalogRefreshAvailable,
          connectorAttemptBudget,
          abortSignal,
          userTurnCount > 0,
          turnEvents,
        );
      }
      // selectConnector owns and rolls back every mutation until it returns. From this point the
      // attachment owns the selected pill and prompt text as one transaction.
      composerMutationStarted = true;
      if (requireThink) {
        await setChatGptThinkMode(
          selectedComposer.locator("xpath=ancestor::form[1]"),
          true,
          captureDiagnostic,
          abortSignal,
        );
      }
      await selectedComposer.focus({ signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
      await selectedComposer.press(CHATGPT_COMPOSER_DOCUMENT_END_KEY, {
        signal: abortSignal,
        timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
      });
      await this.insertPromptText(page, ` ${prompt}`, abortSignal);
      await this.assertPromptAttached(page, prompt, abortSignal);
    } catch (error) {
      if (!composerMutationStarted || error instanceof ChatGptPersistentBrowserStateError) throw error;
      try {
        await this.clearChatGptComposerState(page);
      } catch (cleanupError) {
        throw new ChatGptPersistentBrowserStateError(
          [error, cleanupError],
          "ChatGPT prompt attachment failed and its composer state could not be cleared",
        );
      }
      throw error;
    }
  }

  async insertPromptText(page: Page, text: string, abortSignal?: AbortSignal): Promise<void> {
    throwIfPromptAttachmentAborted(abortSignal);
    const composer = await this.activeComposer(page, 30_000, abortSignal);
    await composer.focus({ signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
    if (typeof page.keyboard?.insertText === "function") {
      const isProseMirror = await composer.evaluate(
        (el) =>
          el.classList.contains("ProseMirror") ||
          (el.getAttribute("role") === "textbox" && !el.hasAttribute("data-lexical-editor")),
      );
      if (isProseMirror) {
        await page.keyboard.insertText(text);
        return;
      }
    }
    // CDP Input.insertText is interpreted as live typing by ChatGPT's Lexical plugins. On a large
    // JSON transport it can turn literal Markdown backticks into rich code nodes, remove the
    // delimiters from textContent, and leave the next insertion outside the intended block. The
    // browser's plain-text editing command updates the same focused contenteditable atomically
    // without running those Markdown shortcuts. Exact readback below remains the authority.
    const inserted = await composer.evaluate(insertPlainTextIntoComposer, text, {
      timeout: 20_000,
      signal: abortSignal,
    });
    throwIfPromptAttachmentAborted(abortSignal);
    if (!inserted) {
      if (typeof page.keyboard?.insertText === "function") {
        await page.keyboard.insertText(text);
      } else {
        throw new ChatGptPromptAttachmentIntegrityError("ChatGPT composer rejected the plain-text editing command");
      }
    }
  }

  async attachFiles(page: Page, prompt: CompiledChatGptWebPrompt): Promise<void> {
    const files = chatGptPromptFilePayloads(prompt);
    if (files.length === 0) return;
    const composer = await this.activeComposer(page);
    const composerForm = composer.locator("xpath=ancestor::form[1]");
    const input = page.locator(CHATGPT_ATTACHMENT_INPUT_SELECTOR);
    await input.waitFor({ state: "attached", timeout: 20_000 });
    await input.setInputFiles(files);
    try {
      await Promise.all(
        files.map((file) => {
          const byRole = composerForm.getByRole("group", { name: file.name, exact: true });
          const target =
            typeof byRole?.or === "function" && typeof composerForm.locator === "function"
              ? byRole.or(
                  composerForm.locator(
                    `.composer-attachment-surface:is(button, [role="button"])[aria-label=${JSON.stringify(file.name)}]`,
                  ),
                )
              : byRole;
          return target.waitFor({ state: "visible", timeout: 60_000 });
        }),
      );
    } catch {
      const alerts = (
        await page
          .locator('[role="alert"]')
          .allInnerTexts()
          .catch(() => [])
      )
        .map((text) => text.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      throw new Error(
        `ChatGPT did not accept all prompt attachments${alerts.length > 0 ? `: ${alerts.join(" | ")}` : ""}`,
      );
    }
    const send =
      (typeof composerForm.locator === "function"
        ? composerForm
            .locator(
              '[data-testid="send-button"], button[type="submit"]:not([aria-haspopup="menu"]), button[aria-label*="Enviar" i], button[aria-label*="Send" i]',
            )
            .first()
        : undefined) ?? composerForm.getByTestId("send-button");
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await send.isEnabled().catch(() => false)) return;
      await waitForChatGptDomRevision(page, { horizonMs: 100 }).catch(() => {});
    }
    throw new Error("ChatGPT accepted the prompt attachments but did not make the message ready to send");
  }
}
