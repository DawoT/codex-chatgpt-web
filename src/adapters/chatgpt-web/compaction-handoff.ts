import { createHash } from "node:crypto";
import type { ChatGptWebBackendModel } from "../../chatgpt-web-models";
import {
  autoHealCompactionBlock,
  COMPACT_PROMPT,
  type CompactionRequirement,
  type CompactionStateBlock,
  compactionStateFields,
  countActiveCompactionStates,
  countCompactionRequirementItems,
  extractStructuredCompactionHandoff,
  formatCompactionStateBlock,
  LATEST_USER_PROMPT_MARKER,
  locateCompactionStateBounds,
  normalizeCompactionStateBlock,
  ORIGINAL_USER_REQUEST_MARKER,
  parseCompactionState,
} from "../../responses/compaction";
import type { CodexContentPart, CodexParsedRequest, CodexToolResultMessage } from "../../types";
import { parseDataUrl } from "../image";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError } from "./adapter-error";
import { extractModifiedFilePaths } from "./autonomous-compaction";
import type { ChatGptBrowserWorker } from "./browser-worker";
import {
  boundedCompactionRepairObservations,
  buildCompactionEvidenceIndex,
  selectCompactionRepairEvidence,
} from "./compaction-evidence";
import { checkpointRepairPromptFits } from "./compaction-repair";
import type { CompactionTransactionHandle } from "./compaction-transaction";
import { extractChatGptCompactionSourceRevision, extractChatGptTurnIdentity } from "./environment";
import type { ChatGptWebCapabilities } from "./model";
import { resolveChatGptWebModelMode } from "./model";
import {
  activeCompactionToolResultInstruction,
  structuredCompactionHandoffInstruction,
  structuredCompactionRepairInstruction,
  zeroRiskActiveCompactionToolResultInstruction,
} from "./native-compaction-control";
import type { BrokerToolResult, TurnBroker, TurnBrokerOwner } from "./turn-broker";
import type { ChatGptTurnSession } from "./turn-execution";

export { LATEST_USER_PROMPT_MARKER, ORIGINAL_USER_REQUEST_MARKER };

function brokerContent(content: string | CodexContentPart[]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part) => {
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
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
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
    content: [
      {
        type: "text",
        text: zeroRiskActiveCompactionToolResultInstruction(false),
      },
    ],
    isError: true,
  };
}

function userPromptText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return [];
      const value = part as { type?: unknown; text?: unknown };
      return (value.type === "input_text" || value.type === "text") && typeof value.text === "string"
        ? [value.text]
        : [];
    })
    .join("\n");
  return text || undefined;
}

function freeformCompactionState(parsed: CodexParsedRequest, summary: string, digest: string): CompactionStateBlock {
  const previous = parsed.context.messages.findLast(
    (message) => message.role === "user" && message.origin === "compaction_summary",
  );
  const prior = previous ? extractStructuredCompactionHandoff(userPromptText(previous.content) ?? "").state : null;
  const checkpointIndex = previous ? parsed.context.messages.lastIndexOf(previous) : -1;
  const requirements: CompactionRequirement[] = [...(prior?.requirements ?? [])];
  const sources = new Set(requirements.map((requirement) => requirement.source));
  const ids = new Set(requirements.map((requirement) => requirement.id));
  for (const message of parsed.context.messages.slice(checkpointIndex + 1)) {
    if (message.role !== "user" || message.origin === "codex_skill" || message.origin === "compaction_summary")
      continue;
    const source = userPromptText(message.content)?.trim();
    if (!source || source === COMPACT_PROMPT || sources.has(source)) continue;
    const hash = createHash("sha256").update(source).digest("hex");
    let length = 12;
    let id = `REQ-${hash.slice(0, length)}`;
    while (ids.has(id) && length < hash.length) {
      length += 2;
      id = `REQ-${hash.slice(0, length)}`;
    }
    requirements.push({ id, status: "pending", source });
    sources.add(source);
    ids.add(id);
  }
  if (requirements.length === 0) {
    requirements.push({ id: `REQ-${digest.slice(0, 12)}`, status: "pending", source: summary });
  }
  return {
    version: 2,
    originalRequestRef: `sha256:${digest}`,
    modifiedFiles: [
      ...new Set([...(prior?.modifiedFiles ?? []), ...extractModifiedFilePaths(parsed.context.messages)]),
    ],
    activeHypothesis: "Continue the user requirements described in the checkpoint narrative.",
    requirements,
    closureCriteria: prior?.closureCriteria?.length
      ? prior.closureCriteria
      : ["Complete and verify the pending user requirements."],
    verifiedAchievements: prior?.verifiedAchievements ?? [],
    decisionsAndInvariants: prior?.decisionsAndInvariants ?? [],
    blockersOrTestFailures: prior?.blockersOrTestFailures ?? [],
    pendingObligations: prior?.pendingObligations ?? [],
    nextActions: ["Continue the pending requirements using the checkpoint narrative and source evidence."],
  };
}

export function canonicalizeCompactionHandoff(
  parsed: CodexParsedRequest,
  summary: string,
  options?: { autoHeal?: boolean },
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
  body = options?.autoHeal ? autoHealCompactionBlock(body) : normalizeCompactionStateBlock(body);

  const previous = parsed.context.messages.filter(
    (message) => message.role === "user" && message.origin === "compaction_summary",
  );
  let originalRequest: string | undefined;
  if (previous.length > 0) {
    for (const checkpoint of previous.toReversed()) {
      const priorText = userPromptText(checkpoint.content) ?? "";
      const marker = new RegExp(`(?:^|\\n)${ORIGINAL_USER_REQUEST_MARKER}\\n([^\\n]+)`).exec(priorText);
      if (!marker) continue;
      try {
        const record = JSON.parse(marker[1]!) as { sha256?: unknown; text?: unknown };
        if (
          typeof record.text === "string" &&
          typeof record.sha256 === "string" &&
          createHash("sha256").update(record.text).digest("hex") === record.sha256
        ) {
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
    const firstUser = parsed.context.messages.find(
      (message) => message.role === "user" && message.origin !== "codex_skill",
    );
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
    if (
      body.trim().length >= 50 &&
      !/<\/?compaction_state\b/i.test(body) &&
      !/^ {0,3}(?:`{3,}|~{3,})/m.test(body) &&
      !/^ {4,}(?:version|original_request_ref|modified_files|active_hypothesis|requirements|closure_criteria|next_actions):/m.test(
        body,
      ) &&
      !locateCompactionStateBounds(body) &&
      extractStructuredCompactionHandoff(body).state?.version !== 2
    ) {
      body = `${body}\n\n${formatCompactionStateBlock(freeformCompactionState(parsed, body, digest))}`;
    }
    const bounds = locateCompactionStateBounds(body);
    let state: CompactionStateBlock | null = null;
    let before = body;
    let after = "";

    if (bounds && !bounds.fenced) {
      before = body.slice(0, bounds.startTagStart).trimEnd();
      after = body.slice(bounds.endTagEnd).trimStart();
      state = parseCompactionState(body.slice(bounds.startTagStart, bounds.endTagEnd));
    } else {
      const handoff = extractStructuredCompactionHandoff(body);
      state = handoff.state;
      if (state) {
        before = handoff.narrative.trimEnd();
      }
    }

    const fields = compactionStateFields(body);
    const completeDraft =
      options?.autoHeal ||
      (!bounds?.fenced &&
        (bounds !== null || !/^ {0,3}(?:`{3,}|~{3,})/m.test(body)) &&
        state?.version === 2 &&
        countActiveCompactionStates(body) <= 1 &&
        state.activeHypothesis?.trim() &&
        state.requirements?.length &&
        countCompactionRequirementItems(body) === state.requirements.length &&
        state.closureCriteria?.length &&
        state.nextActions.length === 1 &&
        [
          "version",
          "modified_files",
          "active_hypothesis",
          "requirements",
          "closure_criteria",
          "verified_achievements",
          "decisions_and_invariants",
          "pending_obligations",
          "next_actions",
        ].every((field) => fields.has(field)) &&
        (fields.has("blockers_or_test_failures") || fields.has("blockers")));

    // Only normalize a complete, explicitly versioned draft. Missing fields,
    // conflicting IDs and extra actions must remain visible to validation/repair.
    if (state && completeDraft) {
      const detectedFiles = extractModifiedFilePaths(parsed.context.messages);
      const existingFiles = (state.modifiedFiles ?? []).filter(
        (f) => f && f.toLowerCase() !== "none" && f.toLowerCase() !== "- none",
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
          `[chatgpt-web] compaction_file_reconciliation ${JSON.stringify({
            schemaVersion: 1,
            source: "successful_patch_history",
            insertedCount: injectedFiles.length,
          })}`,
        );
      }

      let nextActions = state.nextActions ?? [];
      if (options?.autoHeal && nextActions.length > 1) {
        nextActions = [nextActions.join("; ")];
      }

      let healedRequirements = state.requirements;
      if (options?.autoHeal && healedRequirements) {
        const seenIds = new Set<string>();
        healedRequirements = healedRequirements.map((req, idx) => {
          let id = req.id;
          if (!id || !/^[-A-Za-z0-9_]+$/.test(id) || seenIds.has(id)) {
            id = `REQ-${(idx + 1).toString().padStart(3, "0")}`;
            let counter = 1;
            while (seenIds.has(id)) {
              id = `REQ-${(idx + 1).toString().padStart(3, "0")}-${counter++}`;
            }
          }
          seenIds.add(id);
          const source = req.source?.trim() ? req.source.trim() : "User request";
          let status = req.status;
          if (!["pending", "blocked", "verified"].includes(status)) {
            status = "pending";
          }
          if (status === "verified" && !req.evidence?.trim()) {
            status = "pending";
          }
          return {
            ...req,
            id,
            status,
            source,
          };
        });
      }

      let healedAchievements = state.verifiedAchievements ?? [];
      const healedDecisions = [...(state.decisionsAndInvariants ?? [])];
      if (options?.autoHeal) {
        const retainedAchievements: Array<string | CompactionAchievement> = [];
        for (const item of healedAchievements) {
          const evidenceStr =
            typeof item === "string" ? /\bevidence\s*:\s*(.+)$/i.exec(item)?.[1]?.trim() : item.evidence;
          const hasEvidenceInMessages = Boolean(
            evidenceStr &&
              evidenceStr.length >= 8 &&
              parsed.context.messages.some((msg) => {
                const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
                return text.toLowerCase().includes(evidenceStr.toLowerCase());
              }),
          );
          if (hasEvidenceInMessages) {
            retainedAchievements.push(item);
          } else {
            const note = typeof item === "string" ? item : item.result;
            if (note && !healedDecisions.some((d) => d.toLowerCase().includes(note.toLowerCase()))) {
              healedDecisions.push(note);
            }
          }
        }
        healedAchievements = retainedAchievements;
      }

      const canonicalState: CompactionStateBlock = {
        ...state,
        version: state.version ?? 2,
        originalRequestRef: `sha256:${digest}`,
        modifiedFiles: existingFiles.length > 0 ? existingFiles : ["None"],
        ...(healedRequirements ? { requirements: healedRequirements } : {}),
        verifiedAchievements: healedAchievements,
        decisionsAndInvariants: healedDecisions,
        pendingObligations: state.pendingObligations ?? [],
        nextActions: nextActions.length > 0 ? nextActions : ["Continue pending requirements."],
      };

      body = [before, formatCompactionStateBlock(canonicalState), after].filter(Boolean).join("\n\n");
    }
    return `${body}\n\n${originalAppendix}\n\n${latestAppendix}`;
  }
  return `${body}\n\n${latestAppendix}`;
}

export function autoHealCompactionHandoff(parsed: CodexParsedRequest, summary: string): string {
  return canonicalizeCompactionHandoff(parsed, summary, { autoHeal: true });
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
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
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
      throw new Error(`Codex supplied ${results.size} of ${outstanding.length} required tool results for compaction`);
    }
    let token: string | undefined;
    try {
      token = await source.runtime.token;
      broker.requestCompaction(token, interruptedByActiveCompaction());
      for (const request of outstanding) {
        const result = results.get(request.callId)!;
        await broker.completeTool(token, request.callId, toolResult(result));
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
      const interruptedQueued = await broker.requestCompaction(token, interruptedByZeroRiskCompaction());
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
      const instructionDelivered = outstanding.length > 0 || (await broker.compactionDeliveryCount(token)) > 0;
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
  const operationSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const browserAbort = new AbortController();
  const abortBrowser = () => browserAbort.abort(operationSignal.reason);
  let transaction: CompactionTransactionHandle | undefined;
  let browser: Promise<string> | undefined;
  if (operationSignal.aborted) abortBrowser();
  else operationSignal.addEventListener("abort", abortBrowser, { once: true });
  try {
    const transactionPromise = broker.beginCompactionTransaction(traceId, operationTimeoutMs);
    void transactionPromise.then(
      (lateTransaction) => {
        if (operationSignal.aborted && transaction !== lateTransaction) {
          broker.abortCompactionTransaction(lateTransaction.token);
        }
      },
      () => {},
    );
    transaction = await withCompactionAbort(transactionPromise, operationSignal);
    const allObservations = buildCompactionEvidenceIndex(
      parsed.context.messages,
      extractChatGptTurnIdentity(parsed).threadId ?? "",
    );
    let instruction: string;
    if (repairIssues) {
      const selected = boundedCompactionRepairObservations(
        selectCompactionRepairEvidence(allObservations, `${repairIssues.join(" ")} ${repairDraft ?? ""}`, 6),
      );
      instruction = structuredCompactionRepairInstruction(transaction, repairIssues, selected);
      const effort = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities).effort;
      while (
        !checkpointRepairPromptFits(instruction, parsed.modelId as ChatGptWebBackendModel, effort, capabilities) &&
        selected.length > 0
      ) {
        selected.pop();
        instruction = structuredCompactionRepairInstruction(transaction, repairIssues, selected);
      }
      if (!checkpointRepairPromptFits(instruction, parsed.modelId as ChatGptWebBackendModel, effort, capabilities)) {
        throw new ChatGptWebAdapterError("Checkpoint repair exceeds the measured browser transport budget", {
          status: 413,
          errorType: "invalid_request_error",
          code: "compaction_repair_transport_limit",
          retryable: false,
        });
      }
    } else {
      const selected = boundedCompactionRepairObservations(allObservations.slice(-6));
      instruction = structuredCompactionHandoffInstruction(transaction, selected);
      const effort = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities).effort;
      while (
        !checkpointRepairPromptFits(instruction, parsed.modelId as ChatGptWebBackendModel, effort, capabilities) &&
        selected.length > 0
      ) {
        selected.pop();
        instruction = structuredCompactionHandoffInstruction(transaction, selected);
      }
      if (!checkpointRepairPromptFits(instruction, parsed.modelId as ChatGptWebBackendModel, effort, capabilities)) {
        throw new ChatGptWebAdapterError("Checkpoint handoff exceeds the measured browser transport budget", {
          status: 413,
          errorType: "invalid_request_error",
          code: "compaction_handoff_transport_limit",
          retryable: false,
        });
      }
    }
    const prepare = async () => ({ text: instruction, images: [], release: () => {} });
    let accumulatedText = "";
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
      onTextDelta: (delta) => {
        accumulatedText += delta;
      },
    });
    const handoff = broker.waitForCompactionHandoff(transaction.token, operationSignal);
    const browserWithoutHandoff = browser.then<string>((browserOutput) => {
      const candidateText = (browserOutput || accumulatedText || "").trim();
      const bounds = locateCompactionStateBounds(candidateText);
      if (bounds || candidateText.includes("<compaction_state>") || candidateText.includes("compaction_state")) {
        console.info(
          `[chatgpt-web] compaction_retained_text_rescue: Rescued compaction checkpoint from assistant text output (chars=${candidateText.length})`,
        );
        return autoHealCompactionHandoff(parsed, candidateText);
      }
      // The control handler accepts the summary before replying to ChatGPT. A fully
      // settled response without that receipt cannot become a successful checkpoint.
      throw new ChatGptWebAdapterError(
        "ChatGPT finished without sending the context summary to Codex. Check its response for a refusal or tool error.",
        { status: 409, errorType: "invalid_request_error", code: "compaction_handoff_missing", retryable: false },
      );
    });
    const summary = await withCompactionAbort(Promise.race([handoff, browserWithoutHandoff]), operationSignal);
    // The one-shot control submission is the terminal event for this purpose-built response.
    // ChatGPT may render no assistant text after a tool-only response, and therefore no Copy
    // action. End our owned turn explicitly and wait for the launcher/helper cleanup handshake.
    browserAbort.abort(new ChatGptCompactionHandoffAccepted());
    await withCompactionAbort(
      browser.then(
        () => undefined,
        () => undefined,
      ),
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
        browser.then(
          () => undefined,
          () => undefined,
        ),
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
    return Promise.reject(
      new ChatGptWebAdapterError(
        scopeOwner === key
          ? "The completed checkpoint result is no longer available for replay; the native turn must not be resubmitted"
          : "A different compact request revision already owns this native turn and checkpoint epoch",
        {
          status: 409,
          errorType: "invalid_request_error",
          code: scopeOwner === key ? "checkpoint_result_unavailable" : "compaction_revision_conflict",
          retryable: false,
        },
      ),
    );
  }
  const abort = new AbortController();
  const previousOwner = structuredCompactionOwners.get(owner.ownerKey);
  const physicalSettlements: Promise<void>[] = previousOwner ? [previousOwner] : [];
  const promise = Promise.resolve().then(async () => {
    if (previousOwner) await withCompactionAbort(previousOwner, abort.signal);
    if (abort.signal.aborted) throw abortReason(abort.signal);
    return start(abort.signal, (settlement) => {
      physicalSettlements.push(settlement);
    });
  });
  // Return a deadline failure promptly while the physical owner still blocks new work.
  // Replay a failed exact request instead of resubmitting the original history to ChatGPT.
  // Explicit cancellation releases the key; settled replays also expire after the cache TTL.
  const ownerSettlement = promise
    .then(
      () => false,
      () => true,
    )
    .then(async (failed) => {
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
  return {
    cancelled: active.length,
    settlement: Promise.allSettled(active.map((run) => run.settlement)).then(() => undefined),
  };
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
  const runs = [...structuredCompactionRuns.values()].filter(
    (run) => run.active && run.nativeThreadId === threadId && run.nativeTurnId === turnId,
  );
  for (const run of runs) {
    if (!run.abort.signal.aborted) run.abort.abort(reason);
  }
  return {
    cancelled: runs.length,
    settlement: Promise.allSettled(runs.map((run) => run.settlement)).then(() => undefined),
  };
}

/** Cancel a user-requested compaction without treating an HTTP observer disconnect as terminal. */
export function beginCancelStructuredCompactionTrace(
  traceId: string,
  reason: Error,
): { cancelled: number; settlement: Promise<void> } {
  return beginCancelStructuredCompactionRuns((run) => run.traceIds.has(traceId), reason);
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
