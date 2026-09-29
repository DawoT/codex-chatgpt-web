import type { Locator, Page } from "playwright-core";
import {
  activateChatGptEffortMenu,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  readChatGptEffortSnapshot,
} from "../../../chatgpt-session";
import { ChatGptWebAdapterError } from "../adapter-error";
import { type ChatGptUsageModel, readChatGptUsageModel } from "../limits";
import { type ChatGptWebCapabilities, type ChatGptWebModelMode, resolveChatGptWebModelMode } from "../model";
import { assertChatGptModelFamily, selectChatGptModelFamily } from "../model-selection";
import { waitForElementAttribute, waitForElementText, waitForSliderValue } from "./dom-events";
import { waitForChatGptDomSettle } from "./dom-signal";
import {
  chatGptExpiredSessionAlert,
  chatGptRateLimitDialog,
  throwIfChatGptRateLimitDialog,
  throwIfChatGptSessionFailureAlert,
} from "./overlays";
import { setChatGptThinkMode } from "./payloads";
import { chatGptUnavailableProDetail } from "./personalization";

export type SelectedChatGptWebModelMode = ChatGptWebModelMode & {
  modelFamily?: "5.6" | "6";
  selection?: { url: string; label: string };
  usageModel?: ChatGptUsageModel;
};

const CHATGPT_MODEL_CONTROL_UNAVAILABLE_MESSAGE =
  "ChatGPT model controls are unavailable. Reload ChatGPT and retry the task.";

function chatGptModelControlUnavailableError(diagnostic: string): Error {
  return new Error(CHATGPT_MODEL_CONTROL_UNAVAILABLE_MESSAGE, { cause: new Error(diagnostic) });
}

function chatGptModelControlUnavailableAdapterError(diagnostic: string, detail?: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    detail
      ? `${CHATGPT_MODEL_CONTROL_UNAVAILABLE_MESSAGE} ChatGPT: ${detail}`
      : CHATGPT_MODEL_CONTROL_UNAVAILABLE_MESSAGE,
    {
      status: 502,
      errorType: "server_error",
      code: "upstream_server_error",
      retryable: false,
      cause: new Error(diagnostic),
    },
  );
}

/**
 * Dispatch surface the model/effort selection methods rely on through their `this`.
 * The bodies keep the original open recursion (`this.activeComposer(...)`,
 * `this.assertSelectedEffort(...)`), so hosts that stub or override one member keep steering
 * every internal call.
 */
export interface ChatGptModelControlsHost {
  activeComposer(page: Page, timeoutMs?: number, abortSignal?: AbortSignal): Promise<Locator>;
  assertSelectedEffort(page: Page, mode: SelectedChatGptWebModelMode, verifyFamily?: boolean): Promise<void>;
}

export class ChatGptModelControls {
  async selectModelAndEffort(
    this: ChatGptModelControlsHost,
    page: Page,
    modelId: string,
    reasoning: string | undefined,
    capabilities: ChatGptWebCapabilities,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    trackUsage = false,
    modelFamily?: "5.6" | "6",
  ): Promise<SelectedChatGptWebModelMode> {
    const mode = resolveChatGptWebModelMode(modelId, reasoning, capabilities);
    const composer = await this.activeComposer(page);
    const composerForm = composer.locator("xpath=ancestor::form[1]");
    const uiEffortIndex = mode.uiEffortIndex;
    if (uiEffortIndex === null) {
      await waitForChatGptDomSettle(page, { horizonMs: 250 });
      await throwIfChatGptRateLimitDialog(page);
      const visibleControls = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).filter({ visible: true });
      if ((await visibleControls.count()) > 0) {
        throw chatGptModelControlUnavailableError(
          "ChatGPT Luna was selected from a Luna-only capability probe, but the account now exposes a model selector; rerun setup",
        );
      }
      // Enable Think during prompt attachment, after fresh connector selection. Ordinary Luna
      // still clears a previous Think selection here; retained Think is checked on every attach.
      if (!mode.thinkEnabled) await setChatGptThinkMode(composerForm, false, captureDiagnostic);
      return mode;
    }
    const currentEffort = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).filter({ visible: true });
    const effortWaitAbort = new AbortController();
    try {
      const ready = await Promise.race([
        currentEffort
          .waitFor({ state: "visible", timeout: 70_000, signal: effortWaitAbort.signal })
          .then(() => "effort" as const),
        chatGptRateLimitDialog(page)
          .waitFor({ state: "visible", timeout: 70_000, signal: effortWaitAbort.signal })
          .then(() => "rate-limit" as const),
        chatGptExpiredSessionAlert(page)
          .waitFor({ state: "visible", timeout: 70_000, signal: effortWaitAbort.signal })
          .then(() => "session-expired" as const),
      ]);
      if (ready === "rate-limit") await throwIfChatGptRateLimitDialog(page);
      if (ready === "session-expired") await throwIfChatGptSessionFailureAlert(page);
    } catch (error) {
      if (error instanceof ChatGptWebAdapterError) throw error;
      await throwIfChatGptRateLimitDialog(page);
      await throwIfChatGptSessionFailureAlert(page);
      throw chatGptModelControlUnavailableError(
        "ChatGPT rendered the composer but its model/effort control did not become ready",
      );
    } finally {
      effortWaitAbort.abort();
    }
    await waitForChatGptDomSettle(page, { horizonMs: 250 });
    await throwIfChatGptRateLimitDialog(page);
    await captureDiagnostic?.("effort-control-ready");
    await throwIfChatGptRateLimitDialog(page);
    let activation = await activateChatGptEffortMenu(page, currentEffort);
    if (modelFamily)
      activation = await selectChatGptModelFamily(activation, modelFamily, () =>
        activateChatGptEffortMenu(page, currentEffort),
      );
    if (activation.method === "pointerdown") {
      await captureDiagnostic?.("effort-menu-pointerdown-fallback");
    }
    await captureDiagnostic?.("effort-menu-open-requested");
    const effortSlider = activation.slider;
    const sliderContainer = activation.sliderContainer;
    const waitAbort = new AbortController();
    try {
      const ready = await Promise.race([
        sliderContainer
          .waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal })
          .then(() => effortSlider.waitFor({ state: "attached", timeout: 70_000, signal: waitAbort.signal }))
          .then(() => "slider" as const),
        chatGptRateLimitDialog(page)
          .waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal })
          .then(() => "rate-limit" as const),
        chatGptExpiredSessionAlert(page)
          .waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal })
          .then(() => "session-expired" as const),
      ]);
      if (ready === "rate-limit") await throwIfChatGptRateLimitDialog(page);
      if (ready === "session-expired") await throwIfChatGptSessionFailureAlert(page);
      await captureDiagnostic?.("effort-slider-visible");
    } catch (error) {
      if (error instanceof ChatGptWebAdapterError) throw error;
      await throwIfChatGptRateLimitDialog(page);
      await throwIfChatGptSessionFailureAlert(page);
      throw chatGptModelControlUnavailableAdapterError(
        `ChatGPT effort slider did not become ready for item index ${uiEffortIndex}`,
      );
    } finally {
      waitAbort.abort();
    }
    const selectionUrl = page.url();
    const readAvailableEffort = async (container: Locator, menu: Locator) => {
      const state = await readChatGptEffortSnapshot(container).catch((error) => {
        throw chatGptModelControlUnavailableAdapterError(String(error));
      });
      if (uiEffortIndex > state.max - state.min) {
        const detail = uiEffortIndex === 4 ? await chatGptUnavailableProDetail(menu) : undefined;
        throw chatGptModelControlUnavailableAdapterError(
          `ChatGPT effort slider does not expose item index ${uiEffortIndex} (min=${state.min}; max=${state.max})` +
            (uiEffortIndex === 4
              ? " ChatGPT may have temporarily hidden Pro because you reached its usage limit."
              : ""),
          detail,
        );
      }
      if (!state.available[uiEffortIndex]) {
        throw new ChatGptWebAdapterError(
          `ChatGPT locks the browser option requested for ${mode.displayLabel} behind an upgrade. ` +
            "The message was not sent. Choose an available effort and run Repair Codex setup to refresh the model list.",
          { status: 400, errorType: "invalid_request_error", code: "chatgpt_effort_locked", retryable: false },
        );
      }
      return state;
    };
    let sliderState = await readAvailableEffort(sliderContainer, activation.menu);
    const initialMin = sliderState.min;
    const targetValue = initialMin + uiEffortIndex;
    const sliderControl = effortSlider.locator("xpath=ancestor::*[@role='menuitem'][1]");
    while (sliderState.value !== targetValue) {
      await throwIfChatGptRateLimitDialog(page);
      const direction = targetValue > sliderState.value ? 1 : -1;
      const key = direction > 0 ? "ArrowRight" : "ArrowLeft";
      const expectedValue = sliderState.value + direction;
      let stepSucceeded = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        await (sliderControl as unknown as { focus?: () => Promise<void> }).focus?.().catch(() => {});
        await sliderControl
          .press(key)
          .catch(() => effortSlider.press(key))
          .catch(() => page.keyboard.press(key));
        await waitForSliderValue(effortSlider, expectedValue, 1_000).catch(() => {});
        sliderState = await readAvailableEffort(sliderContainer, activation.menu);
        if (sliderState.min !== initialMin) {
          throw chatGptModelControlUnavailableError("ChatGPT changed its effort range origin during selection");
        }
        if (sliderState.value === expectedValue) {
          stepSucceeded = true;
          break;
        }
      }
      if (!stepSucceeded) {
        throw chatGptModelControlUnavailableError(
          `ChatGPT effort slider did not move exactly one step with ${key}` +
            ` (before=${expectedValue - direction}; after=${sliderState.value})`,
        );
      }
    }
    await waitForChatGptDomSettle(page, { horizonMs: 250 });
    const selectedState = await readAvailableEffort(sliderContainer, activation.menu);
    if (selectedState.min !== initialMin || selectedState.value !== targetValue) {
      throw chatGptModelControlUnavailableAdapterError(
        "ChatGPT changed its effort range or selection before the menu closed",
      );
    }
    await captureDiagnostic?.("effort-selected");
    await page.keyboard.press("Escape");
    await waitForElementAttribute(currentEffort, "aria-expanded", "false", 2_000).catch(() => {});
    await waitForChatGptDomSettle(page, { horizonMs: 250 });
    // While open, the trigger reads "Thinking effort", not the selected value. Read its
    // closed label and reopen the menu once to prove the selection survived the commit.
    const selectedMode: SelectedChatGptWebModelMode = {
      ...mode,
      ...(modelFamily ? { modelFamily } : {}),
      selection: { url: selectionUrl, label: (await currentEffort.innerText()).trim() },
    };
    await this.assertSelectedEffort(page, selectedMode, false);
    const confirmation = await activateChatGptEffortMenu(page, currentEffort);
    await confirmation.slider.waitFor({ state: "attached", timeout: 5_000 });
    const confirmedState = await readAvailableEffort(confirmation.sliderContainer, confirmation.menu);
    if (confirmedState.min !== initialMin || confirmedState.value !== targetValue) {
      throw chatGptModelControlUnavailableAdapterError(
        "ChatGPT did not persist the requested effort after closing its menu",
      );
    }
    if (modelFamily) await assertChatGptModelFamily(confirmation, modelFamily, mode.effort, uiEffortIndex, 1_000);
    // A bare 'Pro' trigger does not identify the family selected by ChatGPT's Latest option.
    // Unknown evidence remains visible as unclassified Pro usage in Limits.
    if (trackUsage) {
      selectedMode.usageModel = await readChatGptUsageModel(confirmation.slider, mode.effort === "max").catch(() =>
        mode.effort === "max" ? ("pro-unknown" as const) : ("other" as const),
      );
    }
    await page.keyboard.press("Escape");
    await waitForElementAttribute(currentEffort, "aria-expanded", "false", 2_000).catch(() => {});
    await waitForChatGptDomSettle(page, { horizonMs: 250 });
    await this.assertSelectedEffort(page, selectedMode, false);
    await captureDiagnostic?.("effort-selection-confirmed");
    return selectedMode;
  }

  async assertSelectedEffort(
    this: ChatGptModelControlsHost,
    page: Page,
    mode: SelectedChatGptWebModelMode,
    verifyFamily = true,
  ): Promise<void> {
    if (!mode.selection) return;
    const composer = await this.activeComposer(page);
    const controls = composer
      .locator("xpath=ancestor::form[1]")
      .locator(CHATGPT_EFFORT_CONTROL_SELECTOR)
      .filter({ visible: true });
    if (page.url() !== mode.selection.url || !mode.selection.label || (await controls.count()) !== 1) {
      throw chatGptModelControlUnavailableAdapterError(
        "ChatGPT changed the selected model's browser surface before submission",
      );
    }
    const control = controls.first();
    await waitForElementAttribute(control, "aria-expanded", "false", 2_000).catch(() => {});
    if (mode.selection.label) {
      await waitForElementText(control, mode.selection.label, 2_000).catch(() => {});
    }
    if (
      (await control.innerText()).trim() !== mode.selection.label ||
      (await control.getAttribute("aria-expanded")) !== "false" ||
      !(await composer.isEditable())
    ) {
      throw chatGptModelControlUnavailableAdapterError(
        "ChatGPT did not retain the selected effort in its ready composer; the message was not submitted",
      );
    }
    if (verifyFamily && mode.modelFamily && mode.uiEffortIndex !== null) {
      const menu = await activateChatGptEffortMenu(page, control);
      try {
        await assertChatGptModelFamily(menu, mode.modelFamily, mode.effort, mode.uiEffortIndex);
      } finally {
        await page.keyboard.press("Escape");
        await waitForElementAttribute(control, "aria-expanded", "false", 2_000).catch(() => {});
      }
      if (
        page.url() !== mode.selection.url ||
        (await control.innerText()).trim() !== mode.selection.label ||
        (await control.getAttribute("aria-expanded")) !== "false" ||
        !(await composer.isEditable())
      ) {
        throw chatGptModelControlUnavailableAdapterError(
          "ChatGPT changed the model while checking its family before submission",
        );
      }
    }
  }
}
