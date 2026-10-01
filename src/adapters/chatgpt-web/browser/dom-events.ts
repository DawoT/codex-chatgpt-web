import { randomUUID } from "node:crypto";
import type { ElementHandle, Locator } from "playwright-core";
import { withBrowserTurnAbort, withChatGptBrowserObservationTimeout } from "./suspension-clock";

async function cancellableElementWait(
  locator: Locator,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  operation: (waitId: string, element: ElementHandle<SVGElement | HTMLElement>) => Promise<void>,
): Promise<void> {
  if (signal?.aborted) throw new DOMException("Element wait aborted", "AbortError");
  const waitId = randomUUID();
  let completed = false;
  let element: ElementHandle<SVGElement | HTMLElement> | undefined;
  const acquisition = locator.elementHandle({ timeout: Math.max(1, timeoutMs) }).then(async (handle) => {
    if (signal?.aborted) {
      await handle?.dispose();
      throw new DOMException("Element wait aborted", "AbortError");
    }
    // Claim ownership before resolving acquisition; abort can win the promise handoff.
    element = handle ?? undefined;
    return handle;
  });
  try {
    const handle = await withBrowserTurnAbort(acquisition, signal);
    if (!handle) throw new Error("Element wait target was not found");
    element = handle;
    if (signal?.aborted) throw new DOMException("Element wait aborted", "AbortError");
    await withBrowserTurnAbort(operation(waitId, handle), signal);
    completed = true;
  } finally {
    if (!completed && element) {
      await withChatGptBrowserObservationTimeout(
        locator.page().evaluate((id) => {
          const scope = globalThis as typeof globalThis & {
            __CODEX_WEB_GPT_ELEMENT_WAITS__?: Map<string, () => void>;
          };
          scope.__CODEX_WEB_GPT_ELEMENT_WAITS__?.get(id)?.();
        }, waitId),
        1000,
      ).catch(() => {});
    }
    await element?.dispose().catch(() => {});
  }
}

/**
 * Event-driven DOM synchronizers for ChatGPT Web automation.
 *
 * Replaces blind `setTimeout` polling loops and fixed sleep delays with browser-native
 * `MutationObserver` listeners that resolve synchronously as soon as the DOM mutates.
 */

export interface DomEventWaitOptions {
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

/**
 * Waits for a specific DOM attribute on a Locator element to equal `expectedValue`.
 *
 * Evaluates in page context using a targeted `MutationObserver` listening only to `attributeFilter: [attribute]`.
 * If the attribute already equals `expectedValue`, resolves immediately without waiting.
 */
export async function waitForElementAttribute(
  locator: Locator,
  attribute: string,
  expectedValue: string,
  timeoutMs = 5_000,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (abortSignal?.aborted) {
    throw new DOMException("The operation was aborted", "AbortError");
  }

  await cancellableElementWait(locator, abortSignal, timeoutMs, (waitId, element) =>
    element.evaluate(
      (el, { attr, expected, timeout, waitId }) => {
        return new Promise<void>((resolve, reject) => {
          if (el.getAttribute(attr) === expected) {
            resolve();
            return;
          }

          const scope = globalThis as typeof globalThis & {
            __CODEX_WEB_GPT_ELEMENT_WAITS__?: Map<string, () => void>;
          };
          const waits = scope.__CODEX_WEB_GPT_ELEMENT_WAITS__ ?? new Map<string, () => void>();
          scope.__CODEX_WEB_GPT_ELEMENT_WAITS__ = waits;
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | undefined;

          const cleanup = () => {
            settled = true;
            waits.delete(waitId);
            observer.disconnect();
            if (timer !== undefined) clearTimeout(timer);
          };

          const observer = new MutationObserver(() => {
            if (settled) return;
            if (el.getAttribute(attr) === expected) {
              cleanup();
              resolve();
            }
          });

          observer.observe(el, { attributes: true, attributeFilter: [attr] });

          waits.set(waitId, () => {
            cleanup();
            resolve();
          });
          timer = setTimeout(
            () => {
              if (settled) return;
              const current = el.getAttribute(attr);
              cleanup();
              if (current === expected) {
                resolve();
              } else {
                reject(
                  new Error(
                    `Timeout waiting for attribute ${attr} to equal ${JSON.stringify(expected)}. Current: ${JSON.stringify(current)}`,
                  ),
                );
              }
            },
            Math.max(1, timeout),
          );
        });
      },
      { attr: attribute, expected: expectedValue, timeout: timeoutMs, waitId },
    ),
  );
}

/**
 * Waits for an effort slider (`[role="slider"]`) to reach `expectedValue` (`aria-valuenow`).
 *
 * Uses `MutationObserver` on `aria-valuenow` so state updates from React/Radix resolve immediately.
 */
export async function waitForSliderValue(
  slider: Locator,
  expectedValue: number,
  timeoutMs = 5_000,
  abortSignal?: AbortSignal,
): Promise<void> {
  return waitForElementAttribute(slider, "aria-valuenow", String(expectedValue), timeoutMs, abortSignal);
}

/**
 * Waits for an element's text content to match `expectedText` (trimmed).
 *
 * Uses `MutationObserver` on `childList` and `characterData` within the subtree.
 */
export async function waitForElementText(
  locator: Locator,
  expectedText: string,
  timeoutMs = 5_000,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (abortSignal?.aborted) {
    throw new DOMException("The operation was aborted", "AbortError");
  }

  await cancellableElementWait(locator, abortSignal, timeoutMs, (waitId, element) =>
    element.evaluate(
      (el, { expected, timeout, waitId }) => {
        return new Promise<void>((resolve, reject) => {
          const matches = (current: string) => current.trim() === expected.trim();
          const currentText = el.textContent ?? "";
          if (matches(currentText)) {
            resolve();
            return;
          }

          const scope = globalThis as typeof globalThis & {
            __CODEX_WEB_GPT_ELEMENT_WAITS__?: Map<string, () => void>;
          };
          const waits = scope.__CODEX_WEB_GPT_ELEMENT_WAITS__ ?? new Map<string, () => void>();
          scope.__CODEX_WEB_GPT_ELEMENT_WAITS__ = waits;
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | undefined;

          const cleanup = () => {
            settled = true;
            waits.delete(waitId);
            observer.disconnect();
            if (timer !== undefined) clearTimeout(timer);
          };

          const observer = new MutationObserver(() => {
            if (settled) return;
            const text = el.textContent ?? "";
            if (matches(text)) {
              cleanup();
              resolve();
            }
          });

          observer.observe(el, { childList: true, characterData: true, subtree: true });

          waits.set(waitId, () => {
            cleanup();
            resolve();
          });
          timer = setTimeout(
            () => {
              if (settled) return;
              const text = el.textContent ?? "";
              cleanup();
              if (matches(text)) {
                resolve();
              } else {
                reject(
                  new Error(
                    `Timeout waiting for element text to equal ${JSON.stringify(expected)}. Current: ${JSON.stringify(text.trim())}`,
                  ),
                );
              }
            },
            Math.max(1, timeout),
          );
        });
      },
      { expected: expectedText, timeout: timeoutMs, waitId },
    ),
  );
}
