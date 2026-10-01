import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import {
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
  CHATGPT_USER_TURN_SELECTOR,
  detectChatGptAccountCapabilities,
} from "../../chatgpt-session";
import { atomicWriteFile, CHATGPT_CONNECTOR_NAME, getConfigDir } from "../../config";
import {
  connectLauncherBrowserHost,
  LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS,
  LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS,
  notifyLauncherTurn,
} from "../../launcher-browser-host";
import { runtimeIdentity } from "../../runtime-identity";
import type { CodexProviderConfig } from "../../types";
import {
  ChatGptCompactionHandoffAccepted,
  ChatGptWebAdapterError,
  chatGptBrowserTabClosedError,
  chatGptContextCompactionRequiredError,
  chatGptStoppedThinkingError,
} from "./adapter-error";
import { BrowserSession, type BrowserSessionState } from "./browser/browser-session";
import {
  type ChatGptConnectorAttemptBudget,
  ChatGptConnectorCatalogStaleError,
  ComposerController,
} from "./browser/composer-controller";
import { ChatGptBrowserContextPressure, ChatGptPageDomObserver } from "./browser/context-pressure";
import { waitForChatGptDomRevision, waitForChatGptDomSettle } from "./browser/dom-signal";
import { ChatGptModelControls, type SelectedChatGptWebModelMode } from "./browser/model-controls";
import { ResponseObserver } from "./browser/response-observer";
import {
  type ChatGptSubmissionBaseline,
  type ChatGptSubmissionDomCache,
  type ChatGptSubmissionDomState,
  SubmissionObserver,
} from "./browser/submission-observer";
import { TurnCompletionLoop } from "./browser/turn-completion-loop";
import {
  type ChatGptAssistantTurnBinding,
  type ChatGptObservationRecovery,
  type ChatGptSubmissionObservationRecovery,
  TurnDiagnostics,
} from "./browser/turn-diagnostics";
import { ChatGptTurnEventBus } from "./browser/turn-events";
import { resolveTurnLivenessSignals } from "./browser/turn-liveness";
import { TurnOrchestrator } from "./browser/turn-orchestrator";
import { ChatGptTurnPageBinding } from "./browser/turn-page-binding";
import { interactiveBrowserTurnMutex } from "./browser-mutex";
import { MAX_CHATGPT_BROWSER_TABS, MAX_CHATGPT_LAUNCHER_PENDING_TURNS } from "./concurrency";
import { createBrowserPayloadAcceptanceRecorder } from "./input-tokens";
import { LauncherBrowserHelperClient } from "./launcher-helper-client";
import { detectChatGptLimitsPlan, readChatGptUsageAccount, supportsChatGptUsageTracking } from "./limits";
import {
  CHATGPT_WEB_LUNA_MODEL_ID,
  CHATGPT_WEB_MODEL_ID,
  type ChatGptWebCapabilities,
  resolveChatGptWebModelMode,
} from "./model";
import type { ChatGptWebMultipartStage, CompiledChatGptWebPrompt } from "./prompt";
import { RECORD_FRAGMENT_CAPABILITY } from "./prompt/types";
import type { CapturedChatGptLunaCheckpoint } from "./rolling-checkpoint";
import type { ChatGptTurnProgressReader } from "./turn-progress";
import { classifyTurnTermination, type TurnTerminationCause } from "./turn-terminal";

export * from "./browser";
export { MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS } from "./browser/composer-controller";
export { MAX_CHATGPT_BROWSER_TABS } from "./concurrency";

const workers = new Map<string, ChatGptBrowserWorker>();

export async function closeChatGptBrowserWorkers(): Promise<void> {
  const active = [...workers.entries()];
  const results = await Promise.allSettled(active.map(([, worker]) => worker.close()));
  // Retire the snapshot after every close settles. Same-provider calls keep receiving the
  // closing worker, while a different provider registered during the await remains owned.
  for (const [key, worker] of active) {
    if (workers.get(key) === worker) workers.delete(key);
  }
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} ChatGPT browser worker(s) failed to close`);
  }
}

import { type ResolvedBrowserConfig, resolveBrowserConfig } from "./browser/config";
import { ChatGptBrowserDiagnostics, redactChatGptUiDiagnostic } from "./browser/diagnostics";

import {
  ChatGptCompletionTracker,
  type ChatGptResponseDomCache,
  type ChatGptResponseDomSnapshot,
  type ChatGptSubmissionEvidence,
  ChatGptTurnDomHealthTracker,
} from "./browser/dom-trackers";
import { buildMultipartPlan } from "./browser/multipart-plan";
import {
  ChatGptPromptAttachmentIntegrityError,
  ChatGptSubmissionRejectionObserver,
  throwIfChatGptRateLimitDialog,
  throwIfChatGptSessionFailureAlert,
  throwIfChatGptTerminalErrorAlert,
} from "./browser/overlays";
import { assertChatGptPromptAttachments } from "./browser/payloads";
import {
  browserStageTimeouts,
  CHATGPT_MIN_OPERATIONAL_VIEWPORT,
  CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS,
  CHATGPT_RESPONSE_DOM_GRACE_MS,
  ChatGptBrowserObservationTimeoutError,
  type ChatGptSuspensionClock,
  chatGptSuspensionClock,
  connectAfterClosingBrowserConnection,
  throwIfPromptAttachmentAborted,
  withBrowserTurnAbort,
  withChatGptBrowserObservationTimeout,
} from "./browser/suspension-clock";

const CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS = 10_000;
const CHATGPT_SMOKE_TEXT = "Reply with exactly: CODEX WEB GPT READY";
const CHATGPT_SMOKE_EXPECTED = "CODEX WEB GPT READY";
export const CHATGPT_SEND_ENABLE_GRACE_MS = 5_000;

export async function waitForOperationalChatGptViewport(page: Page, signal?: AbortSignal): Promise<void> {
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

  // Shared browser/page lifecycle state. The worker owns one state object and hands it to the
  // composed BrowserSession, so handles opened by the session are the same objects the accessors
  // below observe.
  private sessionState?: BrowserSessionState;
  private sessionInstance?: BrowserSession;
  private launcherHelper?: LauncherBrowserHelperClient;
  private readonly activeRuns = new Map<string, Promise<string>>();
  private readonly contextPressureByConversation = new Map<string, ChatGptBrowserContextPressure>();
  private readonly contextPressureByPage = new WeakMap<Page, ChatGptBrowserContextPressure>();
  private readonly pageDomObserver = new ChatGptPageDomObserver();
  /**
   * Per-turn event buses of the most recent turns, kept for diagnostics and tests. Buses are
   * disposed when their turn ends but retain their event history; the retention bound keeps a
   * long-lived worker from accumulating one entry per turn.
   */
  turnEventBuses?: Map<string, ChatGptTurnEventBus>;

  private get session(): BrowserSession {
    if (!this.sessionState) this.sessionState = { maintenanceTail: Promise.resolve() };
    if (!this.sessionInstance) {
      this.sessionInstance = new BrowserSession({
        config: this.config,
        state: this.sessionState,
        activeRuns: this.activeRuns,
      });
    }
    return this.sessionInstance;
  }

  private get browser(): Browser | undefined {
    return this.sessionState?.browser;
  }

  private get context(): BrowserContext | undefined {
    return this.sessionState?.context;
  }

  private get maintenanceTail(): Promise<void> {
    return this.sessionState?.maintenanceTail ?? Promise.resolve();
  }

  private responseObserverInstance?: ResponseObserver;
  private get responseObserver(): ResponseObserver {
    if (!this.responseObserverInstance) {
      this.responseObserverInstance = new ResponseObserver({
        pageDomObserver: this.pageDomObserver,
        getContextPressure: (page, conversationKey) => this.getContextPressure(page, conversationKey),
      });
    }
    return this.responseObserverInstance;
  }

  private modelControlsInstance?: ChatGptModelControls;
  private get modelControls(): ChatGptModelControls {
    if (!this.modelControlsInstance) {
      this.modelControlsInstance = new ChatGptModelControls({
        activeComposer: (page, timeoutMs, abortSignal) => this.activeComposer(page, timeoutMs, abortSignal),
      });
    }
    return this.modelControlsInstance;
  }

  private submissionObserverInstance?: SubmissionObserver;
  private get submissionObserver(): SubmissionObserver {
    if (!this.submissionObserverInstance) {
      this.submissionObserverInstance = new SubmissionObserver({
        responseDomSnapshot: (locator, cache) => this.responseDomSnapshot(locator, cache),
      });
    }
    return this.submissionObserverInstance;
  }

  private turnDiagnosticsInstance?: TurnDiagnostics;
  private get turnDiagnostics(): TurnDiagnostics {
    if (!this.turnDiagnosticsInstance) {
      this.turnDiagnosticsInstance = new TurnDiagnostics({
        submissionDomState: (page, cache, signal) => this.submissionDomState(page, cache, signal),
        waitForTurnDomOrExternalProgress: (page, afterProgressRevision, externalProgress, signal) =>
          this.waitForTurnDomOrExternalProgress(page, afterProgressRevision, externalProgress, signal),
        waitForTurnDomRevisionOrExternalProgress: (
          page,
          afterDomKey,
          afterProgressRevision,
          externalProgress,
          signal,
          options,
        ) =>
          this.waitForTurnDomRevisionOrExternalProgress(
            page,
            afterDomKey,
            afterProgressRevision,
            externalProgress,
            signal,
            options,
          ),
        responseDomSnapshot: (locator, cache) => this.responseDomSnapshot(locator, cache),
        waitForSubmissionAccepted: (
          page,
          baseline,
          signal,
          externalProgress,
          initialToolBatchRevision,
          completionTracker,
        ) =>
          this.waitForSubmissionAccepted(
            page,
            baseline,
            signal,
            externalProgress,
            initialToolBatchRevision,
            completionTracker,
          ),
      });
    }
    return this.turnDiagnosticsInstance;
  }

  private composerControllerInstance?: ComposerController;
  private get composer(): ComposerController {
    if (!this.composerControllerInstance) {
      this.composerControllerInstance = new ComposerController({ config: this.config });
    }
    return this.composerControllerInstance;
  }

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

  /**
   * Locate the context pressure already registered for this turn's conversation or page without
   * creating or registering a fresh one. Error paths must observe state, not mutate it.
   */
  private findExistingContextPressure(
    page: Page | undefined,
    conversationKey?: string,
  ): ChatGptBrowserContextPressure | undefined {
    if (conversationKey) {
      const byConversation = this.contextPressureByConversation.get(conversationKey);
      if (byConversation) return byConversation;
    }
    return page ? this.contextPressureByPage.get(page) : undefined;
  }

  async releaseConversationContextPressure(conversationKey: string): Promise<void> {
    this.contextPressureByConversation.delete(conversationKey);
    await this.launcherHelper?.releaseConversationContextPressure(conversationKey);
  }

  private constructor(private readonly config: ResolvedBrowserConfig) {}

  run(turn: BrowserTurn): Promise<string> {
    // Fail fast with the same trace id contract the diagnostics recorder enforces, so an invalid
    // id never reaches prompt preparation (whose prepared resource would otherwise leak when the
    // turn aborts before staging).
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(turn.traceId)) {
      return Promise.reject(new Error("ChatGPT web browser turn trace id is invalid"));
    }
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
    return this.session.enqueueMaintenance(name, action);
  }

  async close(): Promise<void> {
    try {
      if (this.launcherHelper) {
        const helper = this.launcherHelper;
        this.launcherHelper = undefined;
        try {
          await helper.close();
        } catch (error) {
          // A refused helper termination must not skip the browser disconnect and state cleanup
          // below; the failure is surfaced here and shutdown still completes.
          console.error(
            `[chatgpt-web] ChatGPT browser helper failed to close: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      await Promise.allSettled([...this.activeRuns.values()]);
      await this.maintenanceTail;
    } finally {
      const browser = this.browser;
      // Discard every lifecycle handle the composed session opened. The state object itself stays
      // Only the lifecycle handles are cleared; the session retains its state object.
      const state = this.sessionState;
      if (state) {
        state.browser = undefined;
        state.context = undefined;
        state.page = undefined;
        state.managedBrowserReady = undefined;
      }
      this.contextPressureByConversation.clear();
      // For connectOverCDP, Playwright implements Browser.close as a transport disconnect; it does
      // not close the launcher-owned Electron process. Always release that connection and its
      // artifact directory instead of leaking one per timeout/helper lifecycle.
      if (browser) await browser.close();
    }
  }

  private async runStage<T>(
    traceId: string,
    stage: string,
    timeoutMs: number,
    action: (abortSignal: AbortSignal) => Promise<T>,
    suspensionClock: Pick<ChatGptSuspensionClock, "suspendedMs"> = chatGptSuspensionClock,
    awaitAbortedActionSettlement = false,
  ): Promise<T> {
    return this.session.runStage(traceId, stage, timeoutMs, action, suspensionClock, awaitAbortedActionSettlement);
  }

  private async ensurePage(): Promise<Page> {
    return this.session.ensurePage();
  }

  private async ensureManagedBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
    return this.session.ensureManagedBrowser();
  }

  /**
   * A Codex turn owns one isolated browser conversation. Reusing the same
   * ChatGPT SPA page can retain the previous transcript and autocomplete DOM,
   * so an @app lookup may select stale UI from the preceding turn.
   */
  private async pageForNewTurn(): Promise<Page> {
    return this.session.pageForNewTurn();
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
    return this.modelControls.selectModelAndEffort(
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
    return this.modelControls.assertSelectedEffort(page, mode, verifyFamily);
  }

  private async activeComposer(page: Page, timeoutMs = 30_000, abortSignal?: AbortSignal): Promise<Locator> {
    return this.composer.activeComposer(page, timeoutMs, abortSignal);
  }

  /** Prepare a new conversation; account inspection still uses an empty Temporary Chat. */
  private async prepareChatSurface(
    page: Page,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    useSavedChats = false,
  ): Promise<Locator> {
    return this.composer.prepareChatSurface(page, captureDiagnostic, useSavedChats);
  }

  private async waitForTurnDomMutation(page: Page, timeoutMs = 250): Promise<void> {
    return this.submissionObserver.waitForTurnDomMutation(page, timeoutMs);
  }

  private async waitForTurnDomOrExternalProgress(
    page: Page,
    afterProgressRevision: number,
    externalProgress?: ChatGptTurnProgressReader,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.submissionObserver.waitForTurnDomOrExternalProgress(
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
    options?: {
      horizonMs?: number;
      settleMs?: number;
      observationTimeoutMs?: number;
      domChars?: number;
      payloadChars?: number;
    },
  ): Promise<string> {
    return this.submissionObserver.waitForTurnDomRevisionOrExternalProgress(
      page,
      afterDomKey,
      afterProgressRevision,
      externalProgress,
      signal,
      options,
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
    return this.submissionObserver.waitForSubmissionAccepted(
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
    return this.submissionObserver.submissionDomState(page, cache, signal);
  }

  private async currentSubmissionEvidence(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    signal?: AbortSignal,
  ): Promise<ChatGptSubmissionEvidence | undefined> {
    return this.submissionObserver.currentSubmissionEvidence(page, baseline, signal);
  }

  private async currentSubmissionAnswerText(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.submissionObserver.currentSubmissionAnswerText(page, baseline, signal);
  }

  private async captureSubmissionBaseline(page: Page, submittedText?: string): Promise<ChatGptSubmissionBaseline> {
    return this.submissionObserver.captureSubmissionBaseline(page, submittedText);
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
    return this.turnDiagnostics.waitForNewAssistantTurn(
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
    return this.turnDiagnostics.reconcileAssistantTurnBinding(page, baseline, binding, signal);
  }

  private async attachedPromptText(page: Page, abortSignal?: AbortSignal): Promise<string> {
    return this.composer.attachedPromptText(page, abortSignal);
  }

  private async assertPromptAttached(page: Page, prompt: string, abortSignal?: AbortSignal): Promise<void> {
    return this.composer.assertPromptAttached(page, prompt, abortSignal);
  }

  private selectedConnectorControl(composer: Locator): Locator {
    return this.composer.selectedConnectorControl(composer);
  }

  private async connectorIsSelected(composer: Locator, abortSignal?: AbortSignal): Promise<boolean> {
    return this.composer.connectorIsSelected(composer, abortSignal);
  }

  private async connectorMentionRowTitles(menuRows: Locator, abortSignal?: AbortSignal): Promise<string[]> {
    return this.composer.connectorMentionRowTitles(menuRows, abortSignal);
  }

  private async connectorMentionFailure(
    menuRows: Locator,
    triggerAttempts: number,
    abortSignal?: AbortSignal,
    page?: Page,
  ): Promise<string> {
    return this.composer.connectorMentionFailure(menuRows, triggerAttempts, abortSignal, page);
  }

  private async clearChatGptComposerState(page: Page): Promise<void> {
    return this.composer.clearChatGptComposerState(page);
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
    return this.composer.selectConnector(
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
    return this.composer.attachPrompt(
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
    return this.turnDiagnostics.waitForSubmissionAcceptedWithRecovery(
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
    const sendButton = composerForm
      .locator(
        '[data-testid="send-button"], button[type="submit"]:not([aria-haspopup="menu"]), button[aria-label*="Enviar" i], button[aria-label*="Send" i]',
      )
      .first();
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
    if (requireConnector) {
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
    turnEvents?: ChatGptTurnEventBus,
    onHeartbeat?: () => void,
  ): Promise<void> {
    // A staged message may briefly create an assistant shell and then replace it while ChatGPT
    // ingests the attached context. The ordinary 60-second missing-response verdict would cut the
    // dedicated multipart acknowledgement budget back down after that transient shell appears.
    // Keep DOM absence bounded by the same per-stage budget that owns this protocol step.
    const domHealthTracker = new ChatGptTurnDomHealthTracker(CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS);
    const responseDomCache: ChatGptResponseDomCache = {};
    let responseTurn = initialResponseTurn;
    let lastHeartbeat = Date.now();
    let lastRunning: boolean | undefined;
    let domSignalKey: string | undefined;

    const payloadChars = typeof stage?.text === "string" ? stage.text.length : undefined;

    const waitForTurnSignal = async (): Promise<void> => {
      const previousKey = domSignalKey;
      const progressRev = externalProgress?.snapshot().revision ?? 0;
      try {
        domSignalKey = await this.waitForTurnDomRevisionOrExternalProgress(
          page,
          domSignalKey,
          progressRev,
          externalProgress,
          abortSignal,
          { payloadChars },
        );
      } catch (error) {
        if (
          error instanceof ChatGptBrowserObservationTimeoutError &&
          !page.isClosed() &&
          (deadline === undefined || Date.now() < deadline)
        ) {
          console.warn(
            `[chatgpt-web] multipart stage DOM observation signal timed out during heavy rendering; deferring without failure`,
          );
          onHeartbeat?.();
          turnEvents?.publish({ type: "observation_faulted", source: "host", message: error.message });
          return;
        }
        throw error;
      }
      const newProgressRev = externalProgress?.snapshot().revision ?? 0;
      if (newProgressRev > progressRev) {
        turnEvents?.publish({
          type: "external_progress_advanced",
          source: "external_progress",
          revision: newProgressRev,
        });
      }
      if (domSignalKey !== previousKey) {
        turnEvents?.publish({ type: "response_mutated", source: "dom" });
      }
    };

    for (;;) {
      if (Date.now() - lastHeartbeat >= 5_000) {
        onHeartbeat?.();
        lastHeartbeat = Date.now();
      }
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
      let snapshot: ChatGptResponseDomSnapshot;
      try {
        snapshot = await this.responseDomSnapshot(responseTurn.locator, responseDomCache);
      } catch (error) {
        if (!(error instanceof ChatGptBrowserObservationTimeoutError)) throw error;
        const currentProgress = externalProgress?.snapshot();
        const {
          externalProgressLive: currentProgressLive,
          externalToolCallsInFlight: currentCallsInFlight,
          multiChannelLivenessActive,
        } = resolveTurnLivenessSignals(currentProgress, Date.now());
        const isRunning = await page
          .locator(CHATGPT_STOP_BUTTON_SELECTOR)
          .last()
          .isVisible()
          .catch(() => false);
        const stageGraceActive = !page.isClosed() && (deadline === undefined || Date.now() < deadline);
        if (
          currentProgressLive ||
          currentCallsInFlight ||
          isRunning ||
          multiChannelLivenessActive ||
          stageGraceActive
        ) {
          console.warn(
            `[chatgpt-web] multipart stage DOM observation probe timed out while generation, context ingestion, or stage grace is active; deferring without failure`,
          );
          onHeartbeat?.();
          turnEvents?.publish({ type: "observation_faulted", source: "host", message: error.message });
          await waitForTurnSignal();
          continue;
        }
        throw error;
      }
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
      const { externalProgressLive, externalToolCallsInFlight, multiChannelLivenessActive } =
        resolveTurnLivenessSignals(externalProgressSnapshot, Date.now());
      if (!snapshot.responsePresent && (externalProgressLive || multiChannelLivenessActive)) {
        // Proven MCP activity outranks a momentarily unavailable staging DOM, exactly as it does
        // in the main turn loop.
        domHealthTracker.clearMissingResponse();
        await waitForTurnSignal();
        continue;
      }
      const running = await page
        .locator(CHATGPT_STOP_BUTTON_SELECTOR)
        .last()
        .isVisible()
        .catch(() => false);
      if (running !== lastRunning) {
        lastRunning = running;
        turnEvents?.publish({ type: "stop_button_visibility_changed", source: "dom", visible: running });
      }
      const domError = domHealthTracker.update({
        responsePresent: snapshot.responsePresent,
        running,
        currentText: snapshot.visibleText,
        completionActionVisible: snapshot.completionActionVisible,
        externalProgressLive,
        multiChannelLivenessActive,
        domChars: snapshot.fullHtml.length || snapshot.visibleText.length,
      });
      if (domError) {
        throw new ChatGptWebAdapterError(domError, {
          status: 504,
          errorType: "server_error",
          code: "chatgpt_browser_dom_unresponsive",
          retryable: false,
          cause: new Error(domError),
        });
      }
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
      await waitForTurnSignal();
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
    return this.composer.insertPromptText(page, text, abortSignal);
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
    return this.composer.attachFiles(page, prompt);
  }

  private async responseDomSnapshot(
    responseTurn: Locator,
    cache?: ChatGptResponseDomCache,
  ): Promise<ChatGptResponseDomSnapshot> {
    return this.responseObserver.responseDomSnapshot(responseTurn, cache);
  }

  private async stalledTurnDiagnostic(page: Page, responseTurn: Locator): Promise<string> {
    return this.responseObserver.stalledTurnDiagnostic(page, responseTurn);
  }

  private async runExclusive(turn: BrowserTurn): Promise<string> {
    return new TurnOrchestrator({
      config: this.config,
      notifyLauncherTurn,
      acquireInteractive: (traceId, signal) => interactiveBrowserTurnMutex.acquire(traceId, signal),
      runBrowserTurn: (...args) => this.runBrowserTurn(...args),
      heartbeatIntervalMs: LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS,
      heartbeatTimeoutMs: LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS,
    }).run(turn);
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
    let turnConnection: Browser | undefined;
    let managedPage: Page | undefined;
    let diagnosticPage: Page | undefined;
    const usageWrites: Promise<void>[] = [];
    const submissionRejection = new ChatGptSubmissionRejectionObserver();
    let pageBinding: ChatGptTurnPageBinding | undefined;
    let detachDiagnosticPage: (() => void) | undefined;
    // Diagnostics and the event bus are constructed inside the try: neither may throw past the
    // finally block below, which is the only guaranteed release of the prepared prompt resource.
    // Definite-assignment keeps the in-try call sites unchanged; catch/finally use optional
    // chaining because a construction failure leaves both unset.
    let diagnostics!: ChatGptBrowserDiagnostics;
    let turnEvents!: ChatGptTurnEventBus;
    let terminalCause: TurnTerminationCause | "completed" = "internal_failure";
    try {
      diagnostics = new ChatGptBrowserDiagnostics(
        turn.traceId,
        this.config.browserDiagnosticsPath ?? join(getConfigDir(), "diagnostics", "browser-turns"),
        this.config.appName,
      );
      turnEvents = new ChatGptTurnEventBus({
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
      if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      // Validate only the selected physical message, not canonical history used for usage estimates.
      assertChatGptPromptAttachments(prepared);
      // The staging plan (transport split, payload metrics, token estimates, and the limit
      // assertions) is built by a pure module at the same point where the inline block used to
      // run, so every limit violation still throws before any browser work starts.
      const {
        multipartTransactionId,
        multipartStages,
        multipartFinalPrompt,
        browserPayload,
        estimatedInputTokens,
        maxMessageChars,
        maxStageMessageTokens,
        maxStageChars,
        stagingMode,
      } = buildMultipartPlan(prepared, {
        modelId: turn.modelId,
        capabilities: browserCapabilities,
        requestedMode,
        compaction: turn.compaction === true,
        helperCapabilities: [RECORD_FRAGMENT_CAPABILITY],
      });
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
      pageBinding = new ChatGptTurnPageBinding(turnEvents);
      pageBinding.bind(page);
      detachDiagnosticPage = diagnostics.bindPage(page);
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
        pageBinding?.bind(page);
        detachDiagnosticPage = diagnostics.bindPage(page);
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
      contextPressure.recordTokens(estimatedInputTokens);
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
                undefined,
                turnEvents,
                turn.onHeartbeat,
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
      const responseTurn = await this.waitForNewAssistantTurn(
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

      const { text: finalText, cache: responseDomCache } = await new TurnCompletionLoop({
        config: this.config,
        responseDomSnapshot: (locator, cache) => this.responseDomSnapshot(locator, cache),
        reconcileAssistantTurnBinding: (page, baseline, current, signal) =>
          this.reconcileAssistantTurnBinding(page, baseline, current, signal),
        waitForTurnDomRevisionOrExternalProgress: (...args) => this.waitForTurnDomRevisionOrExternalProgress(...args),
        stalledTurnDiagnostic: (page, locator) => this.stalledTurnDiagnostic(page, locator),
        rebindLauncherPage: async (attempt, cause, signal) => {
          await rebindLauncherPage(attempt, cause, signal);
          return page;
        },
        classifyLiveness: resolveTurnLivenessSignals,
      }).run({
        turn,
        page,
        submissionBaseline,
        responseTurn,
        launcherSurfaceId,
        deadline,
        localTools: mode.localTools,
        completionTracker,
        contextPressure,
        diagnostics,
        turnEvents,
      });

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
      terminalCause = "completed";
      return finalText;
    } catch (caughtError) {
      terminalCause = classifyTurnTermination(caughtError, turn.abortSignal);
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
        if (turn.compaction) this.findExistingContextPressure(diagnosticPage, turn.conversationKey)?.reset();
        console.info(`[chatgpt-web] browser turn ${turn.traceId} ended after accepted structured compaction handoff`);
        if (diagnosticPage && !diagnosticPage.isClosed()) {
          await diagnostics?.capture(diagnosticPage, "compaction-handoff-accepted");
        }
        turnEvents?.publish({ type: "compaction_handoff_observed", source: "host" });
        throw turn.abortSignal.reason;
      }
      console.error(
        `[chatgpt-web] browser turn ${turn.traceId} failed:` +
          ` ${redactChatGptUiDiagnostic(error instanceof Error ? error.message : String(error))}`,
      );
      if (diagnosticPage && !diagnosticPage.isClosed()) {
        await diagnostics?.capture(diagnosticPage, "turn-failed", error);
      }
      throw error;
    } finally {
      console.info(
        `[chatgpt-web] turn_terminal ${JSON.stringify({
          traceId: turn.traceId,
          turnId: turnEvents?.scope.turnId,
          documentGeneration: turnEvents?.documentGeneration,
          afterSequence: turnEvents?.cursor,
          terminalCause,
          runtime: runtimeIdentity,
        })}`,
      );
      pageBinding?.dispose();
      detachDiagnosticPage?.();
      turnEvents?.dispose();
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
