import type { Locator } from "playwright-core";

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

  await locator.evaluate(
    (el, { attr, expected, timeout }) => {
      return new Promise<void>((resolve, reject) => {
        if (el.getAttribute(attr) === expected) {
          resolve();
          return;
        }

        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const cleanup = () => {
          settled = true;
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
    { attr: attribute, expected: expectedValue, timeout: timeoutMs },
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

  await locator.evaluate(
    (el, { expected, timeout }) => {
      return new Promise<void>((resolve, reject) => {
        const matches = (current: string) => current.trim() === expected.trim();
        const currentText = el.textContent ?? "";
        if (matches(currentText)) {
          resolve();
          return;
        }

        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const cleanup = () => {
          settled = true;
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
    { expected: expectedText, timeout: timeoutMs },
  );
}
