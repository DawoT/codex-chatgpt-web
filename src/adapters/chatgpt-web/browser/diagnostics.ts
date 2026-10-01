import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Page, Request } from "playwright-core";
import {
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_COMPLETION_ACTION_SELECTOR,
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_EFFORT_ITEM_SELECTOR,
  CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
  CHATGPT_USER_TURN_SELECTOR,
} from "../../../chatgpt-session";
import { atomicWriteFile } from "../../../config";
import {
  type DiagnosticEventInput,
  DiagnosticEventRing,
  emitDiagnosticEvent,
  serializeDiagnosticError,
} from "../../../diagnostics";
import { CHATGPT_MENTION_MENU_ROWS_SELECTOR } from "./connectors";
import { withChatGptBrowserObservationTimeout } from "./suspension-clock";

export function redactChatGptUiDiagnostic(value: string): string {
  return value
    .replace(
      /<codex_context_json>[\s\S]*?<\/codex_context_json>/gi,
      "<codex_context_json>[redacted]</codex_context_json>",
    )
    .replace(/\b(turn|binding|call)_[A-Za-z0-9_-]{12,}\b/g, "$1_[redacted]");
}

const SAFE_STATE_KEYS = new Set([
  "tag",
  "role",
  "ariaExpanded",
  "ariaChecked",
  "dataState",
  "dataHighlighted",
  "origin",
  "location",
  "pathSegments",
  "temporaryChat",
  "titleChars",
  "documentComplete",
  "viewport",
  "width",
  "height",
  "x",
  "y",
  "surfaceBound",
  "bodyTextChars",
  "composer",
  "visibleCount",
  "textChars",
  "editors",
  "contentEditable",
  "focused",
  "unrecognizedEditors",
  "attributes",
  "id",
  "data-testid",
  "data-lexical-editor",
  "data-composer-markdown",
  "contenteditable",
  "placeholder",
  "autofocus",
  "disabled",
  "readonly",
  "inForm",
  "inComposerForm",
  "selectedConnectorCount",
  "exactSelectedConnectorCount",
  "focus",
  "documentFocused",
  "effortControls",
  "effortItems",
  "effortSliders",
  "min",
  "max",
  "value",
  "menus",
  "connectorRows",
  "overlays",
  "rect",
  "turns",
  "user",
  "stopButtonCount",
  "assistant",
  "htmlChars",
  "markdownCount",
  "streamingStatusCount",
  "completionActionCount",
  "renderedCompletionActionCount",
]);
const SAFE_STATE_STRINGS: Record<string, Set<string>> = {
  tag: new Set(["a", "button", "div", "form", "input", "main", "p", "section", "span", "textarea"]),
  role: new Set([
    "alert",
    "button",
    "dialog",
    "listbox",
    "menu",
    "menuitem",
    "menuitemradio",
    "option",
    "slider",
    "status",
    "textbox",
  ]),
  ariaExpanded: new Set(["true", "false"]),
  ariaChecked: new Set(["true", "false", "mixed"]),
  dataState: new Set(["open", "closed", "checked", "unchecked", "active", "inactive"]),
  dataHighlighted: new Set(["", "true", "false"]),
  origin: new Set(["https://chatgpt.com", "https://chat.openai.com"]),
};

/** Bounded structural evidence: neither arbitrary keys nor DOM strings are trusted content. */
export function sanitizeChatGptBrowserDiagnosticState(value: unknown): unknown {
  const active = new Set<object>();
  let remaining = 2000;
  const visit = (candidate: unknown, depth: number, key = ""): unknown => {
    if (--remaining < 0 || depth > 8) return undefined;
    if (candidate === null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") return Number.isFinite(candidate) ? candidate : undefined;
    if (typeof candidate === "string") return SAFE_STATE_STRINGS[key]?.has(candidate) ? candidate : undefined;
    if (!candidate || typeof candidate !== "object" || active.has(candidate)) return undefined;
    active.add(candidate);
    let result: unknown;
    if (Array.isArray(candidate)) {
      result = candidate
        .slice(0, 40)
        .map((item) => visit(item, depth + 1, key))
        .filter((item) => item !== undefined);
    } else {
      result = Object.fromEntries(
        [...SAFE_STATE_KEYS].flatMap((name) => {
          let raw: unknown;
          try {
            raw = Reflect.get(candidate, name);
          } catch {
            return [];
          }
          if (raw === undefined) return [];
          const sanitized = visit(raw, depth + 1, name);
          return sanitized === undefined ? [] : [[name, sanitized]];
        }),
      );
    }
    active.delete(candidate);
    return result;
  };
  return visit(value, 0);
}

export const CHATGPT_BROWSER_DIAGNOSTIC_TRACE_LIMIT = 10;

export function browserDiagnosticCheckpoint(value: string): string {
  const safe = value
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return safe || "checkpoint";
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    /* Windows ACLs are managed by the installer. */
  }
}

export function pruneBrowserDiagnostics(root: string): void {
  try {
    const traces = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[A-Za-z0-9_-]{6,128}$/.test(entry.name))
      .flatMap((entry) => {
        const path = join(root, entry.name);
        try {
          return [{ path, modifiedAt: statSync(path).mtimeMs }];
        } catch {
          return [];
        }
      })
      .sort((left, right) => right.modifiedAt - left.modifiedAt);
    for (const trace of traces.slice(CHATGPT_BROWSER_DIAGNOSTIC_TRACE_LIMIT)) {
      try {
        rmSync(trace.path, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

export class ChatGptBrowserDiagnostics {
  private readonly directory: string;
  private sequence = 0;
  private initialized = false;
  private readonly ring = new DiagnosticEventRing();
  private detachPage?: () => void;
  private documentGeneration = 0;
  private captureEvidence = {
    stateCaptured: false,
    stateMissing: true,
    screenshotCaptured: false,
    screenshotMissing: false,
    contentCapture: false,
    ioFailures: 0,
  };

  constructor(
    private readonly traceId: string,
    private readonly root: string,
    private readonly appName: string,
  ) {
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(traceId)) {
      throw new Error("ChatGPT browser diagnostic trace id is invalid");
    }
    this.directory = join(this.root, `${traceId}-${randomUUID().slice(0, 8)}`);
  }

  recordEvent(input: DiagnosticEventInput): ReturnType<typeof emitDiagnosticEvent> {
    return emitDiagnosticEvent(
      {
        ...input,
        producer: "browser",
        correlation: { ...input.correlation, traceId: this.traceId, turnId: this.traceId },
        fields: { ...input.fields, documentGeneration: this.documentGeneration },
      },
      { ring: this.ring },
    );
  }

  snapshot(): ReturnType<DiagnosticEventRing["snapshot"]> & {
    evidence: {
      stateCaptured: boolean;
      stateMissing: boolean;
      screenshotCaptured: boolean;
      screenshotMissing: boolean;
      contentCapture: boolean;
      ioFailures: number;
    } & ReturnType<DiagnosticEventRing["snapshot"]>["evidence"];
  } {
    const snapshot = this.ring.snapshot(this.traceId);
    return { ...snapshot, evidence: { ...snapshot.evidence, ...this.captureEvidence } };
  }

  /** Bind only the leased page. No BrowserContext tracing or cross-page requests are observed. */
  bindPage(page: Page): () => void {
    this.detachPage?.();
    this.documentGeneration += 1;
    const pageError = (error: Error) => {
      this.recordEvent({ event: "page_error", phase: "failed", error });
    };
    const crash = () => {
      this.recordEvent({ event: "page_crashed", phase: "failed", fields: { reason: "page_crashed" } });
    };
    const close = () => {
      this.recordEvent({ event: "page_closed", phase: "observed", fields: { reason: "page_closed" } });
    };
    const requestFailed = (request: Request) => {
      let requestClass: "conversation" | "other" = "other";
      let resourceType: "document" | "eventsource" | "fetch" | "xhr" | "other" = "other";
      let transportFailure:
        | "aborted"
        | "connection_reset"
        | "internet_disconnected"
        | "network_changed"
        | "timed_out"
        | "other" = "other";
      try {
        const url = new URL(request.url());
        if (url.origin === "https://chatgpt.com" && url.pathname === "/backend-api/f/conversation") {
          requestClass = "conversation";
        }
      } catch {
        /* Diagnostic classification is best effort and never reads request bodies. */
      }
      try {
        const observedType = request.resourceType();
        if (["document", "eventsource", "fetch", "xhr"].includes(observedType)) {
          resourceType = observedType as typeof resourceType;
        }
      } catch {
        /* Keep the closed-vocabulary fallback. */
      }
      try {
        const errorText = request.failure()?.errorText ?? "";
        if (/ERR_CONNECTION_RESET/i.test(errorText)) transportFailure = "connection_reset";
        else if (/ERR_INTERNET_DISCONNECTED/i.test(errorText)) transportFailure = "internet_disconnected";
        else if (/ERR_NETWORK_CHANGED/i.test(errorText)) transportFailure = "network_changed";
        else if (/ERR_TIMED_OUT|TIMED_OUT/i.test(errorText)) transportFailure = "timed_out";
        else if (/ERR_ABORTED|ABORTED/i.test(errorText)) transportFailure = "aborted";
      } catch {
        /* Never persist arbitrary transport text. */
      }
      this.recordEvent({
        event: "page_request_failed",
        phase: "failed",
        fields: {
          reason: "page_request_failed",
          requestClass,
          resourceType,
          transportFailure,
        },
      });
    };
    const response = (response: { status(): number }) => {
      try {
        this.recordEvent({ event: "page_response", phase: "observed", fields: { status: response.status() } });
      } catch {
        /* Diagnostic-only listener. */
      }
    };
    page.on("pageerror", pageError);
    page.on("crash", crash);
    page.on("close", close);
    page.on("requestfailed", requestFailed);
    page.on("response", response);
    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      page.off("pageerror", pageError);
      page.off("crash", crash);
      page.off("close", close);
      page.off("requestfailed", requestFailed);
      page.off("response", response);
      if (this.detachPage === detach) this.detachPage = undefined;
    };
    this.detachPage = detach;
    return detach;
  }

  async capture(page: Page, checkpoint: string, error?: unknown): Promise<void> {
    try {
      if (!this.initialized) {
        privateDirectory(this.root);
        privateDirectory(this.directory);
        pruneBrowserDiagnostics(this.root);
        this.initialized = true;
      }
      const sequence = String(++this.sequence).padStart(2, "0");
      const stem = `${sequence}-${browserDiagnosticCheckpoint(checkpoint)}`;
      const includeScreenshot = process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS === "1";
      const [screenshotResult, stateResult] = await Promise.allSettled([
        includeScreenshot
          ? page.screenshot({ animations: "disabled", caret: "hide", timeout: 5_000, type: "png" })
          : Promise.resolve(undefined),
        withChatGptBrowserObservationTimeout(
          page.evaluate(
            ({
              composerSelector,
              effortControlSelector,
              effortItemSelector,
              effortSliderContainerSelector,
              assistantTurnSelector,
              userTurnSelector,
              stopButtonSelector,
              completionActionSelector,
              menuRowsSelector,
              appName,
            }) => {
              const rendered = (element: Element): boolean => {
                const candidate = element as HTMLElement;
                const style = getComputedStyle(candidate);
                return (
                  candidate.isConnected &&
                  style.display !== "none" &&
                  style.visibility !== "hidden" &&
                  style.opacity !== "0"
                );
              };

              const rows = (selector: string, limit = 40) =>
                [...document.querySelectorAll(selector)]
                  .filter(rendered)
                  .slice(-limit)
                  .map((element) => {
                    const rect = element.getBoundingClientRect();
                    return {
                      tag: element.tagName.toLowerCase(),
                      role: element.getAttribute("role"),
                      ariaExpanded: element.getAttribute("aria-expanded"),
                      ariaChecked: element.getAttribute("aria-checked"),
                      dataState: element.getAttribute("data-state"),
                      dataHighlighted: element.getAttribute("data-highlighted"),
                      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                      textChars: (element.textContent ?? "").length,
                    };
                  });
              const exactText = (element: Element, expected: string): boolean =>
                [element, ...element.querySelectorAll("*")].some(
                  (candidate) =>
                    candidate.children.length === 0 &&
                    (candidate.textContent ?? "").replace(/\s+/g, " ").trim() === expected,
                );
              const composers = [...document.querySelectorAll(composerSelector)].filter(rendered);
              const assistantTurns = [...document.querySelectorAll(assistantTurnSelector)].filter(rendered);
              const selectedConnectors = composers
                .flatMap((composer) => [
                  ...composer.querySelectorAll(
                    '[data-id^="plugin:"][data-keyword], [app-mention-path^="app://"][app-mention-display-name][contenteditable="false"], [app-mention-display-name], [class*="Mention-"]',
                  ),
                ])
                .filter(rendered);
              const exactConnectorRows = [...document.querySelectorAll(menuRowsSelector)].filter(
                (element) => rendered(element) && exactText(element, appName),
              );
              const currentUrl = new URL(location.href);
              const integerAttribute = (element: Element, name: string): number | null => {
                const raw = element.getAttribute(name);
                return raw !== null && /^-?\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
              };
              return {
                location: {
                  origin: currentUrl.origin,
                  pathSegments: currentUrl.pathname.split("/").filter(Boolean).length,
                  temporaryChat: currentUrl.searchParams.has("temporary-chat"),
                },
                titleChars: document.title.length,
                documentComplete: document.readyState === "complete",
                viewport: { width: innerWidth, height: innerHeight },
                surfaceBound:
                  typeof (globalThis as typeof globalThis & { __CODEX_WEB_GPT_SURFACE_ID__?: unknown })
                    .__CODEX_WEB_GPT_SURFACE_ID__ === "string",
                // textContent avoids the synchronous layout forced by innerText on huge prompts.
                bodyTextChars: document.body?.textContent?.length ?? 0,
                composer: {
                  visibleCount: composers.length,
                  textChars: composers.map(
                    (element) =>
                      (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
                        ? element.value
                        : (element.textContent ?? "")
                      ).length,
                  ),
                  editors: composers.map((element) => ({
                    tag: element.tagName.toLowerCase(),
                    contentEditable: (element as HTMLElement).isContentEditable,
                    focused: element === document.activeElement,
                  })),
                  // When recognition fails, retain structure of the unmatched controls,
                  // never their values, labels, HTML or other conversation contents.
                  unrecognizedEditors:
                    composers.length === 0
                      ? [...document.querySelectorAll('textarea, [contenteditable="true"]')]
                          .filter(rendered)
                          .slice(0, 10)
                          .map((element) => ({
                            tag: element.tagName.toLowerCase(),
                            role: element.getAttribute("role"),
                            attributes: Object.fromEntries(
                              [
                                "id",
                                "data-testid",
                                "data-lexical-editor",
                                "data-composer-markdown",
                                "contenteditable",
                                "placeholder",
                                "autofocus",
                                "disabled",
                                "readonly",
                              ].map((name) => [name, element.hasAttribute(name)]),
                            ),
                            inForm: Boolean(element.closest("form")),
                            inComposerForm: Boolean(element.closest("form[data-chatgpt-composer]")),
                            focused: element === document.activeElement,
                          }))
                      : [],
                  selectedConnectorCount: selectedConnectors.length,
                  exactSelectedConnectorCount: selectedConnectors.filter(
                    (element) =>
                      (element.getAttribute("data-keyword") ?? element.getAttribute("app-mention-display-name")) ===
                      appName,
                  ).length,
                },
                focus: {
                  tag: document.activeElement?.tagName.toLowerCase() ?? null,
                  role: document.activeElement?.getAttribute("role") ?? null,
                  documentFocused: document.hasFocus(),
                },
                effortControls: rows(effortControlSelector, 10),
                effortItems: rows(effortItemSelector, 20),
                effortSliders: [...document.querySelectorAll(effortSliderContainerSelector)]
                  .filter(rendered)
                  .slice(-10)
                  .flatMap((container) => [...container.querySelectorAll('[role="slider"]')])
                  .map((element) => ({
                    min: integerAttribute(element, "aria-valuemin"),
                    max: integerAttribute(element, "aria-valuemax"),
                    value: integerAttribute(element, "aria-valuenow"),
                  })),
                menus: rows(
                  '[role="menu"], [role="listbox"], [data-testid="composer-intelligence-picker-content"]',
                  20,
                ),
                connectorRows: exactConnectorRows.slice(-20).map((element) => {
                  const rect = element.getBoundingClientRect();
                  return {
                    tag: element.tagName.toLowerCase(),
                    role: element.getAttribute("role"),
                    dataState: element.getAttribute("data-state"),
                    dataHighlighted: element.getAttribute("data-highlighted"),
                    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                    textChars: (element.textContent ?? "").length,
                  };
                }),
                overlays: rows('[role="dialog"], [role="alert"], [role="status"]', 30),
                turns: {
                  user: document.querySelectorAll(userTurnSelector).length,
                  stopButtonCount: [...document.querySelectorAll(stopButtonSelector)].filter(rendered).length,
                  assistant: assistantTurns.map((element) => ({
                    textChars: (element.textContent ?? "").length,
                    htmlChars: (element as HTMLElement).innerHTML.length,
                    markdownCount: element.querySelectorAll(
                      '.markdown, [data-markdown-text-style="assistant-message"], [class*="MarkdownRoot-"]',
                    ).length,
                    streamingStatusCount: element.querySelectorAll("[data-streaming-response-status]").length,
                    completionActionCount: element.querySelectorAll(completionActionSelector).length,
                    renderedCompletionActionCount: [...element.querySelectorAll(completionActionSelector)].filter(
                      rendered,
                    ).length,
                  })),
                },
              };
            },
            {
              composerSelector: CHATGPT_COMPOSER_SELECTOR,
              effortControlSelector: CHATGPT_EFFORT_CONTROL_SELECTOR,
              effortItemSelector: CHATGPT_EFFORT_ITEM_SELECTOR,
              effortSliderContainerSelector: CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR,
              assistantTurnSelector: CHATGPT_ASSISTANT_TURN_SELECTOR,
              userTurnSelector: CHATGPT_USER_TURN_SELECTOR,
              stopButtonSelector: CHATGPT_STOP_BUTTON_SELECTOR,
              completionActionSelector: CHATGPT_COMPLETION_ACTION_SELECTOR,
              menuRowsSelector: CHATGPT_MENTION_MENU_ROWS_SELECTOR,
              appName: this.appName,
            },
          ),
        ),
      ]);
      const capturedAt = new Date().toISOString();
      if (screenshotResult.status === "fulfilled" && screenshotResult.value) {
        atomicWriteFile(join(this.directory, `${stem}.png`), screenshotResult.value);
      }
      const captureErrors = Object.fromEntries([
        ...(screenshotResult.status === "rejected"
          ? [["screenshot", serializeDiagnosticError(screenshotResult.reason)]]
          : []),
        ...(stateResult.status === "rejected" ? [["state", serializeDiagnosticError(stateResult.reason)]] : []),
      ]);
      this.captureEvidence.stateCaptured = stateResult.status === "fulfilled";
      this.captureEvidence.stateMissing = stateResult.status === "rejected";
      this.captureEvidence.screenshotCaptured =
        screenshotResult.status === "fulfilled" && screenshotResult.value !== undefined;
      this.captureEvidence.screenshotMissing = includeScreenshot && screenshotResult.status === "rejected";
      this.captureEvidence.contentCapture = includeScreenshot;
      this.recordEvent({
        event: "diagnostic_capture",
        phase: "observed",
        fields: {
          stateCaptured: this.captureEvidence.stateCaptured,
          screenshotCaptured: this.captureEvidence.screenshotCaptured,
        },
        ...(error === undefined ? {} : { error }),
      });
      atomicWriteFile(
        join(this.directory, `${stem}.json`),
        `${JSON.stringify(
          {
            version: 2,
            capturedAt,
            traceId: this.traceId,
            checkpoint: browserDiagnosticCheckpoint(checkpoint),
            diagnostics: this.snapshot(),
            ...(error !== undefined
              ? {
                  error: serializeDiagnosticError(error),
                }
              : {}),
            ...(stateResult.status === "fulfilled"
              ? { state: sanitizeChatGptBrowserDiagnosticState(stateResult.value) }
              : {}),
            ...(Object.keys(captureErrors).length > 0 ? { captureErrors } : {}),
          },
          null,
          2,
        )}\n`,
      );
      if (Object.keys(captureErrors).length > 0) {
        console.warn(
          `[chatgpt-web] browser diagnostic partial capture trace=${this.traceId}` +
            ` checkpoint=${stem} failures=${Object.keys(captureErrors).join(",")}`,
        );
      }
      console.info(`[chatgpt-web] browser diagnostic trace=${this.traceId} checkpoint=${stem} path=${this.directory}`);
    } catch (captureError) {
      this.captureEvidence.ioFailures += 1;
      this.captureEvidence.stateMissing = true;
      this.recordEvent({
        event: "diagnostic_capture",
        phase: "failed",
        error: captureError,
        fields: { reason: "diagnostic_capture_failed" },
      });
      try {
        console.warn(
          JSON.stringify({ event: "diagnostic_capture_failed", error: serializeDiagnosticError(captureError) }),
        );
      } catch {
        /* Diagnostics never change the turn outcome. */
      }
    }
  }
}
