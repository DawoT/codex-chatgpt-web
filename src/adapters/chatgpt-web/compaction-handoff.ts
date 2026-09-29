import { createHash } from "node:crypto";
import { parseDataUrl } from "../image";
import type {
  CodexContentPart,
  CodexParsedRequest,
  CodexToolResultMessage,
} from "../../types";
import { extractChatGptCompactionSourceRevision } from "./environment";
import { extractChatGptTurnIdentity } from "./environment";
import { buildCompactionEvidenceIndex, selectCompactionRepairEvidence } from "./compaction-evidence";
import type { ChatGptBrowserWorker } from "./browser-worker";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError } from "./adapter-error";
import type { CompactionTransactionHandle } from "./compaction-transaction";
import type { ChatGptWebCapabilities } from "./model";
import {
  activeCompactionToolResultInstruction,
  structuredCompactionHandoffInstruction,
  structuredCompactionRepairInstruction,
  zeroRiskActiveCompactionToolResultInstruction,
} from "./native-compaction-control";
import type { BrokerToolResult, TurnBroker, TurnBrokerOwner } from "./turn-broker";
import type { ChatGptTurnSession } from "./turn-execution";
import { checkpointRepairPromptFits } from "./compaction-repair";
import { resolveChatGptWebModelMode } from "./model";
import type { ChatGptWebBackendModel } from "../../chatgpt-web-models";
import { extractModifiedFilePaths } from "./autonomous-compaction";
import {
  LATEST_USER_PROMPT_MARKER,
  ORIGINAL_USER_REQUEST_MARKER,
  locateCompactionStateBounds,
  extractStructuredCompactionHandoff,
  formatCompactionStateBlock,
  parseCompactionState,
  type CompactionStateBlock,
} from "../../responses/compaction";

export { LATEST_USER_PROMPT_MARKER, ORIGINAL_USER_REQUEST_MARKER };

function brokerContent(content: string | CodexContentPart[]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    const parsed = parseDataUrl(part.imageUrl);
    if (parsed) return { type: "image", data: parsed.base64, mimeType: parsed.mediaType };
    return { type: "resource_link", uri: part.imageUrl, name: "Codex tool image", mimeType: "image/*" };
  });
}

function structuredContent(text: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toolResult(message: CodexToolResultMessage): BrokerToolResult {
  const content = brokerContent(message.content);
  const text = typeof message.content === "string"
    ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  const structured = structuredContent(text);
  return {
    content,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    ...(message.isError ? { isError: true } : {}),
  };
}

function interruptedByActiveCompaction(): BrokerToolResult {
  return {
    content: [{ type: "text", text: activeCompactionToolResultInstruction() }],
    isError: true,
  };
}

function withZeroRiskCompactionInstruction(result: BrokerToolResult): BrokerToolResult {
  return {
    ...result,
    content: [
      ...result.content,
      {
        type: "text",
        text: zeroRiskActiveCompactionToolResultInstruction(true),
      },
    ],
  };
}

function interruptedByZeroRiskCompaction(): BrokerToolResult {
  return {
    content: [{
      type: "text",
      text: zeroRiskActiveCompactionToolResultInstruction(false),
    }],
    isError: true,
  };
}

function userPromptText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap(part => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const value = part as { type?: unknown; text?: unknown };
    return (value.type === "input_text" || value.type === "text") && typeof value.text === "string"
      ? [value.text]
      : [];
  }).join("\n");
  return text || undefined;
}

export function canonicalizeCompactionHandoff(
  parsed: CodexParsedRequest,
  summary: string,
): string {
  const normalized = summary.trim();
  if (!normalized) throw new Error("ChatGPT returned an empty structured compaction handoff");
  const latestUserPrompt = userPromptText(extractChatGptCompactionSourceRevision(parsed).content);
  if (latestUserPrompt === undefined) {
    throw new Error("ChatGPT compaction source has no canonical latest user prompt");
  }
  const latestAppendix = `${LATEST_USER_PROMPT_MARKER}\n${JSON.stringify(latestUserPrompt)}`;
  const latestOffset = normalized.lastIndexOf(`\n${LATEST_USER_PROMPT_MARKER}\n`);
  let body = normalized;
  if (latestOffset >= 0) {
    if (normalized.slice(latestOffset + 1).trimEnd() !== latestAppendix) {
      throw new Error("ChatGPT compaction handoff contains a conflicting latest-user marker");
    }
    body = normalized.slice(0, latestOffset).trimEnd();
  }

  const previous = parsed.context.messages.filter(message => message.role === "user"
    && message.origin === "compaction_summary");
  let originalRequest: string | undefined;
  if (previous.length > 0) {
    for (const checkpoint of previous.toReversed()) {
      const priorText = userPromptText(checkpoint.content) ?? "";
      const marker = new RegExp(`(?:^|\\n)${ORIGINAL_USER_REQUEST_MARKER}\\n([^\\n]+)`).exec(priorText);
      if (!marker) continue;
      try {
        const record = JSON.parse(marker[1]!) as { sha256?: unknown; text?: unknown };
        if (typeof record.text === "string" && typeof record.sha256 === "string"
          && createHash("sha256").update(record.text).digest("hex") === record.sha256) {
          originalRequest = record.text;
        }
      } catch {
        // The format check below rejects a malformed trusted checkpoint without promoting it.
      }
      if (originalRequest === undefined) {
        throw new Error("Trusted compaction summary has an invalid original-request marker");
      }
      break;
    }
    if (originalRequest === undefined) {
      throw new Error("Trusted compaction summaries have no recoverable original-request marker");
    }
  } else {
    const firstUser = parsed.context.messages.find(message => message.role === "user"
      && message.origin !== "codex_skill");
    originalRequest = firstUser ? userPromptText(firstUser.content) : undefined;
  }
  if (originalRequest !== undefined) {
    const digest = createHash("sha256").update(originalRequest).digest("hex");
    const originalAppendix = `${ORIGINAL_USER_REQUEST_MARKER}\n${JSON.stringify({ sha256: digest, text: originalRequest })}`;
    const originalOffset = body.lastIndexOf(`\n${ORIGINAL_USER_REQUEST_MARKER}\n`);
    if (originalOffset >= 0) {
      if (body.slice(originalOffset + 1).trimEnd() !== originalAppendix) {
        throw new Error("ChatGPT compaction handoff contains a conflicting original-request marker");
      }
      body = body.slice(0, originalOffset).trimEnd();
    }
    const bounds = locateCompactionStateBounds(body);
    let state: CompactionStateBlock | null = null;
    let before = body;
    let after = "";

    if (bounds && !bounds.fenced) {
      before = body.slice(0, bounds.startTagStart).trimEnd();
      after = body.slice(bounds.endTagEnd).trimStart();
      state = parseCompactionState(body.slice(bounds.startTagStart, bounds.endTagEnd)) ?? {
        modifiedFiles: [],
        blockersOrTestFailures: [],
        nextActions: [],
      };
    } else {
      const handoff = extractStructuredCompactionHandoff(body);
      state = handoff.state;
      if (state) {
        before = handoff.narrative.trimEnd();
      }
    }

    if (state) {
      const detectedFiles = extractModifiedFilePaths(parsed.context.messages);
      const existingFiles = (state.modifiedFiles ?? []).filter(
        f => f && f.toLowerCase() !== "none" && f.toLowerCase() !== "- none",
      );
      const injectedFiles: string[] = [];
      for (const f of detectedFiles) {
        if (!existingFiles.includes(f)) {
          existingFiles.push(f);
          injectedFiles.push(f);
        }
      }
      if (injectedFiles.length > 0) {
        console.info(
          `[chatgpt-web] [COMPACTION AUTO-HEAL 🟢] Injected ${injectedFiles.length} file(s) into modified_files from patch history:`,
          injectedFiles,
        );
      }

      const activeHypothesis = state.activeHypothesis?.trim()
        || (originalRequest ? `Complete: ${originalRequest.trim().slice(0, 120)}` : "Complete the requested task.");

      const requirements = (state.requirements && state.requirements.length > 0)
        ? state.requirements
        : [{
            id: "REQ-1",
            status: "pending" as const,
            source: originalRequest ? `original user request: ${originalRequest.trim().slice(0, 80)}` : "original user request",
          }];

      const closureCriteria = (state.closureCriteria && state.closureCriteria.length > 0)
        ? state.closureCriteria
        : ["All mission requirements completed and verified"];

      const verifiedAchievements = state.verifiedAchievements ?? [];
      const decisionsAndInvariants = state.decisionsAndInvariants ?? [];

      const blockersOrTestFailures = (state.blockersOrTestFailures && state.blockersOrTestFailures.length > 0)
        ? state.blockersOrTestFailures
        : ["None"];

      const pendingObligations = (state.pendingObligations && state.pendingObligations.length > 0)
        ? state.pendingObligations
        : [latestUserPrompt ? `Complete latest turn: ${latestUserPrompt.trim().slice(0, 80)}` : "Continue next actions"];

      let nextActions = (state.nextActions ?? []).map(a => a.trim()).filter(Boolean);
      if (nextActions.length !== 1) {
        const action = nextActions[0] || (latestUserPrompt ? `Proceed with: ${latestUserPrompt.trim().slice(0, 80)}` : "Continue with the next planned step");
        nextActions = [action];
      }

      const healedState: CompactionStateBlock = {
        version: 2,
        originalRequestRef: `sha256:${digest}`,
        modifiedFiles: existingFiles,
        activeHypothesis,
        requirements,
        closureCriteria,
        verifiedAchievements,
        decisionsAndInvariants,
        blockersOrTestFailures,
        pendingObligations,
        nextActions,
      };

      body = [before, formatCompactionStateBlock(healedState), after].filter(Boolean).join("\n\n");
    }
    return `${body}\n\n${originalAppendix}\n\n${latestAppendix}`;
  }
  return `${body}\n\n${latestAppendix}`;
}

function currentToolResults(
  parsed: CodexParsedRequest,
  session: ChatGptTurnSession,
): Map<string, CodexToolResultMessage> {
  const results = new Map<string, CodexToolResultMessage>();
  for (const message of parsed.context.messages) {
    if (message.role !== "toolResult" || !session.hasOutstanding(message.toolCallId)) continue;
    if (results.has(message.toolCallId)) {
      throw new Error(`Codex returned duplicate results for tool call ${message.toolCallId}`);
    }
    results.set(message.toolCallId, message);
  }
  return results;
}

export const MAX_COMPACTION_HANDOFF_TIMEOUT_MS = 5 * 60_000;

function boundedCompactionTimeout(timeoutMs: number): number {
  return Math.min(timeoutMs, MAX_COMPACTION_HANDOFF_TIMEOUT_MS);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("ChatGPT compaction handoff aborted", "AbortError");
}

function withCompactionAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function settleActiveCompactionSource(
  parsed: CodexParsedRequest,
  source: ChatGptTurnSession,
  broker: TurnBroker,
  signal?: AbortSignal,
): Promise<{ answer: string; compactionInstructionDelivered: boolean }> {
  return source.runExclusive(async () => {
    if (signal?.aborted) {
      source.cancel(abortReason(signal));
      throw abortReason(signal);
    }
    if (!source.isActive() || source.runtime.mode !== "tools") {
      throw new Error("The active ChatGPT compaction source has no MCP tool boundary");
    }
    const outstanding = source.outstanding();
    const results = currentToolResults(parsed, source);
    if (results.size !== outstanding.length) {
      throw new Error(
        `Codex supplied ${results.size} of ${outstanding.length} required tool results for compaction`,
      );
    }
    let token: string | undefined;
    try {
      token = await source.runtime.token;
      broker.requestCompaction(token, interruptedByActiveCompaction());
      for (const request of outstanding) {
        const result = results.get(request.callId)!;
        await broker.completeTool(
          token,
          request.callId,
          toolResult(result),
        );
        source.runtime.externalProgress.recordToolResult();
        source.markResultDelivered(request.callId);
      }
      const browserOutcome = await withCompactionAbort(source.browserOutcome, signal);
      if (browserOutcome.type === "error") throw browserOutcome.error;
      const compactionInstructionDelivered = broker.compactionDeliveryCount(token) > 0;
      // The one structured checkpoint message reuses this exact retained tab. It must not race the
      // helper's /turn/end handshake for the response that consumed the canonical tool results.
      // `requestCompaction` leaves those results untouched and only intercepts a later tool call, so
      // a zero delivery count proves that this is an ordinary publishable terminal response.
      await withCompactionAbort(source.physicalSettlement, signal);
      return {
        answer: browserOutcome.answer,
        compactionInstructionDelivered,
      };
    } catch (error) {
      if (signal?.aborted) source.cancel(abortReason(signal));
      throw error;
    } finally {
      if (token) await broker.revoke(token);
    }
  });
}

export async function settleActiveZeroRiskCompactionSource(
  parsed: CodexParsedRequest,
  source: ChatGptTurnSession,
  broker: TurnBrokerOwner,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return source.runExclusive(async () => {
    if (signal?.aborted) {
      source.cancel(abortReason(signal));
      throw abortReason(signal);
    }
    if (!source.isActive() || source.runtime.mode !== "tools" || !source.runtime.manualControl) {
      throw new Error("The active Zero Risk compaction source has no manual MCP tool boundary");
    }
    const outstanding = source.outstanding();
    const results = currentToolResults(parsed, source);
    if (results.size !== outstanding.length) {
      throw new Error(
        `Codex supplied ${results.size} of ${outstanding.length} required tool results for Zero Risk compaction`,
      );
    }
    let token: string | undefined;
    try {
      token = await source.runtime.token;
      const interruptedQueued = await broker.requestCompaction(
        token,
        interruptedByZeroRiskCompaction(),
      );
      for (const [index, request] of outstanding.entries()) {
        const result = results.get(request.callId)!;
        const canonical = toolResult(result);
        await broker.completeTool(
          token,
          request.callId,
          interruptedQueued === 0 && index === outstanding.length - 1
            ? withZeroRiskCompactionInstruction(canonical)
            : canonical,
        );
        source.runtime.externalProgress.recordToolResult();
        source.markResultDelivered(request.callId);
      }
      const browserOutcome = await withCompactionAbort(source.browserOutcome, signal);
      if (browserOutcome.type === "error") throw browserOutcome.error;
      await withCompactionAbort(source.physicalSettlement, signal);
      const instructionDelivered = outstanding.length > 0
        || await broker.compactionDeliveryCount(token) > 0;
      if (!instructionDelivered) return undefined;
      const summary = browserOutcome.answer.trim();
      if (!summary) throw new Error("The active Zero Risk response returned an empty compaction summary");
      return summary;
    } catch (error) {
      if (signal?.aborted) source.cancel(abortReason(signal));
      throw error;
    } finally {
      if (token) await broker.revoke(token);
    }
  });
}

export async function requestRetainedCompactionHandoff(
  worker: ChatGptBrowserWorker,
  parsed: CodexParsedRequest,
  source: ChatGptTurnSession,
  broker: TurnBroker,
  capabilities: ChatGptWebCapabilities,
  traceId: string,
  signal?: AbortSignal,
  timeoutMs = MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
  repairIssues?: readonly string[],
  repairDraft?: string,
): Promise<string> {
  const conversationKey = source.conversationKey();
  if (!conversationKey) throw new Error("The completed ChatGPT source has no retained conversation identity");
  const operationTimeoutMs = boundedCompactionTimeout(timeoutMs);
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadline.abort(new Error(`ChatGPT compaction handoff timed out after ${operationTimeoutMs}ms`)),
    operationTimeoutMs,
  );
  deadlineTimer.unref?.();
  const operationSignal = signal
    ? AbortSignal.any([signal, deadline.signal])
    : deadline.signal;
  const browserAbort = new AbortController();
  const abortBrowser = () => browserAbort.abort(operationSignal.reason);
  let transaction: CompactionTransactionHandle | undefined;
  let browser: Promise<string> | undefined;
  if (operationSignal.aborted) abortBrowser();
  else operationSignal.addEventListener("abort", abortBrowser, { once: true });
  try {
    const transactionPromise = broker.beginCompactionTransaction(traceId, operationTimeoutMs);
    void transactionPromise.then(lateTransaction => {
      if (operationSignal.aborted && transaction !== lateTransaction) {
        broker.abortCompactionTransaction(lateTransaction.token);
      }
    }, () => {});
    transaction = await withCompactionAbort(transactionPromise, operationSignal);
    const allObservations = buildCompactionEvidenceIndex(
      parsed.context.messages,
      extractChatGptTurnIdentity(parsed).threadId ?? "",
    );
    const observations = repairIssues
      ? selectCompactionRepairEvidence(allObservations, `${repairIssues.join(" ")} ${repairDraft ?? ""}`, 12)
      : allObservations.slice(-24);
    const instruction = repairIssues
      ? structuredCompactionRepairInstruction(transaction, repairIssues, observations)
      : structuredCompactionHandoffInstruction(transaction, observations);
    if (repairIssues && !checkpointRepairPromptFits(
      instruction,
      parsed.modelId as ChatGptWebBackendModel,
      resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities).effort,
      capabilities,
    )) {
      throw new ChatGptWebAdapterError("Checkpoint repair exceeds the measured browser transport budget", {
        status: 413,
        errorType: "invalid_request_error",
        code: "compaction_repair_transport_limit",
        retryable: false,
      });
    }
    const prepare = async () => ({ text: instruction, images: [], release: () => {} });
    browser = worker.run({
      traceId,
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      // The retained connector exposes only the one-shot control token embedded above. It does
      // not receive an ordinary Codex tool environment for this checkpoint message.
      capabilities: { ...capabilities, localToolsEnabled: false },
      nativeConnector: true,
      prepare,
      prepareResume: prepare,
      conversationKey,
      requireRetainedConversation: true,
      abortSignal: browserAbort.signal,
      onTextDelta: () => {},
    });
    const handoff = broker.waitForCompactionHandoff(transaction.token, operationSignal);
    const browserWithoutHandoff = browser.then<never>(() => {
      // The control handler accepts the summary before replying to ChatGPT. A fully
      // settled response without that receipt cannot become a successful checkpoint.
      throw new ChatGptWebAdapterError(
        "ChatGPT finished without sending the context summary to Codex. Check its response for a refusal or tool error.",
        { status: 409, errorType: "invalid_request_error", code: "compaction_handoff_missing", retryable: false },
      );
    });
    const summary = await withCompactionAbort(
      Promise.race([
        handoff,
        browserWithoutHandoff,
      ]),
      operationSignal,
    );
    // The one-shot control submission is the terminal event for this purpose-built response.
    // ChatGPT may render no assistant text after a tool-only response, and therefore no Copy
    // action. End our owned turn explicitly and wait for the launcher/helper cleanup handshake.
    browserAbort.abort(new ChatGptCompactionHandoffAccepted());
    await withCompactionAbort(
      browser.then(() => undefined, () => undefined),
      operationSignal,
    );
    return summary;
  } finally {
    browserAbort.abort();
    if (transaction) broker.abortCompactionTransaction(transaction.token);
    if (browser) {
      // Logical cancellation is not physical retirement. The retained-session owner tracks
      // physical settlement separately, so this helper must not turn its own deadline into an
      // unbounded wait when the worker does not acknowledge abort immediately.
      await withCompactionAbort(
        browser.then(() => undefined, () => undefined),
        operationSignal,
      ).catch(() => {});
    }
    operationSignal.removeEventListener("abort", abortBrowser);
    clearTimeout(deadlineTimer);
  }
}

interface CachedCompactionRun {
  settledAt?: number;
  failed: boolean;
  ownerKey: string;
  revisionScopeKey?: string;
  traceIds: ReadonlySet<string>;
  nativeThreadId?: string;
  nativeTurnId?: string;
  abort: AbortController;
  active: boolean;
  promise: Promise<string>;
  settlement: Promise<void>;
}

interface StructuredCompactionInterruption {
  createdAt: number;
  reason: Error;
}

export interface StructuredCompactionOwner {
  ownerKey: string;
  /** Authenticated native turn and checkpoint epoch; a different request revision may not reuse it. */
  revisionScopeKey?: string;
  /** Every externally addressable browser trace owned by this structured compaction. */
  traceIds: readonly string[];
  /** Exact native Codex owner, when supplied by the current Responses request. */
  nativeThreadId?: string;
  nativeTurnId?: string;
}

const structuredCompactionRuns = new Map<string, CachedCompactionRun>();
const structuredCompactionOwners = new Map<string, Promise<void>>();
const structuredCompactionRevisionScopes = new Map<string, string>();
const structuredCompactionInterruptions = new Map<string, StructuredCompactionInterruption>();
const STRUCTURED_COMPACTION_RUN_TTL_MS = 30 * 60_000;

function nativeTurnIdentityKey(threadId: string, turnId: string): string {
  if (!threadId.trim() || !turnId.trim()) {
    throw new Error("Structured compaction requires non-empty native thread and turn ids");
  }
  return JSON.stringify([threadId, turnId]);
}

function rememberStructuredCompactionInterruption(threadId: string, turnId: string, reason: Error): void {
  const identity = nativeTurnIdentityKey(threadId, turnId);
  const now = Date.now();
  pruneStructuredCompactionInterruptions(now);
  const existing = structuredCompactionInterruptions.get(identity);
  if (existing) {
    existing.createdAt = now;
    return;
  }
  structuredCompactionInterruptions.set(identity, { createdAt: now, reason });
}

function structuredCompactionInterruption(owner: StructuredCompactionOwner): Error | undefined {
  if (owner.nativeThreadId === undefined && owner.nativeTurnId === undefined) return undefined;
  pruneStructuredCompactionInterruptions();
  return structuredCompactionInterruptions.get(
    nativeTurnIdentityKey(owner.nativeThreadId ?? "", owner.nativeTurnId ?? ""),
  )?.reason;
}

function pruneStructuredCompactionInterruptions(now = Date.now()): void {
  const cutoff = now - STRUCTURED_COMPACTION_RUN_TTL_MS;
  for (const [identity, interruption] of structuredCompactionInterruptions) {
    if (interruption.createdAt < cutoff) structuredCompactionInterruptions.delete(identity);
  }
}

function pruneStructuredCompactionRuns(): void {
  const now = Date.now();
  const cutoff = now - STRUCTURED_COMPACTION_RUN_TTL_MS;
  for (const [candidate, run] of structuredCompactionRuns) {
    if (run.settledAt !== undefined && run.settledAt < cutoff) {
      structuredCompactionRuns.delete(candidate);
    }
  }
  pruneStructuredCompactionInterruptions(now);
}

/** Return the canonical result of an exact compact request, even after its source was retired. */
export function existingStructuredCompactionRun(key: string): Promise<string> | undefined {
  pruneStructuredCompactionRuns();
  return structuredCompactionRuns.get(key)?.promise;
}

export function runStructuredCompactionOnce(
  key: string,
  owner: StructuredCompactionOwner,
  start: (operatorSignal: AbortSignal, retainOwnershipUntil: (settlement: Promise<void>) => void) => Promise<string>,
): Promise<string> {
  pruneStructuredCompactionRuns();
  const existing = structuredCompactionRuns.get(key);
  if (existing) return existing.promise;
  const interrupted = structuredCompactionInterruption(owner);
  if (interrupted) return Promise.reject(interrupted);
  const scopeOwner = owner.revisionScopeKey
    ? structuredCompactionRevisionScopes.get(owner.revisionScopeKey)
    : undefined;
  if (scopeOwner) {
    return Promise.reject(new ChatGptWebAdapterError(
      scopeOwner === key
        ? "The completed checkpoint result is no longer available for replay; the native turn must not be resubmitted"
        : "A different compact request revision already owns this native turn and checkpoint epoch",
      {
        status: 409,
        errorType: "invalid_request_error",
        code: scopeOwner === key ? "checkpoint_result_unavailable" : "compaction_revision_conflict",
        retryable: false,
      },
    ));
  }
  const abort = new AbortController();
  const previousOwner = structuredCompactionOwners.get(owner.ownerKey);
  const physicalSettlements: Promise<void>[] = previousOwner ? [previousOwner] : [];
  const promise = Promise.resolve().then(async () => {
    if (previousOwner) await withCompactionAbort(previousOwner, abort.signal);
    if (abort.signal.aborted) throw abortReason(abort.signal);
    return start(abort.signal, settlement => { physicalSettlements.push(settlement); });
  });
  // Return a deadline failure promptly while the physical owner still blocks new work.
  // Replay a failed exact request instead of resubmitting the original history to ChatGPT.
  // Explicit cancellation releases the key; settled replays also expire after the cache TTL.
  const ownerSettlement = promise.then(() => false, () => true).then(async failed => {
    run.failed = failed;
    await Promise.allSettled(physicalSettlements);
    run.active = false;
    run.settledAt = Date.now();
    if (structuredCompactionOwners.get(owner.ownerKey) === ownerSettlement) {
      structuredCompactionOwners.delete(owner.ownerKey);
    }
    if (failed && abort.signal.aborted && structuredCompactionRuns.get(key) === run) {
      structuredCompactionRuns.delete(key);
      if (run.revisionScopeKey && structuredCompactionRevisionScopes.get(run.revisionScopeKey) === key) {
        structuredCompactionRevisionScopes.delete(run.revisionScopeKey);
      }
    }
  });
  const run: CachedCompactionRun = {
    failed: false,
    ownerKey: owner.ownerKey,
    ...(owner.revisionScopeKey ? { revisionScopeKey: owner.revisionScopeKey } : {}),
    traceIds: new Set(owner.traceIds),
    ...(owner.nativeThreadId ? { nativeThreadId: owner.nativeThreadId } : {}),
    ...(owner.nativeTurnId ? { nativeTurnId: owner.nativeTurnId } : {}),
    abort,
    active: true,
    promise,
    settlement: ownerSettlement,
  };
  structuredCompactionRuns.set(key, run);
  if (owner.revisionScopeKey) structuredCompactionRevisionScopes.set(owner.revisionScopeKey, key);
  structuredCompactionOwners.set(owner.ownerKey, ownerSettlement);
  return promise;
}

function beginCancelStructuredCompactionRuns(
  matches: (run: CachedCompactionRun) => boolean,
  reason: Error,
): { cancelled: number; settlement: Promise<void> } {
  const runs = [...structuredCompactionRuns.entries()].filter(([, run]) => matches(run));
  const active = runs.filter(([, run]) => run.active).map(([, run]) => run);
  for (const [key, run] of runs) {
    if (!run.active && run.failed) {
      structuredCompactionRuns.delete(key);
      if (run.revisionScopeKey && structuredCompactionRevisionScopes.get(run.revisionScopeKey) === key) {
        structuredCompactionRevisionScopes.delete(run.revisionScopeKey);
      }
    }
  }
  for (const run of active) {
    if (!run.abort.signal.aborted) run.abort.abort(reason);
  }
  return { cancelled: active.length, settlement: Promise.allSettled(active.map(run => run.settlement)).then(() => undefined) };
}

/** Begin cancelling the structured compaction owned by one exact native Codex turn. */
export function cancelStructuredCompactionNativeTurn(
  threadId: string,
  turnId: string,
  reason: Error,
): { cancelled: number; settlement: Promise<void> } {
  // Record before scanning active owners. Registration and cancellation share this synchronous
  // boundary, so either registration wins and is aborted below, or interruption wins and the later
  // registration rejects without invoking its detached work.
  rememberStructuredCompactionInterruption(threadId, turnId, reason);
  const runs = [...structuredCompactionRuns.values()].filter(run => (
    run.active
    && run.nativeThreadId === threadId
    && run.nativeTurnId === turnId
  ));
  for (const run of runs) {
    if (!run.abort.signal.aborted) run.abort.abort(reason);
  }
  return {
    cancelled: runs.length,
    settlement: Promise.allSettled(runs.map(run => run.settlement)).then(() => undefined),
  };
}

/** Cancel a user-requested compaction without treating an HTTP observer disconnect as terminal. */
export function beginCancelStructuredCompactionTrace(traceId: string, reason: Error): { cancelled: number; settlement: Promise<void> } {
  return beginCancelStructuredCompactionRuns(run => run.traceIds.has(traceId), reason);
}

export async function cancelStructuredCompactionTrace(traceId: string, reason: Error): Promise<number> {
  const cancellation = beginCancelStructuredCompactionTrace(traceId, reason);
  await cancellation.settlement;
  return cancellation.cancelled;
}

/** Cancel every active compaction owner and wait for its browser/helper cleanup. */
export async function cancelAllStructuredCompactions(reason: Error): Promise<number> {
  const cancellation = beginCancelStructuredCompactionRuns(() => true, reason);
  await cancellation.settlement;
  return cancellation.cancelled;
}
