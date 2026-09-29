import type { ChatGptMarkdownSegment } from "../markdown";
import { type ChatGptExternalTurnProgressSnapshot, chatGptExternalProgressIsLive } from "../turn-progress";
import {
  CHATGPT_COMPLETION_ACTION_GRACE_MS,
  CHATGPT_COMPLETION_SETTLE_MS,
  CHATGPT_EMPTY_RESPONSE_GRACE_MS,
  CHATGPT_RESPONSE_DOM_GRACE_MS,
} from "./suspension-clock";

/**
 * How long completion may stay vetoed by tool-status evidence that nothing corroborates any more.
 *
 * A status container orphaned by its finished tool call leaves the turn otherwise complete: no
 * stream output, no live generation, and no MCP activity, yet the evidence veto never lifts and the
 * poll loop would spin until an external deadline. Past this grace the veto is treated as a
 * rendering defect and fails the turn.
 */
export const CHATGPT_PENDING_TOOL_EVIDENCE_STALL_MS = 90_000;

/**
 * Backstop for a Codex tool call that never returns.
 *
 * A genuinely long tool call used to be killed as an orphan container: external progress goes
 * stale after ten silent minutes and the orphan-evidence window then ran its 90 s course even
 * though the call was still executing. While a call is provably in flight that window cannot
 * accrue any more, so this ceiling — measured from the start of the continuous in-flight
 * stretch — is what bounds a call that truly hung instead.
 */
export const CHATGPT_TOOL_IN_FLIGHT_CEILING_MS = 30 * 60_000;

/**
 * Consecutive internal observation faults tolerated before a turn is abandoned.
 *
 * An internal observation fault is not evidence that the upstream turn failed. The loop
 * re-observes within a consecutive budget; any successful observation resets that budget, and
 * exhausting it fails closed with the original fault as the cause.
 */
export const MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS = 8;

/**
 * How stale recorded MCP progress may be and still suppress DOM health checks.
 *
 * An outstanding tool call reports liveness regardless of age, so a call that never returns would
 * otherwise hold a turn open forever — turns carry no deadline unless a caller supplies one. This
 * bounds the silence since the last recorded activity rather than the turn's total duration, so a
 * long turn that keeps calling tools is never penalised for taking a long time.
 */
export const CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS = 10 * 60_000;

/** Tolerated clock difference between the recording daemon and the observing helper process. */
export const CHATGPT_EXTERNAL_PROGRESS_CLOCK_SKEW_MS = 5_000;

export function chatGptTurnIsComplete(state: {
  responsePresent: boolean;
  running: boolean;
  currentText: string;
  currentHtml?: string;
  completionActionVisible: boolean;
}): boolean {
  return state.responsePresent && !state.running && state.currentText.length > 0 && state.completionActionVisible;
}

export type ChatGptSubmissionEvidence = "user_turn" | "assistant_turn" | "generation_running" | "mcp_tool_call";

export function chatGptNewTurnIdentity(initial: readonly string[], current: readonly string[]): string | undefined {
  const previous = new Set(initial);
  const added = current.filter((identity) => !previous.has(identity));
  if (added.length > 1) {
    throw new Error(`ChatGPT exposed ${added.length} new conversation turns for one submitted message`);
  }
  return added[0];
}

export function chatGptReboundTurnIdentity(
  initial: readonly string[],
  boundIdentity: string,
  current: readonly string[],
): string | undefined {
  if (current.includes(boundIdentity)) return boundIdentity;
  return chatGptNewTurnIdentity(initial, current);
}

export function chatGptSubmissionEvidence(state: {
  initialTurnIdentities: readonly string[];
  userIdentities: readonly string[];
  responseIdentities: readonly string[];
  generationRunning: boolean;
}): ChatGptSubmissionEvidence | undefined {
  if (chatGptNewTurnIdentity(state.initialTurnIdentities, state.userIdentities)) return "user_turn";
  if (chatGptNewTurnIdentity(state.initialTurnIdentities, state.responseIdentities)) return "assistant_turn";
  if (state.generationRunning) return "generation_running";
  return undefined;
}

export type ChatGptConnectorAttachmentMode = "none" | "mention" | "retained";

/** A launcher lease may reuse a connector only after proving that exact retained surface is bound. */
export function chatGptConnectorAttachmentMode(
  localTools: boolean,
  reuseConversation: boolean,
): ChatGptConnectorAttachmentMode {
  if (!localTools) return "none";
  return reuseConversation ? "retained" : "mention";
}

/**
 * Returns a CSS selector string that locates a turn element by its identity.
 * Supports both the new ChatGPT UI (2025+) and the legacy UI:
 * - New UI: identity is a UUID from data-chatgpt-selection-message-id, or a "fallback-turn-*" key
 *   from data-chatgpt-search-unit-key
 * - Legacy UI: identity is a value from data-turn-id
 */
export function chatGptTurnIdentityLocatorSelector(identity: string): string {
  const escaped = JSON.stringify(identity);
  return [
    `[data-turn-id=${escaped}]`,
    `[data-turn-key=${escaped}]`,
    `[data-content-search-turn-key=${escaped}]`,
    `[data-chatgpt-selection-message-id=${escaped}]`,
    `[data-chatgpt-search-unit-key=${escaped}]`,
  ].join(", ");
}

export class ChatGptCompletionTracker {
  private candidate?: { signature: string; since: number };
  private lastToolBatchRevision = 0;
  private postToolAnswerBaselineText?: string;
  private missingPostToolAnswerSince?: number;

  constructor(
    private readonly stableMs = CHATGPT_COMPLETION_SETTLE_MS,
    private readonly missingPostToolAnswerMs = CHATGPT_COMPLETION_ACTION_GRACE_MS,
  ) {}

  needsToolBatchObservation(revision: number): boolean {
    if (!Number.isSafeInteger(revision) || revision < this.lastToolBatchRevision) {
      throw new Error("ChatGPT completion received an invalid tool-batch revision");
    }
    return revision > this.lastToolBatchRevision;
  }

  observeToolBatch(revision: number, currentText: string): boolean {
    if (!this.needsToolBatchObservation(revision)) return false;
    // The caller acknowledges the batch only after this projection is captured. The outer Codex
    // harness therefore cannot execute the tool until this exact pre-tool answer boundary exists.
    this.postToolAnswerBaselineText = currentText;
    this.lastToolBatchRevision = revision;
    this.missingPostToolAnswerSince = undefined;
    this.candidate = undefined;
    return true;
  }

  update(
    state: Parameters<typeof chatGptTurnIsComplete>[0] & {
      externalToolCallsInFlight?: boolean;
      hasPendingToolEvidence?: boolean;
    },
    now = Date.now(),
  ): boolean {
    const signature = `${state.currentText}\0${state.currentHtml ?? state.currentText}`;
    // An outstanding tool call proves the model has more to say, whatever the rendered message
    // currently looks like. Completing here would return a truncated answer and retire the turn
    // while its own tool calls were still in flight.
    if (state.externalToolCallsInFlight) {
      this.candidate = undefined;
      this.missingPostToolAnswerSince = undefined;
      return false;
    }
    if (this.postToolAnswerBaselineText === state.currentText) {
      this.candidate = undefined;
      if (!chatGptTurnIsComplete(state)) {
        this.missingPostToolAnswerSince = undefined;
        return false;
      }
      this.missingPostToolAnswerSince ??= now;
      if (now - this.missingPostToolAnswerSince >= this.missingPostToolAnswerMs) {
        throw new Error("ChatGPT completed without producing a final answer after its last Codex tool call");
      }
      return false;
    }
    this.missingPostToolAnswerSince = undefined;
    if (!chatGptTurnIsComplete(state)) {
      this.candidate = undefined;
      return false;
    }
    if (this.candidate?.signature !== signature) {
      this.candidate = { signature, since: now };
      return false;
    }
    return now - this.candidate.since >= this.stableMs;
  }
}

export class ChatGptTurnDomHealthTracker {
  private sawResponse = false;
  private missingResponseSince?: number;
  private emptyCompletionSince?: number;
  private missingCompletionAction?: { text: string; since: number };

  constructor(
    private readonly missingResponseMs = CHATGPT_RESPONSE_DOM_GRACE_MS,
    private readonly emptyCompletionMs = CHATGPT_EMPTY_RESPONSE_GRACE_MS,
    private readonly missingCompletionActionMs = CHATGPT_COMPLETION_ACTION_GRACE_MS,
  ) {}

  /**
   * Clears only the missing-response window, leaving `sawResponse` history intact.
   *
   * Callers use this when proven external progress suspends DOM health checks: the suspended
   * stretch must not be charged against the grace period, or the first observation after it
   * resumes would fail instantly against a timestamp recorded long before.
   */
  clearMissingResponse(): void {
    this.missingResponseSince = undefined;
  }

  update(
    state: {
      responsePresent: boolean;
      running: boolean;
      currentText: string;
      completionActionVisible: boolean;
      externalProgressLive?: boolean;
    },
    now = Date.now(),
  ): string | undefined {
    if (state.responsePresent) this.sawResponse = true;
    if (state.externalProgressLive || state.running) {
      // Every conclusion below asserts that ChatGPT stopped producing this turn. A tool call that
      // is still completing disproves all of them, whatever the renderer is currently exposing, so
      // no window may accrue while the model is provably working.
      this.missingResponseSince = undefined;
      this.emptyCompletionSince = undefined;
      this.missingCompletionAction = undefined;
      return undefined;
    }
    if (state.responsePresent) {
      this.missingResponseSince = undefined;
    } else {
      this.missingResponseSince ??= now;
      if (now - this.missingResponseSince >= this.missingResponseMs) {
        return this.sawResponse
          ? "ChatGPT response DOM disappeared while the browser turn was active"
          : "ChatGPT did not create a response DOM after the message was sent";
      }
    }

    const emptyCompletion =
      state.responsePresent && !state.running && state.currentText.length === 0 && state.completionActionVisible;
    if (!emptyCompletion) {
      this.emptyCompletionSince = undefined;
    } else {
      this.emptyCompletionSince ??= now;
      if (now - this.emptyCompletionSince >= this.emptyCompletionMs) {
        return "ChatGPT browser turn completed without a final answer";
      }
    }

    const missingCompletionAction =
      state.responsePresent && !state.running && state.currentText.length > 0 && !state.completionActionVisible;
    if (!missingCompletionAction) {
      this.missingCompletionAction = undefined;
    } else if (this.missingCompletionAction?.text !== state.currentText) {
      this.missingCompletionAction = { text: state.currentText, since: now };
    } else if (now - this.missingCompletionAction.since >= this.missingCompletionActionMs) {
      return "ChatGPT stopped generating but did not expose its completed-turn action; the ChatGPT DOM may have changed";
    }
    return undefined;
  }
}

/**
 * Bounds the completion veto that pending tool evidence imposes.
 *
 * The veto is only load-bearing once the turn otherwise looks complete: a live generation or
 * proven MCP activity explains the pending status, so neither may be charged against the stall
 * window. Within a window where the evidence never lifts, a new answer delta restarts it — only
 * evidence that outlives every corroborating signal is an orphan container worth failing over.
 */
export class ChatGptPendingToolEvidenceTracker {
  private pendingSince?: number;
  private lastStreamDeltaAt?: number;
  private inFlightSince?: number;

  constructor(
    private readonly stallMs = CHATGPT_PENDING_TOOL_EVIDENCE_STALL_MS,
    private readonly inFlightCeilingMs = CHATGPT_TOOL_IN_FLIGHT_CEILING_MS,
  ) {}

  update(
    state: {
      pendingToolEvidence: boolean;
      running: boolean;
      streamDelta: boolean;
      externalProgressLive: boolean;
      toolCallsInFlight?: boolean;
      activeToolCalls?: number;
      lastProgressAt?: number;
    },
    now = Date.now(),
  ): string | undefined {
    if (state.streamDelta) {
      this.lastStreamDeltaAt = now;
      this.pendingSince = undefined;
    }
    if (state.toolCallsInFlight) {
      this.inFlightSince ??= now;
      if (now - this.inFlightSince >= this.inFlightCeilingMs) {
        const activeCalls = state.activeToolCalls ?? 0;
        const silence =
          state.lastProgressAt === undefined
            ? "no recorded MCP progress"
            : `${Math.round(Math.max(0, now - state.lastProgressAt) / 1000)}s of silence since the last recorded MCP progress`;
        return (
          `A Codex tool call has been in flight for ${Math.round((now - this.inFlightSince) / 1000)}s` +
          ` (${activeCalls} active tool call(s), ${silence}); the tool call appears hung.` +
          " Capture a browser diagnostic for this turn or set a turn timeout to bound the wait."
        );
      }
    } else {
      this.inFlightSince = undefined;
    }
    if (!state.pendingToolEvidence || state.running || state.externalProgressLive || state.toolCallsInFlight) {
      this.pendingSince = undefined;
      return undefined;
    }
    this.pendingSince ??= now;
    if (now - this.pendingSince < this.stallMs) return undefined;
    const quietMs = this.lastStreamDeltaAt === undefined ? this.stallMs : now - this.lastStreamDeltaAt;
    return `ChatGPT kept pending tool evidence for ${Math.round(this.stallMs / 1000)}s after generation stopped, with no stream output for ${Math.round(quietMs / 1000)}s; an orphan status or tool container is likely vetoing completion. Capture a browser diagnostic for this turn or set a turn timeout to bound the wait.`;
  }
}

/** Proven MCP activity, additionally required to be recent enough to still be evidence. */
export function chatGptExternalProgressSuppressesDomHealth(
  snapshot: ChatGptExternalTurnProgressSnapshot | undefined,
  now: number,
): boolean {
  if (!chatGptExternalProgressIsLive(snapshot, now, CHATGPT_RESPONSE_DOM_GRACE_MS)) return false;
  const lastProgressAt = snapshot?.lastProgressAt;
  if (lastProgressAt === undefined) return false;
  const age = now - lastProgressAt;
  // A timestamp from the future would keep `age` below the ceiling forever. Recorded activity can
  // only precede the observation, so anything meaningfully ahead of now is not evidence at all.
  return age >= -CHATGPT_EXTERNAL_PROGRESS_CLOCK_SKEW_MS && age < CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS;
}

export interface ChatGptVisibleTraceBlock {
  kind: "answer" | "commentary" | "status";
  text: string;
  key?: string;
  complete?: boolean;
  uiControl?: boolean;
}

export interface ChatGptVisibleTraceEvent {
  kind: "reasoning" | "commentary";
  text: string;
  continuation?: boolean;
}

export interface ChatGptResponseDomSnapshot {
  responsePresent: boolean;
  visibleText: string;
  fullHtml: string;
  markdownSegments: ChatGptMarkdownSegment[];
  completionActionVisible: boolean;
  stoppedThinkingVisible: boolean;
  traceBlocks: ChatGptVisibleTraceBlock[];
}

export interface ChatGptResponseDomCache {
  key?: string;
  snapshot?: ChatGptResponseDomSnapshot;
  fullScans?: number;
  cacheHits?: number;
}

export const absentResponseDomSnapshot = (): ChatGptResponseDomSnapshot => ({
  responsePresent: false,
  visibleText: "",
  fullHtml: "",
  markdownSegments: [],
  completionActionVisible: false,
  stoppedThinkingVisible: false,
  traceBlocks: [],
});

/** Convert the public ChatGPT turn DOM into append-only Codex reasoning summaries. */
export class ChatGptVisibleTraceTracker {
  private readonly emittedTrace = new Map<string, string>();
  private readonly traceCandidates = new Map<string, { text: string; changedAt: number }>();

  constructor(private readonly traceStabilityMs = 250) {}

  observe(
    blocks: ChatGptVisibleTraceBlock[],
    completionActionVisible: boolean,
    now = Date.now(),
  ): ChatGptVisibleTraceEvent[] {
    const output: ChatGptVisibleTraceEvent[] = [];
    let statusSlot = 0;
    let commentarySlot = 0;
    for (const block of blocks) {
      // Final-answer roots are carried by ChatGptMarkdownBuffer. Commentary roots are identified
      // structurally by responseDomSnapshot before they reach this tracker.
      if (block.kind === "answer") continue;
      const index = block.kind === "status" ? statusSlot++ : commentarySlot++;
      const slot = block.key ? `${block.kind}:${block.key}` : `${block.kind}:${index}`;
      const stripped = block.text
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line) => line.replace(/[\t ]+/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const text = block.kind === "status" ? stripped.replace(/\s+/g, " ") : stripped;
      if (!text) continue;
      let candidate = this.traceCandidates.get(slot);
      if (!candidate || candidate.text !== text) {
        candidate = { text, changedAt: now };
        this.traceCandidates.set(slot, candidate);
        if (!completionActionVisible && this.traceStabilityMs > 0) continue;
      }
      // A commentary Markdown root remains mutable until ChatGPT appends the next reasoning item.
      // Emitting it earlier lets a tool-status boundary split one semantic paragraph into multiple
      // Codex messages. The next anchored item (or final completion evidence) is the stable boundary.
      if (block.kind === "commentary" && block.complete === false && !completionActionVisible) continue;
      if (!completionActionVisible && now - candidate.changedAt < this.traceStabilityMs) continue;

      const previous = this.emittedTrace.get(slot);
      if (previous === text) continue;
      this.emittedTrace.set(slot, text);
      const kind = block.kind === "commentary" ? "commentary" : "reasoning";

      if (previous && text.startsWith(previous)) {
        output.push({ kind, text: text.slice(previous.length), continuation: true });
      } else {
        output.push({ kind, text });
      }
    }
    return output;
  }
}

export function isChatGptTraceControl(block: ChatGptVisibleTraceBlock): boolean {
  if (block.kind !== "status") return false;
  const text = block.text.replace(/\s+/g, " ").trim();
  return block.uiControl === true || text === "Answer now" || text === "Thinking";
}

export function stripChatGptTraceControlSuffix(block: ChatGptVisibleTraceBlock): ChatGptVisibleTraceBlock {
  if (block.kind !== "status") return block;
  const text = block.text.replace(/(?:^|\s)Answer now\s*$/, "").trimEnd();
  return text === block.text ? block : { ...block, text };
}
