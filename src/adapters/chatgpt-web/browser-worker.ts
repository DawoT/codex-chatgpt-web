import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import {
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
  CHATGPT_USER_TURN_SELECTOR,
  chatGptAssistantTurnSelector,
  detectChatGptAccountCapabilities,
} from "../../chatgpt-session";
import { atomicWriteFile, CHATGPT_CONNECTOR_NAME, getConfigDir } from "../../config";
import {
  connectLauncherBrowserHost,
  LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS,
  LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS,
  LauncherBrowserTurnCancelledError,
  LauncherRetainedConversationUnavailableError,
  notifyLauncherTurn,
} from "../../launcher-browser-host";
import { estimateTokens } from "../../lib/token-estimate";
import type { CodexProviderConfig } from "../../types";
import {
  ChatGptCompactionHandoffAccepted,
  ChatGptWebAdapterError,
  chatGptBrowserTabClosedError,
  chatGptContextCompactionRequiredError,
  chatGptRetainedConversationUnavailableError,
  chatGptStoppedThinkingError,
} from "./adapter-error";
import { BrowserSession, type ChatGptBrowserSessionHost } from "./browser/browser-session";
import {
  type ChatGptComposerControllerHost,
  type ChatGptConnectorAttemptBudget,
  ChatGptConnectorCatalogStaleError,
  ComposerController,
} from "./browser/composer-controller";
import { ChatGptBrowserContextPressure, ChatGptPageDomObserver } from "./browser/context-pressure";
import { waitForChatGptDomRevision, waitForChatGptDomSettle } from "./browser/dom-signal";
import {
  ChatGptModelControls,
  type ChatGptModelControlsHost,
  type SelectedChatGptWebModelMode,
} from "./browser/model-controls";
import { type ChatGptResponseObserverHost, ResponseObserver } from "./browser/response-observer";
import {
  type ChatGptSubmissionBaseline,
  type ChatGptSubmissionDomCache,
  type ChatGptSubmissionDomState,
  type ChatGptSubmissionObserverHost,
  SubmissionObserver,
} from "./browser/submission-observer";
import { ChatGptTurnCompletionFsm } from "./browser/turn-completion-fsm";
import {
  type ChatGptAssistantTurnBinding,
  type ChatGptObservationRecovery,
  type ChatGptSubmissionObservationRecovery,
  type ChatGptTurnDiagnosticsHost,
  TurnDiagnostics,
} from "./browser/turn-diagnostics";
import { ChatGptTurnEventBus } from "./browser/turn-events";
import { type InteractiveBrowserTurnLock, interactiveBrowserTurnMutex } from "./browser-mutex";
import { MAX_CHATGPT_BROWSER_TABS, MAX_CHATGPT_LAUNCHER_PENDING_TURNS } from "./concurrency";
import {
  createBrowserPayloadAcceptanceRecorder,
  estimateChatGptWebImageTokens,
  measureCompiledBrowserPayload,
  measureCompiledChatGptWebInput,
} from "./input-tokens";
import { LauncherBrowserHelperClient } from "./launcher-helper-client";
import { detectChatGptLimitsPlan, readChatGptUsageAccount, supportsChatGptUsageTracking } from "./limits";
import { ChatGptMarkdownBuffer, ChatGptMarkdownConsistencyError, inspectCompactionResponseSurface } from "./markdown";
import {
  CHATGPT_WEB_LUNA_MODEL_ID,
  CHATGPT_WEB_MODEL_ID,
  type ChatGptWebCapabilities,
  resolveChatGptWebModelMode,
} from "./model";
import {
  type ChatGptWebMultipartStage,
  type CompiledChatGptWebPrompt,
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
} from "./prompt";
import { type CapturedChatGptLunaCheckpoint, ChatGptLunaCheckpointStream } from "./rolling-checkpoint";
import { skillFileTokens } from "./skill-attachments";
import type { ChatGptTurnProgressReader } from "./turn-progress";
import { chatGptExternalToolCallsAreInFlight } from "./turn-progress";

export { MAX_CHATGPT_BROWSER_TABS } from "./concurrency";

const workers = new Map<string, ChatGptBrowserWorker>();

export async function closeChatGptBrowserWorkers(): Promise<void> {
  const active = [...workers.values()];
  workers.clear();
  const results = await Promise.allSettled(active.map((worker) => worker.close()));
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} ChatGPT browser worker(s) failed to close`);
  }
}

export {
  browserStageTimeouts,
  CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS,
  CHATGPT_COMPLETION_ACTION_GRACE_MS,
  CHATGPT_COMPLETION_SETTLE_MS,
  CHATGPT_COMPOSER_DOCUMENT_END_KEY,
  CHATGPT_COMPOSER_SELECT_ALL_KEY,
  CHATGPT_EMPTY_RESPONSE_GRACE_MS,
  CHATGPT_MIN_OPERATIONAL_VIEWPORT,
  CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS,
  CHATGPT_RESPONSE_DOM_GRACE_MS,
  ChatGptBrowserObservationTimeoutError,
  ChatGptSuspensionClock,
  chatGptSuspensionClock,
  connectAfterClosingBrowserConnection,
  MAX_CHATGPT_BROWSER_PAGE_REBINDS,
  remainingStageBudgetMs,
  throwIfPromptAttachmentAborted,
  withBrowserTurnAbort,
  withChatGptBrowserObservationTimeout,
} from "./browser/suspension-clock";

import {
  browserStageTimeouts,
  CHATGPT_MIN_OPERATIONAL_VIEWPORT,
  CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS,
  CHATGPT_RESPONSE_DOM_GRACE_MS,
  ChatGptBrowserObservationTimeoutError,
  type ChatGptSuspensionClock,
  chatGptSuspensionClock,
  connectAfterClosingBrowserConnection,
  MAX_CHATGPT_BROWSER_PAGE_REBINDS,
  throwIfPromptAttachmentAborted,
  withBrowserTurnAbort,
  withChatGptBrowserObservationTimeout,
} from "./browser/suspension-clock";

export {
  CHATGPT_OVERLAY_CONFIRM_BUTTON_TEXT_REGEX,
  CHATGPT_OVERLAY_DESTRUCTIVE_TEXT_REGEX,
  CHATGPT_OVERLAY_DISMISS_BUTTON_TEXT_REGEX,
  CHATGPT_OVERLAY_SAFE_DISMISS_BUTTON_TEXT_REGEX,
  CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS,
  ChatGptPromptAttachmentIntegrityError,
  ChatGptSubmissionRejectionObserver,
  type ChatGptTextScope,
  type DismissOverlaysOptions,
  dismissAllChatGptOverlays,
  dismissChatGptTemporaryChatOnboarding,
  resolveChatGptToolConfirmation,
  throwIfChatGptRateLimitDialog,
  throwIfChatGptSessionFailureAlert,
  throwIfChatGptTerminalErrorAlert,
} from "./browser/overlays";
export {
  CHATGPT_PERSONALIZATION_CLEANUP_TIMEOUT_MS,
  CHATGPT_PERSONALIZATION_PREFLIGHT_TIMEOUT_MS,
  CHATGPT_UI_SETTLE_MS,
  type ChatGptPersonalizationPreflight,
  chatGptConnectorUnavailableError,
  chatGptUnavailableProDetail,
  ensureChatGptPersonalizedConnectorAccess,
} from "./browser/personalization";

import {
  CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS,
  ChatGptPromptAttachmentIntegrityError,
  ChatGptSubmissionRejectionObserver,
  resolveChatGptToolConfirmation,
  throwIfChatGptRateLimitDialog,
  throwIfChatGptSessionFailureAlert,
  throwIfChatGptTerminalErrorAlert,
} from "./browser/overlays";

export {
  absentResponseDomSnapshot,
  CHATGPT_EXTERNAL_PROGRESS_CLOCK_SKEW_MS,
  CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS,
  CHATGPT_PENDING_TOOL_EVIDENCE_STALL_MS,
  CHATGPT_TOOL_IN_FLIGHT_CEILING_MS,
  ChatGptCompletionTracker,
  type ChatGptConnectorAttachmentMode,
  ChatGptPendingToolEvidenceTracker,
  type ChatGptResponseDomCache,
  type ChatGptResponseDomSnapshot,
  type ChatGptSubmissionEvidence,
  ChatGptTurnDomHealthTracker,
  type ChatGptVisibleTraceBlock,
  type ChatGptVisibleTraceEvent,
  ChatGptVisibleTraceTracker,
  chatGptConnectorAttachmentMode,
  chatGptExternalProgressSuppressesDomHealth,
  chatGptNewTurnIdentity,
  chatGptReboundTurnIdentity,
  chatGptSubmissionEvidence,
  chatGptTurnIdentityLocatorSelector,
  chatGptTurnIsComplete,
  isChatGptTraceControl,
  MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS,
  stripChatGptTraceControlSuffix,
} from "./browser/dom-trackers";

import {
  ChatGptCompletionTracker,
  type ChatGptResponseDomCache,
  type ChatGptResponseDomSnapshot,
  type ChatGptSubmissionEvidence,
  ChatGptTurnDomHealthTracker,
  ChatGptVisibleTraceTracker,
  chatGptExternalProgressSuppressesDomHealth,
  MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS,
} from "./browser/dom-trackers";

export {
  browserDiagnosticCheckpoint,
  CHATGPT_BROWSER_DIAGNOSTIC_TRACE_LIMIT,
  ChatGptBrowserDiagnostics,
  pruneBrowserDiagnostics,
  redactChatGptUiDiagnostic,
  sanitizeChatGptBrowserDiagnosticState,
} from "./browser/diagnostics";

import { ChatGptBrowserDiagnostics, redactChatGptUiDiagnostic } from "./browser/diagnostics";

export {
  chatGptImageFilePayloads,
  chatGptPromptFilePayloads,
  insertPlainTextIntoComposer,
  normalizePromptForComparison,
  setChatGptThinkMode,
} from "./browser/payloads";

import { assertChatGptPromptAttachments } from "./browser/payloads";

export {
  type ResolvedBrowserConfig,
  resolveBrowserConfig,
} from "./browser/config";

import { type ResolvedBrowserConfig, resolveBrowserConfig } from "./browser/config";

export {
  assertChatGptWebInputWithinLimits,
  assertChatGptWebMultipartInputWithinLimits,
  resolveChatGptWebMultipartStagingMode,
} from "./browser/staging-limits";

import {
  assertChatGptWebInputWithinLimits,
  assertChatGptWebMultipartInputWithinLimits,
  resolveChatGptWebMultipartStagingMode,
} from "./browser/staging-limits";

export {
  promptCodeUnitEquivalent,
  promptEquivalentPrefixLength,
  promptTextEquivalent,
  promptUnitsEquivalent,
} from "./browser/prompt-equivalence";

import { promptEquivalentPrefixLength, promptTextEquivalent } from "./browser/prompt-equivalence";

export {
  type ChatGptClearComposerOptions,
  chatGptActiveComposer,
  chatGptClearComposerState,
} from "./browser/composer";
export { MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS } from "./browser/composer-controller";
export {
  CHATGPT_ATTACHMENT_INPUT_SELECTOR,
  CHATGPT_MENTION_MENU_ROWS_SELECTOR,
  type ChatGptConnectorMentionFailureOptions,
  chatGptConnectorIsSelected,
  chatGptConnectorMentionFailure,
  chatGptConnectorMentionRowTitles,
  chatGptRowIsHighlighted,
  chatGptSelectedConnectorControl,
} from "./browser/connectors";

const CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS = 10_000;
const CHATGPT_SMOKE_TEXT = "Reply with exactly: CODEX WEB GPT READY";
const CHATGPT_SMOKE_EXPECTED = "CODEX WEB GPT READY";
export const CHATGPT_SEND_ENABLE_GRACE_MS = 5_000;

async function waitForOperationalChatGptViewport(page: Page, signal?: AbortSignal): Promise<void> {
  try {
    await withBrowserTurnAbort(
      page.waitForFunction(
        ({ width, height }) => innerWidth >= width && innerHeight >= height,
        CHATGPT_MIN_OPERATIONAL_VIEWPORT,
        { polling: 50, timeout: 10_000 },
      ),
      signal,
    );
  } catch (error) {
    if (signal?.aborted) throw new DOMException("ChatGPT browser page acquisition aborted", "AbortError");
    throw new Error(
      `ChatGPT browser surface did not expose an operational viewport: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface BrowserTurn {
  traceId: string;
  modelId: string;
  reasoning?: string;
  modelFamily?: "5.6" | "6";
  capabilities: ChatGptWebCapabilities;
  pendingMissionRequirements?: boolean;
  prepare: () => Promise<CompiledChatGptWebPrompt & { release: () => void }>;
  prepareResume?: () => Promise<CompiledChatGptWebPrompt & { release: () => void }>;
  /** Select the Codex Native connector without advertising the ordinary turn tool environment. */
  nativeConnector?: boolean;
  retainConversation?: boolean;
  requireRetainedConversation?: boolean;
  conversationKey?: string;
  onPreparedSelected?: (reused: boolean) => void | Promise<void>;
  abortSignal?: AbortSignal;
  onHeartbeat?: () => void;
  /** Send activation is the ambiguity boundary after which a fresh surface must not replay this prompt. */
  onSendActivated?: () => void | Promise<void>;
  /** Semantic submission evidence proved that ChatGPT accepted the prompt. */
  onSubmitted?: () => void | Promise<void>;
  /** Persist the helper's exact tool-boundary request before acknowledging it. */
  onToolBatchObserved?: (requestId: number, revision: number) => void | Promise<void>;
  /** Confirm the launcher surface owner before any browser mutation. */
  onSurfaceLeased?: (surfaceId: string) => void | Promise<void>;
  /** Confirm a released launcher surface after the host ends the turn. */
  onSurfaceReleased?: (surfaceId: string) => void | Promise<void>;
  /** Persist the completed browser answer before releasing its surface. */
  onResultReady?: (text: string) => void | Promise<void>;
  /** One inert Bigger Context stage completed its exact acknowledgement boundary. */
  onMultipartStageAcknowledged?: (stageIndex: number) => void | Promise<void>;
  /** Visible ChatGPT reasoning-summary step titles only; never hidden chain-of-thought. */
  onReasoningSummary?: (text: string, continuation?: boolean) => void;
  /** Stable visible ChatGPT prose between status/tool rows. */
  onCommentary?: (text: string, continuation?: boolean) => void;
  /** Append-only, structurally stable Markdown chunks. */
  onTextDelta: (delta: string) => void;
  /** Proven current-turn MCP activity; never response content or completion. */
  externalProgress?: ChatGptTurnProgressReader;
  /** Atomically fences browser completion against concurrent MCP claims in the turn broker. */
  completionFence?: {
    begin(): Promise<number | undefined>;
    commit(revision: number): Promise<boolean>;
  };
  /** Allow one clean pre-submit composer retry for isolated history compaction only. */
  compaction?: boolean;
  /** Require and remove the private Luna checkpoint tail from the visible Markdown stream. */
  captureLunaCheckpoint?: boolean;
  onLunaCheckpoint?: (captured: CapturedChatGptLunaCheckpoint) => void;
}

export class ChatGptBrowserWorker {
  static releaseContextPressureForConversation(conversationKey: string): void {
    for (const worker of workers.values()) {
      worker.contextPressureByConversation.delete(conversationKey);
    }
  }

  static forProvider(provider: CodexProviderConfig): ChatGptBrowserWorker {
    const config = resolveBrowserConfig(provider);
    const key = JSON.stringify(config);
    let worker = workers.get(key);
    if (!worker) {
      worker = new ChatGptBrowserWorker(config);
      workers.set(key, worker);
    }
    return worker;
  }

  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: lent to BrowserSession through the borrowed `this` dispatch
  private managedBrowserReady?: Promise<{ browser: Browser; context: BrowserContext }>;
  private launcherHelper?: LauncherBrowserHelperClient;
  private maintenanceTail: Promise<void> = Promise.resolve();
  private readonly activeRuns = new Map<string, Promise<string>>();
  private readonly contextPressureByConversation = new Map<string, ChatGptBrowserContextPressure>();
  private readonly contextPressureByPage = new WeakMap<Page, ChatGptBrowserContextPressure>();
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: lent to ResponseObserver through the borrowed `this` dispatch
  private readonly pageDomObserver = new ChatGptPageDomObserver();
  /**
   * Per-turn event buses of the most recent turns, kept for diagnostics and tests. Buses are
   * disposed when their turn ends but retain their event history; the retention bound keeps a
   * long-lived worker from accumulating one entry per turn.
   */
  turnEventBuses?: Map<string, ChatGptTurnEventBus>;

  private getContextPressure(page: Page, conversationKey?: string): ChatGptBrowserContextPressure {
    // A page can be recycled for a different chat. Its old pressure must not follow
    // the new conversation, while response snapshots can still resolve by page.
    const existing = conversationKey
      ? this.contextPressureByConversation.get(conversationKey)
      : this.contextPressureByPage.get(page);
    const pressure = existing ?? new ChatGptBrowserContextPressure();
    this.contextPressureByPage.set(page, pressure);
    if (conversationKey) this.contextPressureByConversation.set(conversationKey, pressure);
    return pressure;
  }

  async releaseConversationContextPressure(conversationKey: string): Promise<void> {
    this.contextPressureByConversation.delete(conversationKey);
    await this.launcherHelper?.releaseConversationContextPressure(conversationKey);
  }

  private constructor(private readonly config: ResolvedBrowserConfig) {}

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: lent to ComposerController through the borrowed `this` dispatch
  private promptTextEquivalent(expected: string, observed: string): boolean {
    return promptTextEquivalent(expected, observed);
  }

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: lent to ComposerController through the borrowed `this` dispatch
  private promptEquivalentPrefixLength(expected: string, observed: string): number {
    return promptEquivalentPrefixLength(expected, observed);
  }

  run(turn: BrowserTurn): Promise<string> {
    if (this.activeRuns.has(turn.traceId)) {
      return Promise.reject(new Error(`Duplicate ChatGPT web browser turn: ${turn.traceId}`));
    }
    const maxRuns =
      this.config.browserHost === "launcher" ? MAX_CHATGPT_LAUNCHER_PENDING_TURNS : MAX_CHATGPT_BROWSER_TABS;
    if (this.activeRuns.size >= maxRuns) {
      return Promise.reject(
        new Error(
          `ChatGPT Web supports at most ${maxRuns} simultaneous browser turns; close or finish a browser tab before starting another`,
        ),
      );
    }
    const useHelper =
      this.config.browserHost === "launcher" && process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS !== "1";
    if (useHelper) {
      this.launcherHelper ??= new LauncherBrowserHelperClient(this.config);
    }
    const run = Promise.resolve().then(() => (useHelper ? this.launcherHelper!.run(turn) : this.runExclusive(turn)));
    this.activeRuns.set(turn.traceId, run);
    void run
      .finally(() => {
        if (this.activeRuns.get(turn.traceId) === run) this.activeRuns.delete(turn.traceId);
      })
      .catch(() => {});
    return run;
  }

  verifyConnector(traceId = `verify_${randomUUID().replaceAll("-", "")}`): Promise<string> {
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(traceId)) {
      return Promise.reject(new Error("ChatGPT connector verification trace id is invalid"));
    }
    return this.enqueueMaintenance("connector verification", () => this.verifyConnectorExclusive(traceId));
  }

  inspectSession(detectCapabilities: boolean): Promise<{
    authenticated: true;
    temporary: true;
    url: string;
    solAvailable?: boolean;
    extraHighAvailable?: boolean;
    proAvailable?: boolean;
  }> {
    return this.enqueueMaintenance("session inspection", () => this.inspectSessionExclusive(detectCapabilities));
  }

  smokeTest(abortSignal?: AbortSignal): Promise<{ effort: string; response: string }> {
    return this.enqueueMaintenance("smoke test", () => this.smokeTestExclusive(abortSignal));
  }

  inspectLimitsPlan() {
    return this.enqueueMaintenance("Limits setup", async () => {
      const page = await this.ensurePage();
      await this.prepareChatSurface(page);
      return detectChatGptLimitsPlan(page);
    });
  }

  private enqueueMaintenance<T>(name: string, action: () => Promise<T>): Promise<T> {
    return BrowserSession.prototype.enqueueMaintenance.call(
      this as unknown as ChatGptBrowserSessionHost,
      name,
      action,
    ) as Promise<T>;
  }

  async close(): Promise<void> {
    if (this.launcherHelper) {
      const helper = this.launcherHelper;
      this.launcherHelper = undefined;
      await helper.close();
    }
    await Promise.allSettled([...this.activeRuns.values()]);
    await this.maintenanceTail;
    const browser = this.browser;
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
    this.managedBrowserReady = undefined;
    this.contextPressureByConversation.clear();
    // For connectOverCDP, Playwright implements Browser.close as a transport disconnect; it does
    // not close the launcher-owned Electron process. Always release that connection and its
    // artifact directory instead of leaking one per timeout/helper lifecycle.
    if (browser) await browser.close();
  }

  private async runStage<T>(
    traceId: string,
    stage: string,
    timeoutMs: number,
    action: (abortSignal: AbortSignal) => Promise<T>,
    suspensionClock: Pick<ChatGptSuspensionClock, "suspendedMs"> = chatGptSuspensionClock,
    awaitAbortedActionSettlement = false,
  ): Promise<T> {
    return BrowserSession.prototype.runStage.call(
      this as unknown as ChatGptBrowserSessionHost,
      traceId,
      stage,
      timeoutMs,
      action,
      suspensionClock,
      awaitAbortedActionSettlement,
    ) as Promise<T>;
  }

  private async ensurePage(): Promise<Page> {
    return BrowserSession.prototype.ensurePage.call(this as unknown as ChatGptBrowserSessionHost);
  }

  private async ensureManagedBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
    return BrowserSession.prototype.ensureManagedBrowser.call(this as unknown as ChatGptBrowserSessionHost);
  }

  /**
   * A Codex turn owns one isolated browser conversation. Reusing the same
   * ChatGPT SPA page can retain the previous transcript and autocomplete DOM,
   * so an @app lookup may select stale UI from the preceding turn.
   */
  private async pageForNewTurn(): Promise<Page> {
    return BrowserSession.prototype.pageForNewTurn.call(this as unknown as ChatGptBrowserSessionHost);
  }

  private async selectModelAndEffort(
    page: Page,
    modelId: string,
    reasoning: string | undefined,
    capabilities: ChatGptWebCapabilities,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    trackUsage = false,
    modelFamily?: "5.6" | "6",
  ): Promise<SelectedChatGptWebModelMode> {
    return ChatGptModelControls.prototype.selectModelAndEffort.call(
      this as unknown as ChatGptModelControlsHost,
      page,
      modelId,
      reasoning,
      capabilities,
      captureDiagnostic,
      trackUsage,
      modelFamily,
    );
  }

  private async assertSelectedEffort(
    page: Page,
    mode: SelectedChatGptWebModelMode,
    verifyFamily = true,
  ): Promise<void> {
    return ChatGptModelControls.prototype.assertSelectedEffort.call(
      this as unknown as ChatGptModelControlsHost,
      page,
      mode,
      verifyFamily,
    );
  }

  private async activeComposer(page: Page, timeoutMs = 30_000, abortSignal?: AbortSignal): Promise<Locator> {
    return ComposerController.prototype.activeComposer.call(
      this as unknown as ChatGptComposerControllerHost,
      page,
      timeoutMs,
      abortSignal,
    );
  }

  /** Prepare a new conversation; account inspection still uses an empty Temporary Chat. */
  private async prepareChatSurface(
    page: Page,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    useSavedChats = false,
  ): Promise<Locator> {
    return ComposerController.prototype.prepareChatSurface.call(
      this as unknown as ChatGptComposerControllerHost,
      page,
      captureDiagnostic,
      useSavedChats,
    );
  }

  private async waitForTurnDomMutation(page: Page, timeoutMs = 250): Promise<void> {
    return SubmissionObserver.prototype.waitForTurnDomMutation.call(
      this as unknown as ChatGptSubmissionObserverHost,
      page,
      timeoutMs,
    );
  }

  private async waitForTurnDomOrExternalProgress(
    page: Page,
    afterProgressRevision: number,
    externalProgress?: ChatGptTurnProgressReader,
    signal?: AbortSignal,
  ): Promise<void> {
    return SubmissionObserver.prototype.waitForTurnDomOrExternalProgress.call(
      this as unknown as ChatGptSubmissionObserverHost,
      page,
      afterProgressRevision,
      externalProgress,
      signal,
    );
  }

  private async waitForTurnDomRevisionOrExternalProgress(
    page: Page,
    afterDomKey: string | undefined,
    afterProgressRevision: number,
    externalProgress?: ChatGptTurnProgressReader,
    signal?: AbortSignal,
  ): Promise<string> {
    return SubmissionObserver.prototype.waitForTurnDomRevisionOrExternalProgress.call(
      this as unknown as ChatGptSubmissionObserverHost,
      page,
      afterDomKey,
      afterProgressRevision,
      externalProgress,
      signal,
    );
  }

  private async waitForSubmissionAccepted(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    signal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    initialToolBatchRevision = externalProgress?.snapshot().lastToolBatchRevision ?? 0,
    completionTracker?: ChatGptCompletionTracker,
  ): Promise<ChatGptSubmissionEvidence> {
    return SubmissionObserver.prototype.waitForSubmissionAccepted.call(
      this as unknown as ChatGptSubmissionObserverHost,
      page,
      baseline,
      signal,
      externalProgress,
      initialToolBatchRevision,
      completionTracker,
    );
  }

  private async submissionDomState(
    page: Page,
    cache?: ChatGptSubmissionDomCache,
    signal?: AbortSignal,
  ): Promise<ChatGptSubmissionDomState> {
    return SubmissionObserver.prototype.submissionDomState.call(
      this as unknown as ChatGptSubmissionObserverHost,
      page,
      cache,
      signal,
    );
  }

  private async currentSubmissionEvidence(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    signal?: AbortSignal,
  ): Promise<ChatGptSubmissionEvidence | undefined> {
    return SubmissionObserver.prototype.currentSubmissionEvidence.call(
      this as unknown as ChatGptSubmissionObserverHost,
      page,
      baseline,
      signal,
    );
  }

  private async currentSubmissionAnswerText(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    signal?: AbortSignal,
  ): Promise<string> {
    return SubmissionObserver.prototype.currentSubmissionAnswerText.call(
      this as unknown as ChatGptSubmissionObserverHost,
      page,
      baseline,
      signal,
    );
  }

  private async captureSubmissionBaseline(page: Page, submittedText?: string): Promise<ChatGptSubmissionBaseline> {
    return SubmissionObserver.prototype.captureSubmissionBaseline.call(
      this as unknown as ChatGptSubmissionObserverHost,
      page,
      submittedText,
    );
  }

  private async waitForNewAssistantTurn(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    deadline: number | undefined,
    signal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    graceMs: number = CHATGPT_RESPONSE_DOM_GRACE_MS,
    completionTracker?: ChatGptCompletionTracker,
    recoverObservation?: ChatGptObservationRecovery,
    turnEvents?: ChatGptTurnEventBus,
  ): Promise<ChatGptAssistantTurnBinding> {
    return TurnDiagnostics.prototype.waitForNewAssistantTurn.call(
      this as unknown as ChatGptTurnDiagnosticsHost,
      page,
      baseline,
      deadline,
      signal,
      externalProgress,
      graceMs,
      completionTracker,
      recoverObservation,
      turnEvents,
    );
  }

  private async reconcileAssistantTurnBinding(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    binding: ChatGptAssistantTurnBinding,
    signal?: AbortSignal,
  ): Promise<ChatGptAssistantTurnBinding> {
    return TurnDiagnostics.prototype.reconcileAssistantTurnBinding.call(
      this as unknown as ChatGptTurnDiagnosticsHost,
      page,
      baseline,
      binding,
      signal,
    );
  }

  private async attachedPromptText(page: Page, abortSignal?: AbortSignal): Promise<string> {
    const composer = await this.activeComposer(page, 30_000, abortSignal);
    return composer.evaluate(
      (element, appName) => {
        const clone = element.cloneNode(true) as HTMLElement;
        for (const br of Array.from(clone.querySelectorAll("br"))) {
          if (br.previousSibling || br.nextSibling) {
            if (typeof br.replaceWith === "function") {
              br.replaceWith("\n");
            } else if (br.parentNode) {
              br.parentNode.replaceChild(
                clone.ownerDocument?.createTextNode("\n") ?? document.createTextNode("\n"),
                br,
              );
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
      this.config?.appName,
      { timeout: 20_000, signal: abortSignal },
    );
  }

  private async assertPromptAttached(page: Page, prompt: string, abortSignal?: AbortSignal): Promise<void> {
    return ComposerController.prototype.assertPromptAttached.call(
      this as unknown as ChatGptComposerControllerHost,
      page,
      prompt,
      abortSignal,
    );
  }

  private selectedConnectorControl(composer: Locator): Locator {
    return ComposerController.prototype.selectedConnectorControl.call(
      this as unknown as ChatGptComposerControllerHost,
      composer,
    );
  }

  private async connectorIsSelected(composer: Locator, abortSignal?: AbortSignal): Promise<boolean> {
    return ComposerController.prototype.connectorIsSelected.call(
      this as unknown as ChatGptComposerControllerHost,
      composer,
      abortSignal,
    );
  }

  private async connectorMentionRowTitles(menuRows: Locator, abortSignal?: AbortSignal): Promise<string[]> {
    return ComposerController.prototype.connectorMentionRowTitles.call(
      this as unknown as ChatGptComposerControllerHost,
      menuRows,
      abortSignal,
    );
  }

  private async connectorMentionFailure(
    menuRows: Locator,
    triggerAttempts: number,
    abortSignal?: AbortSignal,
    page?: Page,
  ): Promise<string> {
    return ComposerController.prototype.connectorMentionFailure.call(
      this as unknown as ChatGptComposerControllerHost,
      menuRows,
      triggerAttempts,
      abortSignal,
      page,
    );
  }

  private async clearChatGptComposerState(page: Page): Promise<void> {
    return ComposerController.prototype.clearChatGptComposerState.call(
      this as unknown as ChatGptComposerControllerHost,
      page,
    );
  }

  private async selectConnector(
    page: Page,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    catalogRefreshAvailable = false,
    attemptBudget: ChatGptConnectorAttemptBudget = { triggerAttempts: 0 },
    abortSignal?: AbortSignal,
    hasExistingTurns = false,
    turnEvents?: ChatGptTurnEventBus,
  ): Promise<Locator> {
    return ComposerController.prototype.selectConnector.call(
      this as unknown as ChatGptComposerControllerHost,
      page,
      captureDiagnostic,
      catalogRefreshAvailable,
      attemptBudget,
      abortSignal,
      hasExistingTurns,
      turnEvents,
    );
  }

  private async attachPrompt(
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
    return ComposerController.prototype.attachPrompt.call(
      this as unknown as ChatGptComposerControllerHost,
      page,
      prompt,
      localTools,
      captureDiagnostic,
      abortSignal,
      catalogRefreshAvailable,
      connectorAttemptBudget,
      reuseConnector,
      requireThink,
      turnEvents,
    );
  }

  private async waitForSubmissionAcceptedWithRecovery(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    abortSignal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    initialToolBatchRevision = externalProgress?.snapshot().lastToolBatchRevision ?? 0,
    completionTracker?: ChatGptCompletionTracker,
    recoverObservation?: ChatGptObservationRecovery,
  ): Promise<ChatGptSubmissionEvidence> {
    return TurnDiagnostics.prototype.waitForSubmissionAcceptedWithRecovery.call(
      this as unknown as ChatGptTurnDiagnosticsHost,
      page,
      baseline,
      abortSignal,
      externalProgress,
      initialToolBatchRevision,
      completionTracker,
      recoverObservation,
    );
  }

  private async sendAttachedPrompt(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    abortSignal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    submissionLifecycle?: Pick<BrowserTurn, "onSendActivated" | "onSubmitted">,
    completionTracker?: ChatGptCompletionTracker,
    recoverObservation?: ChatGptObservationRecovery,
    requireConnector = false,
    onPhysicalSendComplete?: () => void,
  ): Promise<ChatGptSubmissionEvidence> {
    const composer = await this.activeComposer(page);
    const composerForm = composer.locator("xpath=ancestor::form[1]");
    const sendButton =
      (typeof composerForm.locator === "function"
        ? composerForm
            .locator(
              '[data-testid="send-button"], button[type="submit"]:not([aria-haspopup="menu"]), button[aria-label*="Enviar" i], button[aria-label*="Send" i]',
            )
            .first()
        : undefined) ?? composerForm.getByTestId("send-button");
    await sendButton.waitFor({ state: "visible", timeout: browserStageTimeouts.send });
    await waitForChatGptDomSettle(page, { signal: abortSignal, horizonMs: 250 });
    const sendEnableDeadline = Date.now() + CHATGPT_SEND_ENABLE_GRACE_MS;
    let sendDomKey: string | undefined;
    for (;;) {
      if (abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      if (page.isClosed()) throw chatGptBrowserTabClosedError();
      await throwIfChatGptSessionFailureAlert(page);
      await throwIfChatGptRateLimitDialog(page);
      if (await sendButton.isEnabled()) break;
      if (Date.now() >= sendEnableDeadline) {
        await captureDiagnostic?.("send-disabled");
        throw new Error("ChatGPT send button remained disabled after the complete prompt was attached");
      }
      // React enables the submit control asynchronously; wake on the next qualifying mutation
      // (disabled/aria-disabled are revision attributes) instead of re-checking on a fixed beat.
      const verdict = await waitForChatGptDomRevision(page, {
        afterKey: sendDomKey,
        settleMs: 150,
        horizonMs: 250,
        signal: abortSignal,
      });
      sendDomKey = verdict.key;
    }
    await captureDiagnostic?.("send-ready");
    if (requireConnector && typeof this.connectorIsSelected === "function") {
      const selected = await this.connectorIsSelected(composer, abortSignal);
      if (!selected) {
        throw new ChatGptPromptAttachmentIntegrityError(
          `ChatGPT connector ${JSON.stringify(this.config?.appName ?? CHATGPT_CONNECTOR_NAME)} was detached before prompt submission`,
        );
      }
    }
    const initialToolBatchRevision = externalProgress?.snapshot().lastToolBatchRevision ?? 0;
    await submissionLifecycle?.onSendActivated?.();
    try {
      await sendButton.press("Enter", {
        noWaitAfter: true,
        signal: abortSignal,
        // runStage owns the operation budget. A second Locator timeout would silently collapse the
        // 180-second Bigger Context budget back to the ordinary 20 seconds after Enter has already
        // submitted the message; semantic submission evidence below remains the authority.
        timeout: 0,
      });
    } finally {
      onPhysicalSendComplete?.();
    }
    const evidence = await this.waitForSubmissionAcceptedWithRecovery(
      page,
      baseline,
      abortSignal,
      externalProgress,
      initialToolBatchRevision,
      completionTracker,
      recoverObservation,
    );
    await submissionLifecycle?.onSubmitted?.();
    return evidence;
  }

  private async waitForMultipartAcknowledgement(
    page: Page,
    initialResponseTurn: ChatGptAssistantTurnBinding,
    submissionBaseline: ChatGptSubmissionBaseline,
    stage: ChatGptWebMultipartStage,
    deadline: number | undefined,
    abortSignal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    completionTracker = new ChatGptCompletionTracker(),
  ): Promise<void> {
    // A staged message may briefly create an assistant shell and then replace it while ChatGPT
    // ingests the attached context. The ordinary 60-second missing-response verdict would cut the
    // dedicated multipart acknowledgement budget back down after that transient shell appears.
    // Keep DOM absence bounded by the same per-stage budget that owns this protocol step.
    const domHealthTracker = new ChatGptTurnDomHealthTracker(CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS);
    const responseDomCache: ChatGptResponseDomCache = {};
    let responseTurn = initialResponseTurn;
    for (;;) {
      if (page.isClosed()) throw chatGptBrowserTabClosedError();
      if (abortSignal?.aborted) {
        const stop = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last();
        if (await stop.isVisible().catch(() => false)) await stop.press("Enter").catch(() => {});
        throw new DOMException("ChatGPT multipart stage aborted", "AbortError");
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new Error("ChatGPT Bigger Context transaction timed out while awaiting a stage acknowledgement");
      }
      await throwIfChatGptSessionFailureAlert(page);
      await throwIfChatGptTerminalErrorAlert(responseTurn.locator);
      let snapshot = await this.responseDomSnapshot(responseTurn.locator, responseDomCache);
      if (!snapshot.responsePresent && (await responseTurn.locator.count()) !== 1) {
        const rebound = await this.reconcileAssistantTurnBinding(page, submissionBaseline, responseTurn, abortSignal);
        if (rebound.identity !== responseTurn.identity) {
          responseTurn = rebound;
          responseDomCache.key = undefined;
          responseDomCache.snapshot = undefined;
          snapshot = await this.responseDomSnapshot(responseTurn.locator, responseDomCache);
        }
      }
      if (snapshot.stoppedThinkingVisible) throw chatGptStoppedThinkingError();
      const externalProgressSnapshot = externalProgress?.snapshot();
      if (
        externalProgress &&
        externalProgressSnapshot &&
        completionTracker.needsToolBatchObservation(externalProgressSnapshot.lastToolBatchRevision)
      ) {
        completionTracker.observeToolBatch(externalProgressSnapshot.lastToolBatchRevision, snapshot.visibleText);
        await externalProgress.acknowledgeToolBatch(externalProgressSnapshot.lastToolBatchRevision);
      }
      const externalProgressLive = chatGptExternalProgressSuppressesDomHealth(externalProgressSnapshot, Date.now());
      const externalToolCallsInFlight = chatGptExternalToolCallsAreInFlight(externalProgressSnapshot);
      if (!snapshot.responsePresent && externalProgressLive) {
        // Proven MCP activity outranks a momentarily unavailable staging DOM, exactly as it does
        // in the main turn loop.
        domHealthTracker.clearMissingResponse();
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
        continue;
      }
      const running = await page
        .locator(CHATGPT_STOP_BUTTON_SELECTOR)
        .last()
        .isVisible()
        .catch(() => false);
      const domError = domHealthTracker.update({
        responsePresent: snapshot.responsePresent,
        running,
        currentText: snapshot.visibleText,
        completionActionVisible: snapshot.completionActionVisible,
        externalProgressLive,
      });
      if (domError) throw new Error(domError);
      if (
        completionTracker.update({
          responsePresent: snapshot.responsePresent,
          running,
          currentText: snapshot.visibleText,
          currentHtml: snapshot.fullHtml,
          completionActionVisible: snapshot.completionActionVisible,
          externalToolCallsInFlight,
        })
      ) {
        const actual = snapshot.visibleText.trim();
        if (actual !== stage.acknowledgement) {
          throw new ChatGptWebAdapterError(
            "ChatGPT did not confirm the Bigger Context handoff. Disable Bigger Context or retry the task.",
            {
              status: 502,
              errorType: "server_error",
              code: "multipart_protocol_violation",
              retryable: false,
              cause: new Error(
                `Bigger Context acknowledgement mismatch (actualChars=${actual.length.toLocaleString("en-US")})`,
              ),
            },
          );
        }
        return;
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
    }
  }

  private async resetCompactionComposerForRetry(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    throwIfPromptAttachmentAborted(abortSignal);
    const before = await this.currentSubmissionEvidence(page, baseline, abortSignal);
    if (before) {
      throw new ChatGptPromptAttachmentIntegrityError(
        "ChatGPT changed while the compaction prompt was being prepared. Check the ChatGPT tab before retrying.",
        new Error(`Submission evidence appeared after prompt attachment failed: ${before}`),
      );
    }

    const composer = await this.activeComposer(page, 30_000, abortSignal);
    await composer.fill("", { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
    await composer.focus({ signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
    await waitForChatGptDomSettle(page, { signal: abortSignal, horizonMs: 250 });
    throwIfPromptAttachmentAborted(abortSignal);

    const after = await this.currentSubmissionEvidence(page, baseline, abortSignal);
    if (after) {
      throw new ChatGptPromptAttachmentIntegrityError(
        "ChatGPT changed while the compaction prompt was being reset. Check the ChatGPT tab before retrying.",
        new Error(`Submission evidence appeared while resetting the prompt: ${after}`),
      );
    }
    const observed = await this.attachedPromptText(page, abortSignal);
    if (observed.length > 0) {
      throw new ChatGptPromptAttachmentIntegrityError(
        `ChatGPT composer could not reset cleanly for compaction retry (actualChars=${observed.length})`,
      );
    }
  }

  private async attachPromptWithCompactionRetry(
    page: Page,
    prompt: string,
    localTools: boolean,
    compaction: boolean,
    baseline: ChatGptSubmissionBaseline,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    abortSignal?: AbortSignal,
    catalogRefreshAvailable = false,
    connectorAttemptBudget?: ChatGptConnectorAttemptBudget,
    reuseConnector = false,
    requireThink = false,
  ): Promise<void> {
    let retryAvailable = compaction;
    for (;;) {
      try {
        await this.attachPrompt(
          page,
          prompt,
          localTools,
          captureDiagnostic,
          abortSignal,
          catalogRefreshAvailable,
          connectorAttemptBudget,
          reuseConnector,
          requireThink,
        );
        return;
      } catch (error) {
        if (!retryAvailable || !(error instanceof ChatGptPromptAttachmentIntegrityError)) throw error;
        retryAvailable = false;
        const evidence = await this.currentSubmissionEvidence(page, baseline, abortSignal);
        if (evidence) {
          throw new ChatGptPromptAttachmentIntegrityError(
            "ChatGPT changed while the compaction prompt was being prepared. Check the ChatGPT tab before retrying.",
            new Error(`Prompt attachment failed before submission evidence appeared: ${evidence}`, { cause: error }),
          );
        }
        await captureDiagnostic?.("prompt-attachment-integrity-retry");
        await this.resetCompactionComposerForRetry(page, baseline, abortSignal);
      }
    }
  }

  private async insertPromptText(page: Page, text: string, abortSignal?: AbortSignal): Promise<void> {
    return ComposerController.prototype.insertPromptText.call(
      this as unknown as ChatGptComposerControllerHost,
      page,
      text,
      abortSignal,
    );
  }

  private async verifyConnectorExclusive(traceId = `verify_${randomUUID().replaceAll("-", "")}`): Promise<string> {
    const page = await this.ensurePage();
    const diagnostics = new ChatGptBrowserDiagnostics(
      traceId,
      this.config.browserDiagnosticsPath ?? join(getConfigDir(), "diagnostics", "browser-turns"),
      this.config.appName,
    );
    const captureDiagnostic = (checkpoint: string): Promise<void> => diagnostics.capture(page, checkpoint);
    try {
      await captureDiagnostic("connector-verification-started");
      await this.prepareChatSurface(page, captureDiagnostic);
      // The launcher refreshes its owned ChatGPT document before starting this helper. A second
      // reload here can discard the first catalog's exact mismatch evidence and report a generic
      // menu failure instead of identifying the connector the account actually exposes.
      await this.selectConnector(page, captureDiagnostic);
      // Verification proves selection but does not submit a turn. Leaving the selected plugin in
      // ChatGPT's persisted composer draft makes the next hard refresh restore half-hydrated plugin
      // state; clearing it through native editor deletion keeps repeated verification transactional.
      await this.clearChatGptComposerState(page);
      await captureDiagnostic("connector-verification-cleared");
      await captureDiagnostic("connector-verification-succeeded");
      return this.config.appName;
    } catch (error) {
      await diagnostics.capture(page, "connector-verification-failed", error);
      throw error;
    }
  }

  private async inspectSessionExclusive(detectCapabilities: boolean): Promise<{
    authenticated: true;
    temporary: true;
    url: string;
    solAvailable?: boolean;
    extraHighAvailable?: boolean;
    proAvailable?: boolean;
  }> {
    const page = await this.ensurePage();
    await this.prepareChatSurface(page);
    const url = page.url();
    if (!detectCapabilities) return { authenticated: true, temporary: true, url };
    const capabilities = await detectChatGptAccountCapabilities(page);
    return { authenticated: true, temporary: true, url, ...capabilities };
  }

  private async smokeTestExclusive(abortSignal?: AbortSignal): Promise<{ effort: string; response: string }> {
    const page = await this.ensurePage();
    await this.prepareChatSurface(page);
    const account = await detectChatGptAccountCapabilities(page);
    // Core smoke runs before the optional MCP connector is configured, so it must remain a
    // browser-only transport check. Connector setup has its own explicit verification operation.
    const capabilities: ChatGptWebCapabilities = { ...account, localToolsEnabled: false };
    const modelId = account.solAvailable ? CHATGPT_WEB_MODEL_ID : CHATGPT_WEB_LUNA_MODEL_ID;
    const reasoning = account.solAvailable ? "high" : "low";
    const mode = resolveChatGptWebModelMode(modelId, reasoning, capabilities);
    const traceId = `smoke_${randomUUID().replaceAll("-", "")}`;
    const response = await this.runBrowserTurn(
      {
        traceId,
        modelId,
        reasoning,
        capabilities,
        prepare: async () => ({ text: CHATGPT_SMOKE_TEXT, images: [], release: () => {} }),
        abortSignal,
        onTextDelta: () => {},
      },
      undefined,
      page,
    );
    if (response.trim() !== CHATGPT_SMOKE_EXPECTED) {
      throw new Error(
        `ChatGPT smoke test returned an unexpected answer (${JSON.stringify(response.trim().slice(0, 200))})`,
      );
    }
    return { effort: mode.displayLabel, response: CHATGPT_SMOKE_EXPECTED };
  }

  private async attachFiles(page: Page, prompt: CompiledChatGptWebPrompt): Promise<void> {
    return ComposerController.prototype.attachFiles.call(
      this as unknown as ChatGptComposerControllerHost,
      page,
      prompt,
    );
  }

  private async responseDomSnapshot(
    responseTurn: Locator,
    cache?: ChatGptResponseDomCache,
  ): Promise<ChatGptResponseDomSnapshot> {
    return ResponseObserver.prototype.responseDomSnapshot.call(
      this as unknown as ChatGptResponseObserverHost,
      responseTurn,
      cache,
    );
  }

  private async stalledTurnDiagnostic(page: Page, responseTurn: Locator): Promise<string> {
    return ResponseObserver.prototype.stalledTurnDiagnostic.call(
      this as unknown as ChatGptResponseObserverHost,
      page,
      responseTurn,
    );
  }

  private async runExclusive(turn: BrowserTurn): Promise<string> {
    if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");

    let interactiveLock: InteractiveBrowserTurnLock | undefined;
    const acquireInteractive = async () => {
      if (interactiveLock) return;
      interactiveLock = await interactiveBrowserTurnMutex.acquire(turn.traceId, turn.abortSignal);
    };
    const releaseInteractive = () => {
      interactiveLock?.release();
      interactiveLock = undefined;
    };

    if (this.config.browserHost !== "launcher") {
      try {
        const answer = await this.runBrowserTurn(
          turn,
          undefined,
          undefined,
          false,
          false,
          releaseInteractive,
          acquireInteractive,
        );
        await turn.onResultReady?.(answer);
        return answer;
      } finally {
        releaseInteractive();
      }
    }

    let surfaceId: string | undefined;
    let surfaceClaimed = false;
    let resultReadyConfirmed = false;
    let reused = false;
    let terminal: "completed" | "failed" | "aborted" = "completed";
    let terminalMessage: string | undefined;
    let originalError: unknown;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatInFlight = false;
    let lastHeartbeatFailureAt = 0;
    try {
      const lease = await notifyLauncherTurn(
        this.config.browserHostDescriptorPath!,
        {
          phase: "start",
          traceId: turn.traceId,
          helperPid: process.pid,
          ...(turn.conversationKey ? { conversationKey: turn.conversationKey } : {}),
          ...(turn.conversationKey &&
          (turn.nativeConnector || turn.capabilities.localToolsEnabled || turn.requireRetainedConversation)
            ? { connectorIdentity: this.config.appName }
            : {}),
          ...(turn.requireRetainedConversation ? { requireRetainedConversation: true } : {}),
          ...(turn.compaction ? { compaction: true } : {}),
        },
        undefined,
        turn.abortSignal,
      ).catch((error) => {
        if (error instanceof LauncherBrowserTurnCancelledError) throw chatGptBrowserTabClosedError();
        if (error instanceof LauncherRetainedConversationUnavailableError) {
          throw chatGptRetainedConversationUnavailableError();
        }
        throw error;
      });
      surfaceId = lease.surfaceId;
      reused = lease.reused === true;
      if (!surfaceId) throw new Error("Launcher did not lease a browser tab for the ChatGPT turn");
      await turn.onSurfaceLeased?.(surfaceId);
      surfaceClaimed = true;
      const sendHeartbeat = () => {
        if (heartbeatInFlight) return;
        heartbeatInFlight = true;
        void notifyLauncherTurn(
          this.config.browserHostDescriptorPath!,
          {
            phase: "heartbeat",
            traceId: turn.traceId,
            helperPid: process.pid,
          },
          LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS,
        )
          .catch((error) => {
            const now = Date.now();
            if (now - lastHeartbeatFailureAt < 30_000) return;
            lastHeartbeatFailureAt = now;
            console.warn(
              `[chatgpt-web] launcher turn heartbeat failed for ${turn.traceId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          })
          .finally(() => {
            heartbeatInFlight = false;
          });
      };
      if (turn.requireRetainedConversation && !reused) {
        throw chatGptRetainedConversationUnavailableError();
      }
      if (reused && !turn.prepareResume) {
        throw new Error("Launcher reused a ChatGPT conversation without a continuation prompt");
      }
      await turn.onPreparedSelected?.(reused);
      heartbeatTimer = setInterval(sendHeartbeat, LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref?.();
      const answer = await this.runBrowserTurn(
        turn,
        surfaceId,
        undefined,
        reused,
        lease.trackUsage === true,
        releaseInteractive,
        acquireInteractive,
      );
      await turn.onResultReady?.(answer);
      resultReadyConfirmed = turn.onResultReady !== undefined;
      return answer;
    } catch (error) {
      originalError = error;
      terminal =
        error instanceof ChatGptCompactionHandoffAccepted
          ? "completed"
          : (error instanceof DOMException && error.name === "AbortError") ||
              (error instanceof ChatGptWebAdapterError && error.code === "client_cancelled")
            ? "aborted"
            : "failed";
      terminalMessage = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      throw error;
    } finally {
      releaseInteractive();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (surfaceId) {
        try {
          const release = await notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
            phase: "end",
            traceId: turn.traceId,
            helperPid: process.pid,
            status: terminal,
            ...(terminalMessage ? { message: terminalMessage } : {}),
            ...(terminal === "completed" && turn.retainConversation ? { retain: true } : {}),
            ...(resultReadyConfirmed ? { resultPersisted: true } : {}),
            ...(terminal === "completed" && (turn.nativeConnector || turn.capabilities.localToolsEnabled)
              ? { connectorBound: true }
              : {}),
          });
          if (surfaceClaimed && !(terminal === "completed" && turn.retainConversation && turn.conversationKey)) {
            await turn.onSurfaceReleased?.(surfaceId);
          }
          if (release.cancelledByUser) throw chatGptBrowserTabClosedError();
        } catch (controlError) {
          if (controlError instanceof ChatGptWebAdapterError && controlError.code === "client_cancelled") {
            throw controlError;
          }
          if (!originalError) throw controlError;
          console.error(
            `[chatgpt-web] launcher turn-end notification failed after browser error: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
          );
        }
      }
    }
  }

  private async runBrowserTurn(
    turn: BrowserTurn,
    launcherSurfaceId?: string,
    maintenancePage?: Page,
    reuseConversation = false,
    trackUsage = false,
    onInteractiveSettled?: () => void,
    acquireInteractive?: () => Promise<void>,
  ): Promise<string> {
    if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    if ((turn.externalProgress !== undefined) !== (turn.completionFence !== undefined)) {
      throw new Error("Tool-capable ChatGPT turns require both progress and terminal-fence transports");
    }
    if ((turn.captureLunaCheckpoint === true) !== (turn.onLunaCheckpoint !== undefined)) {
      throw new Error("ChatGPT Luna checkpoint capture requires exactly one checkpoint callback");
    }
    if (turn.captureLunaCheckpoint && turn.modelId !== CHATGPT_WEB_LUNA_MODEL_ID) {
      throw new Error("Private rolling checkpoint capture is valid only for ChatGPT Luna");
    }
    const browserCapabilities = turn.nativeConnector
      ? { ...turn.capabilities, localToolsEnabled: true }
      : turn.capabilities;
    const requestedMode = resolveChatGptWebModelMode(turn.modelId, turn.reasoning, browserCapabilities);
    const prepare = reuseConversation ? turn.prepareResume : turn.prepare;
    if (!prepare) throw new Error("The retained ChatGPT conversation has no continuation prompt");
    const prepared = await prepare();
    const diagnostics = new ChatGptBrowserDiagnostics(
      turn.traceId,
      this.config.browserDiagnosticsPath ?? join(getConfigDir(), "diagnostics", "browser-turns"),
      this.config.appName,
    );
    let turnConnection: Browser | undefined;
    let managedPage: Page | undefined;
    let diagnosticPage: Page | undefined;
    const usageWrites: Promise<void>[] = [];
    const submissionRejection = new ChatGptSubmissionRejectionObserver();
    const turnEvents = new ChatGptTurnEventBus({
      sessionId: turn.conversationKey,
      surfaceId: launcherSurfaceId,
      turnId: turn.traceId,
    });
    if (!this.turnEventBuses) {
      this.turnEventBuses = new Map();
    }
    this.turnEventBuses.set(turn.traceId, turnEvents);
    while ((this.turnEventBuses?.size ?? 0) > 8) {
      const oldest = this.turnEventBuses!.keys().next().value;
      if (oldest === undefined || oldest === turn.traceId) break;
      this.turnEventBuses!.delete(oldest);
    }
    let onNetworkResponse: ((response: { url(): string; status(): number }) => void) | undefined;
    try {
      if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      // Validate only the selected physical message, not canonical history used for usage estimates.
      assertChatGptPromptAttachments(prepared);
      const multipartTransactionId = prepared.multipart ? `ctx_${randomUUID().replaceAll("-", "")}` : undefined;
      const multipartStages =
        prepared.multipart && multipartTransactionId
          ? prepared.multipart.parts
              .slice(0, -1)
              .map((payload, index) =>
                formatChatGptWebMultipartStage(
                  payload,
                  multipartTransactionId,
                  index + 1,
                  prepared.multipart!.parts.length,
                ),
              )
          : undefined;
      const multipartFinalPrompt =
        prepared.multipart && multipartTransactionId
          ? formatChatGptWebMultipartCommit(prepared.multipart, multipartTransactionId)
          : undefined;
      const selectedMessages =
        multipartStages && multipartFinalPrompt
          ? [...multipartStages.map((stage) => stage.text), multipartFinalPrompt]
          : [prepared.text];
      const browserPayload = measureCompiledBrowserPayload(prepared, turn.modelId, selectedMessages);
      const {
        inputTokens: estimatedInputTokens,
        maxMessageTokens: estimatedMessageTokens,
        maxMessageChars,
      } = measureCompiledChatGptWebInput(prepared, turn.modelId, browserPayload);
      const maxStageMessageTokens = multipartStages
        ? Math.max(...multipartStages.map((stage) => estimateTokens(stage.text, turn.modelId)))
        : undefined;
      const maxStageChars = multipartStages
        ? Math.max(...multipartStages.map((stage) => stage.text.length))
        : undefined;
      const stagingMode = multipartStages
        ? resolveChatGptWebMultipartStagingMode(
            turn.modelId,
            browserCapabilities,
            maxStageMessageTokens!,
            maxStageChars!,
          )
        : requestedMode;
      if (prepared.multipart) {
        assertChatGptWebMultipartInputWithinLimits(
          estimatedInputTokens,
          estimatedMessageTokens,
          turn.modelId,
          requestedMode.effort,
          browserCapabilities,
          maxMessageChars,
          prepared.multipart.parts.length,
          multipartStages && multipartFinalPrompt && maxStageMessageTokens !== undefined && maxStageChars !== undefined
            ? {
                stagingEffort: stagingMode.effort,
                maxStageMessageTokens,
                maxStageChars,
                finalMessageTokens:
                  estimateTokens(multipartFinalPrompt, turn.modelId) +
                  skillFileTokens(prepared.skillFiles, turn.modelId),
                finalMessageChars: multipartFinalPrompt.length,
                finalImageTokens: estimateChatGptWebImageTokens(prepared),
                isCompaction: turn.compaction === true,
              }
            : undefined,
          turn.compaction === true,
        );
      } else {
        assertChatGptWebInputWithinLimits(
          estimatedInputTokens,
          estimatedMessageTokens,
          turn.modelId,
          requestedMode.effort,
          browserCapabilities,
          maxMessageChars,
        );
      }
      // The provider exposes no token-cache read/write accounting through this browser surface.
      // Record only the selected physical payload, and only once the respective Send is accepted.
      const recordAcceptedPayload = createBrowserPayloadAcceptanceRecorder(
        browserPayload,
        {
          retainedConversation: reuseConversation,
          compaction: turn.compaction === true,
        },
        (metric) => {
          console.info(`[chatgpt-web] browser turn ${turn.traceId} accepted_payload=${JSON.stringify(metric)}`);
        },
      );
      const deadline = this.config.turnTimeoutMs === undefined ? undefined : Date.now() + this.config.turnTimeoutMs;
      let page = await this.runStage(
        turn.traceId,
        "browser_page",
        browserStageTimeouts.browserPage,
        async (abortSignal) => {
          if (maintenancePage) return maintenancePage;
          if (!launcherSurfaceId) {
            const managed = await this.pageForNewTurn();
            if (abortSignal.aborted) {
              await managed.close().catch(() => {});
              throw new DOMException("ChatGPT browser page acquisition aborted", "AbortError");
            }
            return managed;
          }
          const connection = await connectLauncherBrowserHost(
            this.config.browserHostDescriptorPath!,
            browserStageTimeouts.browserPage,
            launcherSurfaceId,
            abortSignal,
          );
          if (abortSignal.aborted) {
            await connection.browser.close().catch(() => {});
            throw new DOMException("ChatGPT browser page acquisition aborted", "AbortError");
          }
          turnConnection = connection.browser;
          await waitForOperationalChatGptViewport(connection.page, abortSignal);
          return connection.page;
        },
      );
      if (!maintenancePage && !launcherSurfaceId) managedPage = page;
      diagnosticPage = page;
      onNetworkResponse = (response: { url(): string; status(): number }) => {
        try {
          if (response.url().includes("/backend-api/")) {
            turnEvents.publish({
              type: "network_submission_observed",
              source: "network",
              status: response.status(),
            });
          }
        } catch {}
      };
      if (typeof page?.on === "function") {
        page.on("response", onNetworkResponse);
      }
      const contextPressure = this.getContextPressure(page, turn.conversationKey);
      const rebindLauncherPage = async (attempt: number, cause: Error, callerSignal?: AbortSignal): Promise<void> => {
        if (!launcherSurfaceId || !this.config.browserHostDescriptorPath) throw cause;
        console.warn(
          `[chatgpt-web] browser turn ${turn.traceId} is rebinding its existing launcher page after a stalled DOM probe:` +
            ` ${redactChatGptUiDiagnostic(cause.message)}`,
        );
        const previousConnection = turnConnection;
        // The observation timeout races the Playwright operation but cannot cancel the underlying
        // page.evaluate by itself. A failed disconnect is terminal: opening a replacement while
        // the stale probe still owns its transport would recreate the contention this rebind is
        // meant to remove.
        const connection = await connectAfterClosingBrowserConnection(previousConnection, () => {
          turnConnection = undefined;
          return this.runStage(
            turn.traceId,
            `response_page_rebind_${attempt}`,
            browserStageTimeouts.browserPage,
            async (stageSignal) => {
              const signal = callerSignal
                ? AbortSignal.any([stageSignal, callerSignal])
                : turn.abortSignal
                  ? AbortSignal.any([stageSignal, turn.abortSignal])
                  : stageSignal;
              await notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
                phase: "heartbeat",
                traceId: turn.traceId,
                helperPid: process.pid,
                refreshViewport: true,
              });
              const rebound = await connectLauncherBrowserHost(
                this.config.browserHostDescriptorPath!,
                browserStageTimeouts.browserPage,
                launcherSurfaceId,
                signal,
              );
              // Own the connection before validating its page: viewport failure still needs
              // the outer diagnostic capture and finally block to release this exact transport.
              turnConnection = rebound.browser;
              diagnosticPage = rebound.page;
              await waitForOperationalChatGptViewport(rebound.page, signal);
              return rebound;
            },
          );
        });
        turnConnection = connection.browser;
        page = connection.page;
        diagnosticPage = page;
        this.contextPressureByPage.set(page, contextPressure);
        console.warn(
          `[chatgpt-web] browser turn ${turn.traceId} rebound its existing launcher page after a stalled DOM probe`,
        );
      };
      const recoverPageObservation = async (
        attempt: number,
        cause: ChatGptBrowserObservationTimeoutError,
        baseline: ChatGptSubmissionBaseline,
        checkpoint: "submission-page-rebound" | "assistant-page-rebound",
        abortSignal?: AbortSignal,
      ): Promise<ChatGptSubmissionObservationRecovery> => {
        await rebindLauncherPage(attempt, cause, abortSignal);
        const reboundBaseline: ChatGptSubmissionBaseline = {
          ...baseline,
          userTurns: page.locator(CHATGPT_USER_TURN_SELECTOR),
          responseTurns: page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR),
          domCache: {},
        };
        await diagnostics.capture(page, checkpoint);
        return { page, baseline: reboundBaseline };
      };
      const recoverSubmissionObservation: ChatGptObservationRecovery = (attempt, cause, baseline, abortSignal) =>
        recoverPageObservation(attempt, cause, baseline, "submission-page-rebound", abortSignal);
      const recoverAssistantObservation: ChatGptObservationRecovery = (attempt, cause, baseline, abortSignal) =>
        recoverPageObservation(attempt, cause, baseline, "assistant-page-rebound", abortSignal);
      // Rebinding the exact leased page is a browser-ownership operation. Read-only
      // compaction needs it too; acquiring MCP tools is not a prerequisite.
      const launcherObservationRecovery =
        launcherSurfaceId !== undefined && this.config.browserHostDescriptorPath !== undefined;
      await diagnostics.capture(page, "browser-page-acquired");
      const pressureProbeStarted = performance.now();
      const observedDomChars = await withChatGptBrowserObservationTimeout(
        withBrowserTurnAbort(
          page.evaluate(() => document.documentElement?.innerHTML.length ?? 0),
          turn.abortSignal,
        ),
      );
      if (typeof observedDomChars === "number") {
        contextPressure.recordObservation({
          domChars: observedDomChars,
          elapsedMs: performance.now() - pressureProbeStarted,
        });
        if (contextPressure.snapshot().watchDomSize) {
          console.info(`[chatgpt-web] browser turn ${turn.traceId} large_dom_watch chars=${observedDomChars}`);
        }
      }
      if (!turn.compaction && contextPressure.snapshot().recoveryRequired) {
        contextPressure.recordRecovery();
        if (launcherObservationRecovery) {
          await rebindLauncherPage(1, new Error("Repeated slow DOM observations"));
        } else {
          await withBrowserTurnAbort(page.reload({ waitUntil: "domcontentloaded", timeout: 10_000 }), turn.abortSignal);
        }
        const recoveredProbeStarted = performance.now();
        const recoveredDomChars = await withChatGptBrowserObservationTimeout(
          withBrowserTurnAbort(
            page.evaluate(() => document.documentElement?.innerHTML.length ?? 0),
            turn.abortSignal,
          ),
        );
        if (typeof recoveredDomChars === "number") {
          contextPressure.recordObservation({
            domChars: recoveredDomChars,
            elapsedMs: performance.now() - recoveredProbeStarted,
          });
        }
      }
      if (!turn.compaction && turn.pendingMissionRequirements && contextPressure.snapshot().compactionRequired) {
        throw chatGptContextCompactionRequiredError("ChatGPT page observation remains slow after same-page recovery.");
      }
      console.info(
        `[chatgpt-web] browser turn ${turn.traceId} opened (transport=${prepared.multipart ? `multipart-${prepared.multipart.parts.length}` : "inline"}, maxMessageChars=${maxMessageChars}, estimatedInputTokens=${estimatedInputTokens}, images=${prepared.images.length}, compactionTrimmedMessages=${prepared.trimmedCompactionMessages ?? 0})`,
      );
      if (multipartStages) {
        console.info(
          `[chatgpt-web] browser turn ${turn.traceId} multipart staging effort=${stagingMode.effort}` +
            ` maxStageMessageTokens=${maxStageMessageTokens} maxStageChars=${maxStageChars}`,
        );
      }
      await acquireInteractive?.();
      if (!reuseConversation) {
        await this.runStage(
          turn.traceId,
          "temporary_chat_preparation",
          browserStageTimeouts.temporaryChatPreparation,
          () =>
            this.prepareChatSurface(
              page,
              (checkpoint) => diagnostics.capture(page, checkpoint),
              this.config.useSavedChats,
            ),
        );
      }
      // A retained lease proves the connector binding, not the current model selection.
      // Reconcile the live control before every submission, including retained continuations.
      const selectStagingMode = () =>
        this.selectModelAndEffort(
          page,
          turn.modelId,
          stagingMode.effort,
          browserCapabilities,
          (checkpoint) => diagnostics.capture(page, checkpoint),
          trackUsage,
          turn.modelFamily,
        );
      let mode = await this.runStage(
        turn.traceId,
        "effort_selection",
        browserStageTimeouts.effortSelection,
        selectStagingMode,
      );
      await diagnostics.capture(page, "effort-selection-complete");

      // One receipt per physical Send, not per native tool call or stream attachment.
      // The ID survives observation recovery; a new actual Send receives a new ID.
      const usageSubmission = async () => {
        if (!trackUsage) return undefined;
        const id = randomUUID();
        let accountKey: string | undefined;
        try {
          const account = await readChatGptUsageAccount(page);
          if (supportsChatGptUsageTracking(account)) accountKey = account.accountKey;
        } catch {
          // A missing identity is reported as a tracking gap, never charged to the previous account.
        }
        const model = mode.usageModel ?? (mode.effort === "max" ? "pro-unknown" : "other");
        return () => {
          // Do not spend the Send observation deadline waiting for optional local accounting.
          // Drain these bounded writes before releasing this turn's launcher lease.
          const write = notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
            phase: "usage",
            traceId: turn.traceId,
            helperPid: process.pid,
            ...(accountKey
              ? { receipt: { id, accountKey, model, at: Date.now() } }
              : { trackingError: "account-unavailable" as const }),
          }).then(
            () => {},
            () => {
              // Approximate accounting must not turn an already accepted model message into a retry.
              console.warn(`[chatgpt-web] Limits could not persist a submission receipt for ${turn.traceId}`);
            },
          );
          usageWrites.push(write);
        };
      };

      let finalPrompt = prepared.text;
      if (prepared.multipart && multipartStages && multipartTransactionId && multipartFinalPrompt) {
        for (let index = 0; index < multipartStages.length; index += 1) {
          const stage = multipartStages[index]!;
          if (index > 0) await acquireInteractive?.();
          // Each acknowledgement can replace the picker controls. Establish a fresh model/effort
          // proof for the next physical submission, retaining family selection and usage evidence.
          if (index > 0)
            mode = await this.runStage(
              turn.traceId,
              `multipart_stage_${index + 1}_effort_selection`,
              browserStageTimeouts.effortSelection,
              selectStagingMode,
            );
          let stageBaseline = await this.captureSubmissionBaseline(page, stage.text);
          await this.runStage(
            turn.traceId,
            `multipart_stage_${index + 1}_attachment`,
            browserStageTimeouts.promptAttachment,
            (stageSignal) =>
              this.attachPrompt(
                page,
                stage.text,
                false,
                (checkpoint) => diagnostics.capture(page, `multipart-${index + 1}-${checkpoint}`),
                turn.abortSignal ? AbortSignal.any([stageSignal, turn.abortSignal]) : stageSignal,
              ),
            chatGptSuspensionClock,
            true,
          );
          await diagnostics.capture(page, `multipart-stage-${index + 1}-attachment-complete`);
          const recordStageUsage = await usageSubmission();
          const stageSendPreparedAt = performance.now();
          let stageSendActivatedAt: number | undefined;
          console.info(`[chatgpt-web] browser turn ${turn.traceId} multipart_stage=${index + 1} send_phase=prepared`);
          const evidence = await this.runStage(
            turn.traceId,
            `multipart_stage_${index + 1}_send`,
            browserStageTimeouts.multipartStageSend,
            (stageSignal) =>
              this.sendAttachedPrompt(
                page,
                stageBaseline,
                (checkpoint) => diagnostics.capture(page, `multipart-${index + 1}-${checkpoint}`),
                turn.abortSignal ? AbortSignal.any([stageSignal, turn.abortSignal]) : stageSignal,
                undefined,
                {
                  onSubmitted: async () => {
                    recordStageUsage?.();
                    recordAcceptedPayload(index);
                    await turn.onSubmitted?.();
                  },
                  onSendActivated: async () => {
                    await this.assertSelectedEffort(page, mode);
                    submissionRejection.begin(page);
                    stageSendActivatedAt = performance.now();
                    console.info(
                      `[chatgpt-web] browser turn ${turn.traceId} multipart_stage=${index + 1} send_phase=activated readyWaitMs=${Math.round(stageSendActivatedAt - stageSendPreparedAt)}`,
                    );
                    await turn.onSendActivated?.();
                  },
                },
                undefined,
                launcherObservationRecovery
                  ? async (...args) => {
                      const recovered = await recoverSubmissionObservation(...args);
                      stageBaseline = recovered.baseline;
                      return recovered;
                    }
                  : undefined,
                false,
                onInteractiveSettled,
              ),
          );
          console.info(
            `[chatgpt-web] browser turn ${turn.traceId} multipart_stage=${index + 1} send_phase=accepted activationMs=${stageSendActivatedAt === undefined ? "unobserved" : Math.round(performance.now() - stageSendActivatedAt)}`,
          );
          console.info(
            `[chatgpt-web] browser turn ${turn.traceId} multipart part ${index + 1}/${prepared.multipart.parts.length} submission accepted evidence=${evidence}`,
          );
          await this.runStage(
            turn.traceId,
            `multipart_stage_${index + 1}_acknowledgement`,
            browserStageTimeouts.multipartStageAcknowledgement,
            async (stageSignal) => {
              const acknowledgementSignal = turn.abortSignal
                ? AbortSignal.any([stageSignal, turn.abortSignal])
                : stageSignal;
              const responseTurn = await this.waitForNewAssistantTurn(
                page,
                stageBaseline,
                deadline,
                acknowledgementSignal,
                // A part still being ingested has produced no MCP activity, so there is no progress
                // to consult here; the dedicated acknowledgement stage owns this wait.
                undefined,
                CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS,
                undefined,
                launcherObservationRecovery
                  ? async (...args) => {
                      const recovered = await recoverAssistantObservation(...args);
                      stageBaseline = recovered.baseline;
                      return recovered;
                    }
                  : undefined,
                turnEvents,
              );
              await this.waitForMultipartAcknowledgement(
                page,
                responseTurn,
                stageBaseline,
                stage,
                deadline,
                acknowledgementSignal,
                turn.externalProgress,
              );
            },
            chatGptSuspensionClock,
          );
          const stageRejection = await submissionRejection.failure();
          if (stageRejection) throw stageRejection;
          await diagnostics.capture(page, `multipart-stage-${index + 1}-acknowledged`);
          await turn.onMultipartStageAcknowledged?.(index + 1);
        }
        await acquireInteractive?.();
        // The first saved message changes / to /c/<id>. Re-prove the selection on
        // that conversation even when staging and final effort are identical.
        if (mode.effort !== requestedMode.effort || (mode.selection && mode.selection.url !== page.url())) {
          mode = await this.runStage(
            turn.traceId,
            "final_part_effort_selection",
            browserStageTimeouts.effortSelection,
            () =>
              this.selectModelAndEffort(
                page,
                turn.modelId,
                requestedMode.effort,
                browserCapabilities,
                (checkpoint) => diagnostics.capture(page, `final-part-${checkpoint}`),
                trackUsage,
                turn.modelFamily,
              ),
          );
          await diagnostics.capture(page, "final-part-effort-selected");
        }
        finalPrompt = multipartFinalPrompt;
      }

      const finalSendPreparationStartedAt = performance.now();
      let submissionBaseline = await this.captureSubmissionBaseline(page, finalPrompt);
      let catalogRefreshAvailable = mode.localTools && !reuseConversation && !prepared.multipart;
      const connectorAttemptBudget: ChatGptConnectorAttemptBudget = { triggerAttempts: 0 };
      for (;;) {
        try {
          await this.runStage(
            turn.traceId,
            "prompt_attachment",
            browserStageTimeouts.promptAttachment,
            (stageSignal) => {
              const promptAbortSignal = turn.abortSignal
                ? AbortSignal.any([stageSignal, turn.abortSignal])
                : stageSignal;
              return this.attachPromptWithCompactionRetry(
                page,
                finalPrompt,
                mode.localTools,
                turn.compaction === true,
                submissionBaseline,
                (checkpoint) => diagnostics.capture(page, checkpoint),
                promptAbortSignal,
                catalogRefreshAvailable,
                connectorAttemptBudget,
                reuseConversation,
                mode.thinkEnabled,
              );
            },
            chatGptSuspensionClock,
            true,
          );
          break;
        } catch (error) {
          if (!(error instanceof ChatGptConnectorCatalogStaleError) || !catalogRefreshAvailable) throw error;
          catalogRefreshAvailable = false;
          await diagnostics.capture(page, "connector-catalog-stale");
          await this.runStage(
            turn.traceId,
            "connector_catalog_refresh",
            browserStageTimeouts.temporaryChatPreparation,
            async () => {
              await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
              await this.prepareChatSurface(
                page,
                (checkpoint) => diagnostics.capture(page, checkpoint),
                this.config.useSavedChats,
              );
              mode = await this.selectModelAndEffort(
                page,
                turn.modelId,
                turn.reasoning,
                turn.capabilities,
                (checkpoint) => diagnostics.capture(page, checkpoint),
                trackUsage,
                turn.modelFamily,
              );
              submissionBaseline = await this.captureSubmissionBaseline(page, finalPrompt);
            },
          );
          await diagnostics.capture(page, "connector-catalog-refreshed");
        }
      }
      await diagnostics.capture(page, "prompt-attachment-complete");
      await this.runStage(turn.traceId, "file_attachment", browserStageTimeouts.fileAttachment, () =>
        this.attachFiles(page, prepared),
      );
      await diagnostics.capture(page, "file-attachment-complete");
      const completionTracker = new ChatGptCompletionTracker();
      const recordFinalUsage = await usageSubmission();
      const finalSendPreparedAt = performance.now();
      let finalSendActivatedAt: number | undefined;
      console.info(
        `[chatgpt-web] browser turn ${turn.traceId} send_phase=prepared preparationMs=${Math.round(finalSendPreparedAt - finalSendPreparationStartedAt)}`,
      );
      const finalSubmissionEvidence = await this.runStage(
        turn.traceId,
        "send",
        // A multipart commit lands on a conversation already carrying every staged part, so it
        // needs the same acceptance headroom the stages themselves get.
        prepared.multipart ? browserStageTimeouts.multipartStageSend : browserStageTimeouts.send,
        (stageSignal) =>
          this.sendAttachedPrompt(
            page,
            submissionBaseline,
            (checkpoint) => diagnostics.capture(page, checkpoint),
            turn.abortSignal ? AbortSignal.any([stageSignal, turn.abortSignal]) : stageSignal,
            turn.externalProgress,
            {
              ...turn,
              onSubmitted: () => {
                recordFinalUsage?.();
                recordAcceptedPayload(browserPayload.messageCount - 1);
                return turn.onSubmitted?.();
              },
              onSendActivated: async () => {
                await this.assertSelectedEffort(page, mode);
                submissionRejection.begin(page);
                finalSendActivatedAt = performance.now();
                console.info(
                  `[chatgpt-web] browser turn ${turn.traceId} send_phase=activated readyWaitMs=${Math.round(finalSendActivatedAt - finalSendPreparedAt)}`,
                );
                await turn.onSendActivated?.();
              },
            },
            completionTracker,
            launcherObservationRecovery
              ? async (...args) => {
                  const recovered = await recoverSubmissionObservation(...args);
                  submissionBaseline = recovered.baseline;
                  return recovered;
                }
              : undefined,
            mode.localTools,
            onInteractiveSettled,
          ),
      );
      console.info(
        `[chatgpt-web] browser turn ${turn.traceId} send_phase=accepted activationMs=${finalSendActivatedAt === undefined ? "unobserved" : Math.round(performance.now() - finalSendActivatedAt)}`,
      );
      console.info(
        `[chatgpt-web] browser turn ${turn.traceId} submission accepted evidence=${finalSubmissionEvidence}`,
      );
      let responseTurn = await this.waitForNewAssistantTurn(
        page,
        submissionBaseline,
        deadline,
        turn.abortSignal,
        turn.externalProgress,
        CHATGPT_RESPONSE_DOM_GRACE_MS,
        completionTracker,
        launcherObservationRecovery
          ? async (...args) => {
              const recovered = await recoverAssistantObservation(...args);
              submissionBaseline = recovered.baseline;
              return recovered;
            }
          : undefined,
        turnEvents,
      );
      await diagnostics.capture(page, "send-accepted");
      onInteractiveSettled?.();

      let lastHeartbeat = 0;
      let finalText = "";
      let sawRunning = false;
      let loggedCompletionWait = false;
      let capturedResponse = false;
      const sentAt = Date.now();
      const visibleTrace = new ChatGptVisibleTraceTracker();
      const markdownBuffer = new ChatGptMarkdownBuffer(undefined, {
        adaptive: true,
        proseStabilityMs: 350,
        toolStabilityMs: 0,
        compactionCheckpoint: turn.compaction === true,
      });
      const checkpointStream = turn.captureLunaCheckpoint ? new ChatGptLunaCheckpointStream() : undefined;
      const emitMarkdownDelta = (delta: string): void => {
        const visible = checkpointStream ? checkpointStream.push(delta) : delta;
        if (visible) turn.onTextDelta(visible);
      };
      const throwMarkdownConsistencyError = (error: unknown): never => {
        if (!(error instanceof ChatGptMarkdownConsistencyError)) throw error;
        if (error.diagnostic) {
          console.error(
            `[chatgpt-web] browser turn ${turn.traceId} Markdown conflict: ${JSON.stringify(error.diagnostic)}`,
          );
        }
        throw new ChatGptWebAdapterError(error.message, {
          status: 502,
          errorType: "server_error",
          code: "browser_stream_inconsistent",
          retryable: false,
        });
      };
      const domHealthTracker = new ChatGptTurnDomHealthTracker();
      const responseDomCache: ChatGptResponseDomCache = {};
      let consecutiveObservationRebinds = 0;
      let internalObservationFaults = 0;
      let observedThisIteration = false;
      let fenceRevision: number | undefined;
      const completionFsm = new ChatGptTurnCompletionFsm({ fenced: turn.completionFence !== undefined });
      let domSignalKey: string | undefined;
      let lastRunning: boolean | undefined;
      let lastCompletionActionVisible: boolean | undefined;
      // The wake between completion iterations: the next DOM mutation or external progress
      // advance, with the horizon bounding how often ceilings are re-checked on a quiet page.
      const waitForTurnSignal = async (): Promise<void> => {
        const previousKey = domSignalKey;
        const progressRev = turn.externalProgress?.snapshot().revision ?? 0;
        domSignalKey = await this.waitForTurnDomRevisionOrExternalProgress(
          page,
          domSignalKey,
          progressRev,
          turn.externalProgress,
          turn.abortSignal,
        );
        const newProgressRev = turn.externalProgress?.snapshot().revision ?? 0;
        if (newProgressRev > progressRev) {
          turnEvents.publish({
            type: "external_progress_advanced",
            source: "external_progress",
            revision: newProgressRev,
          });
        }
        if (domSignalKey !== previousKey) {
          turnEvents.publish({ type: "response_mutated", source: "dom" });
        }
      };
      const recoverStalledResponsePage = async (error: ChatGptBrowserObservationTimeoutError): Promise<void> => {
        if (!launcherSurfaceId) {
          throw new ChatGptWebAdapterError(
            "ChatGPT browser DOM observation timed out and this page has no recovery lease",
            {
              status: 504,
              errorType: "server_error",
              code: "chatgpt_browser_dom_unresponsive",
              retryable: false,
              cause: error,
            },
          );
        }
        consecutiveObservationRebinds += 1;
        if (consecutiveObservationRebinds > MAX_CHATGPT_BROWSER_PAGE_REBINDS) {
          throw new ChatGptWebAdapterError(
            `ChatGPT browser DOM remained unresponsive after ${MAX_CHATGPT_BROWSER_PAGE_REBINDS} same-page rebinds`,
            {
              status: 504,
              errorType: "server_error",
              code: "chatgpt_browser_dom_unresponsive",
              retryable: false,
              cause: error,
            },
          );
        }
        try {
          await rebindLauncherPage(consecutiveObservationRebinds, error, turn.abortSignal);
        } catch (recoveryError) {
          if (turn.abortSignal?.aborted) throw recoveryError;
          throw new ChatGptWebAdapterError("ChatGPT browser page recovery failed after a stalled DOM observation", {
            status: 504,
            errorType: "server_error",
            code: "chatgpt_browser_dom_unresponsive",
            retryable: false,
            cause: recoveryError,
          });
        }
        submissionBaseline = {
          ...submissionBaseline,
          userTurns: page.locator(CHATGPT_USER_TURN_SELECTOR),
          responseTurns: page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR),
          domCache: {},
        };
        responseTurn = {
          ...responseTurn,
          locator: page.locator(chatGptAssistantTurnSelector(responseTurn.identity)),
        };
        responseDomCache.key = undefined;
        responseDomCache.snapshot = undefined;
        await diagnostics.capture(page, "response-page-rebound");
      };
      for (;;) {
        // The heartbeat is a consumer callback, so it stays outside the observation-fault region:
        // a defect in the caller must not be retried as though the page could not be read.
        if (Date.now() - lastHeartbeat >= 10_000) {
          turn.onHeartbeat?.();
          lastHeartbeat = Date.now();
        }
        try {
          observedThisIteration = false;
          if (page.isClosed()) {
            throw chatGptBrowserTabClosedError();
          }
          if (turn.abortSignal?.aborted) {
            const stop = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last();
            if (await stop.isVisible().catch(() => false)) await stop.press("Enter").catch(() => {});
            throw new DOMException("ChatGPT web turn aborted", "AbortError");
          }
          if (deadline !== undefined && Date.now() >= deadline) {
            throw new Error("ChatGPT web turn timed out");
          }
          await throwIfChatGptSessionFailureAlert(page);
          await throwIfChatGptTerminalErrorAlert(responseTurn.locator);

          if (
            mode.localTools &&
            (await resolveChatGptToolConfirmation(
              page,
              this.config.appName,
              this.config.autoApproveToolCalls,
              turn.abortSignal,
              CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS,
              () => diagnostics.capture(page, "tool-confirmation-visible"),
            ))
          ) {
            internalObservationFaults = 0;
            // The dialog just resolved; let its React teardown settle before re-observing.
            await waitForChatGptDomSettle(page, { signal: turn.abortSignal });
            turnEvents.publish({ type: "dom_settled", source: "dom" });
            continue;
          }

          const responseProbeTimeoutMs = (turn.externalProgress?.snapshot().activeToolCalls ?? 0) > 0 ? 3_000 : 6_000;
          let snapshot: ChatGptResponseDomSnapshot;
          try {
            snapshot = await withChatGptBrowserObservationTimeout(
              this.responseDomSnapshot(responseTurn.locator, responseDomCache),
              responseProbeTimeoutMs,
            );
          } catch (error) {
            if (!(error instanceof ChatGptBrowserObservationTimeoutError)) throw error;
            await recoverStalledResponsePage(error);
            continue;
          }
          if (!snapshot.responsePresent && (await responseTurn.locator.count()) !== 1) {
            try {
              const rebound = await withChatGptBrowserObservationTimeout(
                this.reconcileAssistantTurnBinding(page, submissionBaseline, responseTurn, turn.abortSignal),
              );
              if (rebound.identity !== responseTurn.identity) {
                responseTurn = rebound;
                responseDomCache.key = undefined;
                responseDomCache.snapshot = undefined;
                snapshot = await withChatGptBrowserObservationTimeout(
                  this.responseDomSnapshot(responseTurn.locator, responseDomCache),
                  responseProbeTimeoutMs,
                );
              }
            } catch (error) {
              if (!(error instanceof ChatGptBrowserObservationTimeoutError) || !launcherSurfaceId) throw error;
              const currentProgress = turn.externalProgress?.snapshot();
              const currentProgressLive = chatGptExternalProgressSuppressesDomHealth(currentProgress, Date.now());
              const currentCallsInFlight = chatGptExternalToolCallsAreInFlight(currentProgress);
              const isRunning = await page
                .locator(CHATGPT_STOP_BUTTON_SELECTOR)
                .last()
                .isVisible()
                .catch(() => false);
              if (!currentCallsInFlight && (currentProgressLive || isRunning)) {
                console.warn(
                  `[chatgpt-web] browser turn ${turn.traceId} DOM observation probe timed out while generation is active; continuing observation without rebind`,
                );
                await new Promise((resolveSleep) => setTimeout(resolveSleep, 1_000));
                continue;
              }
              await recoverStalledResponsePage(error);
              continue;
            }
          }
          if (snapshot.stoppedThinkingVisible) throw chatGptStoppedThinkingError();
          if (snapshot.responsePresent) consecutiveObservationRebinds = 0;
          // The page was read successfully, so the fault budget is genuinely consecutive even when
          // this iteration goes on to `continue` for a rebind, confirmation, or liveness pause.
          internalObservationFaults = 0;
          observedThisIteration = true;
          // Liveness may postpone a verdict, never waive it: once activity goes stale the DOM alone
          // decides, so a tool call that never returns cannot hold a turn with no explicit deadline open forever.
          const externalProgressSnapshot = turn.externalProgress?.snapshot();
          if (
            turn.externalProgress &&
            externalProgressSnapshot &&
            completionTracker.needsToolBatchObservation(externalProgressSnapshot.lastToolBatchRevision)
          ) {
            completionTracker.observeToolBatch(externalProgressSnapshot.lastToolBatchRevision, snapshot.visibleText);
            await turn.externalProgress.acknowledgeToolBatch(externalProgressSnapshot.lastToolBatchRevision);
          }
          const externalProgressLive = chatGptExternalProgressSuppressesDomHealth(externalProgressSnapshot, Date.now());
          const externalToolCallsInFlight = chatGptExternalToolCallsAreInFlight(externalProgressSnapshot);
          if (!snapshot.responsePresent && externalProgressLive) {
            // Current-turn MCP activity proves that ChatGPT is still executing even if its renderer
            // temporarily cannot expose the response subtree. DOM remains authoritative for text and
            // completion; this only prevents a live turn from being misclassified as vanished.
            domHealthTracker.clearMissingResponse();
            await waitForTurnSignal();
            continue;
          }
          const stop = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last();
          const running = await stop.isVisible().catch(() => false);
          if (running !== lastRunning) {
            lastRunning = running;
            turnEvents.publish({ type: "stop_button_visibility_changed", source: "dom", visible: running });
          }
          if (running) sawRunning = true;
          if (snapshot.responsePresent) {
            if (!capturedResponse) {
              capturedResponse = true;
              await diagnostics.capture(page, "response-visible");
            }
            const textDelta = (() => {
              try {
                return markdownBuffer.observe(snapshot.markdownSegments);
              } catch (error) {
                return throwMarkdownConsistencyError(error);
              }
            })();
            for (const trace of visibleTrace.observe(snapshot.traceBlocks, snapshot.completionActionVisible)) {
              if (trace.kind === "commentary") turn.onCommentary?.(trace.text, trace.continuation === true);
              else turn.onReasoningSummary?.(trace.text, trace.continuation === true);
            }
            if (textDelta) emitMarkdownDelta(textDelta);
            const domError = domHealthTracker.update({
              responsePresent: snapshot.responsePresent,
              running,
              currentText: snapshot.visibleText,
              completionActionVisible: snapshot.completionActionVisible,
              externalProgressLive,
            });
            if (domError) throw new Error(domError);
            const completionReady = completionTracker.update({
              responsePresent: snapshot.responsePresent,
              running,
              currentText: snapshot.visibleText,
              currentHtml: snapshot.fullHtml,
              completionActionVisible: snapshot.completionActionVisible,
              externalToolCallsInFlight,
            });
            if (snapshot.completionActionVisible !== lastCompletionActionVisible) {
              lastCompletionActionVisible = snapshot.completionActionVisible;
              turnEvents.publish({
                type: "completion_action_changed",
                source: "dom",
                visible: snapshot.completionActionVisible,
              });
            }
            if (!completionReady) fenceRevision = undefined;
            const decision = completionFsm.observe({
              responsePresent: snapshot.responsePresent,
              completionReady,
              externalToolCallsInFlight,
              externalProgressLive,
            });
            if (decision.changed) {
              turnEvents.publish({ type: "phase_changed", source: "host", from: decision.from, to: decision.phase });
            }
            if (decision.action === "fence_begin") {
              const revision = await turn.completionFence!.begin();
              if (revision === undefined) {
                completionFsm.fenceBeginUnavailable();
                await waitForTurnSignal();
                continue;
              }
              completionFsm.fenceAccepted();
              fenceRevision = revision;
              // The fence revision is captured after this DOM projection. Force one fresh read
              // before commit so an MCP activity that just settled cannot disappear between a
              // stale cached completion and the broker's terminal decision.
              responseDomCache.key = undefined;
              responseDomCache.snapshot = undefined;
              await waitForTurnSignal();
              continue;
            }
            if (decision.action === "fresh_read") {
              // The snapshot this iteration just observed is the fresh read (the cache was
              // invalidated before the previous wake); re-decide on the next iteration.
              continue;
            }
            if (decision.action === "fence_commit") {
              if (!(await turn.completionFence!.commit(fenceRevision!))) {
                completionFsm.fenceCommitted(false);
                fenceRevision = undefined;
                responseDomCache.key = undefined;
                responseDomCache.snapshot = undefined;
                await waitForTurnSignal();
                continue;
              }
              completionFsm.fenceCommitted(true);
              turnEvents.publish({ type: "phase_changed", source: "host", from: "settling", to: "completed" });
            }
            if (completionReady && decision.action !== "wait_for_signal") {
              if (snapshot.visibleText === "api_tool unavailable") {
                throw new Error("ChatGPT selected mode rejected the Codex Native MCP tool (api_tool unavailable)");
              }
              const final = (() => {
                try {
                  return markdownBuffer.finish();
                } catch (error) {
                  return throwMarkdownConsistencyError(error);
                }
              })();
              if (turn.compaction) {
                console.info(
                  `[chatgpt-web] browser turn ${turn.traceId} checkpoint_surface ` +
                    JSON.stringify(inspectCompactionResponseSurface(snapshot, final.markdown)),
                );
              }
              if (!final.markdown && snapshot.visibleText) {
                throw new Error("ChatGPT completed with visible text that could not be serialized as Markdown");
              }
              if (final.delta) emitMarkdownDelta(final.delta);
              if (checkpointStream) {
                const completed = checkpointStream.finishOptional(snapshot.visibleText);
                if (completed.visibleRemainder) turn.onTextDelta(completed.visibleRemainder);
                if (completed.captured) turn.onLunaCheckpoint!(completed.captured);
                else
                  console.warn(
                    `[chatgpt-web] browser turn ${turn.traceId} completed without a Luna rolling checkpoint; preserving full native history`,
                  );
                finalText = completed.answer;
              } else {
                finalText = final.markdown;
              }
              break;
            }
            if (!completionReady && !loggedCompletionWait && Date.now() - sentAt >= 60_000) {
              loggedCompletionWait = true;
              await diagnostics.capture(page, "response-stalled-60s");
              const diagnostic = await this.stalledTurnDiagnostic(page, responseTurn.locator).catch((error) =>
                JSON.stringify({
                  diagnosticError: error instanceof Error ? error.message : String(error),
                }),
              );
              console.warn(
                `[chatgpt-web] waiting for completed-turn evidence (running=${running}, sawRunning=${sawRunning}, textChars=${snapshot.visibleText.length}, completionActionVisible=${snapshot.completionActionVisible}, ui=${diagnostic})`,
              );
            }
          } else {
            const domError = domHealthTracker.update({
              responsePresent: false,
              running,
              currentText: "",
              completionActionVisible: false,
              externalProgressLive,
            });
            if (domError) throw new Error(domError);
          }
          await waitForTurnSignal();
        } catch (error) {
          // Only a defect in this worker is retried here. Every deliberate signal — adapter errors,
          // aborts, closed tabs, DOM-health verdicts — still fails the turn immediately.
          // Retry only faults raised while reading the page. Once observation succeeded, a
          // TypeError belongs to a consumer - Markdown buffering, text/trace callbacks, checkpoint
          // capture - and retrying it would rerun an iteration whose side effects already happened.
          if (!(error instanceof TypeError) || observedThisIteration) throw error;
          internalObservationFaults += 1;
          if (internalObservationFaults > MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS) {
            throw new Error(
              `ChatGPT browser observation failed ${internalObservationFaults} times in a row: ${error.message}`,
              { cause: error },
            );
          }
          console.warn(
            `[chatgpt-web] browser turn ${turn.traceId} tolerated internal observation fault` +
              ` ${internalObservationFaults}/${MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS}: ${error.message}`,
          );
          await diagnostics.capture(page, "internal-observation-fault");
          responseDomCache.key = undefined;
          responseDomCache.snapshot = undefined;
          turnEvents.publish({ type: "observation_faulted", source: "host", message: error.message });
          await waitForChatGptDomSettle(page);
          turnEvents.publish({ type: "dom_settled", source: "dom" });
        }
      }

      const finalRejection = await submissionRejection.failure();
      if (finalRejection) throw finalRejection;
      if (this.context && this.config.browserHost === "managed-chrome") {
        const state = await this.context.storageState();
        atomicWriteFile(this.config.storageStatePath, `${JSON.stringify(state)}\n`);
      }
      await diagnostics.capture(page, "turn-completed");
      if (turn.compaction) contextPressure.reset();
      console.info(
        `[chatgpt-web] browser turn ${turn.traceId} completed` +
          ` (markdownChars=${finalText.length}, domFullScans=${responseDomCache.fullScans ?? 0}, domCacheHits=${responseDomCache.cacheHits ?? 0})`,
      );
      return finalText;
    } catch (caughtError) {
      let error = caughtError;
      if (
        !(error instanceof DOMException && error.name === "AbortError") &&
        !(error instanceof ChatGptWebAdapterError && error.code === "client_cancelled")
      ) {
        error = (await submissionRejection.failure()) ?? error;
      }
      if (
        error instanceof DOMException &&
        error.name === "AbortError" &&
        turn.abortSignal?.reason instanceof ChatGptCompactionHandoffAccepted
      ) {
        if (turn.compaction && diagnosticPage) this.getContextPressure(diagnosticPage).reset();
        console.info(`[chatgpt-web] browser turn ${turn.traceId} ended after accepted structured compaction handoff`);
        if (diagnosticPage && !diagnosticPage.isClosed()) {
          await diagnostics.capture(diagnosticPage, "compaction-handoff-accepted");
        }
        turnEvents?.publish({ type: "compaction_handoff_observed", source: "host" });
        throw turn.abortSignal.reason;
      }
      console.error(
        `[chatgpt-web] browser turn ${turn.traceId} failed:` +
          ` ${redactChatGptUiDiagnostic(error instanceof Error ? error.message : String(error))}`,
      );
      if (diagnosticPage && !diagnosticPage.isClosed()) {
        await diagnostics.capture(diagnosticPage, "turn-failed", error);
      }
      throw error;
    } finally {
      if (onNetworkResponse && typeof diagnosticPage?.off === "function") {
        diagnosticPage.off("response", onNetworkResponse);
      }
      turnEvents.dispose();
      submissionRejection.dispose();
      await Promise.all(usageWrites);
      prepared.release();
      if (turn.conversationKey && (!turn.retainConversation || turn.compaction)) {
        this.contextPressureByConversation.delete(turn.conversationKey);
      }
      if (turnConnection) {
        await turnConnection.close().catch((error) => {
          console.error(
            `[chatgpt-web] failed to release launcher browser connection for ${turn.traceId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      } else if (managedPage && !managedPage.isClosed()) {
        await managedPage.close().catch((error) => {
          console.error(
            `[chatgpt-web] failed to close managed browser tab for ${turn.traceId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
    }
  }
}
