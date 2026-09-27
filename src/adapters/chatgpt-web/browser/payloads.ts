import type { Locator } from "playwright-core";
import { parseDataUrl } from "../../image";
import { validateSkillFiles } from "../skill-attachments";
import {
  CHATGPT_MAX_INPUT_IMAGES,
  type ChatGptWebPromptImage,
  type CompiledChatGptWebPrompt,
} from "../prompt";
import { ChatGptWebAdapterError } from "../adapter-error";
import {
  CHATGPT_COMPOSER_DOCUMENT_END_KEY,
  throwIfPromptAttachmentAborted,
  withBrowserTurnAbort,
} from "./suspension-clock";
import { CHATGPT_COMPOSER_SELECTOR } from "../../../chatgpt-session";

const CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS = 10_000;

export async function setChatGptThinkMode(
  composerForm: Locator,
  enabled: boolean,
  captureDiagnostic?: (checkpoint: string) => Promise<void>,
  abortSignal?: AbortSignal,
): Promise<void> {
  throwIfPromptAttachmentAborted(abortSignal);
  const controls = composerForm
    .getByRole("button", { name: "Think", exact: true })
    .filter({ visible: true });
  const count = await controls.count();
  if (count === 0 && !enabled) {
    await captureDiagnostic?.("luna-default-confirmed");
    return;
  }
  if (count > 1) throw new Error(`ChatGPT exposed ${count} visible Think controls`);
  const control = controls.first();
  const actionOptions = { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS };
  let pressed = count === 1 ? await control.getAttribute("aria-pressed", actionOptions) : null;
  if (count === 1 && pressed !== "true" && pressed !== "false") {
    throw new Error("ChatGPT Think control has no semantic pressed state");
  }
  const target = enabled ? "true" : "false";
  if (pressed !== target) {
    const composer = composerForm.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true }).first();
    const composerState = () => composer.evaluate(element => {
      const copy = element.cloneNode(true) as HTMLElement;
      const pills = [...copy.querySelectorAll('[data-id^="plugin:"][data-keyword]')];
      const connectors = pills.map(pill => pill.getAttribute("data-keyword")).sort();
      for (const pill of pills) pill.remove();
      const text = element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
        ? element.value : copy.textContent ?? "";
      return { text: text.trim(), connectors };
    }, undefined, actionOptions);
    const before = await composerState();
    if (before.text) throw new Error("ChatGPT Think selection requires an empty prompt draft");
    await composer.focus(actionOptions);
    await composer.press(CHATGPT_COMPOSER_DOCUMENT_END_KEY, actionOptions);
    await composer.pressSequentially("/think", { ...actionOptions, delay: 25 });
    await captureDiagnostic?.("think-slash-triggered");
    // The command popup shares menu-item classes with sidebar history. Count only this popup.
    const popup = composerForm.page().locator('.popover[aria-busy="false"], [class*="suggestionMenu"], .composer-home-top-menu').filter({ visible: true });
    const rows = popup.locator('.__menu-item[tabindex="0"], [class*="suggestionMenu"] button, .composer-home-top-menu button, [role="menuitem"], [role="option"]').filter({ visible: true });
    await rows.first().waitFor({ state: "visible", timeout: 5_000, signal: abortSignal });
    if (await popup.count() !== 1 || await rows.count() !== 1) {
      throw new Error("ChatGPT Think slash menu must expose exactly one command option");
    }
    const row = rows.first();
    if (await row.getAttribute("data-highlighted", actionOptions) === null) {
      await composer.press("ArrowDown", actionOptions);
    }
    if (await row.getAttribute("data-highlighted", actionOptions) === null) {
      throw new Error("ChatGPT Think slash option is not highlighted");
    }
    await captureDiagnostic?.("think-slash-menu-ready");
    throwIfPromptAttachmentAborted(abortSignal);
    await composer.press("Enter", actionOptions);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      throwIfPromptAttachmentAborted(abortSignal);
      const currentCount = await controls.count();
      if (currentCount > 1) throw new Error(`ChatGPT exposed ${currentCount} visible Think controls`);
      pressed = currentCount === 1 ? await control.getAttribute("aria-pressed", actionOptions) : null;
      if (pressed === target) break;
      if (currentCount === 1 && pressed !== "true" && pressed !== "false") {
        throw new Error("ChatGPT Think control lost its semantic pressed state");
      }
      await withBrowserTurnAbort(new Promise(resolveSleep => setTimeout(resolveSleep, 100)), abortSignal);
    }
    if (pressed !== target) {
      throw new Error(`ChatGPT did not ${enabled ? "enable" : "disable"} Think mode`);
    }
    const after = await composerState();
    if (after.text || JSON.stringify(after.connectors) !== JSON.stringify(before.connectors)) {
      throw new Error("ChatGPT Think slash selection did not preserve the empty draft and selected connectors");
    }
  }
  await captureDiagnostic?.(enabled ? "think-enabled" : "think-disabled");
}

const imageExtensions = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);

export function chatGptImageFilePayloads(images: ChatGptWebPromptImage[]): Array<{ name: string; mimeType: string; buffer: Buffer }> {
  if (images.length > CHATGPT_MAX_INPUT_IMAGES) {
    throw new Error(`ChatGPT web accepts at most ${CHATGPT_MAX_INPUT_IMAGES} input images per Codex turn`);
  }
  let totalBytes = 0;
  return images.map(image => {
    const parsed = parseDataUrl(image.imageUrl);
    if (!parsed) throw new Error(`ChatGPT web input image ${image.ref} must be an inline base64 data URL`);
    const extension = imageExtensions.get(parsed.mediaType.toLowerCase());
    if (!extension) throw new Error(`ChatGPT web input image ${image.ref} has unsupported media type: ${parsed.mediaType}`);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(parsed.base64) || parsed.base64.length % 4 !== 0) {
      throw new Error(`ChatGPT web input image ${image.ref} contains invalid base64 data`);
    }
    const buffer = Buffer.from(parsed.base64, "base64");
    if (buffer.length === 0) throw new Error(`ChatGPT web input image ${image.ref} is empty`);
    if (buffer.length > 20_000_000) throw new Error(`ChatGPT web input image ${image.ref} exceeds 20 MB`);
    totalBytes += buffer.length;
    if (totalBytes > 50_000_000) throw new Error("ChatGPT web input images exceed the 50 MB per-turn limit");
    return { name: `${image.ref}.${extension}`, mimeType: parsed.mediaType.toLowerCase(), buffer };
  });
}

export function assertChatGptPromptAttachments(prompt: CompiledChatGptWebPrompt): void {
  if (prompt.images.length + (prompt.skillFiles?.length ?? 0) > CHATGPT_MAX_INPUT_IMAGES) {
    throw new ChatGptWebAdapterError(
      "Selected skills and images exceed ChatGPT's 10 attachments per message; disable Skills as files or reduce attachments.",
      { status: 400, errorType: "invalid_request_error", code: "too_many_attachments", retryable: false },
    );
  }
  validateSkillFiles(prompt.skillFiles);
}

export function chatGptPromptFilePayloads(
  prompt: CompiledChatGptWebPrompt,
): Array<{ name: string; mimeType: string; buffer: Buffer }> {
  assertChatGptPromptAttachments(prompt);
  const files = [...chatGptImageFilePayloads(prompt.images), ...(prompt.skillFiles ?? []).map(file => ({
    name: file.name, mimeType: "text/plain", buffer: Buffer.from(file.text, "utf8"),
  }))];
  if (files.reduce((sum, file) => sum + file.buffer.length, 0) > 50_000_000) {
    throw new Error("ChatGPT web attachments exceed the 50 MB per-turn limit");
  }
  return files;
}

/**
 * Insert `value` at the caret of an already-resolved ChatGPT composer, returning whether the edit
 * was applied. Runs inside the page, so it may reference only globals and its two arguments.
 *
 * Effort selection closes a menu immediately before a staged part is attached, and focus is still
 * settling when this runs: the composer can be the active element while the caret has not yet been
 * placed inside it, or focus can still be on the menu that just closed. Reading that as a rejected
 * edit failed whole turns roughly a tenth of a second after the effort menu closed, so the caret is
 * placed explicitly instead of assumed. An existing collapsed caret inside the composer is left
 * exactly where the user put it; only a missing or foreign one is replaced, and always with a
 * position inside this composer, so an insert can never land in another element.
 */
export function insertPlainTextIntoComposer(element: HTMLElement, value: string): boolean {
  try {
    element.setAttribute("spellcheck", "false");
    element.setAttribute("autocorrect", "off");
    element.setAttribute("autocapitalize", "off");
  } catch {}
  if (document.activeElement !== element) element.focus();
  if (document.activeElement !== element) return false;
  const selection = window.getSelection();
  if (!selection) return false;
  const alreadyPlaced = selection.isCollapsed
    && selection.anchorNode !== null
    && element.contains(selection.anchorNode);
  if (!alreadyPlaced) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  if (
    !selection.isCollapsed
    || !selection.anchorNode
    || !element.contains(selection.anchorNode)
  ) {
    return false;
  }
  return document.execCommand("insertText", false, value);
}

/**
 * Normalizes user prompts for comparison against ChatGPT contenteditable DOM text.
 * Line endings (CRLF / CR) are normalized to LF, and trailing horizontal whitespace
 * (spaces and tabs) at the end of each line is trimmed to match browser contenteditable
 * rendering semantics without altering indentation or syntax.
 */
export function normalizePromptForComparison(text: string): string {
  return text
    .replace(/\r\n|\r/g, "\n")
    .replace(/[ \t]+(?=\n|$)/g, "");
}
