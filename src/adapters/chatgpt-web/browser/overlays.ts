import type { Locator, Page, Request, Response } from "playwright-core";
import { ChatGptWebAdapterError } from "../adapter-error";
import { withChatGptBrowserObservationTimeout } from "./suspension-clock";

export const CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS = 60_000;

export class ChatGptPromptAttachmentIntegrityError extends ChatGptWebAdapterError {
  constructor(message: string, cause?: unknown) {
    super(message, {
      status: 502,
      errorType: "server_error",
      code: "prompt_attachment_integrity",
      retryable: false,
      cause,
    });
    this.name = "ChatGptPromptAttachmentIntegrityError";
  }
}

export const chatGptRateLimitDialog = (page: Page): Locator =>
  page
    .locator('[role="dialog"]')
    .filter({
      hasText:
        /Too many requests|太多要求|太多请求|リクエストが多すぎます|요청이 너무 많습니다|요청을 너무 빠르게|너무 많은 요청/i,
    })
    .filter({
      hasText:
        /making requests too quickly|過於頻繁|过于频繁|リクエストの頻度が高すぎます|요청을 너무 빠르게|요청이 너무 많습니다|너무 많은 요청/i,
    })
    .last();

export async function throwIfChatGptRateLimitDialog(page: Page): Promise<void> {
  const dialog = chatGptRateLimitDialog(page);
  if (!(await dialog.isVisible().catch(() => false))) return;

  const acknowledge = dialog.getByRole("button", { name: /^(Got it|知道了|了解|알겠습니다|확인)$/ }).last();
  if (await acknowledge.isVisible().catch(() => false)) {
    try {
      await acknowledge.press("Enter");
    } catch (error) {
      throw new ChatGptWebAdapterError(
        `ChatGPT rate limit: too many requests, and the dialog could not be dismissed (${error instanceof Error ? error.message : String(error)}). Try again in a few minutes.`,
        { status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: false },
      );
    }
  }
  // Dismissing the modal does not prove the account cooldown has cleared. Keep this failure
  // replayable in the adapter so native reconnects cannot start more browser submissions.
  throw new ChatGptWebAdapterError("ChatGPT rate limit: too many requests. Try again in a few minutes.", {
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: false,
  });
}

const chatGptTemporaryChatOnboardingDialog = (page: Page): Locator =>
  page
    .locator('[role="dialog"]')
    .filter({ hasText: "Not in history" })
    .filter({ hasText: "No model training" })
    .filter({ hasText: "Memory off" })
    .last();

export async function dismissChatGptTemporaryChatOnboarding(page: Page): Promise<boolean> {
  let dialog = chatGptTemporaryChatOnboardingDialog(page);
  let visible = await dialog.isVisible().catch(() => false);
  if (!visible) {
    dialog = page
      .locator('[role="dialog"]')
      .filter({
        hasText:
          /(Not in history|No se guarda|No está en el historial|Historial desactivado|Sin entrenamiento|Memoria desactivada|不在历史记录中|不在歷史記錄中|履歴に残りません|기록에 저장되지 않음|Chat temporal|Temporary Chat)/i,
      })
      .last();
    visible = await dialog.isVisible().catch(() => false);
  }
  if (!visible) return false;

  let continueButton = dialog.getByRole("button", { name: "Continue", exact: true }).last();
  if (!(await continueButton.isVisible().catch(() => false))) {
    continueButton = dialog
      .getByRole("button", { name: /^(Continue|Continuar|Aceptar|Got it|Entendido|知道了|了解|계속|확인)$/i })
      .last();
  }
  if (!(await continueButton.isVisible().catch(() => false))) {
    continueButton = dialog.locator('button[type="button"], button').last();
  }
  if (!(await continueButton.isVisible().catch(() => false))) {
    throw new Error("ChatGPT Temporary Chat onboarding is visible without its Continue action");
  }
  await continueButton.click({ force: true });
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  return true;
}

export const CHATGPT_OVERLAY_DISMISS_BUTTON_TEXT_REGEX =
  /^(Dismiss|Continuar|Continue|Cerrar|Close|Entendido|Got it|Aceptar|Accept|OK|Skip|Omitir|Not now|Ahora no|Maybe later|Más tarde|Later|Done|Hecho|Cancel|Cancelar|No thanks|No, gracias|Decline|Rechazar|Stay logged out|Seguir desconectado|Confirmar|Confirm|知道了|了解|关闭|取消|稍后|閉じる|後で|キャンセル|확인|계속|닫기|나중에|취소)$/i;

/**
 * The committing verbs of the dismissal set. Every other token cancels or acknowledges, but a
 * confirm button agrees to whatever the dialog proposes, so it is only ever clickable on a
 * dialog whose intent this adapter recognizes; everywhere else it must be left to the flow that
 * owns that dialog.
 */
export const CHATGPT_OVERLAY_CONFIRM_BUTTON_TEXT_REGEX = /^(Confirmar|Confirm)$/i;

/** The dismissal set without its committing verbs; these close or cancel and never consent. */
export const CHATGPT_OVERLAY_SAFE_DISMISS_BUTTON_TEXT_REGEX =
  /^(Dismiss|Continuar|Continue|Cerrar|Close|Entendido|Got it|Aceptar|Accept|OK|Skip|Omitir|Not now|Ahora no|Maybe later|Más tarde|Later|Done|Hecho|Cancel|Cancelar|No thanks|No, gracias|Decline|Rechazar|Stay logged out|Seguir desconectado|知道了|了解|关闭|取消|稍后|閉じる|後で|キャンセル|확인|계속|닫기|나중에|취소)$/i;

/**
 * Destructive intents that a janitor must never force-accept, matched against the button label
 * or the whole dialog container. ChatGPT renders confirmation prompts in English and Spanish, so
 * both vocabularies are covered ("¿Eliminar chat?", "Delete conversation?", "Archive", "Trash").
 */
export const CHATGPT_OVERLAY_DESTRUCTIVE_TEXT_REGEX =
  /(\b(delete|eliminar|borrar|remove|quitar|archive|archivar|trash|papelera|permanently|permanentemente)\b|삭제|영구\s*삭제|削除|永久削除|删除|永久删除|刪除|永久刪除)/i;

const overlayDialogSnippet = (text: string): string => {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
};

/** Best-effort read of a button's own label; unreadable labels simply never match. */
const overlayButtonLabel = async (loc: unknown): Promise<string> => {
  if (!loc || typeof loc !== "object") return "";
  const candidate = loc as {
    allInnerTexts?: () => Promise<string[]>;
    textContent?: () => Promise<string | null>;
  };
  try {
    if (typeof candidate.allInnerTexts === "function") {
      return (await candidate.allInnerTexts()).join(" ");
    }
    if (typeof candidate.textContent === "function") {
      return (await candidate.textContent()) ?? "";
    }
  } catch {
    return "";
  }
  return "";
};

const CHATGPT_RATE_LIMIT_TEXT_REGEX =
  /(Too many requests|making requests too quickly|太多要求|太多请求|過於頻繁|过于频繁|リクエストが多すぎます|リクエストの頻度が高すぎます|요청이 너무 많습니다|요청을 너무 빠르게|너무 많은 요청)/i;

const CHATGPT_SESSION_EXPIRED_TEXT_REGEX =
  /(Your session has expired|你的工作階段已過期|您的工作階段已過期|你的会话已过期|您的会话已过期)/i;

export interface DismissOverlaysOptions {
  maxPasses?: number;
  captureDiagnostic?: (checkpoint: string) => Promise<void>;
}

const isVisibleSafe = async (loc: unknown): Promise<boolean> => {
  if (!loc || typeof (loc as { isVisible?: unknown }).isVisible !== "function") return false;
  return Boolean(await (loc as { isVisible: () => Promise<boolean> }).isVisible().catch(() => false));
};

const countSafe = async (loc: unknown): Promise<number> => {
  if (!loc || typeof (loc as { count?: unknown }).count !== "function") return 0;
  return Number(await (loc as { count: () => Promise<number> }).count().catch(() => 0));
};

export async function dismissAllChatGptOverlays(page: Page, options: DismissOverlaysOptions = {}): Promise<number> {
  const maxPasses = options.maxPasses ?? 3;
  let totalDismissed = 0;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const dialogsLocator = page.locator?.('[role="dialog"], [aria-modal="true"]')?.filter?.({ visible: true });
    const count = await countSafe(dialogsLocator);
    if (count === 0) break;

    const dialogs = (await dialogsLocator?.all?.().catch(() => [])) ?? [];
    let dismissedInPass = 0;

    for (const dialog of dialogs) {
      if (!(await isVisibleSafe(dialog))) continue;

      const textContent = (await dialog.allInnerTexts?.().catch(() => []))?.join(" ") ?? "";
      if (CHATGPT_RATE_LIMIT_TEXT_REGEX.test(textContent) || CHATGPT_SESSION_EXPIRED_TEXT_REGEX.test(textContent)) {
        continue;
      }

      const isToolApproval =
        textContent.includes("tool-approval") ||
        (await countSafe(dialog.locator?.('[data-testid="tool-approval-card"]'))) > 0;
      if (isToolApproval) continue;

      // A dialog whose container talks about deletion, removal, or archiving must never be
      // force-accepted: clicking its affirmative action would commit exactly the destruction
      // this janitor exists to route around. Cancellation affordances (close button, Escape)
      // stay available below.
      const isDestructiveDialog = CHATGPT_OVERLAY_DESTRUCTIVE_TEXT_REGEX.test(textContent);

      const isTemporaryChatOnboarding =
        /(Not in history|No se guarda|No está en el historial|Historial desactivado|Sin entrenamiento|Memoria desactivada|不在历史记录中|不在歷史記錄中|履歴に残りません|기록에 저장되지 않음|Chat temporal|Temporary Chat)/i.test(
          textContent,
        );
      if (isTemporaryChatOnboarding) {
        if (isDestructiveDialog) {
          console.error(
            `[chatgpt-web] overlay guard refused to dismiss a recognized dialog that matches destructive patterns: "${overlayDialogSnippet(textContent)}"`,
          );
        } else if (await dismissChatGptTemporaryChatOnboarding(page).catch(() => false)) {
          dismissedInPass += 1;
          totalDismissed += 1;
          continue;
        }
      }

      let actionExecuted = false;

      // Strategy A: Action button matching dismissal regex. Confirm-type buttons are the only
      // committing verbs in that set, so they are clicked solely on dialogs this adapter
      // recognizes; the tool-approval and rate-limit surfaces are handled above, so any dialog
      // reaching this point is unrecognized and its confirm action belongs to its own flow.
      if (isDestructiveDialog) {
        console.error(
          `[chatgpt-web] overlay guard refused to force-click an action on a destructive dialog: "${overlayDialogSnippet(textContent)}"`,
        );
      } else {
        const confirmButton = dialog
          .getByRole?.("button", { name: CHATGPT_OVERLAY_CONFIRM_BUTTON_TEXT_REGEX })
          ?.last?.();
        if (await isVisibleSafe(confirmButton)) {
          console.info(
            `[chatgpt-web] overlay guard skipped a confirm action on an unrecognized dialog: "${overlayDialogSnippet(textContent)}"`,
          );
        }
        const actionButton = dialog
          .getByRole?.("button", { name: CHATGPT_OVERLAY_SAFE_DISMISS_BUTTON_TEXT_REGEX })
          ?.last?.();
        const actionLabel = await overlayButtonLabel(actionButton);
        if ((await isVisibleSafe(actionButton)) && !CHATGPT_OVERLAY_DESTRUCTIVE_TEXT_REGEX.test(actionLabel)) {
          try {
            await actionButton.click({ force: true, timeout: 2_000 });
            actionExecuted = true;
          } catch {
            // Fall through
          }
        }
      }

      // Strategy B: Close button with aria-label
      if (!actionExecuted) {
        const closeByAria = dialog
          .locator?.(
            'button[aria-label*="close" i], button[aria-label*="cerrar" i], button[aria-label*="dismiss" i], button[aria-label*="descartar" i], button[data-testid*="close"]',
          )
          ?.last?.();
        if (await isVisibleSafe(closeByAria)) {
          try {
            await closeByAria.click({ force: true, timeout: 2_000 });
            actionExecuted = true;
          } catch {
            // Fall through
          }
        }
      }

      // Strategy C: Generic button in header or containing svg. On a destructive dialog that
      // generic svg-bearing button may well be the destructive action itself, so it is skipped
      // alongside Strategy A; only an explicit close affordance (Strategy B) may be clicked.
      if (!actionExecuted && !isDestructiveDialog && typeof dialog.locator === "function") {
        const svgButton = dialog
          .locator("button")
          ?.filter?.({ has: page.locator?.("svg") })
          ?.last?.();
        if (await isVisibleSafe(svgButton)) {
          try {
            await svgButton.click({ force: true, timeout: 1_000 });
            actionExecuted = true;
          } catch {
            // Fall through
          }
        }
      }

      // Strategy D: Fallback to keyboard Escape
      if (!actionExecuted && page.keyboard?.press) {
        try {
          await page.keyboard.press("Escape");
          actionExecuted = true;
        } catch {
          // Escape failed
        }
      }

      if (actionExecuted) {
        if (typeof dialog.waitFor === "function") {
          await dialog.waitFor({ state: "hidden", timeout: 1_500 }).catch(() => {});
        }
        if (!(await isVisibleSafe(dialog))) {
          dismissedInPass += 1;
          totalDismissed += 1;
        }
      }
    }

    if (dismissedInPass === 0) {
      if (count > 0) {
        await options.captureDiagnostic?.("overlay-unresolved");
      }
      break;
    }
  }

  return totalDismissed;
}

export type ChatGptTextScope = Pick<Locator, "getByText" | "getByTestId">;

const chatGptSubscriptionFailureAlert = (page: Page): Locator =>
  page
    .locator('[role="alert"]')
    .filter({ hasText: /Failed to load subscription/i })
    .last();

export const chatGptExpiredSessionAlert = (page: Page): Locator =>
  page
    .locator('[role="alert"], [role="dialog"]')
    .filter({
      hasText: /Your session has expired|你的工作階段已過期|您的工作階段已過期|你的会话已过期|您的会话已过期/i,
    })
    .last();

export async function throwIfChatGptSessionFailureAlert(page: Page): Promise<void> {
  if (
    await chatGptExpiredSessionAlert(page)
      .isVisible()
      .catch(() => false)
  ) {
    throw new ChatGptWebAdapterError("The ChatGPT session has expired. Sign in again in Codex Web GPT.", {
      status: 401,
      errorType: "authentication_error",
      code: "chatgpt_session_expired",
      retryable: false,
    });
  }
  if (
    !(await chatGptSubscriptionFailureAlert(page)
      .isVisible()
      .catch(() => false))
  )
    return;
  throw new ChatGptWebAdapterError(
    "ChatGPT could not load the account subscription. Reload ChatGPT inside the launcher and retry; sign out only if the error persists.",
    { status: 503, errorType: "server_error", code: "chatgpt_subscription_unavailable", retryable: true },
  );
}

const chatGptTerminalErrorAlert = (scope: ChatGptTextScope): Locator =>
  scope.getByText(/Something went wrong[\s\S]*help\.openai\.com/i).last();

// The current UI renders message_length_exceeds_limit as an ordinary response error.
// Observe only browser-issued submissions from this owned page after Send is activated;
// an old response, another tab, or a background endpoint cannot classify this turn.
export class ChatGptSubmissionRejectionObserver {
  private page?: Page;
  private readonly requests = new Set<Request>();
  private checks: Array<Promise<ChatGptWebAdapterError | undefined>> = [];

  private readonly onRequest = (request: Request): void => {
    if (
      !this.page ||
      request.method() !== "POST" ||
      request.url() !== "https://chatgpt.com/backend-api/f/conversation" ||
      request.frame() !== this.page.mainFrame()
    )
      return;
    this.requests.add(request);
  };

  private readonly onResponse = (response: Response): void => {
    if (
      !this.requests.delete(response.request()) ||
      response.status() !== 413 ||
      !response.headers()["content-type"]?.includes("application/json")
    )
      return;
    this.checks.push(
      withChatGptBrowserObservationTimeout(response.json(), 3_000)
        .then((body) =>
          body?.detail?.code === "message_length_exceeds_limit"
            ? new ChatGptWebAdapterError(
                "ChatGPT rejected this message because it exceeds the selected mode's input-size limit. Compact the task before retrying.",
                { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
              )
            : undefined,
        )
        // Unreadable or unfamiliar responses do not establish a size rejection. The normal
        // bound-response DOM error remains authoritative in that case.
        .catch(() => undefined),
    );
  };

  begin(page: Page): void {
    this.dispose();
    this.checks = [];
    this.page = page;
    page.on("request", this.onRequest);
    page.on("response", this.onResponse);
  }

  async failure(): Promise<ChatGptWebAdapterError | undefined> {
    return (await Promise.all(this.checks)).find((error) => error !== undefined);
  }

  dispose(): void {
    this.page?.off("request", this.onRequest);
    this.page?.off("response", this.onResponse);
    this.page = undefined;
    this.requests.clear();
  }
}

export async function throwIfChatGptTerminalErrorAlert(scope: ChatGptTextScope): Promise<void> {
  if (
    await scope
      .getByTestId("regenerate-thread-error-button")
      .last()
      .isVisible()
      .catch(() => false)
  ) {
    throw new ChatGptWebAdapterError(
      "ChatGPT displayed an error for this response. Check the ChatGPT tab for the exact error, then retry the turn.",
      { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: true },
    );
  }
  if (
    !(await chatGptTerminalErrorAlert(scope)
      .isVisible()
      .catch(() => false))
  )
    return;
  throw new ChatGptWebAdapterError("ChatGPT ended the turn with 'Something went wrong'. Retry the turn.", {
    status: 502,
    errorType: "server_error",
    code: "upstream_server_error",
    retryable: true,
  });
}

export async function resolveChatGptToolConfirmation(
  page: Page,
  appName: string,
  autoApprove: boolean,
  signal?: AbortSignal,
  timeoutMs = CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS,
  onVisible?: () => Promise<void>,
): Promise<boolean> {
  const dialog = page
    .locator('[role="dialog"], [data-testid="tool-approval-card"]')
    .filter({ hasText: `Allow ChatGPT to use ${appName}?` })
    .last();
  let targetDialog = dialog;
  if (!(await targetDialog.isVisible().catch(() => false))) {
    targetDialog = page
      .locator('[role="dialog"], [data-testid="tool-approval-card"]')
      .filter({ hasText: appName })
      .filter({ hasText: /(Allow|Permitir|許可|허용|允許|允许)/i })
      .last();
  }
  if (!(await targetDialog.isVisible().catch(() => false))) return false;
  await onVisible?.();

  if (autoApprove) {
    // ChatGPT exposes either "Allow once" or the shorter "Allow" for the
    // current one-shot approval. Keep the matcher anchored so persistent
    // actions such as "Always allow" cannot match.
    const allowCurrentAction = targetDialog
      .getByRole("button", {
        name: /^(Allow(?: once)?|Permitir(?: una vez)?|1回のみ許可|一度だけ許可|한 번만 허용|僅允許一次|仅允许一次)$/i,
      })
      .last();
    await allowCurrentAction.waitFor({ state: "visible", timeout: 10_000 });
    await allowCurrentAction.press("Enter");
    return true;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    if (!(await targetDialog.isVisible().catch(() => false))) return true;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, Math.min(100, Math.max(1, deadline - Date.now()))));
  }

  if (!(await targetDialog.isVisible().catch(() => false))) return true;
  const deny = targetDialog.getByRole("button", { name: /^(Deny|Denegar|Rechazar|拒否|거부|拒絕|拒绝)$/i }).last();
  await deny.waitFor({ state: "visible", timeout: 5_000 });
  await deny.press("Enter");
  await targetDialog.waitFor({ state: "hidden", timeout: 10_000 });
  return true;
}
