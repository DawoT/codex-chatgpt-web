import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { skillFileTokens, validateSkillFiles } from "./skill-attachments";
import { detectChatGptLimitsPlan, readChatGptUsageAccount, readChatGptUsageModel, supportsChatGptUsageTracking, type ChatGptUsageModel } from "./limits";
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Request, type Response } from "playwright-core";
import {
  atomicWriteFile,
  CHATGPT_CONNECTOR_NAME,
  defaultChromeExecutable,
  DEV_CHATGPT_CONNECTOR_NAME,
  expandUserPath,
  getConfigDir,
  isLegacyChatGptConnectorName,
  legacyChatGptConnectorMigrationMessage,
  LEGACY_CHATGPT_CONNECTOR_NAMES,
} from "../../config";
import { estimateTokens } from "../../lib/token-estimate";
import { CHATGPT_STOPPED_THINKING_LABELS } from "./ui-labels";
import type { CodexProviderConfig } from "../../types";
import { parseDataUrl } from "../image";
import {
  ChatGptMarkdownBuffer,
  ChatGptMarkdownConsistencyError,
  inspectCompactionResponseSurface,
  type ChatGptMarkdownSegment,
} from "./markdown";
import {
  CHATGPT_WEB_LUNA_MODEL_ID,
  CHATGPT_WEB_MODEL_ID,
  resolveChatGptWebModelMode,
  type ChatGptWebCapabilities,
  type ChatGptWebModelMode,
} from "./model";
import {
  CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET,
  createBrowserPayloadAcceptanceRecorder,
  estimateChatGptWebImageTokens,
  measureCompiledBrowserPayload,
  measureCompiledChatGptWebInput,
} from "./input-tokens";
import {
  CHATGPT_MAX_INPUT_IMAGES,
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
  isChatGptWebMultipartPartCount,
  type CompiledChatGptWebPrompt,
  type ChatGptWebPromptImage,
  type ChatGptWebMultipartStage,
} from "./prompt";
import {
  assertAuthenticatedChatGptPage,
  assertNewChatPage,
  chatGptAssistantTurnSelector,
  chatGptNewChatUrl,
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_COMPLETION_ACTION_SELECTOR,
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_EFFORT_ITEM_SELECTOR,
  CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR,
  CHATGPT_SEND_BUTTON_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
  CHATGPT_USER_TURN_SELECTOR,
  activateChatGptEffortMenu,
  detectChatGptAccountCapabilities,
  parseChatGptEffortSliderState,
  readChatGptEffortAvailability,
  readChatGptEffortSnapshot,
} from "../../chatgpt-session";
import { loginVerificationMarkerPath } from "../../browser-login";
import {
  connectLauncherBrowserHost,
  LauncherBrowserTurnCancelledError,
  LauncherRetainedConversationUnavailableError,
  LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS,
  LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS,
  notifyLauncherTurn,
} from "../../launcher-browser-host";
import {
  CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER,
  resolveChatGptWebContextLimits,
  resolveChatGptWebMessageTokenBudget,
  resolveChatGptWebTransportLimits,
} from "../../chatgpt-web-models";
import { LauncherBrowserHelperClient } from "./launcher-helper-client";
import { interactiveBrowserTurnMutex, type InteractiveBrowserTurnLock } from "./browser-mutex";
import { assertChatGptModelFamily, selectChatGptModelFamily } from "./model-selection";
import { MAX_CHATGPT_BROWSER_TABS, MAX_CHATGPT_LAUNCHER_PENDING_TURNS } from "./concurrency";
import {
  ChatGptCompactionHandoffAccepted,
  ChatGptWebAdapterError,
  chatGptBrowserTabClosedError,
  chatGptContextCompactionRequiredError,
  chatGptRetainedConversationUnavailableError,
  chatGptStoppedThinkingError,
} from "./adapter-error";
import { ChatGptBrowserContextPressure, ChatGptPageDomObserver } from "./browser/context-pressure";
import {
  ChatGptLunaCheckpointStream,
  type CapturedChatGptLunaCheckpoint,
} from "./rolling-checkpoint";
import {
  chatGptExternalProgressIsLive,
  chatGptExternalToolCallsAreInFlight,
} from "./turn-progress";
import type {
  ChatGptExternalTurnProgressSnapshot,
  ChatGptTurnProgressReader,
} from "./turn-progress";

export { MAX_CHATGPT_BROWSER_TABS } from "./concurrency";

const workers = new Map<string, ChatGptBrowserWorker>();

export async function closeChatGptBrowserWorkers(): Promise<void> {
  const active = [...workers.values()];
  workers.clear();
  const results = await Promise.allSettled(active.map(worker => worker.close()));
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map(result => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} ChatGPT browser worker(s) failed to close`);
  }
}

export {
  CHATGPT_RESPONSE_DOM_GRACE_MS,
  CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS,
  CHATGPT_EMPTY_RESPONSE_GRACE_MS,
  CHATGPT_COMPLETION_ACTION_GRACE_MS,
  CHATGPT_COMPLETION_SETTLE_MS,
  browserStageTimeouts,
  ChatGptSuspensionClock,
  chatGptSuspensionClock,
  remainingStageBudgetMs,
  CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS,
  MAX_CHATGPT_BROWSER_PAGE_REBINDS,
  ChatGptBrowserObservationTimeoutError,
  withChatGptBrowserObservationTimeout,
  connectAfterClosingBrowserConnection,
  CHATGPT_MIN_OPERATIONAL_VIEWPORT,
  CHATGPT_COMPOSER_DOCUMENT_END_KEY,
  CHATGPT_COMPOSER_SELECT_ALL_KEY,
  throwIfPromptAttachmentAborted,
  withBrowserTurnAbort,
} from "./browser/suspension-clock";
import {
  CHATGPT_RESPONSE_DOM_GRACE_MS,
  CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS,
  CHATGPT_EMPTY_RESPONSE_GRACE_MS,
  CHATGPT_COMPLETION_ACTION_GRACE_MS,
  CHATGPT_COMPLETION_SETTLE_MS,
  browserStageTimeouts,
  ChatGptSuspensionClock,
  chatGptSuspensionClock,
  remainingStageBudgetMs,
  CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS,
  MAX_CHATGPT_BROWSER_PAGE_REBINDS,
  ChatGptBrowserObservationTimeoutError,
  withChatGptBrowserObservationTimeout,
  connectAfterClosingBrowserConnection,
  CHATGPT_MIN_OPERATIONAL_VIEWPORT,
  CHATGPT_COMPOSER_DOCUMENT_END_KEY,
  CHATGPT_COMPOSER_SELECT_ALL_KEY,
  throwIfPromptAttachmentAborted,
  withBrowserTurnAbort,
} from "./browser/suspension-clock";
export {
  CHATGPT_UI_SETTLE_MS,
  settleChatGptUi,
  chatGptConnectorUnavailableError,
  chatGptUnavailableProDetail,
  type ChatGptPersonalizationPreflight,
  CHATGPT_PERSONALIZATION_PREFLIGHT_TIMEOUT_MS,
  CHATGPT_PERSONALIZATION_CLEANUP_TIMEOUT_MS,
  ensureChatGptPersonalizedConnectorAccess,
} from "./browser/personalization";
import {
  CHATGPT_UI_SETTLE_MS,
  settleChatGptUi,
  chatGptConnectorUnavailableError,
  chatGptUnavailableProDetail,
  type ChatGptPersonalizationPreflight,
  CHATGPT_PERSONALIZATION_PREFLIGHT_TIMEOUT_MS,
  CHATGPT_PERSONALIZATION_CLEANUP_TIMEOUT_MS,
  ensureChatGptPersonalizedConnectorAccess,
  ChatGptPersistentBrowserStateError,
  runChatGptPersonalizationCleanup,
  pressChatGptPersonalizationEscape,
  waitForChatGptPersonalizationPoll,
} from "./browser/personalization";
export {
  CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS,
  ChatGptPromptAttachmentIntegrityError,
  throwIfChatGptRateLimitDialog,
  dismissChatGptTemporaryChatOnboarding,
  CHATGPT_OVERLAY_DISMISS_BUTTON_TEXT_REGEX,
  CHATGPT_OVERLAY_CONFIRM_BUTTON_TEXT_REGEX,
  CHATGPT_OVERLAY_SAFE_DISMISS_BUTTON_TEXT_REGEX,
  CHATGPT_OVERLAY_DESTRUCTIVE_TEXT_REGEX,
  type DismissOverlaysOptions,
  dismissAllChatGptOverlays,
  type ChatGptTextScope,
  throwIfChatGptSessionFailureAlert,
  ChatGptSubmissionRejectionObserver,
  throwIfChatGptTerminalErrorAlert,
  resolveChatGptToolConfirmation,
} from "./browser/overlays";
import {
  CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS,
  ChatGptPromptAttachmentIntegrityError,
  throwIfChatGptRateLimitDialog,
  dismissChatGptTemporaryChatOnboarding,
  CHATGPT_OVERLAY_DISMISS_BUTTON_TEXT_REGEX,
  CHATGPT_OVERLAY_CONFIRM_BUTTON_TEXT_REGEX,
  CHATGPT_OVERLAY_SAFE_DISMISS_BUTTON_TEXT_REGEX,
  CHATGPT_OVERLAY_DESTRUCTIVE_TEXT_REGEX,
  type DismissOverlaysOptions,
  dismissAllChatGptOverlays,
  type ChatGptTextScope,
  throwIfChatGptSessionFailureAlert,
  ChatGptSubmissionRejectionObserver,
  throwIfChatGptTerminalErrorAlert,
  resolveChatGptToolConfirmation,
  chatGptRateLimitDialog,
  chatGptExpiredSessionAlert,
} from "./browser/overlays";
export {
  CHATGPT_PENDING_TOOL_EVIDENCE_STALL_MS,
  CHATGPT_TOOL_IN_FLIGHT_CEILING_MS,
  MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS,
  CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS,
  CHATGPT_EXTERNAL_PROGRESS_CLOCK_SKEW_MS,
  chatGptTurnIsComplete,
  type ChatGptSubmissionEvidence,
  chatGptSubmissionEvidence,
  type ChatGptConnectorAttachmentMode,
  chatGptConnectorAttachmentMode,
  chatGptNewTurnIdentity,
  chatGptReboundTurnIdentity,
  chatGptTurnIdentityLocatorSelector,
  ChatGptCompletionTracker,
  ChatGptTurnDomHealthTracker,
  ChatGptPendingToolEvidenceTracker,
  chatGptExternalProgressSuppressesDomHealth,
  type ChatGptVisibleTraceBlock,
  type ChatGptVisibleTraceEvent,
  type ChatGptResponseDomSnapshot,
  type ChatGptResponseDomCache,
  absentResponseDomSnapshot,
  ChatGptVisibleTraceTracker,
  isChatGptTraceControl,
  stripChatGptTraceControlSuffix,
} from "./browser/dom-trackers";
import {
  CHATGPT_PENDING_TOOL_EVIDENCE_STALL_MS,
  CHATGPT_TOOL_IN_FLIGHT_CEILING_MS,
  MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS,
  CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS,
  CHATGPT_EXTERNAL_PROGRESS_CLOCK_SKEW_MS,
  chatGptTurnIsComplete,
  type ChatGptSubmissionEvidence,
  chatGptSubmissionEvidence,
  type ChatGptConnectorAttachmentMode,
  chatGptConnectorAttachmentMode,
  chatGptNewTurnIdentity,
  chatGptReboundTurnIdentity,
  chatGptTurnIdentityLocatorSelector,
  ChatGptCompletionTracker,
  ChatGptTurnDomHealthTracker,
  ChatGptPendingToolEvidenceTracker,
  chatGptExternalProgressSuppressesDomHealth,
  type ChatGptVisibleTraceBlock,
  type ChatGptVisibleTraceEvent,
  type ChatGptResponseDomSnapshot,
  type ChatGptResponseDomCache,
  absentResponseDomSnapshot,
  ChatGptVisibleTraceTracker,
  isChatGptTraceControl,
  stripChatGptTraceControlSuffix,
} from "./browser/dom-trackers";
export {
  redactChatGptUiDiagnostic,
  sanitizeChatGptBrowserDiagnosticState,
  CHATGPT_BROWSER_DIAGNOSTIC_TRACE_LIMIT,
  browserDiagnosticCheckpoint,
  ChatGptBrowserDiagnostics,
  pruneBrowserDiagnostics,
} from "./browser/diagnostics";
import {
  redactChatGptUiDiagnostic,
  sanitizeChatGptBrowserDiagnosticState,
  CHATGPT_BROWSER_DIAGNOSTIC_TRACE_LIMIT,
  browserDiagnosticCheckpoint,
  ChatGptBrowserDiagnostics,
  pruneBrowserDiagnostics,
} from "./browser/diagnostics";
export {
  setChatGptThinkMode,
  chatGptImageFilePayloads,
  chatGptPromptFilePayloads,
  insertPlainTextIntoComposer,
  normalizePromptForComparison,
} from "./browser/payloads";
import {
  setChatGptThinkMode,
  chatGptImageFilePayloads,
  chatGptPromptFilePayloads,
  insertPlainTextIntoComposer,
  normalizePromptForComparison,
  assertChatGptPromptAttachments,
} from "./browser/payloads";
export {
  type ResolvedBrowserConfig,
  resolveBrowserConfig,
} from "./browser/config";
import {
  type ResolvedBrowserConfig,
  resolveBrowserConfig,
} from "./browser/config";
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
  promptUnitsEquivalent,
  promptTextEquivalent,
  promptEquivalentPrefixLength,
} from "./browser/prompt-equivalence";
import {
  promptCodeUnitEquivalent,
  promptUnitsEquivalent,
  promptTextEquivalent,
  promptEquivalentPrefixLength,
} from "./browser/prompt-equivalence";
export {
  chatGptSelectedConnectorControl,
  chatGptConnectorIsSelected,
  chatGptConnectorMentionRowTitles,
  chatGptConnectorMentionFailure,
  chatGptRowIsHighlighted,
  CHATGPT_ATTACHMENT_INPUT_SELECTOR,
  CHATGPT_MENTION_MENU_ROWS_SELECTOR,
  type ChatGptConnectorMentionFailureOptions,
} from "./browser/connectors";
import {
  chatGptSelectedConnectorControl,
  chatGptConnectorIsSelected,
  chatGptConnectorMentionRowTitles,
  chatGptConnectorMentionFailure,
  chatGptRowIsHighlighted,
  CHATGPT_ATTACHMENT_INPUT_SELECTOR,
  CHATGPT_MENTION_MENU_ROWS_SELECTOR,
} from "./browser/connectors";
export {
  chatGptActiveComposer,
  chatGptClearComposerState,
  type ChatGptClearComposerOptions,
} from "./browser/composer";
import {
  chatGptActiveComposer,
  chatGptClearComposerState,
  chatGptReuseCleanConnector,
} from "./browser/composer";
export const MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS = 3;
const CHATGPT_CONNECTOR_MENTION_QUERY = "@codex";
const CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS = 10_000;
const CHATGPT_SMOKE_TEXT = "Reply with exactly: CODEX WEB GPT READY";
const CHATGPT_SMOKE_EXPECTED = "CODEX WEB GPT READY";
export const CHATGPT_SEND_ENABLE_GRACE_MS = 5_000;

const CHATGPT_DOM_REVISION_ATTRIBUTES = [
  "aria-hidden",
  "aria-label",
  "aria-busy",
  "aria-disabled",
  "aria-expanded",
  "class",
  "data-item-anchor",
  "data-is-last-node",
  "data-message-author-role",
  "data-state",
  "data-streaming-response-status",
  "data-testid",
  "data-turn",
  "data-turn-id",
  "data-turn-id-container",
  // New ChatGPT UI (2025+) attributes replacing data-turn-id / data-turn-id-container
  "data-turn-key",
  "data-conversation-role",
  "data-chatgpt-agent-turn-start",
  "data-content-search-unit-key",
  "data-user-message-bubble",
  "data-markdown-text-style",
  "data-markdown-text-tone",
  "disabled",
  "hidden",
  "inert",
  "open",
  "role",
  "start",
  "style",
] as const;

class ChatGptConnectorCatalogStaleError extends Error {
  constructor(
    readonly appName: string,
    readonly triggerAttempts: number,
  ) {
    super(`ChatGPT connector catalog is missing ${JSON.stringify(appName)}`);
    this.name = "ChatGptConnectorCatalogStaleError";
  }
}

interface ChatGptConnectorAttemptBudget {
  triggerAttempts: number;
}

const CHATGPT_MODEL_CONTROL_UNAVAILABLE_MESSAGE = "ChatGPT model controls are unavailable. Reload ChatGPT and retry the task.";

function chatGptModelControlUnavailableError(diagnostic: string): Error {
  return new Error(CHATGPT_MODEL_CONTROL_UNAVAILABLE_MESSAGE, { cause: new Error(diagnostic) });
}

function chatGptModelControlUnavailableAdapterError(diagnostic: string, detail?: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    detail ? `${CHATGPT_MODEL_CONTROL_UNAVAILABLE_MESSAGE} ChatGPT: ${detail}` : CHATGPT_MODEL_CONTROL_UNAVAILABLE_MESSAGE,
    {
      status: 502,
      errorType: "server_error",
      code: "upstream_server_error",
      retryable: false,
      cause: new Error(diagnostic),
    },
  );
}



type SelectedChatGptWebModelMode = ChatGptWebModelMode & {
  modelFamily?: "5.6" | "6";
  selection?: { url: string; label: string };
  usageModel?: ChatGptUsageModel;
};


async function waitForOperationalChatGptViewport(page: Page, signal?: AbortSignal): Promise<void> {
  try {
    await withBrowserTurnAbort(page.waitForFunction(
      ({ width, height }) => innerWidth >= width && innerHeight >= height,
      CHATGPT_MIN_OPERATIONAL_VIEWPORT,
      { polling: 50, timeout: 10_000 },
    ), signal);
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

interface ChatGptSubmissionBaseline {
  userTurns: Locator;
  responseTurns: Locator;
  initialTurnIdentities: readonly string[];
  domCache: ChatGptSubmissionDomCache;
  submittedText?: string;
  acceptedUserIdentity?: string;
}

interface ChatGptSubmissionObservationRecovery {
  page: Page;
  baseline: ChatGptSubmissionBaseline;
}

type ChatGptObservationRecovery = (
  attempt: number,
  cause: ChatGptBrowserObservationTimeoutError,
  baseline: ChatGptSubmissionBaseline,
  abortSignal?: AbortSignal,
) => Promise<ChatGptSubmissionObservationRecovery>;

interface ChatGptAssistantTurnBinding {
  identity: string;
  locator: Locator;
  acceptedTurnIdentities: readonly string[];
  /** User turn identities at the time of binding (for detecting new user turns in the new UI) */
  acceptedUserIdentities?: readonly string[];
}

interface ChatGptSubmissionDomState {
  userTurnCount: number;
  assistantTurnCount: number;
  visibleStopButtonCount: number;
  turnIdentities: string[];
  userIdentities: string[];
  responseIdentities: string[];
}

interface ChatGptSubmissionDomCache {
  key?: string;
  snapshot?: ChatGptSubmissionDomState;
  fullScans?: number;
  cacheHits?: number;
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
  private managedBrowserReady?: Promise<{ browser: Browser; context: BrowserContext }>;
  private launcherHelper?: LauncherBrowserHelperClient;
  private maintenanceTail: Promise<void> = Promise.resolve();
  private readonly activeRuns = new Map<string, Promise<string>>();
  private readonly contextPressureByConversation = new Map<string, ChatGptBrowserContextPressure>();
  private readonly contextPressureByPage = new WeakMap<Page, ChatGptBrowserContextPressure>();
  private readonly pageDomObserver = new ChatGptPageDomObserver();

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

  /**
   * Lexical/contenteditable may preserve runs of ASCII spaces by exposing some of them as NBSP
   * through DOM textContent. Treat that DOM-only representation as equivalent only when the
   * expected U+0020 belongs to a multi-space run. Single spaces, tabs, newlines, intentional
   * expected NBSP characters, and every other mutation remain exact and fail closed.
   */
  private promptCodeUnitEquivalent(
    expected: string,
    observed: string,
    index: number,
  ): boolean {
    return promptCodeUnitEquivalent(expected, observed, index);
  }

  private promptUnitsEquivalent(
    expected: string,
    observed: string,
  ): boolean {
    return promptUnitsEquivalent(expected, observed);
  }

  private promptTextEquivalent(
    expected: string,
    observed: string,
  ): boolean {
    return promptTextEquivalent(expected, observed);
  }

  private promptEquivalentPrefixLength(
    expected: string,
    observed: string,
  ): number {
    return promptEquivalentPrefixLength(expected, observed);
  }

  run(turn: BrowserTurn): Promise<string> {
    if (this.activeRuns.has(turn.traceId)) {
      return Promise.reject(new Error(`Duplicate ChatGPT web browser turn: ${turn.traceId}`));
    }
    const maxRuns = this.config.browserHost === "launcher"
      ? MAX_CHATGPT_LAUNCHER_PENDING_TURNS
      : MAX_CHATGPT_BROWSER_TABS;
    if (this.activeRuns.size >= maxRuns) {
      return Promise.reject(new Error(
        `ChatGPT Web supports at most ${maxRuns} simultaneous browser turns; close or finish a browser tab before starting another`,
      ));
    }
    const useHelper = this.config.browserHost === "launcher" && process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS !== "1";
    if (useHelper) {
      this.launcherHelper ??= new LauncherBrowserHelperClient(this.config);
    }
    const run = Promise.resolve().then(() => useHelper ? this.launcherHelper!.run(turn) : this.runExclusive(turn));
    this.activeRuns.set(turn.traceId, run);
    void run.finally(() => {
      if (this.activeRuns.get(turn.traceId) === run) this.activeRuns.delete(turn.traceId);
    }).catch(() => {});
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
    const operation = this.maintenanceTail.then(() => {
      if (this.activeRuns.size > 0) {
        throw new Error(`ChatGPT ${name} requires all browser turns to finish`);
      }
      return action();
    });
    this.maintenanceTail = operation.then(() => undefined, () => undefined);
    return operation;
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
    chatGptSuspensionClock.start();
    const startedAt = performance.now();
    const suspendedAtStart = suspensionClock.suspendedMs();
    console.info(`[chatgpt-web] browser turn ${traceId} stage=${stage} started`);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stageTimedOut = false;
    let actionPromise: Promise<T> | undefined;
    try {
      const timeout = new Promise<never>((_, rejectTimeout) => {
        const fireOrRearm = () => {
          // A stage that spans a system sleep has not consumed its budget: the browser was as
          // frozen as this process, so slept time is refunded before the timer is re-armed.
          const suspendedMs = suspensionClock.suspendedMs() - suspendedAtStart;
          const remaining = remainingStageBudgetMs(timeoutMs, performance.now() - startedAt, suspendedMs);
          if (remaining > 0) {
            timer = setTimeout(fireOrRearm, remaining);
            return;
          }
          stageTimedOut = true;
          controller.abort();
          rejectTimeout(new Error(`ChatGPT browser stage timed out: ${stage}`));
        };
        timer = setTimeout(fireOrRearm, timeoutMs);
      });
      actionPromise = action(controller.signal);
      const value = await Promise.race([actionPromise, timeout]);
      console.info(`[chatgpt-web] browser turn ${traceId} stage=${stage} completed durationMs=${Math.round(performance.now() - startedAt)}`);
      return value;
    } catch (error) {
      let surfacedError = error;
      if (stageTimedOut && awaitAbortedActionSettlement && actionPromise) {
        try {
          await actionPromise;
        } catch (settlementError) {
          if (settlementError instanceof ChatGptPersistentBrowserStateError) {
            surfacedError = settlementError;
          }
        }
      }
      console.error(`[chatgpt-web] browser turn ${traceId} stage=${stage} failed durationMs=${Math.round(performance.now() - startedAt)}: ${surfacedError instanceof Error ? surfacedError.message : String(surfacedError)}`);
      throw surfacedError;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (this.config.browserHost === "launcher") {
      const connection = await connectLauncherBrowserHost(this.config.browserHostDescriptorPath!);
      this.browser = connection.browser;
      this.context = connection.context;
      this.page = connection.page;
      return this.page;
    }
    if (!existsSync(this.config.storageStatePath) || !existsSync(loginVerificationMarkerPath(this.config.storageStatePath))) {
      throw new Error(`ChatGPT web login state is missing: ${this.config.storageStatePath}`);
    }
    if (!existsSync(this.config.chromeExecutablePath)) {
      throw new Error(`Configured Chrome executable does not exist: ${this.config.chromeExecutablePath}`);
    }
    this.browser = await chromium.launch({
      executablePath: this.config.chromeExecutablePath,
      headless: !this.config.headed,
    });
    this.context = await this.browser.newContext({ storageState: this.config.storageStatePath });
    this.page = await this.context.newPage();
    return this.page;
  }

  private async ensureManagedBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
    if (this.managedBrowserReady) return this.managedBrowserReady;
    const opening = (async () => {
      if (!existsSync(this.config.storageStatePath) || !existsSync(loginVerificationMarkerPath(this.config.storageStatePath))) {
        throw new Error(`ChatGPT web login state is missing: ${this.config.storageStatePath}`);
      }
      if (!existsSync(this.config.chromeExecutablePath)) {
        throw new Error(`Configured Chrome executable does not exist: ${this.config.chromeExecutablePath}`);
      }
      const browser = await chromium.launch({
        executablePath: this.config.chromeExecutablePath,
        headless: !this.config.headed,
      });
      const context = await browser.newContext({ storageState: this.config.storageStatePath });
      this.browser = browser;
      this.context = context;
      return { browser, context };
    })();
    this.managedBrowserReady = opening;
    try {
      return await opening;
    } catch (error) {
      if (this.managedBrowserReady === opening) this.managedBrowserReady = undefined;
      throw error;
    }
  }

  /**
   * A Codex turn owns one isolated browser conversation. Reusing the same
   * ChatGPT SPA page can retain the previous transcript and autocomplete DOM,
   * so an @app lookup may select stale UI from the preceding turn.
   */
  private async pageForNewTurn(): Promise<Page> {
    if (this.config.browserHost === "launcher") {
      throw new Error("Launcher turns require an explicitly leased browser surface");
    }
    const { context } = await this.ensureManagedBrowser();
    return await context.newPage();
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
    const mode = resolveChatGptWebModelMode(modelId, reasoning, capabilities);
    const composer = await this.activeComposer(page);
    const composerForm = composer.locator("xpath=ancestor::form[1]");
    const uiEffortIndex = mode.uiEffortIndex;
    if (uiEffortIndex === null) {
      await settleChatGptUi();
      await throwIfChatGptRateLimitDialog(page);
      const visibleControls = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).filter({ visible: true });
      if (await visibleControls.count() > 0) {
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
        currentEffort.waitFor({ state: "visible", timeout: 70_000, signal: effortWaitAbort.signal }).then(() => "effort" as const),
        chatGptRateLimitDialog(page).waitFor({ state: "visible", timeout: 70_000, signal: effortWaitAbort.signal }).then(() => "rate-limit" as const),
        chatGptExpiredSessionAlert(page).waitFor({ state: "visible", timeout: 70_000, signal: effortWaitAbort.signal }).then(() => "session-expired" as const),
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
    await settleChatGptUi();
    await throwIfChatGptRateLimitDialog(page);
    await captureDiagnostic?.("effort-control-ready");
    await throwIfChatGptRateLimitDialog(page);
    let activation = await activateChatGptEffortMenu(page, currentEffort);
    if (modelFamily) activation = await selectChatGptModelFamily(
      activation, modelFamily, () => activateChatGptEffortMenu(page, currentEffort),
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
        sliderContainer.waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal })
          .then(() => effortSlider.waitFor({ state: "attached", timeout: 70_000, signal: waitAbort.signal }))
          .then(() => "slider" as const),
        chatGptRateLimitDialog(page).waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal }).then(() => "rate-limit" as const),
        chatGptExpiredSessionAlert(page).waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal }).then(() => "session-expired" as const),
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
      const state = await readChatGptEffortSnapshot(container)
        .catch(error => { throw chatGptModelControlUnavailableAdapterError(String(error)); });
      if (uiEffortIndex > state.max - state.min) {
        const detail = uiEffortIndex === 4 ? await chatGptUnavailableProDetail(menu) : undefined;
        throw chatGptModelControlUnavailableAdapterError(
          `ChatGPT effort slider does not expose item index ${uiEffortIndex} (min=${state.min}; max=${state.max})`
          + (uiEffortIndex === 4 ? " ChatGPT may have temporarily hidden Pro because you reached its usage limit." : ""),
          detail,
        );
      }
      if (!state.available[uiEffortIndex]) {
        throw new ChatGptWebAdapterError(
          `ChatGPT locks the browser option requested for ${mode.displayLabel} behind an upgrade. `
          + "The message was not sent. Choose an available effort and run Repair Codex setup to refresh the model list.",
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
      const previousValue = sliderState.value;
      await sliderControl.press(key);
      const changeDeadline = Date.now() + 5_000;
      do {
        sliderState = await readAvailableEffort(sliderContainer, activation.menu);
        if (sliderState.min !== initialMin) {
          throw chatGptModelControlUnavailableError("ChatGPT changed its effort range origin during selection");
        }
        if (sliderState.value !== previousValue) break;
        await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
      } while (Date.now() < changeDeadline);
      if (sliderState.value !== previousValue + direction) {
        throw chatGptModelControlUnavailableError(
          `ChatGPT effort slider did not move exactly one step with ${key}`
          + ` (before=${previousValue}; after=${sliderState.value})`,
        );
      }
    }
    await settleChatGptUi();
    const selectedState = await readAvailableEffort(sliderContainer, activation.menu);
    if (selectedState.min !== initialMin || selectedState.value !== targetValue) {
      throw chatGptModelControlUnavailableAdapterError("ChatGPT changed its effort range or selection before the menu closed");
    }
    await captureDiagnostic?.("effort-selected");
    await page.keyboard.press("Escape");
    await settleChatGptUi();
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
      throw chatGptModelControlUnavailableAdapterError("ChatGPT did not persist the requested effort after closing its menu");
    }
    if (modelFamily) await assertChatGptModelFamily(confirmation, modelFamily, mode.effort, uiEffortIndex, 1_000);
    // A bare 'Pro' trigger does not identify the family selected by ChatGPT's Latest option.
    // Unknown evidence remains visible as unclassified Pro usage in Limits.
    if (trackUsage) {
      selectedMode.usageModel = await readChatGptUsageModel(confirmation.slider, mode.effort === "max")
        .catch(() => mode.effort === "max" ? "pro-unknown" as const : "other" as const);
    }
    await page.keyboard.press("Escape");
    await settleChatGptUi();
    await this.assertSelectedEffort(page, selectedMode, false);
    await captureDiagnostic?.("effort-selection-confirmed");
    return selectedMode;
  }

  private async assertSelectedEffort(page: Page, mode: SelectedChatGptWebModelMode, verifyFamily = true): Promise<void> {
    if (!mode.selection) return;
    const composer = await this.activeComposer(page);
    const controls = composer.locator("xpath=ancestor::form[1]")
      .locator(CHATGPT_EFFORT_CONTROL_SELECTOR).filter({ visible: true });
    if (page.url() !== mode.selection.url || !mode.selection.label || await controls.count() !== 1) {
      throw chatGptModelControlUnavailableAdapterError("ChatGPT changed the selected model's browser surface before submission");
    }
    const control = controls.first();
    if ((await control.innerText()).trim() !== mode.selection.label
      || await control.getAttribute("aria-expanded") !== "false"
      || !await composer.isEditable()) {
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
      }
      if (page.url() !== mode.selection.url || (await control.innerText()).trim() !== mode.selection.label
        || await control.getAttribute("aria-expanded") !== "false" || !await composer.isEditable()) {
        throw chatGptModelControlUnavailableAdapterError("ChatGPT changed the model while checking its family before submission");
      }
    }
  }

  private async activeComposer(
    page: Page,
    timeoutMs = 30_000,
    abortSignal?: AbortSignal,
  ): Promise<Locator> {
    return chatGptActiveComposer(page, timeoutMs, abortSignal);
  }

  /** Prepare a new conversation; account inspection still uses an empty Temporary Chat. */
  private async prepareChatSurface(
    page: Page,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    useSavedChats = false,
  ): Promise<Locator> {
    // Launcher verification refreshes its owned page before attaching Playwright so a newly added
    // connector is present in the catalog. Navigating again here destroys that freshly hydrated
    // document and made the first verification race a second SPA bootstrap. A leased turn starts on
    // about:blank and therefore still performs exactly one navigation through this same method.
    const targetUrl = chatGptNewChatUrl(useSavedChats);
    const existingTurnsPresent = page.url() === targetUrl && await (async () => {
      try {
        const u = page.locator(CHATGPT_USER_TURN_SELECTOR);
        const a = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR);
        const userCount = typeof u?.count === "function" ? await u.count().catch(() => 0) : 0;
        const assistantCount = typeof a?.count === "function" ? await a.count().catch(() => 0) : 0;
        return userCount > 0 || assistantCount > 0;
      } catch {
        return false;
      }
    })();
    if (page.url() !== targetUrl || existingTurnsPresent) {
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await captureDiagnostic?.(useSavedChats ? "saved-chat-navigation-complete" : "temporary-chat-navigation-complete");
    }
    const initialDismissed = await dismissAllChatGptOverlays(page, { captureDiagnostic }).catch(() => 0);
    if (initialDismissed > 0) {
      await captureDiagnostic?.("overlays-dismissed-before-composer");
    }
    // A failed page read is not evidence of an expired login. Preserve the actual
    // observation error; the authenticated-session check below owns login failures.
    const composer = await this.activeComposer(page);
    const postDismissed = await dismissAllChatGptOverlays(page, { captureDiagnostic }).catch(() => 0);
    if (postDismissed > 0 || (!useSavedChats && await dismissChatGptTemporaryChatOnboarding(page))) {
      await captureDiagnostic?.("temporary-chat-onboarding-dismissed");
    }
    await captureDiagnostic?.("composer-ready");
    await throwIfChatGptSessionFailureAlert(page);
    await assertAuthenticatedChatGptPage(page);
    await assertNewChatPage(page, useSavedChats);
    await captureDiagnostic?.("session-verified");
    if (typeof page.evaluate === "function") {
      await page.evaluate(() => {
        try {
          const desc = Object.getOwnPropertyDescriptor(Document.prototype, "title");
          if (desc && desc.set && !(desc.set as { __clamped?: boolean }).__clamped) {
            const originalSet = desc.set;
            const clampedSet = function (this: Document, value: string) {
              const clamped = typeof value === "string" && value.length > 200
                ? `${value.slice(0, 197)}...`
                : value;
              return originalSet.call(this, clamped);
            };
            (clampedSet as { __clamped?: boolean }).__clamped = true;
            Object.defineProperty(document, "title", {
              get: desc.get,
              set: clampedSet,
              configurable: true,
            });
          }
          const clampTitleElement = () => {
            const titleEl = document.querySelector("title");
            if (titleEl && (titleEl.textContent?.length ?? 0) > 200) {
              titleEl.textContent = `${titleEl.textContent!.slice(0, 197)}...`;
            }
          };
          clampTitleElement();
          const globalAny = globalThis as unknown as { __TITLE_OBSERVER_ATTACHED__?: boolean };
          if (!globalAny.__TITLE_OBSERVER_ATTACHED__) {
            globalAny.__TITLE_OBSERVER_ATTACHED__ = true;
            const titleObserver = new MutationObserver(() => clampTitleElement());
            const target = document.querySelector("title") || document.head;
            if (target) {
              titleObserver.observe(target, { childList: true, characterData: true, subtree: true });
            }
          }
          for (const el of document.querySelectorAll('[contenteditable="true"], textarea')) {
            el.setAttribute("spellcheck", "false");
            el.setAttribute("autocorrect", "off");
            el.setAttribute("autocapitalize", "off");
          }
        } catch {}
      }).catch(() => {});
    }
    return composer;
  }

  private async waitForTurnDomMutation(page: Page, timeoutMs = 250): Promise<void> {
    await page.evaluate(({ timeout, attributeFilter }) => new Promise<void>(resolveMutation => {
      let settled = false;
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timeoutTimer);
        if (settleTimer) clearTimeout(settleTimer);
        resolveMutation();
      };
      const observer = new MutationObserver(() => {
        if (settleTimer) return;
        // Let one React mutation batch finish before the next compact state read.
        settleTimer = setTimeout(finish, 150);
      });
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter,
      });
      const timeoutTimer = setTimeout(finish, timeout);
    }), { timeout: timeoutMs, attributeFilter: [...CHATGPT_DOM_REVISION_ATTRIBUTES] });
  }

  private async waitForTurnDomOrExternalProgress(
    page: Page,
    afterProgressRevision: number,
    externalProgress?: ChatGptTurnProgressReader,
    signal?: AbortSignal,
  ): Promise<void> {
    const domMutation = this.waitForTurnDomMutation(page);
    if (!externalProgress) {
      await withBrowserTurnAbort(domMutation, signal);
      return;
    }
    const progressWaitAbort = new AbortController();
    const progressSignal = signal
      ? AbortSignal.any([progressWaitAbort.signal, signal])
      : progressWaitAbort.signal;
    try {
      await withBrowserTurnAbort(Promise.race([
        domMutation,
        externalProgress.waitForChange(afterProgressRevision, progressSignal).then(() => undefined),
      ]), signal);
    } finally {
      progressWaitAbort.abort();
    }
  }

  private async waitForSubmissionAccepted(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    signal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    initialToolBatchRevision = externalProgress?.snapshot().lastToolBatchRevision ?? 0,
    completionTracker?: ChatGptCompletionTracker,
  ): Promise<ChatGptSubmissionEvidence> {
    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    for (;;) {
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      const progress = externalProgress?.snapshot();
      if (progress
        && externalProgress
        && completionTracker?.needsToolBatchObservation(progress.lastToolBatchRevision)) {
        const boundaryText = await this.currentSubmissionAnswerText(page, baseline, signal);
        completionTracker.observeToolBatch(progress.lastToolBatchRevision, boundaryText);
        await externalProgress.acknowledgeToolBatch(progress.lastToolBatchRevision);
      }
      if (progress && (progress.claimed || progress.lastToolBatchRevision > initialToolBatchRevision)) return "mcp_tool_call";
      await throwIfChatGptSessionFailureAlert(page);
      await throwIfChatGptRateLimitDialog(page);
      // Until the new response is bound, last() can still be a historical failed answer.
      // Response errors are checked against the bound current turn in the observation loops.
      let evidence: ChatGptSubmissionEvidence | undefined;
      if (externalProgress) {
        const progressWaitAbort = new AbortController();
        const progressSignal = signal
          ? AbortSignal.any([progressWaitAbort.signal, signal])
          : progressWaitAbort.signal;
        try {
          const observed = await withBrowserTurnAbort(Promise.race([
            this.currentSubmissionEvidence(page, baseline, signal)
              .then(value => ({ kind: "dom" as const, value }))
              .catch(error => {
                if (error instanceof ChatGptBrowserObservationTimeoutError) {
                  return { kind: "dom_timeout" as const, error };
                }
                throw error;
              }),
            externalProgress.waitForChange(progress?.revision ?? 0, progressSignal)
              .then(() => ({ kind: "external" as const })),
          ]), signal);
          if (observed.kind === "external") continue;
          if (observed.kind === "dom_timeout") {
            const latestProgress = externalProgress.snapshot();
            if (latestProgress.claimed || chatGptExternalProgressIsLive(latestProgress, Date.now(), CHATGPT_RESPONSE_DOM_GRACE_MS)) {
              continue;
            }
            throw observed.error;
          }
          evidence = observed.value;
        } finally {
          progressWaitAbort.abort();
        }
      } else {
        evidence = await this.currentSubmissionEvidence(page, baseline, signal);
      }
      if (evidence) return evidence;
      await this.waitForTurnDomOrExternalProgress(
        page,
        progress?.revision ?? 0,
        externalProgress,
        signal,
      );
    }
  }

  private async submissionDomState(
    page: Page,
    cache?: ChatGptSubmissionDomCache,
    signal?: AbortSignal,
  ): Promise<ChatGptSubmissionDomState> {
    throwIfPromptAttachmentAborted(signal);
    const observed = await withChatGptBrowserObservationTimeout(withBrowserTurnAbort(page.evaluate(options => {
      type ObserverState = { id: string; revision: number; observer: MutationObserver };
      const scope = globalThis as typeof globalThis & {
        __CODEX_WEB_GPT_TURN_OBSERVER__?: ObserverState;
      };
      const observerState = scope.__CODEX_WEB_GPT_TURN_OBSERVER__ ??= (() => {
        const state: ObserverState = {
          id: `${performance.timeOrigin}:${Math.random().toString(36).slice(2)}`,
          revision: 0,
          observer: undefined as unknown as MutationObserver,
        };
        state.observer = new MutationObserver(() => {
          state.revision += 1;
        });
        state.observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: options.attributeFilter,
        });
        return state;
      })();
      const observerKey = `${observerState.id}:${observerState.revision}`;
      if (options.knownKey === observerKey) return { key: observerKey };
      const identities = (elements: Element[], attribute: string): string[] => {
        const values = elements.map(element => element.getAttribute(attribute));
        if (values.some(value => typeof value !== "string" || value.trim().length === 0)) {
          throw new Error(`ChatGPT conversation turn has no stable ${attribute} identity`);
        }
        const typed = values as string[];
        if (new Set(typed).size !== typed.length) {
          throw new Error("ChatGPT exposed duplicate conversation turn identities");
        }
        return typed;
      };
      const visible = (element: Element): boolean => {
        const candidate = element as HTMLElement;
        if (!candidate.isConnected) return false;
        if (typeof candidate.checkVisibility === "function") {
          return candidate.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        }
        const style = getComputedStyle(candidate);
        const bounds = candidate.getBoundingClientRect();
        return style.visibility !== "hidden"
          && (bounds.width > 0 || bounds.height > 0);
      };
      // data-testid contains a display index: ChatGPT can renumber it while the same turn lives.
      // Virtualization removes a turn's section, but retains its outer identity container.
      // New ChatGPT UI (2025+) uses data-turn-key instead of data-turn-id-container.
      // It uses data-chatgpt-search-unit-key (ending in ":user"/":assistant") for individual turns,
      // and data-chatgpt-selection-message-id for the stable UUID identity of assistant messages.

      const containers = [...document.querySelectorAll("[data-turn-id-container]")].filter(element =>
        !element.closest?.("[data-turn-key]")
        && element.parentElement?.closest("[data-turn-id-container]")?.getAttribute("data-turn-id-container")
          !== element.getAttribute("data-turn-id-container"));
      const turnIdentities = identities(containers, "data-turn-id-container");
      const legacyTurns = (selector: string) => [...document.querySelectorAll(selector)]
        .filter(element => element.getAttribute("data-turn-key") == null && !element.closest?.("[data-turn-key]"));
      const userIdentities = identities(legacyTurns(options.userTurnSelector), "data-turn-id");
      const responseIdentities = identities(legacyTurns(options.assistantTurnSelector), "data-turn-id");
      const knownTurns = new Set(turnIdentities);
      if ([...userIdentities, ...responseIdentities].some(identity => !knownTurns.has(identity))) {
        throw new Error("ChatGPT conversation turn has no matching identity container");
      }
      const groups = [...document.querySelectorAll("[data-turn-key]")];
      const groupKeys = identities(groups, "data-turn-key");
      groups.forEach((group, index) => {
        const user = `group:user:${groupKeys[index]}`;
        const assistant = `group:assistant:${groupKeys[index]}`;
        // Keep both logical roles in the baseline even when virtualization unmounts their
        // contents. Remounting an old answer must never acknowledge a new submission.
        turnIdentities.push(user, assistant);
        if (group.querySelector("[data-user-message-bubble]")) userIdentities.push(user);
        if (group.querySelector('[data-conversation-role="assistant"], [data-chatgpt-agent-turn-start]')) responseIdentities.push(assistant);
      });

      return {
        key: observerKey,
        snapshot: {
          userTurnCount: userIdentities.length,
          assistantTurnCount: responseIdentities.length,
          visibleStopButtonCount: [...document.querySelectorAll(options.stopButtonSelector)].filter(visible).length,
          turnIdentities,
          userIdentities,
          responseIdentities,
        },
      };
    }, {
      userTurnSelector: CHATGPT_USER_TURN_SELECTOR,
      assistantTurnSelector: CHATGPT_ASSISTANT_TURN_SELECTOR,
      stopButtonSelector: CHATGPT_STOP_BUTTON_SELECTOR,
      knownKey: cache?.key,
      attributeFilter: [...CHATGPT_DOM_REVISION_ATTRIBUTES],
    }), signal));
    const snapshot = observed.snapshot ?? cache?.snapshot;
    if (!snapshot) throw new Error("ChatGPT turn DOM revision cache has no baseline snapshot");
    if (observed.snapshot && cache) {
      cache.key = observed.key;
      cache.snapshot = observed.snapshot;
      cache.fullScans = (cache.fullScans ?? 0) + 1;
    } else if (!observed.snapshot && cache?.snapshot) {
      cache.cacheHits = (cache.cacheHits ?? 0) + 1;
    }
    return snapshot;
  }

  private async currentSubmissionEvidence(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    signal?: AbortSignal,
  ): Promise<ChatGptSubmissionEvidence | undefined> {
    const state = await this.submissionDomState(page, baseline.domCache, signal);
    const evidence = chatGptSubmissionEvidence({
      initialTurnIdentities: baseline.initialTurnIdentities,
      userIdentities: state.userIdentities,
      responseIdentities: state.responseIdentities,
      generationRunning: state.visibleStopButtonCount > 0,
    });
    if (evidence === "user_turn") {
      // Activity can temporarily replace this group before the assistant is mounted.
      // Preserve the identity that acknowledged Send, independently of rendered text.
      const identity = chatGptNewTurnIdentity(baseline.initialTurnIdentities, state.userIdentities)!;
      if (baseline.acceptedUserIdentity && baseline.acceptedUserIdentity !== identity) {
        throw new Error("ChatGPT changed the user turn that acknowledged the submission");
      }
      baseline.acceptedUserIdentity = identity;
    }
    return evidence;
  }

  private async currentSubmissionAnswerText(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      const state = await this.submissionDomState(page, baseline.domCache, signal);
      const identity = chatGptNewTurnIdentity(
        baseline.initialTurnIdentities,
        state.responseIdentities,
      );
      if (!identity) return "";
      const locator = page.locator(chatGptAssistantTurnSelector(identity));
      return (await withChatGptBrowserObservationTimeout(
        this.responseDomSnapshot(locator, {}),
        3_000,
      )).visibleText;
    } catch {
      return "";
    }
  }

  private async captureSubmissionBaseline(page: Page, submittedText?: string): Promise<ChatGptSubmissionBaseline> {
    const userTurns = page.locator(CHATGPT_USER_TURN_SELECTOR);
    const responseTurns = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR);
    const domCache: ChatGptSubmissionDomCache = {};
    const state = await this.submissionDomState(page, domCache);
    return {
      userTurns,
      responseTurns,
      initialTurnIdentities: state.turnIdentities,
      domCache,
      submittedText,
    };
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
  ): Promise<ChatGptAssistantTurnBinding> {
    let observationPage = page;
    let observationBaseline = baseline;
    let recoveryAttempts = 0;
    let responseDeadline = Math.min(
      deadline ?? Number.POSITIVE_INFINITY,
      Date.now() + graceMs,
    );
    for (;;) {
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      if (observationPage.isClosed()) throw chatGptBrowserTabClosedError();
      let progress = externalProgress?.snapshot();
      if (progress?.lastProgressAt !== undefined) {
        responseDeadline = Math.min(
          deadline ?? Number.POSITIVE_INFINITY,
          Math.max(responseDeadline, progress.lastProgressAt + graceMs),
        );
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new Error("ChatGPT web turn timed out");
      }
      await throwIfChatGptSessionFailureAlert(observationPage);
      await throwIfChatGptRateLimitDialog(observationPage);
      let state: ChatGptSubmissionDomState;
      try {
        state = await this.submissionDomState(
          observationPage,
          observationBaseline.domCache,
          signal,
        );
      } catch (error) {
        const latestProgress = externalProgress?.snapshot();
        if (chatGptExternalProgressIsLive(latestProgress, Date.now(), graceMs)) {
          await this.waitForTurnDomOrExternalProgress(
            observationPage,
            latestProgress?.revision ?? 0,
            externalProgress,
            signal,
          );
          continue;
        }
        if (error instanceof ChatGptBrowserObservationTimeoutError && recoverObservation) {
          recoveryAttempts += 1;
          if (recoveryAttempts > MAX_CHATGPT_BROWSER_PAGE_REBINDS) {
            throw new Error(
              `ChatGPT accepted the message, but its DOM remained unresponsive after ${MAX_CHATGPT_BROWSER_PAGE_REBINDS} same-page rebinds`,
              { cause: error },
            );
          }
          const recovered = await recoverObservation(
            recoveryAttempts,
            error,
            observationBaseline,
            signal,
          );
          observationPage = recovered.page;
          observationBaseline = recovered.baseline;
          continue;
        }
        if (!chatGptExternalProgressIsLive(latestProgress, Date.now(), graceMs)) throw error;
        await this.waitForTurnDomOrExternalProgress(
          observationPage,
          latestProgress?.revision ?? 0,
          externalProgress,
          signal,
        );
        continue;
      }
      recoveryAttempts = 0;
      // A tool batch can arrive while the DOM probe is in flight. Read progress again before
      // acknowledging its boundary; the pre-probe snapshot can otherwise leave the broker waiting
      // despite this exact iteration having successfully observed the page.
      progress = externalProgress?.snapshot();
      const identity = chatGptNewTurnIdentity(
        observationBaseline.initialTurnIdentities,
        state.responseIdentities,
      );
      if (progress
        && externalProgress
        && completionTracker?.needsToolBatchObservation(progress.lastToolBatchRevision)) {
        let boundaryText = "";
        try {
          boundaryText = identity
            ? (await withChatGptBrowserObservationTimeout(
              this.responseDomSnapshot(
                observationPage.locator(chatGptAssistantTurnSelector(identity)),
                {},
              ),
              3_000,
            )).visibleText
            : "";
        } catch {
          boundaryText = "";
        }
        completionTracker.observeToolBatch(progress.lastToolBatchRevision, boundaryText);
        await externalProgress.acknowledgeToolBatch(progress.lastToolBatchRevision);
      }
      if (identity) return {
        identity,
        locator: observationPage.locator(chatGptAssistantTurnSelector(identity)),
        acceptedTurnIdentities: state.turnIdentities,
      };
      // The power UI can expose Stop for a long reasoning phase before mounting any assistant
      // node. Fresh generation evidence extends only DOM grace, never the caller's deadline.
      if (state.visibleStopButtonCount > 0) {
        responseDeadline = Math.min(deadline ?? Number.POSITIVE_INFINITY, Date.now() + graceMs);
      }
      // A delayed renderer wake can cross the grace while the assistant appears. Only a fresh
      // observation can prove it is still missing; the explicit turn deadline remains above.
      if (Date.now() >= responseDeadline
        && !chatGptExternalProgressSuppressesDomHealth(progress, Date.now())) {
        throw new Error("ChatGPT accepted the message but did not expose its assistant turn in the DOM");
      }
      await this.waitForTurnDomOrExternalProgress(
        observationPage,
        progress?.revision ?? 0,
        externalProgress,
        signal,
      );
    }
  }

  private async reconcileAssistantTurnBinding(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    binding: ChatGptAssistantTurnBinding,
    signal?: AbortSignal,
  ): Promise<ChatGptAssistantTurnBinding> {
    const boundCount = await withChatGptBrowserObservationTimeout(
      withBrowserTurnAbort(binding.locator.count(), signal),
    );
    if (boundCount === 1) return binding;
    if (boundCount > 1) {
      throw new Error(`ChatGPT exposed ${boundCount} DOM nodes for the bound assistant turn`);
    }
    const state = await this.submissionDomState(page, baseline.domCache, signal);
    const acceptedTurns = new Set(binding.acceptedTurnIdentities);
    const identity = chatGptReboundTurnIdentity(
      baseline.initialTurnIdentities,
      binding.identity,
      state.responseIdentities,
    );
    const newUsers = state.userIdentities.filter(identity => !acceptedTurns.has(identity));
    if (newUsers.length > 0) {
      // Activity can unmount the accepted user group while it renders a temporary
      // assistant group. Its return must match the ID that acknowledged Send. If no
      // user ID was observed then, require the entire submitted text instead. A
      // surviving old group or any competing new turn remains foreign.
      const user = newUsers[0]!;
      const replacement = identity && newUsers.length === 1
        && binding.identity.startsWith("group:assistant:")
        && user.startsWith("group:user:")
        && identity === `group:assistant:${user.slice("group:user:".length)}`
        && !state.turnIdentities.includes(binding.identity)
        && state.turnIdentities.every(turn => acceptedTurns.has(turn) || turn === user || turn === identity);
      let matches = false;
      if (replacement) {
        const locator = page.locator(chatGptAssistantTurnSelector(identity!));
        matches = baseline.acceptedUserIdentity
          ? user === baseline.acceptedUserIdentity
          : Boolean(baseline.submittedText) && await withChatGptBrowserObservationTimeout(withBrowserTurnAbort(locator.evaluate((group, submitted) => {
          const bubbles = group.querySelectorAll<HTMLElement>("[data-user-message-bubble]");
          const contents = bubbles.length === 1
            ? bubbles[0]!.querySelectorAll<HTMLElement>("[data-search-result-target]")
            : [];
          const normalize = (text: string) => text.replace(/\r\n?/g, "\n");
          // The bubble also contains Show more and accessibility spacing. Only its
          // observed message-content target represents the submitted prompt.
          return contents.length === 1 && normalize(contents[0]!.innerText) === normalize(submitted);
        }, baseline.submittedText!), signal));
        if (matches) {
          const response = await this.responseDomSnapshot(locator, {});
          matches = response.responsePresent && response.completionActionVisible;
        }
      }
      if (!matches) throw new Error("ChatGPT opened another user turn while the bound assistant response was detached");
    }
    if (!identity || identity === binding.identity) {
      return {
        ...binding,
        acceptedTurnIdentities: state.turnIdentities,
      };
    }
    return {
      identity,
      locator: page.locator(chatGptAssistantTurnSelector(identity)),
      acceptedTurnIdentities: state.turnIdentities,
    };
  }

  private async attachedPromptText(page: Page, abortSignal?: AbortSignal): Promise<string> {
    const composer = await this.activeComposer(page, 30_000, abortSignal);
    return composer.evaluate((element, appName) => {
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
      for (const part of Array.from(clone.querySelectorAll('[data-inline-selection-pill-cursor-target]'))) {
        if (typeof part.remove === "function") part.remove();
        else part.parentNode?.removeChild(part);
      }
      const slug = (appName ?? "").toLowerCase().replace(/\s+/g, "-");
      for (const part of Array.from(clone.querySelectorAll(
        '[data-id^="plugin:"], [app-mention-display-name], [data-prompt-link-label], [class*="Mention-"]',
      ))) {
        const text = (part.textContent ?? "").trim();
        const kw = part.getAttribute("data-keyword")
          ?? part.getAttribute("app-mention-display-name")
          ?? part.getAttribute("data-prompt-link-label")
          ?? "";
        if (
          !appName
          || kw === appName
          || kw === `$${slug}`
          || text === `@${appName}`
          || text === `$${appName}`
          || (slug && (text.toLowerCase() === `@${slug}` || text.toLowerCase() === `$${slug}`))
        ) {
          if (typeof part.remove === "function") part.remove();
          else part.parentNode?.removeChild(part);
        }
      }
      return [...clone.childNodes]
        .map(child => child.textContent ?? "")
        .join("\n")
        .trimStart();
    }, this.config?.appName, { timeout: 20_000, signal: abortSignal });
  }

  private async assertPromptAttached(
    page: Page,
    prompt: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + 10_000;
    let observed = "";
    while (Date.now() < deadline) {
      throwIfPromptAttachmentAborted(abortSignal);
      observed = await this.attachedPromptText(page, abortSignal);
      throwIfPromptAttachmentAborted(abortSignal);
      if (this.promptTextEquivalent(prompt, observed)) return;
      await withBrowserTurnAbort(
        new Promise(resolveSleep => setTimeout(resolveSleep, 200)),
        abortSignal,
      );
    }
    throwIfPromptAttachmentAborted(abortSignal);
    const commonPrefix = this.promptEquivalentPrefixLength(prompt, observed);
    throw new ChatGptPromptAttachmentIntegrityError(
      `ChatGPT composer did not preserve the complete prompt (expectedChars=${prompt.length}, actualChars=${observed.length}, commonPrefixChars=${commonPrefix})`,
    );
  }

  private selectedConnectorControl(composer: Locator): Locator {
    return chatGptSelectedConnectorControl(composer, this.config.appName);
  }

  private async connectorIsSelected(composer: Locator, abortSignal?: AbortSignal): Promise<boolean> {
    return chatGptConnectorIsSelected(composer, this.config.appName, abortSignal);
  }

  private async connectorMentionRowTitles(
    menuRows: Locator,
    abortSignal?: AbortSignal,
  ): Promise<string[]> {
    return chatGptConnectorMentionRowTitles(menuRows, abortSignal);
  }

  private async connectorMentionFailure(
    menuRows: Locator,
    triggerAttempts: number,
    abortSignal?: AbortSignal,
    page?: Page,
  ): Promise<string> {
    return chatGptConnectorMentionFailure(menuRows, triggerAttempts, {
      appName: this.config?.appName,
      abortSignal,
      page,
      fetchRowTitles: typeof this?.connectorMentionRowTitles === "function"
        ? (rows, signal) => this.connectorMentionRowTitles(rows, signal)
        : undefined,
    });
  }

  private async clearChatGptComposerState(page: Page): Promise<void> {
    return chatGptClearComposerState(page, {
      appName: this.config?.appName,
      activeComposer: typeof this?.activeComposer === "function"
        ? (p, t, s) => this.activeComposer(p, t, s)
        : undefined,
      connectorIsSelected: typeof this?.connectorIsSelected === "function"
        ? (c, s) => this.connectorIsSelected(c, s)
        : undefined,
    });
  }

  private async selectConnector(
    page: Page,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    catalogRefreshAvailable = false,
    attemptBudget: ChatGptConnectorAttemptBudget = { triggerAttempts: 0 },
    abortSignal?: AbortSignal,
    hasExistingTurns = false,
  ): Promise<Locator> {
    const capture = async (checkpoint: string): Promise<void> => {
      throwIfPromptAttachmentAborted(abortSignal);
      await withBrowserTurnAbort(captureDiagnostic?.(checkpoint) ?? Promise.resolve(), abortSignal);
      throwIfPromptAttachmentAborted(abortSignal);
    };
    let composer: Locator;
    const menuRows = page.locator(CHATGPT_MENTION_MENU_ROWS_SELECTOR);
    const appResult = menuRows.filter({
      has: page.getByText(this.config.appName, { exact: true }),
    });
    const pageUrl = page.url();
    const isTemporaryChat = Boolean(pageUrl && new URL(pageUrl, "https://chatgpt.com").searchParams.get("temporary-chat") === "true");
    if (isTemporaryChat && !hasExistingTurns) await ensureChatGptPersonalizedConnectorAccess(
      page,
      capture,
      async (personalizationSignal) => {
        let proofResult: boolean | undefined;
        let proofError: unknown;
        try {
          composer = await this.activeComposer(page, 30_000, personalizationSignal);
          await composer.fill("", {
            signal: personalizationSignal,
            timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
          });
          if (typeof page?.bringToFront === "function") {
            await page.bringToFront().catch(() => {});
          }
          await composer.focus({
            signal: personalizationSignal,
            timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
          });
          await withBrowserTurnAbort(settleChatGptUi(), personalizationSignal);
          await composer.pressSequentially(CHATGPT_CONNECTOR_MENTION_QUERY, {
            delay: 25,
            signal: personalizationSignal,
            timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
          });
          await capture("personalization-proof-mention-triggered");
          try {
            await appResult.waitFor({ state: "visible", timeout: 2_500, signal: personalizationSignal });
            proofResult = true;
            await capture("personalization-proof-menu-visible");
          } catch (error) {
            if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
            proofResult = false;
            await capture("personalization-proof-menu-missing");
            const mention = await composer.evaluate(element => ({
              text: element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
                ? element.value : element.textContent ?? "",
              focused: element === document.activeElement,
            }), undefined, { timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS, signal: personalizationSignal });
            if (mention.text !== CHATGPT_CONNECTOR_MENTION_QUERY) {
              throw new ChatGptPromptAttachmentIntegrityError(
                `ChatGPT did not preserve the connector mention (expectedChars=${CHATGPT_CONNECTOR_MENTION_QUERY.length}, actualChars=${mention.text.length}, focused=${mention.focused})`,
              );
            }
          }
        } catch (error) {
          proofError = error;
        }
        try {
          if (typeof this.clearChatGptComposerState === "function") {
            await this.clearChatGptComposerState(page);
          }
        } catch (cleanupError) {
          throw new ChatGptPersistentBrowserStateError(
            proofError !== undefined ? [proofError, cleanupError] : [cleanupError],
            "ChatGPT connector proof did not leave a verified empty composer",
          );
        }
        if (proofError !== undefined) throw proofError;
        return proofResult === true;
      },
      abortSignal,
    );
    try {
      composer = await this.activeComposer(page, 30_000, abortSignal);
      if (await this.connectorIsSelected(composer, abortSignal)) {
        const reusable = await chatGptReuseCleanConnector(page, {
          readPrompt: (p, signal) => this.attachedPromptText(p, signal),
          clear: p => this.clearChatGptComposerState(p),
        }, abortSignal);
        if (reusable) {
          await capture("connector-already-selected");
          return composer;
        }
        composer = await this.activeComposer(page, 30_000, abortSignal);
      }
      await composer.fill("", { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });

      let firstMenuCaptured = false;
      while (attemptBudget.triggerAttempts < MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS) {
        attemptBudget.triggerAttempts += 1;
        composer = await this.activeComposer(page, 30_000, abortSignal);
        await composer.fill("", { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
        if (typeof page?.bringToFront === "function") {
          await page.bringToFront().catch(() => {});
        }
        await composer.focus({ signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
        await withBrowserTurnAbort(settleChatGptUi(), abortSignal);
        await composer.pressSequentially(CHATGPT_CONNECTOR_MENTION_QUERY, {
          delay: 25,
          signal: abortSignal,
          timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
        });
        if (!firstMenuCaptured) {
          firstMenuCaptured = true;
          await capture("connector-mention-triggered");
        }
        try {
          await appResult.waitFor({
            state: "visible",
            timeout: 2_500,
            signal: abortSignal,
          });
          await capture("connector-menu-visible");
          break;
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
          const visibleRows = await this.connectorMentionRowTitles(menuRows, abortSignal);
          const knownIdentityMismatch = this.config.appName === CHATGPT_CONNECTOR_NAME
            && (
              visibleRows.includes(DEV_CHATGPT_CONNECTOR_NAME)
              || LEGACY_CHATGPT_CONNECTOR_NAMES.some(name => visibleRows.includes(name))
            );
          if (knownIdentityMismatch) {
            await capture("connector-menu-missing");
            throw chatGptConnectorUnavailableError(
              await this.connectorMentionFailure(menuRows, attemptBudget.triggerAttempts, abortSignal, page),
            );
          }
          if (
            catalogRefreshAvailable
            && visibleRows.length > 0
            && !visibleRows.includes(this.config.appName)
            && attemptBudget.triggerAttempts < MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS
          ) {
            throw new ChatGptConnectorCatalogStaleError(
              this.config.appName,
              attemptBudget.triggerAttempts,
            );
          }
          if (attemptBudget.triggerAttempts >= MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS) {
            await capture("connector-menu-missing");
            throw chatGptConnectorUnavailableError(
              await this.connectorMentionFailure(menuRows, attemptBudget.triggerAttempts, abortSignal, page),
            );
          }
        }
      }
      const exactResultCount = await withBrowserTurnAbort(
        withChatGptBrowserObservationTimeout(appResult.count()),
        abortSignal,
      );
      if (exactResultCount !== 1) {
        throw chatGptConnectorUnavailableError(
          `ChatGPT connector menu did not expose one exact ${JSON.stringify(this.config.appName)} row`
          + ` after ${attemptBudget.triggerAttempts} complete mention trigger attempt(s)`,
        );
      }
      // Hidden launcher maintenance keeps a 1x1 Chromium viewport, so pointer activation cannot
      // reach this menu. Require the exact row to own ChatGPT's keyboard highlight first;
      // otherwise move the menu highlight until it does. Keep
      // focus on the composer, activate through the menu's real keyboard owner, then prove the exact
      // selected connector pill below.
      const rowHighlighted = async () => chatGptRowIsHighlighted(
        appResult,
        abortSignal,
        CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
      );
      if (!await rowHighlighted()) {
        const visibleRowCount = await withBrowserTurnAbort(
          withChatGptBrowserObservationTimeout(menuRows.filter({ visible: true }).count()),
          abortSignal,
        );
        for (let step = 0; step < visibleRowCount && !await rowHighlighted(); step += 1) {
          await composer.press("ArrowDown", {
            signal: abortSignal,
            timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
          });
        }
      }
      if (!await rowHighlighted()) {
        throw new Error(`ChatGPT connector menu could not highlight ${JSON.stringify(this.config.appName)}`);
      }
      await composer.press("Enter", {
        signal: abortSignal,
        timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
      });
      await capture("connector-choice-activated");
      // Selecting a connector replaces the Lexical composer subtree. Resolve the active composer
      // again instead of returning the pre-selection locator, otherwise the real turn can focus a
      // detached/hidden editor even though verification just succeeded.
      const selectedComposer = await this.activeComposer(page, 30_000, abortSignal);
      const selectedConnector = this.selectedConnectorControl(selectedComposer);
      await selectedConnector.waitFor({
        state: "visible",
        timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
        signal: abortSignal,
      });
      if (!await this.connectorIsSelected(selectedComposer, abortSignal)) {
        throw new Error(`ChatGPT composer did not select ${JSON.stringify(this.config?.appName ?? CHATGPT_CONNECTOR_NAME)} connector`);
      }
      await capture("connector-selected");
      return selectedComposer;
    } catch (error) {
      try {
        if (typeof this.clearChatGptComposerState === "function") {
          await this.clearChatGptComposerState(page);
        }
      } catch (cleanupError) {
        throw new ChatGptPersistentBrowserStateError(
          [error, cleanupError],
          "ChatGPT connector selection failed and its composer state could not be cleared",
        );
      }
      throw error;
    }
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
  ): Promise<void> {
    prompt = prompt.replace(/\r\n|\r/g, "\n");
    throwIfPromptAttachmentAborted(abortSignal);
    await throwIfChatGptRateLimitDialog(page);
    throwIfPromptAttachmentAborted(abortSignal);
    const connectorMode = chatGptConnectorAttachmentMode(localTools, reuseConnector);
    let composerMutationStarted = false;
    try {
      if (connectorMode === "none") {
        const composer = await this.activeComposer(page, 30_000, abortSignal);
        // Playwright's multiline fill maps through an input action that ChatGPT's Lexical editor can
        // collapse to the first paragraph on the launcher-owned Electron surface. Clear separately,
        // then transport the complete text through the browser's plain-text editing command.
        composerMutationStarted = true;
        await composer.fill("", { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
        await composer.focus({ signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
        if (requireThink) {
          await setChatGptThinkMode(composer.locator("xpath=ancestor::form[1]"), true, captureDiagnostic, abortSignal);
        }
        await this.insertPromptText(page, prompt, abortSignal);
        await this.assertPromptAttached(page, prompt, abortSignal);
        return;
      }
      let selectedComposer: Locator;
      if (connectorMode === "retained") {
        const composer = await this.activeComposer(page, 30_000, abortSignal);
        const alreadyBound = this.connectorIsSelected !== undefined
          && await this.connectorIsSelected(composer, abortSignal);
        const cleanBinding = alreadyBound && await chatGptReuseCleanConnector(page, {
          readPrompt: (p, signal) => this.attachedPromptText(p, signal),
          clear: async p => {
            composerMutationStarted = true;
            await this.clearChatGptComposerState(p);
          },
        }, abortSignal);
        let userTurnCount = 0;
        try {
          if (typeof page?.locator === "function") {
            const userTurns = page.locator(CHATGPT_USER_TURN_SELECTOR);
            if (userTurns && typeof userTurns.count === "function") {
              userTurnCount = await userTurns.count().catch(() => 0);
            }
          }
        } catch {
          userTurnCount = 0;
        }
        selectedComposer = cleanBinding
          ? composer
          : await this.selectConnector(
              page,
              captureDiagnostic,
              catalogRefreshAvailable,
              connectorAttemptBudget,
              abortSignal,
              userTurnCount > 0,
            );
      } else {
        selectedComposer = await this.selectConnector(
          page,
          captureDiagnostic,
          catalogRefreshAvailable,
          connectorAttemptBudget,
          abortSignal,
        );
      }
      // selectConnector owns and rolls back every mutation until it returns. From this point the
      // attachment owns the selected pill and prompt text as one transaction.
      composerMutationStarted = true;
      if (requireThink) {
        await setChatGptThinkMode(selectedComposer.locator("xpath=ancestor::form[1]"), true, captureDiagnostic, abortSignal);
      }
      await selectedComposer.focus({ signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
      await selectedComposer.press(CHATGPT_COMPOSER_DOCUMENT_END_KEY, {
        signal: abortSignal,
        timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
      });
      await this.insertPromptText(page, ` ${prompt}`, abortSignal);
      await this.assertPromptAttached(page, prompt, abortSignal);
    } catch (error) {
      if (!composerMutationStarted || error instanceof ChatGptPersistentBrowserStateError) throw error;
      try {
        if (typeof this.clearChatGptComposerState === "function") {
          await this.clearChatGptComposerState(page);
        }
      } catch (cleanupError) {
        throw new ChatGptPersistentBrowserStateError(
          [error, cleanupError],
          "ChatGPT prompt attachment failed and its composer state could not be cleared",
        );
      }
      throw error;
    }
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
    let observationPage = page;
    let observationBaseline = baseline;
    let recoveryAttempts = 0;
    for (;;) {
      try {
        const evidence = await this.waitForSubmissionAccepted(
          observationPage,
          observationBaseline,
          abortSignal,
          externalProgress,
          initialToolBatchRevision,
          completionTracker,
        );
        return evidence;
      } catch (error) {
        if (!(error instanceof ChatGptBrowserObservationTimeoutError) || !recoverObservation) throw error;
        const latestProgress = externalProgress?.snapshot();
        if (latestProgress?.claimed || chatGptExternalProgressIsLive(latestProgress, Date.now(), CHATGPT_RESPONSE_DOM_GRACE_MS)) {
          await new Promise(resolveSleep => setTimeout(resolveSleep, 1_000));
          continue;
        }
        recoveryAttempts += 1;
        if (recoveryAttempts > MAX_CHATGPT_BROWSER_PAGE_REBINDS) {
          throw new Error(
            `ChatGPT submission DOM remained unresponsive after ${MAX_CHATGPT_BROWSER_PAGE_REBINDS} same-page rebinds`,
            { cause: error },
          );
        }
        const recovered = await recoverObservation(
          recoveryAttempts,
          error,
          observationBaseline,
          abortSignal,
        );
        observationPage = recovered.page;
        observationBaseline = recovered.baseline;
      }
    }
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
    const sendButton = (typeof composerForm.locator === "function"
      ? composerForm.locator('[data-testid="send-button"], button[type="submit"]:not([aria-haspopup="menu"]), button[aria-label*="Enviar" i], button[aria-label*="Send" i]').first()
      : undefined) ?? composerForm.getByTestId("send-button");
    await sendButton.waitFor({ state: "visible", timeout: browserStageTimeouts.send });
    await settleChatGptUi();
    const sendEnableDeadline = Date.now() + CHATGPT_SEND_ENABLE_GRACE_MS;
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
      await settleChatGptUi();
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
    const domHealthTracker = new ChatGptTurnDomHealthTracker(
      CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS,
    );
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
      if (!snapshot.responsePresent && await responseTurn.locator.count() !== 1) {
        const rebound = await this.reconcileAssistantTurnBinding(
          page,
          submissionBaseline,
          responseTurn,
          abortSignal,
        );
        if (rebound.identity !== responseTurn.identity) {
          responseTurn = rebound;
          responseDomCache.key = undefined;
          responseDomCache.snapshot = undefined;
          snapshot = await this.responseDomSnapshot(responseTurn.locator, responseDomCache);
        }
      }
      if (snapshot.stoppedThinkingVisible) throw chatGptStoppedThinkingError();
      const externalProgressSnapshot = externalProgress?.snapshot();
      if (externalProgress
        && externalProgressSnapshot
        && completionTracker.needsToolBatchObservation(externalProgressSnapshot.lastToolBatchRevision)) {
        completionTracker.observeToolBatch(
          externalProgressSnapshot.lastToolBatchRevision,
          snapshot.visibleText,
        );
        await externalProgress.acknowledgeToolBatch(externalProgressSnapshot.lastToolBatchRevision);
      }
      const externalProgressLive = chatGptExternalProgressSuppressesDomHealth(
        externalProgressSnapshot,
        Date.now(),
      );
      const externalToolCallsInFlight = chatGptExternalToolCallsAreInFlight(externalProgressSnapshot);
      if (!snapshot.responsePresent && externalProgressLive) {
        // Proven MCP activity outranks a momentarily unavailable staging DOM, exactly as it does
        // in the main turn loop.
        domHealthTracker.clearMissingResponse();
        await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
        continue;
      }
      const running = await page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last().isVisible().catch(() => false);
      const domError = domHealthTracker.update({
        responsePresent: snapshot.responsePresent,
        running,
        currentText: snapshot.visibleText,
        completionActionVisible: snapshot.completionActionVisible,
        externalProgressLive,
      });
      if (domError) throw new Error(domError);
      if (completionTracker.update({
        responsePresent: snapshot.responsePresent,
        running,
        currentText: snapshot.visibleText,
        currentHtml: snapshot.fullHtml,
        completionActionVisible: snapshot.completionActionVisible,
        externalToolCallsInFlight,
      })) {
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
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
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
    await withBrowserTurnAbort(settleChatGptUi(), abortSignal);
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
    throwIfPromptAttachmentAborted(abortSignal);
    const composer = await this.activeComposer(page, 30_000, abortSignal);
    await composer.focus({ signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
    if (typeof page.keyboard?.insertText === "function") {
      const isProseMirror = await composer.evaluate(
        el => el.classList.contains("ProseMirror") || (el.getAttribute("role") === "textbox" && !el.hasAttribute("data-lexical-editor")),
      );
      if (isProseMirror) {
        await page.keyboard.insertText(text);
        return;
      }
    }
    // CDP Input.insertText is interpreted as live typing by ChatGPT's Lexical plugins. On a large
    // JSON transport it can turn literal Markdown backticks into rich code nodes, remove the
    // delimiters from textContent, and leave the next insertion outside the intended block. The
    // browser's plain-text editing command updates the same focused contenteditable atomically
    // without running those Markdown shortcuts. Exact readback below remains the authority.
    const inserted = await composer.evaluate(insertPlainTextIntoComposer, text, {
      timeout: 20_000,
      signal: abortSignal,
    });
    throwIfPromptAttachmentAborted(abortSignal);
    if (!inserted) {
      if (typeof page.keyboard?.insertText === "function") {
        await page.keyboard.insertText(text);
      } else {
        throw new ChatGptPromptAttachmentIntegrityError(
          "ChatGPT composer rejected the plain-text editing command",
        );
      }
    }
  }

  private async verifyConnectorExclusive(
    traceId = `verify_${randomUUID().replaceAll("-", "")}`,
  ): Promise<string> {
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
    const response = await this.runBrowserTurn({
      traceId,
      modelId,
      reasoning,
      capabilities,
      prepare: async () => ({ text: CHATGPT_SMOKE_TEXT, images: [], release: () => {} }),
      abortSignal,
      onTextDelta: () => {},
    }, undefined, page);
    if (response.trim() !== CHATGPT_SMOKE_EXPECTED) {
      throw new Error(
        `ChatGPT smoke test returned an unexpected answer (${JSON.stringify(response.trim().slice(0, 200))})`,
      );
    }
    return { effort: mode.displayLabel, response: CHATGPT_SMOKE_EXPECTED };
  }

  private async attachFiles(page: Page, prompt: CompiledChatGptWebPrompt): Promise<void> {
    const files = chatGptPromptFilePayloads(prompt);
    if (files.length === 0) return;
    const composer = await this.activeComposer(page);
    const composerForm = composer.locator("xpath=ancestor::form[1]");
    const input = page.locator(CHATGPT_ATTACHMENT_INPUT_SELECTOR);
    await input.waitFor({ state: "attached", timeout: 20_000 });
    await input.setInputFiles(files);
    try {
      await Promise.all(files.map(file => {
        const byRole = composerForm.getByRole("group", { name: file.name, exact: true });
        const target = typeof byRole?.or === "function" && typeof composerForm.locator === "function"
          ? byRole.or(composerForm.locator(`.composer-attachment-surface:is(button, [role="button"])[aria-label=${JSON.stringify(file.name)}]`))
          : byRole;
        return target.waitFor({ state: "visible", timeout: 60_000 });
      }));
    } catch {
      const alerts = (await page.locator('[role="alert"]').allInnerTexts().catch(() => []))
        .map(text => text.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      throw new Error(
        `ChatGPT did not accept all prompt attachments`
        + (alerts.length > 0 ? `: ${alerts.join(" | ")}` : ""),
      );
    }
    const send = (typeof composerForm.locator === "function"
      ? composerForm.locator('[data-testid="send-button"], button[type="submit"]:not([aria-haspopup="menu"]), button[aria-label*="Enviar" i], button[aria-label*="Send" i]').first()
      : undefined) ?? composerForm.getByTestId("send-button");
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await send.isEnabled().catch(() => false)) return;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    }
    throw new Error("ChatGPT accepted the prompt attachments but did not make the message ready to send");
  }

  private async responseDomSnapshot(
    responseTurn: Locator,
    cache?: ChatGptResponseDomCache,
  ): Promise<ChatGptResponseDomSnapshot> {
    const observationStarted = performance.now();
    const observed = await responseTurn.evaluate((element, options) => {
      const root = element as HTMLElement;
      type ObserverState = {
        id: number;
        revision: number;
        observer: MutationObserver;
        rendered: Map<HTMLElement, boolean>;
      };
      type ObserverRegistry = { documentId: string; nextId: number; states: WeakMap<Element, ObserverState> };
      const scope = globalThis as typeof globalThis & {
        __CODEX_WEB_GPT_RESPONSE_OBSERVERS__?: ObserverRegistry;
      };
      const registry = scope.__CODEX_WEB_GPT_RESPONSE_OBSERVERS__ ??= {
        documentId: `${performance.timeOrigin}:${Math.random().toString(36).slice(2)}`,
        nextId: 0,
        states: new WeakMap<Element, ObserverState>(),
      };
      let observerState = registry.states.get(root);
      if (!observerState) {
        observerState = {
          id: ++registry.nextId,
          revision: 0,
          observer: undefined as unknown as MutationObserver,
          rendered: new Map<HTMLElement, boolean>(),
        };
        const state = observerState;
        state.observer = new MutationObserver(() => {
          state.revision += 1;
        });
        state.observer.observe(root, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: options.attributeFilter,
        });
        registry.states.set(root, state);
      }
      // Browser turn WebContents are intentionally allowed to run while their Electron view is
      // hidden or has no measured width. Layout geometry is therefore not response visibility:
      // completed Markdown can have width=0 while remaining connected, rendered and readable.
      const isRendered = (candidate: HTMLElement): boolean => {
        if (!candidate.isConnected) return false;
        if (typeof candidate.checkVisibility === "function") {
          return candidate.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        }
        for (let node: HTMLElement | null = candidate; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (node.hidden || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        }
        return true;
      };
      // CSS animations and stylesheet changes can reveal an answer or its completion controls
      // without mutating this subtree. Recheck the rendering dependencies of the cached scan;
      // unchanged text/HTML still avoids the expensive serialization below.
      for (const [candidate, rendered] of observerState.rendered) {
        if (isRendered(candidate) !== rendered) {
          observerState.revision += 1;
          break;
        }
      }
      const observerKey = `${registry.documentId}:${observerState.id}:${observerState.revision}`;
      if (options.knownKey === observerKey) return { key: observerKey };
      observerState.rendered.clear();
      const renderedInDom = (candidate: HTMLElement): boolean => {
        const rendered = isRendered(candidate);
        observerState.rendered.set(candidate, rendered);
        return rendered;
      };

      // ChatGPT's DIL renderer has no .markdown class (#538). Read its response root within the
      // assistant-owned PUIK container; the CSS module hash is build-specific. Both renderers
      // feed the same content serializer and completion checks below, without reading UI text.
      const answerRootSelector = '.markdown, [data-markdown-text-style="assistant-message"], [class*="MarkdownRoot-"], [data-message-author-role="assistant"] .puik-root.not-markdown > [class*="_DilResponseRoot"]';
      // In the Activity renderer, the agent-start marker owns the progress block
      // before an assistant search unit exists. Final answers have their own unit.
      const activityContainers = [...root.querySelectorAll<HTMLElement>("[data-chatgpt-agent-turn-start]")]
        .map(marker => marker.parentElement!);
      // ChatGPT uses the same content renderer for intermediate commentary and for the final
      // answer. Older responses nested commentary in the streaming-status container. Pro can also
      // render a completed commentary Markdown root immediately before that live status container.
      // Final-answer Markdown follows the live status instead, so DOM order remains the semantic
      // boundary without relying on localized labels such as "Pro thinking".
      const allMarkdownRoots = [...root.querySelectorAll<HTMLElement>(answerRootSelector)]
        .filter(candidate => {
          if (!root.hasAttribute("data-turn-key") && !candidate.hasAttribute("data-markdown-text-style")) return true;
          const unit = candidate.closest("[data-content-search-unit-key]");
          return unit ? Array.from(unit.children)
            .some(child => child.getAttribute("data-conversation-role") === "assistant")
            : activityContainers.some(container => container.contains(candidate));
        })
        .filter(candidate => !candidate.parentElement?.closest(answerRootSelector))
        .filter(renderedInDom);
      const streamingStatusContainers = [...root.querySelectorAll<HTMLElement>("[data-streaming-response-status]")]
        .filter(renderedInDom);
      // Captured Activity uses the same Markdown component for public action summaries
      // and assistant commentary, including summaries outside activity-header rows.
      // Its explicit tone distinguishes these within the agent's progress section;
      // a final-answer search unit remains an answer regardless of its text tone.
      const activitySummaryRoots = new Set(allMarkdownRoots.filter(candidate => (
        candidate.getAttribute("data-markdown-text-tone") === "tertiary"
        && !candidate.closest("[data-content-search-unit-key]")
        && activityContainers.some(container => container.contains(candidate))
      )));
      // CHATGPT_COMMENTARY_CLASSIFIER_BEGIN
      // Self-contained so the test suite can execute this exact source against a synthetic DOM;
      // it must not close over anything from the surrounding evaluate scope.
      const selectChatGptAnswerRoots = (
        markdownRoots: HTMLElement[],
        statusContainers: HTMLElement[],
        activityContainers: HTMLElement[] = [],
      ): { commentaryRoots: HTMLElement[]; answerRoots: HTMLElement[] } => {
        const firstStatusContainer = statusContainers[0];
        const commentary = markdownRoots.filter(candidate => (
          (!candidate.closest("[data-content-search-unit-key]")
            && activityContainers.some(container => container.contains(candidate)))
          || candidate.closest("[data-streaming-response-status]") !== null
          // Chain-of-thought components carry reasoning, never the final answer, so containment is
          // a position-independent commentary signal. Position alone cannot separate "commentary
          // between two status containers" from "answer between two tool calls".
          || candidate.closest('[data-testid^="cot-v5"]') !== null
          // Only Markdown that precedes the FIRST status container is prior commentary. Keying
          // this on "some status follows me" silently reclassified answer text as commentary as
          // soon as a second tool call opened another status container below it, which both zeroed
          // the visible text and dropped every answer chunk emitted between tool calls.
          || (firstStatusContainer !== undefined && Boolean(
            // 4 is Node.DOCUMENT_POSITION_FOLLOWING, inlined to keep this function standalone.
            candidate.compareDocumentPosition(firstStatusContainer) & 4,
          ))
        ));
        return {
          commentaryRoots: commentary,
          answerRoots: markdownRoots.filter(candidate => !commentary.includes(candidate)),
        };
      };
      // CHATGPT_COMMENTARY_CLASSIFIER_END
      const classified = selectChatGptAnswerRoots(
        allMarkdownRoots.filter(candidate => !activitySummaryRoots.has(candidate)),
        streamingStatusContainers,
        activityContainers,
      );
      const commentaryRoots = classified.commentaryRoots;
      const renderedRoots = classified.answerRoots;
      // CHATGPT_MARKDOWN_CONTENT_BEGIN
      const chatGptMarkdownContent = (markdownRoot: HTMLElement): HTMLElement => {
        const content = markdownRoot.cloneNode(true) as HTMLElement;
        // These are embedded renderers, not Markdown answer text. Their loading labels, controls
        // and plot axes change independently of generation (including after a later paragraph).
        // Keep their UI out of both the emitted HTML and the text consistency fingerprint.
        // Also remove the media already excluded by chatGptHtmlToMarkdown, so their
        // accessibility labels cannot become consistency fingerprints for untransmitted text.
        // Ordinary code blocks, surrounding prose and the original observed DOM remain intact.
        for (const widget of Array.from(content.querySelectorAll(
          ".chart-widget-container, [data-code-block-preview-pane], script, style, svg, img, picture, source",
        ))) widget.remove();
        for (const button of Array.from(content.querySelectorAll("button"))) {
          // Observed file-reference controls have a label but no authoritative download URL.
          // Keep only their text; never carry button attributes or infer a link from the name.
          if (button.matches(".behavior-btn.entity-underline")
            && !button.closest('[hidden], [aria-hidden="true"]')) {
            for (const hidden of Array.from(button.querySelectorAll('[hidden], [aria-hidden="true"], .sr-only, [role="tooltip"]'))) {
              hidden.remove();
            }
            button.replaceWith(content.ownerDocument.createTextNode(button.textContent ?? ""));
          } else {
            button.remove();
          }
        }
        return content;
      };
      // ChatGPT may merge adjacent `.markdown` roots or virtualize an earlier prefix while a streamed
      // answer is finalized. Root boundaries and visible indices therefore are not identity:
      // flatten semantic blocks and preserve ChatGPT's source ranges across that reparenting.
      const flattenedMarkdownSegments: Array<{
        tag: string;
        html: string;
        text: string;
        pendingLinks: boolean;
        linkTargets: string[];
        group?: string;
        sourceStart?: number;
        sourceEnd?: number;
      }> = [];
      const blockMarkdownTags = new Set([
        "address", "article", "aside", "blockquote", "div", "dl", "fieldset", "figcaption",
        "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr",
        "li", "main", "nav", "ol", "p", "pre", "section", "table", "ul",
      ]);
      const markdownText = (element: HTMLElement): string => {
        // Detached content has no layout-derived innerText. Preserve textual line boundaries
        // explicitly: plain textContent would conflate "A<br>B" with "AB" in the guard.
        const parts: string[] = [];
        const blockBoundary = () => {
          if (parts.length > 0 && !parts.at(-1)!.endsWith("\n")) parts.push("\n");
        };
        const visit = (node: Node) => {
          if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent ?? "");
          if (!(node instanceof HTMLElement)) return;
          const tag = node.tagName.toLowerCase();
          const block = blockMarkdownTags.has(tag);
          if (block) blockBoundary();
          if (tag === "br") parts.push("\n");
          node.childNodes.forEach(visit);
          if (block) blockBoundary();
        };
        visit(element);
        return parts.join("").trim();
      };
      // CHATGPT_MARKDOWN_CONTENT_END
      let listGroupIndex = 0;
      const sourceRange = (candidate: Element): { sourceStart: number; sourceEnd: number } | undefined => {
        const startAttribute = candidate.getAttribute("data-start");
        const endAttribute = candidate.getAttribute("data-end");
        if (startAttribute === null || endAttribute === null) return undefined;
        if (!startAttribute.trim() || !endAttribute.trim()) return undefined;
        const sourceStart = Number(startAttribute);
        const sourceEnd = Number(endAttribute);
        return Number.isFinite(sourceStart) && Number.isFinite(sourceEnd) && sourceEnd >= sourceStart
          ? { sourceStart, sourceEnd }
          : undefined;
      };
      const linkState = (element: HTMLElement): { pendingLinks: boolean; linkTargets: string[] } => {
        // ChatGPT may paint a link label before supplying its destination. An append-only
        // response cannot add that destination back after committing the label as plain text.
        const anchors = [element, ...element.querySelectorAll<HTMLElement>("a")]
          .filter(candidate => candidate.tagName === "A" && Boolean(candidate.textContent?.trim()));
        return {
          pendingLinks: anchors.some(candidate => !candidate.getAttribute("href")?.trim()),
          linkTargets: anchors.flatMap(candidate => {
            const href = candidate.getAttribute("href");
            return href?.trim() ? [href] : [];
          }),
        };
      };
      const appendBlockSegment = (child: HTMLElement) => {
        const tag = child.tagName.toLowerCase();
        const childRange = sourceRange(child);
        const listItems = tag === "ol" || tag === "ul"
          ? [...child.children].filter(candidate => candidate.tagName === "LI") as HTMLElement[]
          : [];
        if (listItems.length === 0) {
          flattenedMarkdownSegments.push({
            tag,
            html: child.outerHTML,
            text: markdownText(child),
            ...linkState(child),
            ...childRange,
          });
          return;
        }

        const group = childRange
          ? `list:${childRange.sourceStart}:${tag}`
          : `list:${listGroupIndex++}:${tag}`;
        const orderedStart = tag === "ol" ? Number(child.getAttribute("start") ?? "1") : undefined;
        listItems.forEach((item, itemIndex) => {
          const shell = child.cloneNode(false) as HTMLElement;
          shell.removeAttribute("data-is-last-node");
          if (orderedStart !== undefined && Number.isFinite(orderedStart)) {
            shell.setAttribute("start", String(orderedStart + itemIndex));
          }
          shell.append(item.cloneNode(true));
          flattenedMarkdownSegments.push({
            tag: `${tag}:item`,
            html: shell.outerHTML,
            text: markdownText(item),
            ...linkState(item),
            group,
            ...sourceRange(item),
          });
        });
      };
      renderedRoots.map(chatGptMarkdownContent).forEach((markdownRoot) => {
        const children = [...markdownRoot.children] as HTMLElement[];
        const hasBlockChildren = children.some(child => blockMarkdownTags.has(child.tagName.toLowerCase()));
        if (!hasBlockChildren) {
          if (markdownRoot.innerHTML.trim()) flattenedMarkdownSegments.push({
            tag: "root",
            html: markdownRoot.innerHTML,
            text: markdownText(markdownRoot),
            ...linkState(markdownRoot),
            ...sourceRange(markdownRoot),
          });
          return;
        }

        let inlineRun: Node[] = [];
        const flushInlineRun = () => {
          if (inlineRun.length === 0) return;
          const nodes = inlineRun;
          inlineRun = [];
          const shell = document.createElement("span");
          nodes.forEach(node => shell.append(node.cloneNode(true)));
          const text = markdownText(shell);
          if (text) {
            const rangedElements = nodes.flatMap(node => node instanceof Element
              ? [node, ...node.querySelectorAll<HTMLElement>("[data-start][data-end]")]
              : []);
            const ranges = rangedElements
              .map(sourceRange)
              .filter((range): range is { sourceStart: number; sourceEnd: number } => range !== undefined);
            flattenedMarkdownSegments.push({
              tag: "inline",
              html: shell.outerHTML,
              text,
              ...linkState(shell),
              ...(ranges.length > 0 ? {
                sourceStart: Math.min(...ranges.map(range => range.sourceStart)),
                sourceEnd: Math.max(...ranges.map(range => range.sourceEnd)),
              } : {}),
            });
          }
        };

        markdownRoot.childNodes.forEach((node) => {
          if (node instanceof HTMLElement && blockMarkdownTags.has(node.tagName.toLowerCase())) {
            flushInlineRun();
            appendBlockSegment(node);
            return;
          }
          inlineRun.push(node);
        });
        flushInlineRun();
      });
      const markdownSegments = flattenedMarkdownSegments.map((segment, index, segments) => ({
        key: segment.sourceStart !== undefined
          ? `${segment.sourceStart}:${segment.tag}`
          : `${index}:${segment.tag}`,
        tag: segment.tag,
        html: segment.html,
        text: segment.text,
        ...(segment.group ? { group: segment.group } : {}),
        ...(segment.sourceStart !== undefined ? { sourceStart: segment.sourceStart } : {}),
        ...(segment.sourceEnd !== undefined ? { sourceEnd: segment.sourceEnd } : {}),
        streamable: index < segments.length - 1 && !segment.pendingLinks,
        linkTargets: segment.linkTargets,
      }));
      const rendered = renderedRoots.at(-1);
      const completionAction = rendered
        ? [...root.querySelectorAll<HTMLElement>(options.completionActionSelector)]
          .filter(renderedInDom)
          .find(candidate => !rendered.contains(candidate)
            && Boolean(rendered.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING))
        : undefined;
      const completionActionSet = new Set(completionAction ? [completionAction] : []);
      const candidates = new Map<HTMLElement, ChatGptVisibleTraceBlock["kind"]>();
      renderedRoots.forEach(candidate => candidates.set(candidate, "answer"));
      commentaryRoots.forEach(candidate => candidates.set(candidate, "commentary"));
      activitySummaryRoots.forEach(candidate => candidates.set(candidate, "status"));
      const overlapsRenderedAnswer = (candidate: HTMLElement): boolean => renderedRoots.some(rendered => (
        candidate.contains(rendered) || rendered.contains(candidate)
      ));
      const overlapsCommentary = (candidate: HTMLElement): boolean => commentaryRoots.some(commentary => (
        candidate.contains(commentary) || commentary.contains(candidate)
      ));
      const overlapsActivitySummary = (candidate: HTMLElement): boolean => [...activitySummaryRoots].some(summary => (
        candidate.contains(summary) || summary.contains(candidate)
      ));
      const statusSemantic = (candidate: HTMLElement): HTMLElement => {
        // Current cot-v5 action rows expose the semantic text on their item anchor while the
        // discoverable data-testid lives on a textless icon below it. Promote that descendant to
        // the owned row; otherwise every non-button action is silently filtered as empty text.
        return candidate.closest<HTMLElement>("button")
          ?? candidate.closest<HTMLElement>("[data-item-anchor]")
          ?? candidate;
      };
      const traceText = (candidate: HTMLElement): string => {
        const ariaLabel = candidate.getAttribute("aria-label")?.trim();
        if (ariaLabel) return ariaLabel;
        // Animated ChatGPT action counters visually split a phrase around the changing number, so
        // `innerText` can become `Searching websites\n3`. The button's screen-reader label already
        // carries the stable semantic phrase (`Searching 3 websites`) without enclosing unrelated
        // commentary from the surrounding streaming-status container.
        const screenReaderText = [...candidate.querySelectorAll<HTMLElement>(".sr-only")]
          .map(element => element.textContent?.replace(/\s+/g, " ").trim() ?? "")
          .find(Boolean);
        return screenReaderText || candidate.innerText.trim();
      };
      const traceKey = (candidate: HTMLElement, kind: ChatGptVisibleTraceBlock["kind"]): string | undefined => {
        const statusContainer = candidate.closest<HTMLElement>("[data-streaming-response-status]");
        const itemAnchor = candidate.closest<HTMLElement>("[data-item-anchor]");
        if (!statusContainer || !itemAnchor) return undefined;
        const anchorIndex = [...statusContainer.querySelectorAll<HTMLElement>("[data-item-anchor]")]
          .indexOf(itemAnchor);
        return anchorIndex >= 0 ? `${kind}:anchor:${anchorIndex}` : undefined;
      };
      const hasFollowingRenderedSibling = (candidate: HTMLElement): boolean => {
        const itemAnchor = candidate.closest<HTMLElement>("[data-item-anchor]");
        for (
          let sibling = itemAnchor?.nextElementSibling;
          sibling;
          sibling = sibling.nextElementSibling
        ) {
          if (sibling instanceof HTMLElement && renderedInDom(sibling) && sibling.innerText.trim()) {
            return true;
          }
        }
        return false;
      };
      root.querySelectorAll<HTMLElement>(
        'button, [role="status"], [aria-busy="true"], [data-testid*="cot"], [data-testid*="reason"], [data-testid*="thought"]',
      ).forEach(candidate => {
        if (completionActionSet.has(candidate)) return;
        if (overlapsRenderedAnswer(candidate) || overlapsCommentary(candidate)) return;
        const semantic = statusSemantic(candidate);
        // A renderer may wrap the final Markdown in a reason/status container. That wrapper and
        // its descendants still belong exclusively to the final-answer stream; assigning either
        // side to the trace stream duplicates or truncates the answer under Codex's `Working` UI.
        if (!overlapsRenderedAnswer(semantic)
          && !overlapsCommentary(semantic)
          && !overlapsActivitySummary(semantic)
          && !candidates.has(semantic)) {
          candidates.set(semantic, "status");
        }
      });
      root.querySelectorAll<HTMLElement>("[data-streaming-response-status]").forEach(container => {
        if (!overlapsRenderedAnswer(container)
          && !overlapsCommentary(container)
          && ![...candidates.keys()].some(candidate => container.contains(candidate))) {
          candidates.set(container, "status");
        }
      });
      const traceByKey = new Map<string, ChatGptVisibleTraceBlock>();
      [...candidates]
        .filter(([candidate]) => renderedInDom(candidate))
        .sort(([left], [right]) => left === right
          ? 0
          : left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
        .map(([candidate, kind]) => ({
          kind,
          text: traceText(candidate),
          key: traceKey(candidate, kind),
          ...(kind === "commentary" ? { complete: hasFollowingRenderedSibling(candidate) } : {}),
          // Footer controls such as the model picker and overflow menu are siblings of the final
          // Markdown inside the assistant turn. They are UI, not model trace. Real action buttons
          // are scoped by ChatGPT's streaming-status container.
          uiControl: candidate.matches("button")
            && candidate.closest("[data-streaming-response-status]") === null,
        }))
        .filter(block => block.text.length > 0)
        .forEach((block, index) => {
          const key = block.key ?? `${block.kind}:fallback:${index}`;
          const previous = traceByKey.get(key);
          if (!previous || block.text.length > previous.text.length) traceByKey.set(key, block);
        });
      const traceBlocks = [...traceByKey.values()].map((block, index, blocks) => ({
        ...block,
        ...(block.kind === "commentary" ? {
          complete: block.complete === true || index < blocks.length - 1,
        } : {}),
      }));
      const stoppedThinkingVisible = (() => {
        // Only ChatGPT UI in the bound response may terminate the turn. A model quoting this
        // phrase in its answer or reasoning is ordinary content, not a stopped-thinking status.
        // Match the site's observed labels regardless of the account/document language.
        const labels = new Set<string>(options.stoppedThinkingLabels);
        const isStoppedLabel = (value: string | null): boolean => labels.has(value?.replace(/\s+/g, " ").trim() ?? "");
        const isStatus = (candidate: HTMLElement): boolean => {
          if (overlapsRenderedAnswer(candidate) || overlapsCommentary(candidate)
            || candidate.closest("pre, code, blockquote")) return false;
          for (let element: HTMLElement | null = candidate; element; element = element.parentElement) {
            if (!renderedInDom(element)) return false;
          }
          return true;
        };
        const ariaMatch = Array.from(root.querySelectorAll<HTMLElement>("[aria-label]"))
          .some(candidate => isStoppedLabel(candidate.getAttribute("aria-label")) && isStatus(candidate));
        if (ariaMatch) return true;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!isStoppedLabel(node.textContent)) continue;
          const parent = node.parentElement;
          if (parent && isStatus(parent)) return true;
        }
        return false;
      })();
      return {
        key: observerKey,
        snapshot: {
          responsePresent: true,
          visibleText: renderedRoots.map(candidate => candidate.innerText.trim()).filter(Boolean).join("\n\n"),
          fullHtml: renderedRoots.map(candidate => candidate.innerHTML).join(""),
          markdownSegments,
          completionActionVisible: completionAction !== undefined,
          stoppedThinkingVisible,
          traceBlocks,
        },
      };
    }, {
      completionActionSelector: CHATGPT_COMPLETION_ACTION_SELECTOR,
      stoppedThinkingLabels: [...CHATGPT_STOPPED_THINKING_LABELS],
      knownKey: cache?.key,
      attributeFilter: [...CHATGPT_DOM_REVISION_ATTRIBUTES],
    }, { timeout: 10_000 }).catch(() => undefined);
    if (!observed) {
      if (responseTurn.page().isClosed()) {
        throw chatGptBrowserTabClosedError();
      }
      return absentResponseDomSnapshot();
    }
    const snapshot = observed.snapshot ?? cache?.snapshot ?? absentResponseDomSnapshot();
    if (observed.snapshot && cache) {
      cache.key = observed.key;
      cache.snapshot = observed.snapshot;
      cache.fullScans = (cache.fullScans ?? 0) + 1;
    } else if (!observed.snapshot && cache?.snapshot) {
      cache.cacheHits = (cache.cacheHits ?? 0) + 1;
    }
    snapshot.traceBlocks = snapshot.traceBlocks
      .map(stripChatGptTraceControlSuffix)
      .filter(block => block.text.length > 0 && !isChatGptTraceControl(block));
    const observationPage = responseTurn.page();
    await this.pageDomObserver.measure(
      observationPage,
      Boolean(observed.snapshot),
      observationStarted,
      () => this.getContextPressure(observationPage),
    );
    return snapshot;
  }

  private async stalledTurnDiagnostic(page: Page, responseTurn: Locator): Promise<string> {
    const responseState = await responseTurn.count()
      ? await responseTurn.evaluate(element => {
        const root = element as HTMLElement;
        const descriptors = [...root.querySelectorAll<HTMLElement>("[role], [data-testid], button, [aria-label]")]
          .filter(candidate => {
            const style = getComputedStyle(candidate);
            return style.visibility !== "hidden" && style.display !== "none";
          })
          .slice(-80)
          .map(candidate => ({
            tag: candidate.tagName.toLowerCase(),
            role: candidate.getAttribute("role"),
            testId: candidate.getAttribute("data-testid"),
            ariaLabelChars: candidate.getAttribute("aria-label")?.length ?? 0,
            titleChars: candidate.getAttribute("title")?.length ?? 0,
            textChars: (candidate.innerText ?? candidate.textContent ?? "").trim().length,
          }));
        return {
          textChars: (root.innerText ?? root.textContent ?? "").trim().length,
          htmlChars: root.innerHTML.length,
          descriptors,
        };
      })
      : { text: "", descriptors: [] };
    const overlays = await page.locator('[role="dialog"], [role="alert"], [role="status"]').evaluateAll(elements => (
      elements
        .filter(element => {
          const candidate = element as HTMLElement;
          const style = getComputedStyle(candidate);
          return style.visibility !== "hidden" && style.display !== "none";
        })
        .slice(-30)
        .map(element => {
          const candidate = element as HTMLElement;
          return {
            role: candidate.getAttribute("role"),
            testId: candidate.getAttribute("data-testid"),
            ariaLabelChars: candidate.getAttribute("aria-label")?.length ?? 0,
            textChars: (candidate.innerText ?? candidate.textContent ?? "").trim().length,
          };
        })
    )).catch(() => [] as Array<Record<string, string | null>>);
    return redactChatGptUiDiagnostic(JSON.stringify({ response: responseState, overlays }));
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
        const answer = await this.runBrowserTurn(turn, undefined, undefined, false, false, releaseInteractive, acquireInteractive);
        await turn.onResultReady?.(answer);
        return answer;
      } finally {
        releaseInteractive();
      }
    }

    let surfaceId: string | undefined;
    let surfaceClaimed = false;
    let reused = false;
    let terminal: "completed" | "failed" | "aborted" = "completed";
    let terminalMessage: string | undefined;
    let originalError: unknown;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatInFlight = false;
    let lastHeartbeatFailureAt = 0;
    try {
      const lease = await notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
        phase: "start",
        traceId: turn.traceId,
        helperPid: process.pid,
        ...(turn.conversationKey ? { conversationKey: turn.conversationKey } : {}),
        ...((turn.conversationKey
          && (turn.nativeConnector || turn.capabilities.localToolsEnabled || turn.requireRetainedConversation))
          ? { connectorIdentity: this.config.appName }
          : {}),
        ...(turn.requireRetainedConversation ? { requireRetainedConversation: true } : {}),
        ...(turn.compaction ? { compaction: true } : {}),
      }, undefined, turn.abortSignal).catch(error => {
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
        void notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
          phase: "heartbeat",
          traceId: turn.traceId,
          helperPid: process.pid,
        }, LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS).catch(error => {
          const now = Date.now();
          if (now - lastHeartbeatFailureAt < 30_000) return;
          lastHeartbeatFailureAt = now;
          console.warn(
            `[chatgpt-web] launcher turn heartbeat failed for ${turn.traceId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }).finally(() => {
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
      const answer = await this.runBrowserTurn(turn, surfaceId, undefined, reused, lease.trackUsage === true, releaseInteractive, acquireInteractive);
      await turn.onResultReady?.(answer);
      return answer;
    } catch (error) {
      originalError = error;
      terminal = error instanceof ChatGptCompactionHandoffAccepted
        ? "completed"
        : (error instanceof DOMException && error.name === "AbortError")
        || (error instanceof ChatGptWebAdapterError && error.code === "client_cancelled")
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
            ...(terminal === "completed" && (turn.nativeConnector || turn.capabilities.localToolsEnabled)
              ? { connectorBound: true }
              : {}),
          });
          if (surfaceClaimed
            && !(terminal === "completed" && turn.retainConversation && turn.conversationKey)) {
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
    try {
      if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      // Validate only the selected physical message, not canonical history used for usage estimates.
      assertChatGptPromptAttachments(prepared);
      const multipartTransactionId = prepared.multipart
        ? `ctx_${randomUUID().replaceAll("-", "")}`
        : undefined;
      const multipartStages = prepared.multipart && multipartTransactionId
        ? prepared.multipart.parts.slice(0, -1).map((payload, index) => formatChatGptWebMultipartStage(
          payload,
          multipartTransactionId,
          index + 1,
          prepared.multipart!.parts.length,
        ))
        : undefined;
      const multipartFinalPrompt = prepared.multipart && multipartTransactionId
        ? formatChatGptWebMultipartCommit(prepared.multipart, multipartTransactionId)
        : undefined;
      const selectedMessages = multipartStages && multipartFinalPrompt
        ? [...multipartStages.map(stage => stage.text), multipartFinalPrompt]
        : [prepared.text];
      const browserPayload = measureCompiledBrowserPayload(prepared, turn.modelId, selectedMessages);
      const {
        inputTokens: estimatedInputTokens,
        maxMessageTokens: estimatedMessageTokens,
        maxMessageChars,
      } = measureCompiledChatGptWebInput(prepared, turn.modelId, browserPayload);
      const maxStageMessageTokens = multipartStages
        ? Math.max(...multipartStages.map(stage => estimateTokens(stage.text, turn.modelId)))
        : undefined;
      const maxStageChars = multipartStages
        ? Math.max(...multipartStages.map(stage => stage.text.length))
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
          multipartStages
            && multipartFinalPrompt
            && maxStageMessageTokens !== undefined
            && maxStageChars !== undefined ? {
            stagingEffort: stagingMode.effort,
            maxStageMessageTokens,
            maxStageChars,
            finalMessageTokens: estimateTokens(multipartFinalPrompt, turn.modelId) + skillFileTokens(prepared.skillFiles, turn.modelId),
            finalMessageChars: multipartFinalPrompt.length,
            finalImageTokens: estimateChatGptWebImageTokens(prepared),
          } : undefined,
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
      const recordAcceptedPayload = createBrowserPayloadAcceptanceRecorder(browserPayload, {
        retainedConversation: reuseConversation,
        compaction: turn.compaction === true,
      }, metric => {
        console.info(`[chatgpt-web] browser turn ${turn.traceId} accepted_payload=${JSON.stringify(
          metric,
        )}`);
      });
      const deadline = this.config.turnTimeoutMs === undefined
        ? undefined
        : Date.now() + this.config.turnTimeoutMs;
      let page = await this.runStage(turn.traceId, "browser_page", browserStageTimeouts.browserPage, async (abortSignal) => {
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
      });
      if (!maintenancePage && !launcherSurfaceId) managedPage = page;
      diagnosticPage = page;
      const contextPressure = this.getContextPressure(page, turn.conversationKey);
      const rebindLauncherPage = async (
        attempt: number,
        cause: Error,
        callerSignal?: AbortSignal,
      ): Promise<void> => {
        if (!launcherSurfaceId || !this.config.browserHostDescriptorPath) throw cause;
        console.warn(
          `[chatgpt-web] browser turn ${turn.traceId} is rebinding its existing launcher page after a stalled DOM probe:`
          + ` ${redactChatGptUiDiagnostic(cause.message)}`,
        );
        const previousConnection = turnConnection;
        // The observation timeout races the Playwright operation but cannot cancel the underlying
        // page.evaluate by itself. A failed disconnect is terminal: opening a replacement while
        // the stale probe still owns its transport would recreate the contention this rebind is
        // meant to remove.
        const connection = await connectAfterClosingBrowserConnection(
          previousConnection,
          () => {
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
          },
        );
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
      const recoverSubmissionObservation: ChatGptObservationRecovery = (
        attempt,
        cause,
        baseline,
        abortSignal,
      ) => recoverPageObservation(
        attempt,
        cause,
        baseline,
        "submission-page-rebound",
        abortSignal,
      );
      const recoverAssistantObservation: ChatGptObservationRecovery = (
        attempt,
        cause,
        baseline,
        abortSignal,
      ) => recoverPageObservation(
        attempt,
        cause,
        baseline,
        "assistant-page-rebound",
        abortSignal,
      );
      // Rebinding the exact leased page is a browser-ownership operation. Read-only
      // compaction needs it too; acquiring MCP tools is not a prerequisite.
      const launcherObservationRecovery = launcherSurfaceId !== undefined
        && this.config.browserHostDescriptorPath !== undefined;
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
          withBrowserTurnAbort(page.evaluate(() => document.documentElement?.innerHTML.length ?? 0), turn.abortSignal),
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
          `[chatgpt-web] browser turn ${turn.traceId} multipart staging effort=${stagingMode.effort}`
          + ` maxStageMessageTokens=${maxStageMessageTokens} maxStageChars=${maxStageChars}`,
        );
      }
      await acquireInteractive?.();
      if (!reuseConversation) {
        await this.runStage(
          turn.traceId,
          "temporary_chat_preparation",
          browserStageTimeouts.temporaryChatPreparation,
          () => this.prepareChatSurface(
            page,
            checkpoint => diagnostics.capture(page, checkpoint),
            this.config.useSavedChats,
          ),
        );
      }
      // A retained lease proves the connector binding, not the current model selection.
      // Reconcile the live control before every submission, including retained continuations.
      const selectStagingMode = () => (
        this.selectModelAndEffort(
          page,
          turn.modelId,
          stagingMode.effort,
          browserCapabilities,
          checkpoint => diagnostics.capture(page, checkpoint),
          trackUsage,
          turn.modelFamily,
        )
      );
      let mode = await this.runStage(turn.traceId, "effort_selection", browserStageTimeouts.effortSelection, selectStagingMode);
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
            phase: "usage", traceId: turn.traceId, helperPid: process.pid,
            ...(accountKey ? { receipt: { id, accountKey, model, at: Date.now() } }
              : { trackingError: "account-unavailable" as const }),
          }).then(() => {}, () => {
            // Approximate accounting must not turn an already accepted model message into a retry.
            console.warn(`[chatgpt-web] Limits could not persist a submission receipt for ${turn.traceId}`);
          });
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
          if (index > 0) mode = await this.runStage(
            turn.traceId, `multipart_stage_${index + 1}_effort_selection`,
            browserStageTimeouts.effortSelection, selectStagingMode,
          );
          let stageBaseline = await this.captureSubmissionBaseline(page, stage.text);
          await this.runStage(
            turn.traceId,
            `multipart_stage_${index + 1}_attachment`,
            browserStageTimeouts.promptAttachment,
            (stageSignal) => this.attachPrompt(
              page,
              stage.text,
              false,
              checkpoint => diagnostics.capture(page, `multipart-${index + 1}-${checkpoint}`),
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
            (stageSignal) => this.sendAttachedPrompt(
              page,
              stageBaseline,
              checkpoint => diagnostics.capture(page, `multipart-${index + 1}-${checkpoint}`),
              turn.abortSignal ? AbortSignal.any([stageSignal, turn.abortSignal]) : stageSignal,
              undefined,
              { onSubmitted: async () => {
                recordStageUsage?.();
                recordAcceptedPayload(index);
                await turn.onSubmitted?.();
              }, onSendActivated: async () => {
                await this.assertSelectedEffort(page, mode);
                submissionRejection.begin(page);
                stageSendActivatedAt = performance.now();
                console.info(`[chatgpt-web] browser turn ${turn.traceId} multipart_stage=${index + 1} send_phase=activated readyWaitMs=${Math.round(stageSendActivatedAt - stageSendPreparedAt)}`);
                await turn.onSendActivated?.();
              } },
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
          console.info(`[chatgpt-web] browser turn ${turn.traceId} multipart_stage=${index + 1} send_phase=accepted activationMs=${stageSendActivatedAt === undefined ? "unobserved" : Math.round(performance.now() - stageSendActivatedAt)}`);
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
            () => this.selectModelAndEffort(
              page,
              turn.modelId,
              requestedMode.effort,
              browserCapabilities,
              checkpoint => diagnostics.capture(page, `final-part-${checkpoint}`),
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
                checkpoint => diagnostics.capture(page, checkpoint),
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
                checkpoint => diagnostics.capture(page, checkpoint),
                this.config.useSavedChats,
              );
              mode = await this.selectModelAndEffort(
                page,
                turn.modelId,
                turn.reasoning,
                turn.capabilities,
                checkpoint => diagnostics.capture(page, checkpoint),
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
      await this.runStage(turn.traceId, "file_attachment", browserStageTimeouts.fileAttachment, () => (
        this.attachFiles(page, prepared)
      ));
      await diagnostics.capture(page, "file-attachment-complete");
      const completionTracker = new ChatGptCompletionTracker();
      const recordFinalUsage = await usageSubmission();
      const finalSendPreparedAt = performance.now();
      let finalSendActivatedAt: number | undefined;
      console.info(`[chatgpt-web] browser turn ${turn.traceId} send_phase=prepared preparationMs=${Math.round(finalSendPreparedAt - finalSendPreparationStartedAt)}`);
      const finalSubmissionEvidence = await this.runStage(
        turn.traceId,
        "send",
        // A multipart commit lands on a conversation already carrying every staged part, so it
        // needs the same acceptance headroom the stages themselves get.
        prepared.multipart ? browserStageTimeouts.multipartStageSend : browserStageTimeouts.send,
        (stageSignal) => this.sendAttachedPrompt(
          page,
          submissionBaseline,
          checkpoint => diagnostics.capture(page, checkpoint),
          turn.abortSignal ? AbortSignal.any([stageSignal, turn.abortSignal]) : stageSignal,
          turn.externalProgress,
          { ...turn, onSubmitted: () => {
            recordFinalUsage?.();
            recordAcceptedPayload(browserPayload.messageCount - 1);
            return turn.onSubmitted?.();
          }, onSendActivated: async () => {
            await this.assertSelectedEffort(page, mode);
            submissionRejection.begin(page);
            finalSendActivatedAt = performance.now();
            console.info(`[chatgpt-web] browser turn ${turn.traceId} send_phase=activated readyWaitMs=${Math.round(finalSendActivatedAt - finalSendPreparedAt)}`);
            await turn.onSendActivated?.();
          } },
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
      console.info(`[chatgpt-web] browser turn ${turn.traceId} send_phase=accepted activationMs=${finalSendActivatedAt === undefined ? "unobserved" : Math.round(performance.now() - finalSendActivatedAt)}`);
      console.info(`[chatgpt-web] browser turn ${turn.traceId} submission accepted evidence=${finalSubmissionEvidence}`);
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
      const checkpointStream = turn.captureLunaCheckpoint
        ? new ChatGptLunaCheckpointStream()
        : undefined;
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
      let completionFenceRevision: number | undefined;
      const recoverStalledResponsePage = async (error: ChatGptBrowserObservationTimeoutError): Promise<void> => {
        if (!launcherSurfaceId) {
          throw new ChatGptWebAdapterError("ChatGPT browser DOM observation timed out and this page has no recovery lease", {
            status: 504,
            errorType: "server_error",
            code: "chatgpt_browser_dom_unresponsive",
            retryable: false,
            cause: error,
          });
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

        if (mode.localTools && await resolveChatGptToolConfirmation(
          page,
          this.config.appName,
          this.config.autoApproveToolCalls,
          turn.abortSignal,
          CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS,
          () => diagnostics.capture(page, "tool-confirmation-visible"),
        )) {
          internalObservationFaults = 0;
          await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
          continue;
        }

        const responseProbeTimeoutMs = (turn.externalProgress?.snapshot().activeToolCalls ?? 0) > 0
          ? 3_000
          : 6_000;
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
        if (!snapshot.responsePresent && await responseTurn.locator.count() !== 1) {
          try {
            const rebound = await withChatGptBrowserObservationTimeout(
              this.reconcileAssistantTurnBinding(
                page,
                submissionBaseline,
                responseTurn,
                turn.abortSignal,
              ),
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
            const isRunning = await page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last().isVisible().catch(() => false);
            if (!currentCallsInFlight && (currentProgressLive || isRunning)) {
              console.warn(
                `[chatgpt-web] browser turn ${turn.traceId} DOM observation probe timed out while generation is active; continuing observation without rebind`,
              );
              await new Promise(resolveSleep => setTimeout(resolveSleep, 1_000));
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
        if (turn.externalProgress
          && externalProgressSnapshot
          && completionTracker.needsToolBatchObservation(externalProgressSnapshot.lastToolBatchRevision)) {
          completionTracker.observeToolBatch(
            externalProgressSnapshot.lastToolBatchRevision,
            snapshot.visibleText,
          );
          await turn.externalProgress.acknowledgeToolBatch(externalProgressSnapshot.lastToolBatchRevision);
        }
        const externalProgressLive = chatGptExternalProgressSuppressesDomHealth(
          externalProgressSnapshot,
          Date.now(),
        );
        const externalToolCallsInFlight = chatGptExternalToolCallsAreInFlight(externalProgressSnapshot);
        if (!snapshot.responsePresent && externalProgressLive) {
          // Current-turn MCP activity proves that ChatGPT is still executing even if its renderer
          // temporarily cannot expose the response subtree. DOM remains authoritative for text and
          // completion; this only prevents a live turn from being misclassified as vanished.
          domHealthTracker.clearMissingResponse();
          await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
          continue;
        }
        const stop = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last();
        const running = await stop.isVisible().catch(() => false);
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
          if (!completionReady) completionFenceRevision = undefined;
          if (completionReady) {
            if (turn.completionFence) {
              if (completionFenceRevision === undefined) {
                const revision = await turn.completionFence.begin();
                if (revision === undefined) {
                  await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
                  continue;
                }
                completionFenceRevision = revision;
                // The fence revision is captured after this DOM projection. Force one fresh read
                // before commit so an MCP activity that just settled cannot disappear between a
                // stale cached completion and the broker's terminal decision.
                responseDomCache.key = undefined;
                responseDomCache.snapshot = undefined;
                await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
                continue;
              }
              if (!await turn.completionFence.commit(completionFenceRevision)) {
                completionFenceRevision = undefined;
                responseDomCache.key = undefined;
                responseDomCache.snapshot = undefined;
                await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
                continue;
              }
            }
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
                `[chatgpt-web] browser turn ${turn.traceId} checkpoint_surface `
                + JSON.stringify(inspectCompactionResponseSurface(snapshot, final.markdown)),
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
              else console.warn(`[chatgpt-web] browser turn ${turn.traceId} completed without a Luna rolling checkpoint; preserving full native history`);
              finalText = completed.answer;
            } else {
              finalText = final.markdown;
            }
            break;
          }
          if (!loggedCompletionWait && Date.now() - sentAt >= 60_000) {
            loggedCompletionWait = true;
            await diagnostics.capture(page, "response-stalled-60s");
            const diagnostic = await this.stalledTurnDiagnostic(page, responseTurn.locator).catch(error => JSON.stringify({
              diagnosticError: error instanceof Error ? error.message : String(error),
            }));
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
        await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
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
          `[chatgpt-web] browser turn ${turn.traceId} tolerated internal observation fault`
          + ` ${internalObservationFaults}/${MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS}: ${error.message}`,
        );
        await diagnostics.capture(page, "internal-observation-fault");
        responseDomCache.key = undefined;
        responseDomCache.snapshot = undefined;
        await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
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
        `[chatgpt-web] browser turn ${turn.traceId} completed`
        + ` (markdownChars=${finalText.length}, domFullScans=${responseDomCache.fullScans ?? 0}, domCacheHits=${responseDomCache.cacheHits ?? 0})`,
      );
      return finalText;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")
        && !(error instanceof ChatGptWebAdapterError && error.code === "client_cancelled")) {
        error = await submissionRejection.failure() ?? error;
      }
      if (error instanceof DOMException && error.name === "AbortError"
        && turn.abortSignal?.reason instanceof ChatGptCompactionHandoffAccepted) {
        if (turn.compaction && diagnosticPage) this.getContextPressure(diagnosticPage).reset();
        console.info(`[chatgpt-web] browser turn ${turn.traceId} ended after accepted structured compaction handoff`);
        if (diagnosticPage && !diagnosticPage.isClosed()) {
          await diagnostics.capture(diagnosticPage, "compaction-handoff-accepted");
        }
        throw turn.abortSignal.reason;
      }
      console.error(
        `[chatgpt-web] browser turn ${turn.traceId} failed:`
        + ` ${redactChatGptUiDiagnostic(error instanceof Error ? error.message : String(error))}`,
      );
      if (diagnosticPage && !diagnosticPage.isClosed()) {
        await diagnostics.capture(diagnosticPage, "turn-failed", error);
      }
      throw error;
    } finally {
      submissionRejection.dispose();
      await Promise.all(usageWrites);
      prepared.release();
      if (turn.conversationKey && (!turn.retainConversation || turn.compaction)) {
        this.contextPressureByConversation.delete(turn.conversationKey);
      }
      if (turnConnection) {
        await turnConnection.close().catch(error => {
          console.error(
            `[chatgpt-web] failed to release launcher browser connection for ${turn.traceId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      } else if (managedPage && !managedPage.isClosed()) {
        await managedPage.close().catch(error => {
          console.error(
            `[chatgpt-web] failed to close managed browser tab for ${turn.traceId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
    }
  }
}
