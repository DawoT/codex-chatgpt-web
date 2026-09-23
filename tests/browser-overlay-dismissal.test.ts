import { describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import {
  CHATGPT_OVERLAY_DISMISS_BUTTON_TEXT_REGEX,
  dismissAllChatGptOverlays,
} from "../src/adapters/chatgpt-web/browser-worker";

interface MockDialogOptions {
  text: string;
  onDismiss?: () => void;
  canDismiss?: boolean;
  hasRoleButton?: boolean;
  hasAriaClose?: boolean;
  isEscapeDismissable?: boolean;
  isToolApproval?: boolean;
}

function createMockDialog(options: MockDialogOptions) {
  let visible = true;
  const dismissBtn = {
    last: () => dismissBtn,
    isVisible: async () => visible && (options.canDismiss ?? true),
    click: async () => {
      visible = false;
      options.onDismiss?.();
    },
  };

  const emptyLoc = {
    last: () => emptyLoc,
    isVisible: async () => false,
    count: async () => 0,
  };

  const toolApprovalLoc = {
    last: () => toolApprovalLoc,
    isVisible: async () => Boolean(options.isToolApproval),
    count: async () => (options.isToolApproval ? 1 : 0),
  };

  const dialog: any = {
    allInnerTexts: async () => [options.text],
    isVisible: async () => visible,
    getByRole: (role: string) => {
      if (role === "button" && options.hasRoleButton) {
        return dismissBtn;
      }
      return emptyLoc;
    },
    locator: (selector: string) => {
      if (selector.includes("tool-approval-card")) return toolApprovalLoc;
      if (options.hasAriaClose && (selector.includes("close") || selector.includes("aria-label"))) {
        return dismissBtn;
      }
      return emptyLoc;
    },
    waitFor: async () => {},
    triggerEscape: () => {
      if (options.isEscapeDismissable) {
        visible = false;
        options.onDismiss?.();
      }
    },
  };

  return dialog;
}

function createMockPage(getDialogs: () => any[]): Page {
  return {
    locator: (selector: string) => {
      if (selector.includes("role=\"dialog\"") || selector.includes("aria-modal")) {
        return {
          filter: () => ({
            all: async () => getDialogs().filter(d => d.isVisible()),
            count: async () => getDialogs().filter(d => d.isVisible()).length,
          }),
        };
      }
      return {
        filter: () => ({
          all: async () => [],
          count: async () => 0,
        }),
      };
    },
    keyboard: {
      press: async (key: string) => {
        if (key === "Escape") {
          for (const d of getDialogs()) {
            if (typeof d.triggerEscape === "function") {
              d.triggerEscape();
            }
          }
        }
      },
    },
  } as unknown as Page;
}

describe("Sprint J: Universal DOM Guarding & i18n Modal Dismissal", () => {
  test("dismiss button regex matches all supported multi-lingual actions", () => {
    const supported = [
      // English
      "Dismiss", "Continue", "Close", "Got it", "Entendido", "Not now", "Maybe later", "Done", "Cancel", "No thanks",
      // Spanish
      "Continuar", "Cerrar", "Aceptar", "Ahora no", "Más tarde", "Hecho", "Cancelar", "No, gracias", "Rechazar", "Seguir desconectado",
      // Chinese
      "知道了", "了解", "关闭", "取消", "稍后",
      // Japanese
      "閉じる", "後で", "キャンセル",
      // Korean
      "확인", "계속", "닫기", "나중에", "취소",
    ];

    for (const text of supported) {
      expect(CHATGPT_OVERLAY_DISMISS_BUTTON_TEXT_REGEX.test(text)).toBeTrue();
      expect(CHATGPT_OVERLAY_DISMISS_BUTTON_TEXT_REGEX.test(text.toLowerCase())).toBeTrue();
      expect(CHATGPT_OVERLAY_DISMISS_BUTTON_TEXT_REGEX.test(text.toUpperCase())).toBeTrue();
    }

    const unsupported = [
      "Delete account", "Upgrade to Pro", "Submit query", "Send message", "Approve tool call",
    ];
    for (const text of unsupported) {
      expect(CHATGPT_OVERLAY_DISMISS_BUTTON_TEXT_REGEX.test(text)).toBeFalse();
    }
  });

  test("returns 0 when no dialogs are visible", async () => {
    const page = createMockPage(() => []);
    const count = await dismissAllChatGptOverlays(page);
    expect(count).toBe(0);
  });

  test("dismisses standard dialog by clicking matching button", async () => {
    let dismissed = false;
    const dialog = createMockDialog({
      text: "Welcome to Canvas! Explore features now.",
      hasRoleButton: true,
      onDismiss: () => { dismissed = true; },
    });

    const page = createMockPage(() => [dialog]);
    const count = await dismissAllChatGptOverlays(page);

    expect(count).toBe(1);
    expect(dismissed).toBeTrue();
  });

  test("dismisses dialog with close button aria-label", async () => {
    let dismissed = false;
    const dialog = createMockDialog({
      text: "Survey: How was your experience?",
      hasAriaClose: true,
      onDismiss: () => { dismissed = true; },
    });

    const page = createMockPage(() => [dialog]);
    const count = await dismissAllChatGptOverlays(page);

    expect(count).toBe(1);
    expect(dismissed).toBeTrue();
  });

  test("falls back to Escape key when no dismiss button is found", async () => {
    let dismissed = false;
    const dialog = createMockDialog({
      text: "Notice banner without actions",
      isEscapeDismissable: true,
      onDismiss: () => { dismissed = true; },
    });

    const page = createMockPage(() => [dialog]);
    const count = await dismissAllChatGptOverlays(page);

    expect(count).toBe(1);
    expect(dismissed).toBeTrue();
  });

  test("does NOT dismiss rate limit dialogs", async () => {
    let dismissed = false;
    const dialog = createMockDialog({
      text: "Too many requests in 1 hour. You are making requests too quickly.",
      hasRoleButton: true,
      onDismiss: () => { dismissed = true; },
    });

    const page = createMockPage(() => [dialog]);
    const count = await dismissAllChatGptOverlays(page);

    expect(count).toBe(0);
    expect(dismissed).toBeFalse();
  });

  test("does NOT dismiss session expired alerts", async () => {
    let dismissed = false;
    const dialog = createMockDialog({
      text: "Your session has expired. Please log in again.",
      hasRoleButton: true,
      onDismiss: () => { dismissed = true; },
    });

    const page = createMockPage(() => [dialog]);
    const count = await dismissAllChatGptOverlays(page);

    expect(count).toBe(0);
    expect(dismissed).toBeFalse();
  });

  test("does NOT dismiss tool approval cards", async () => {
    let dismissed = false;
    const dialog = createMockDialog({
      text: "Codex wants to run bash tool-approval",
      isToolApproval: true,
      hasRoleButton: true,
      onDismiss: () => { dismissed = true; },
    });

    const page = createMockPage(() => [dialog]);
    const count = await dismissAllChatGptOverlays(page);

    expect(count).toBe(0);
    expect(dismissed).toBeFalse();
  });

  test("handles stacked overlays across multiple passes", async () => {
    let step = 0;
    const d1 = createMockDialog({
      text: "Cookie consent banner. Accept all",
      hasRoleButton: true,
      onDismiss: () => { step += 1; },
    });
    const d2 = createMockDialog({
      text: "What's new in GPT-5. Got it",
      hasRoleButton: true,
      onDismiss: () => { step += 1; },
    });

    const page = createMockPage(() => {
      if (step === 0) return [d1];
      if (step === 1) return [d2];
      return [];
    });

    const count = await dismissAllChatGptOverlays(page, { maxPasses: 3 });
    expect(count).toBe(2);
    expect(step).toBe(2);
  });

  test("captures diagnostic callback when overlay remains unresolved", async () => {
    let diagnosticCaptured = false;
    const stubbornDialog = createMockDialog({
      text: "Stubborn unclosable banner",
      canDismiss: false,
    });

    const page = createMockPage(() => [stubbornDialog]);
    const count = await dismissAllChatGptOverlays(page, {
      maxPasses: 2,
      captureDiagnostic: async name => {
        if (name === "overlay-unresolved") diagnosticCaptured = true;
      },
    });

    expect(count).toBe(0);
    expect(diagnosticCaptured).toBeTrue();
  });
});
