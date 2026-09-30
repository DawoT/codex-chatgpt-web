import type { Locator } from "playwright-core";

export interface ExtractAttachedPromptTextOptions {
  /** Locator evaluation timeout forwarded to the composer readback. */
  timeoutMs?: number;
  /** Abort signal forwarded to the composer readback. */
  signal?: AbortSignal;
}

/**
 * Read back the attached prompt text from the active ChatGPT composer element.
 *
 * The evaluation clones the composer inside the page, converts `<br>` soft breaks into newlines,
 * strips cursor-target selection pills, and removes only connector mention pills that identify the
 * bound app (by keyword, `@`/`$` name, or slug). Legitimate user mentions that merely share the
 * pill styling survive, as does every other character of the draft.
 */
export async function extractAttachedPromptText(
  composer: Locator,
  appName: string | undefined,
  options: ExtractAttachedPromptTextOptions = {},
): Promise<string> {
  return composer.evaluate(
    // The callback is serialized into the page context: it must not close over `appName` and
    // instead receives it as its own second parameter (which shadows this function's argument).
    (element, appName) => {
      const clone = element.cloneNode(true) as HTMLElement;
      for (const br of Array.from(clone.querySelectorAll("br"))) {
        if (br.previousSibling || br.nextSibling) {
          if (typeof br.replaceWith === "function") {
            br.replaceWith("\n");
          } else if (br.parentNode) {
            br.parentNode.replaceChild(clone.ownerDocument?.createTextNode("\n") ?? document.createTextNode("\n"), br);
          }
        }
      }
      for (const part of Array.from(clone.querySelectorAll("[data-inline-selection-pill-cursor-target]"))) {
        if (typeof part.remove === "function") part.remove();
        else part.parentNode?.removeChild(part);
      }
      const slug = (appName ?? "").toLowerCase().replace(/\s+/g, "-");
      for (const part of Array.from(
        clone.querySelectorAll(
          '[data-id^="plugin:"], [app-mention-display-name], [data-prompt-link-label], [class*="Mention-"]',
        ),
      )) {
        const text = (part.textContent ?? "").trim();
        const kw =
          part.getAttribute("data-keyword") ??
          part.getAttribute("app-mention-display-name") ??
          part.getAttribute("data-prompt-link-label") ??
          "";
        if (
          !appName ||
          kw === appName ||
          kw === `$${slug}` ||
          text === `@${appName}` ||
          text === `$${appName}` ||
          (slug && (text.toLowerCase() === `@${slug}` || text.toLowerCase() === `$${slug}`))
        ) {
          if (typeof part.remove === "function") part.remove();
          else part.parentNode?.removeChild(part);
        }
      }
      return [...clone.childNodes]
        .map((child) => child.textContent ?? "")
        .join("\n")
        .trimStart();
    },
    appName,
    { timeout: options.timeoutMs, signal: options.signal },
  );
}
