import type { Locator, Page } from "playwright-core";
import { ChatGptWebAdapterError } from "../adapter-error";
import { waitForChatGptDomSettle } from "./dom-signal";
import { withBrowserTurnAbort } from "./suspension-clock";

export const CHATGPT_UI_SETTLE_MS = 250;

export const settleChatGptUi = (page?: Page, options?: { signal?: AbortSignal; horizonMs?: number }): Promise<void> =>
  page && typeof page.evaluate === "function"
    ? waitForChatGptDomSettle(page, {
        signal: options?.signal,
        horizonMs: options?.horizonMs ?? CHATGPT_UI_SETTLE_MS,
      }).then(() => {})
    : new Promise((resolveSettle) => setTimeout(resolveSettle, CHATGPT_UI_SETTLE_MS));

export function chatGptConnectorUnavailableError(message: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(message, {
    status: 424,
    errorType: "connector_error",
    code: "connector_not_found",
    retryable: false,
  });
}

export async function chatGptUnavailableProDetail(menu: Locator): Promise<string | undefined> {
  // Pro is the product label in the picker. Its linked tooltip supplies the site's own
  // localized explanation/date; do not search the conversation or infer a reset time.
  const rows = menu.getByRole("menuitemradio", { name: "Pro", exact: true }).filter({ visible: true });
  try {
    if ((await rows.count()) !== 1 || (await rows.getAttribute("aria-disabled")) !== "true") return undefined;
    await rows.hover({ timeout: 1_500 });
    return await rows.evaluate(
      async (element) => {
        const deadline = Date.now() + 1_000;
        do {
          const ids = element.getAttribute("aria-describedby")?.trim().split(/\s+/).filter(Boolean) ?? [];
          const tooltips = ids
            .map((id) => document.getElementById(id))
            .filter(
              (node): node is HTMLElement => node instanceof HTMLElement && node.getAttribute("role") === "tooltip",
            );
          const visible = tooltips.filter((node) => {
            for (let current: HTMLElement | null = node; current; current = current.parentElement) {
              const style = getComputedStyle(current);
              if (
                !current.isConnected ||
                current.hidden ||
                current.getAttribute("aria-hidden") === "true" ||
                style.display === "none" ||
                style.visibility === "hidden" ||
                style.opacity === "0"
              )
                return false;
            }
            return true;
          });
          if (visible.length === 1) {
            const text = visible[0]!.textContent?.replace(/\s+/g, " ").trim();
            if (text && text.length <= 512) return text;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        return undefined;
      },
      undefined,
      { timeout: 1_500 },
    );
  } catch {
    // Optional UI detail must not replace the existing model-unavailable error.
    return undefined;
  }
}

export type ChatGptPersonalizationPreflight = "already-personalized" | "enabled";

const CHATGPT_PERSONALIZATION_CONTROL_SELECTOR = [
  '[data-testid="thread-header-right-actions"] [aria-haspopup="menu"]',
  '#conversation-header-actions [aria-haspopup="menu"]',
  "[data-content-sheet-root] > button[aria-expanded][aria-controls]",
].join(", ");
const CHATGPT_PERSONALIZATION_CHOICE_SELECTOR = '[role="menuitemradio"], [role="radio"]';
export const CHATGPT_PERSONALIZATION_PREFLIGHT_TIMEOUT_MS = 60_000;
export const CHATGPT_PERSONALIZATION_CLEANUP_TIMEOUT_MS = 5_000;

const verifiedPersonalizedPages = new WeakSet<Page>();

class ChatGptPersonalizationDeadlineError extends Error {
  constructor() {
    super("ChatGPT personalization preflight exceeded its readiness deadline");
    this.name = "ChatGptPersonalizationDeadlineError";
  }
}

export class ChatGptPersistentBrowserStateError extends AggregateError {
  constructor(errors: Iterable<unknown>, message: string) {
    super(errors, message);
    this.name = "ChatGptPersistentBrowserStateError";
  }
}

function remainingChatGptPersonalizationMs(deadline: number, signal?: AbortSignal): number {
  if (signal?.aborted) throw new DOMException("ChatGPT personalization preflight aborted", "AbortError");
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ChatGptPersonalizationDeadlineError();
  return remaining;
}

async function runChatGptPersonalizationStep<T>(
  operation: () => Promise<T>,
  deadline: number,
  signal?: AbortSignal,
): Promise<T> {
  const timeoutMs = remainingChatGptPersonalizationMs(deadline, signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await withBrowserTurnAbort(
      Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new ChatGptPersonalizationDeadlineError()), timeoutMs);
        }),
      ]),
      signal,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Mutating personalization work owns its AbortSignal and must settle its cleanup before the caller
 * can observe cancellation. Unlike observation races, returning early here could release the page
 * while a rollback or composer clear was still running against the persistent browser profile.
 */
async function runChatGptPersonalizationOwnedStep<T>(
  operation: () => Promise<T>,
  deadline: number,
  signal: AbortSignal,
): Promise<T> {
  remainingChatGptPersonalizationMs(deadline, signal);
  const result = await operation();
  remainingChatGptPersonalizationMs(deadline, signal);
  return result;
}

export async function waitForChatGptPersonalizationPoll(timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    return;
  }
  if (signal.aborted) throw new DOMException("ChatGPT personalization preflight aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("ChatGPT personalization preflight aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runChatGptPersonalizationCleanup<T>(
  operation: (deadline: number, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + CHATGPT_PERSONALIZATION_CLEANUP_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
  timer.unref?.();
  try {
    return await operation(deadline, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function pressChatGptPersonalizationEscape(
  page: Page,
  deadline: number,
  signal: AbortSignal,
): Promise<void> {
  await page.locator("body").press("Escape", {
    timeout: remainingChatGptPersonalizationMs(deadline, signal),
    signal,
  });
}

async function dismissChatGptPersonalizationMenu(page: Page): Promise<void> {
  await runChatGptPersonalizationCleanup((deadline, signal) =>
    pressChatGptPersonalizationEscape(page, deadline, signal),
  );
}

async function waitForChatGptOwnedPersonalizationMenu(
  page: Page,
  control: Locator,
  deadline: number,
  signal?: AbortSignal,
): Promise<Locator> {
  let menuId: string | null = null;
  while (!menuId) {
    const remaining = remainingChatGptPersonalizationMs(deadline, signal);
    menuId = await control.getAttribute("aria-controls", { timeout: remaining, signal });
    if (!menuId) await waitForChatGptPersonalizationPoll(Math.min(50, remaining), signal);
  }
  const menu = page.locator(`[id=${JSON.stringify(menuId)}]`);
  try {
    await menu.waitFor({
      state: "visible",
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    throw chatGptConnectorUnavailableError(
      "ChatGPT personalization control did not expose its owned menu before the readiness deadline",
    );
  }
  return menu;
}

type ChatGptPersonalizationChoiceIndex = 0 | 1;

interface ChatGptPersonalizationState {
  menu: Locator;
  choices: Locator;
  checkedIndex: ChatGptPersonalizationChoiceIndex;
}

interface ChatGptPersonalizationToggleReceipt {
  originalIndex: ChatGptPersonalizationChoiceIndex;
}

async function readChatGptPersonalizationCheckedIndex(
  choices: Locator,
  deadline: number,
  signal: AbortSignal,
): Promise<ChatGptPersonalizationChoiceIndex> {
  const checked: boolean[] = [];
  for (let index = 0; index < 2; index += 1) {
    const choice = choices.nth(index);
    const ariaChecked = await choice.getAttribute("aria-checked", {
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
    const dataState = await choice.getAttribute("data-state", {
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
    checked.push(ariaChecked === "true" || dataState === "checked");
  }
  if (checked.filter(Boolean).length !== 1) {
    throw chatGptConnectorUnavailableError("ChatGPT personalization menu did not expose one checked state");
  }
  return checked[0] ? 0 : 1;
}

async function openChatGptStructuralPersonalizationState(
  page: Page,
  deadline: number,
  signal: AbortSignal,
): Promise<ChatGptPersonalizationState> {
  const controls = page.locator(CHATGPT_PERSONALIZATION_CONTROL_SELECTOR).filter({ visible: true });
  const control = controls.first();
  try {
    await control.waitFor({
      state: "visible",
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    throw chatGptConnectorUnavailableError(
      "ChatGPT Temporary Chat did not expose a structural personalization control before the readiness deadline",
    );
  }
  const controlCount = await runChatGptPersonalizationStep(() => controls.count(), deadline, signal);
  if (controlCount !== 1) {
    throw chatGptConnectorUnavailableError(
      `ChatGPT Temporary Chat exposed ${controlCount} structural personalization controls; expected exactly one`,
    );
  }
  await control.click({
    timeout: remainingChatGptPersonalizationMs(deadline, signal),
    signal,
  });
  const menu = await waitForChatGptOwnedPersonalizationMenu(page, control, deadline, signal);
  const choices = menu.locator(CHATGPT_PERSONALIZATION_CHOICE_SELECTOR).filter({ visible: true });
  if ((await runChatGptPersonalizationStep(() => choices.count(), deadline, signal)) !== 2) {
    throw chatGptConnectorUnavailableError("ChatGPT personalization menu did not expose exactly two checkable states");
  }
  return {
    menu,
    choices,
    checkedIndex: await readChatGptPersonalizationCheckedIndex(choices, deadline, signal),
  };
}

async function restoreChatGptPersonalizationChoice(
  page: Page,
  receipt: ChatGptPersonalizationToggleReceipt,
): Promise<void> {
  await runChatGptPersonalizationCleanup(async (deadline, signal) => {
    await pressChatGptPersonalizationEscape(page, deadline, signal);
    let state = await openChatGptStructuralPersonalizationState(page, deadline, signal);
    if (state.checkedIndex === receipt.originalIndex) {
      await pressChatGptPersonalizationEscape(page, deadline, signal);
      return;
    }
    await state.choices.nth(receipt.originalIndex).click({
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
    await state.menu.waitFor({
      state: "hidden",
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
    await waitForChatGptPersonalizationPoll(CHATGPT_UI_SETTLE_MS, signal);

    state = await openChatGptStructuralPersonalizationState(page, deadline, signal);
    if (state.checkedIndex !== receipt.originalIndex) {
      throw new Error("ChatGPT personalization rollback did not restore the original checked state");
    }
    await pressChatGptPersonalizationEscape(page, deadline, signal);
  });
}

async function toggleChatGptPersonalizationChoice(
  page: Page,
  deadline: number,
  signal: AbortSignal,
): Promise<ChatGptPersonalizationToggleReceipt> {
  let receipt: ChatGptPersonalizationToggleReceipt | undefined;
  try {
    const state = await openChatGptStructuralPersonalizationState(page, deadline, signal);
    receipt = { originalIndex: state.checkedIndex };
    const nextIndex: ChatGptPersonalizationChoiceIndex = state.checkedIndex === 0 ? 1 : 0;
    await state.choices.nth(nextIndex).click({
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
    await state.menu.waitFor({
      state: "hidden",
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
    await runChatGptPersonalizationStep(
      () => settleChatGptUi(page, { signal, horizonMs: CHATGPT_UI_SETTLE_MS }),
      deadline,
      signal,
    );
    return receipt;
  } catch (error) {
    try {
      if (receipt) await restoreChatGptPersonalizationChoice(page, receipt);
      else await dismissChatGptPersonalizationMenu(page);
    } catch (cleanupError) {
      throw new ChatGptPersistentBrowserStateError(
        [error, cleanupError],
        "ChatGPT personalization change failed and its original state could not be restored",
      );
    }
    throw error;
  }
}

async function ensureChatGptPersonalizedConnectorAccessWithinDeadline(
  page: Page,
  deadline: number,
  abortSignal: AbortSignal,
  captureDiagnostic?: (checkpoint: string) => Promise<void>,
  proveConfiguredConnectorAccess?: (signal?: AbortSignal) => Promise<boolean>,
  hasExistingTurns = false,
): Promise<ChatGptPersonalizationPreflight> {
  const capture = async (checkpoint: string): Promise<void> => {
    if (!captureDiagnostic) return;
    await runChatGptPersonalizationStep(() => captureDiagnostic(checkpoint), deadline, abortSignal);
  };
  if (hasExistingTurns) {
    await capture("personalization-already-enabled");
    return "already-personalized";
  }
  const proveConnectorAccess = async (): Promise<boolean> => {
    if (!proveConfiguredConnectorAccess) return false;
    return runChatGptPersonalizationOwnedStep(() => proveConfiguredConnectorAccess(abortSignal), deadline, abortSignal);
  };
  // The visible sheet can be aria-hidden during hydration. Include those controls in the role
  // query but still require visibility; never select a hidden duplicate or switch locator rules.
  const personalized = page
    .getByRole("button", { name: /^(?:Personalized|Personalizado|个性化)$/i, exact: true, includeHidden: true })
    .filter({ visible: true });
  const unpersonalized = page
    .getByRole("button", {
      name: /^(?:Unpersonalized|No personalizado|Sin personalizar|Despersonalizado|非个性化)$/i,
      exact: true,
      includeHidden: true,
    })
    .filter({ visible: true });
  let personalizedCount = await runChatGptPersonalizationStep(() => personalized.count(), deadline, abortSignal);
  let unpersonalizedCount = await runChatGptPersonalizationStep(() => unpersonalized.count(), deadline, abortSignal);
  if (personalizedCount === 0 && unpersonalizedCount === 0) {
    await runChatGptPersonalizationStep(
      () => settleChatGptUi(page, { signal: abortSignal, horizonMs: CHATGPT_UI_SETTLE_MS }),
      deadline,
      abortSignal,
    );
    personalizedCount = await runChatGptPersonalizationStep(() => personalized.count(), deadline, abortSignal);
    unpersonalizedCount = await runChatGptPersonalizationStep(() => unpersonalized.count(), deadline, abortSignal);
    if (personalizedCount === 0 && unpersonalizedCount === 0) {
      if (!proveConfiguredConnectorAccess) {
        await capture("personalization-control-missing");
        throw chatGptConnectorUnavailableError(
          "ChatGPT Temporary Chat did not expose a verifiable personalization control",
        );
      }
      if (await proveConnectorAccess()) {
        await capture("personalization-already-enabled");
        return "already-personalized";
      }
      await capture("personalization-unpersonalized");
      const toggleReceipt = await toggleChatGptPersonalizationChoice(page, deadline, abortSignal);
      try {
        if (await proveConnectorAccess()) {
          await capture("personalization-enabled");
          return "enabled";
        }
      } catch (error) {
        try {
          await restoreChatGptPersonalizationChoice(page, toggleReceipt);
        } catch (restoreError) {
          throw new ChatGptPersistentBrowserStateError(
            [error, restoreError],
            "ChatGPT personalization proof failed and the original state could not be restored",
          );
        }
        throw error;
      }
      try {
        await restoreChatGptPersonalizationChoice(page, toggleReceipt);
      } catch (restoreError) {
        throw new ChatGptPersistentBrowserStateError(
          [restoreError],
          "ChatGPT personalization changed but connector access was not proven and the original state could not be restored",
        );
      }
      throw chatGptConnectorUnavailableError(
        "The configured ChatGPT connector remained unavailable after the structural personalization state changed",
      );
    }
  }
  if (personalizedCount === 1 && unpersonalizedCount === 0) {
    await capture("personalization-already-enabled");
    return "already-personalized";
  }
  if (personalizedCount !== 0 || unpersonalizedCount !== 1) {
    throw chatGptConnectorUnavailableError(
      `ChatGPT exposed an invalid Temporary Chat personalization state` +
        ` (personalized=${personalizedCount}, unpersonalized=${unpersonalizedCount})`,
    );
  }

  await capture("personalization-unpersonalized");
  await unpersonalized.click({
    timeout: remainingChatGptPersonalizationMs(deadline, abortSignal),
    signal: abortSignal,
  });
  try {
    const menu = await waitForChatGptOwnedPersonalizationMenu(page, unpersonalized, deadline, abortSignal);
    const choice = menu
      .locator(CHATGPT_PERSONALIZATION_CHOICE_SELECTOR)
      .filter({ hasText: /^(?:Personalized|Personalizado|个性化)/i });
    if ((await runChatGptPersonalizationStep(() => choice.count(), deadline, abortSignal)) !== 1) {
      throw chatGptConnectorUnavailableError(
        "ChatGPT personalization menu did not expose one exact Personalized choice",
      );
    }
    await choice.click({
      timeout: remainingChatGptPersonalizationMs(deadline, abortSignal),
      signal: abortSignal,
    });
    await personalized.waitFor({
      state: "visible",
      timeout: remainingChatGptPersonalizationMs(deadline, abortSignal),
      signal: abortSignal,
    });
    await unpersonalized.waitFor({
      state: "hidden",
      timeout: remainingChatGptPersonalizationMs(deadline, abortSignal),
      signal: abortSignal,
    });
  } catch (error) {
    try {
      await dismissChatGptPersonalizationMenu(page);
    } catch (cleanupError) {
      throw new ChatGptPersistentBrowserStateError(
        [error, cleanupError],
        "ChatGPT labeled personalization change failed and its opened menu could not be closed",
      );
    }
    if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    throw chatGptConnectorUnavailableError(
      "ChatGPT did not confirm Personalized connector access for this Temporary Chat",
    );
  }
  await capture("personalization-enabled");
  return "enabled";
}

/** New Temporary Chats may suppress connectors until this exact browser conversation is Personalized. */
export async function ensureChatGptPersonalizedConnectorAccess(
  page: Page,
  captureDiagnostic?: (checkpoint: string) => Promise<void>,
  proveConfiguredConnectorAccess?: (signal?: AbortSignal) => Promise<boolean>,
  abortSignal?: AbortSignal,
  hasExistingTurns?: boolean,
): Promise<ChatGptPersonalizationPreflight> {
  if (hasExistingTurns || verifiedPersonalizedPages.has(page)) {
    if (captureDiagnostic) await captureDiagnostic("personalization-already-enabled");
    return "already-personalized";
  }
  const deadline = Date.now() + CHATGPT_PERSONALIZATION_PREFLIGHT_TIMEOUT_MS;
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(new ChatGptPersonalizationDeadlineError()),
    Math.max(1, deadline - Date.now()),
  );
  deadlineTimer.unref?.();
  const operationSignal = abortSignal
    ? AbortSignal.any([abortSignal, deadlineController.signal])
    : deadlineController.signal;
  try {
    const outcome = await ensureChatGptPersonalizedConnectorAccessWithinDeadline(
      page,
      deadline,
      operationSignal,
      captureDiagnostic,
      proveConfiguredConnectorAccess,
      hasExistingTurns,
    );
    verifiedPersonalizedPages.add(page);
    return outcome;
  } catch (error) {
    if (error instanceof ChatGptPersistentBrowserStateError) throw error;
    if (
      !abortSignal?.aborted &&
      (error instanceof ChatGptPersonalizationDeadlineError ||
        deadlineController.signal.aborted ||
        Date.now() >= deadline)
    ) {
      throw chatGptConnectorUnavailableError("ChatGPT personalization preflight exceeded its readiness deadline");
    }
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
  }
}
