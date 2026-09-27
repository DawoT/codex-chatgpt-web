import { isReadableCompactionSummaryText, OPAQUE_COMPACTION_NOTE } from "../../../responses/compaction";
import type { CodexParsedRequest } from "../../../types";
import { isAcceptedCompactionContinuation, recoverCompactionInstruction } from "../compaction-continuation";
import { clientTurnMetadata, isTurnAbortedNotice, itemTurnId, rawMessageText, record } from "./helpers";
import { extractChatGptTurnIdentity } from "./identity";
import {
  CHATGPT_TURN_REVISION_CONFLICT_MESSAGE,
  type ChatGptTurnUserRevision,
} from "./types";

/** Native context is a user fragment, never an XML mention in an answer, tool result or request. */
export function hasEnvironmentContextFragment(item: Record<string, unknown> | undefined): item is Record<string, unknown> {
  if (item?.type !== "message" || item.role !== "user") return false;
  const kinds = record(item.internal_chat_message_metadata_passthrough)?.content_item_kinds;
  // Keep explicitly typed native fragments fail-closed even when their XML is malformed.
  if (Array.isArray(kinds) && kinds.includes("environments.environment_context")) return true;
  const texts = typeof item.content === "string" ? [item.content]
    : Array.isArray(item.content) ? item.content.map(part => record(part)?.text) : [];
  // Older wire messages have no content kind. A fragment starting an environment tag is
  // still an attempted update when truncated; prose mentions and fenced examples are not.
  return texts.some(text => typeof text === "string"
    && /^<\/?environment_context\b/i.test(text.trimStart()));
}

export function contextualUserMessage(value: Record<string, unknown>): boolean {
  const text = rawMessageText(value).trim();
  return hasEnvironmentContextFragment(value)
    || /^<subagent_notification>[\s\S]*<\/subagent_notification>$/.test(text)
    || isReadableCompactionSummaryText(text)
    || text === OPAQUE_COMPACTION_NOTE;
}

export function compactionSummaryMessage(value: Record<string, unknown>): boolean {
  if (value.type !== "message" || value.role !== "user") return false;
  const text = rawMessageText(value).trim();
  return isReadableCompactionSummaryText(text) || text === OPAQUE_COMPACTION_NOTE;
}

/** The desktop injects cross-task messages as synthetic tool outputs without a call_id. */
export function isDelegatedInstruction(item: Record<string, unknown> | undefined): boolean {
  if (item?.type !== "function_call_output" || item.name !== "send_message_to_thread"
    || item.namespace !== "codex_app" || item.call_id !== undefined
    || typeof item.id !== "string" || !item.id || !itemTurnId(item)?.trim()
    || typeof item.output !== "string") return false;
  // The native producer escapes &, < and > in both fields. Reject extra/nested tags and
  // malformed entities; keep the original text as task content, never environment authority.
  const fields = /^<codex_delegation>\s*<source_thread_id>([^<>]+)<\/source_thread_id>\s*<input>([^<>]+)<\/input>\s*<\/codex_delegation>$/.exec(item.output.trim());
  return fields !== null && fields.slice(1).every(text => text.trim() && !/&(?!amp;|lt;|gt;)/.test(text));
}

/** V2 agent_message instructions must still come from this child's direct parent. */
export function isNativeInstruction(
  item: Record<string, unknown> | undefined,
  metadata?: Record<string, unknown>,
): item is Record<string, unknown> {
  if (item?.type === "message" && item.role === "user") return !contextualUserMessage(item);
  if (isDelegatedInstruction(item)) return true;
  if (item?.type !== "agent_message" || typeof item.id !== "string" || !item.id
    || metadata?.subagent_kind !== "thread_spawn"
    || (metadata.request_kind !== "turn" && metadata.request_kind !== "compaction")
    || typeof metadata.thread_id !== "string" || !metadata.thread_id
    || typeof metadata.parent_thread_id !== "string" || !metadata.parent_thread_id
    || metadata.thread_id === metadata.parent_thread_id) return false;
  const agentName = metadata.agent_name;
  return typeof agentName === "string" && /^\/root\/(?:[^/]+\/)*[^/]+$/.test(agentName)
    && item.recipient === agentName
    && item.author === agentName.slice(0, agentName.lastIndexOf("/"));
}

/** Native turn ids that Codex has authoritatively marked as interrupted in this thread. */
export function priorChatGptAbortedTurnIds(parsed: CodexParsedRequest): string[] {
  const currentTurnId = extractChatGptTurnIdentity(parsed).turnId;
  if (!currentTurnId) return [];
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  return [...new Set(input.flatMap(value => {
    const item = record(value);
    const abortedTurnId = item ? itemTurnId(item) : undefined;
    return item?.type === "message"
      && item.role === "user"
      && isTurnAbortedNotice(item)
      && abortedTurnId !== undefined
      && abortedTurnId !== currentTurnId
      ? [abortedTurnId]
      : [];
  }))];
}

export function userRevision(value: unknown, expectedTurnId?: string, metadata?: Record<string, unknown>): ChatGptTurnUserRevision | undefined {
  const item = record(value);
  if (!isNativeInstruction(item, metadata)) return undefined;
  const messageTurnId = itemTurnId(item);
  // An abort notice is contextual only when native metadata identifies its earlier turn.
  if (item.type === "message" && isTurnAbortedNotice(item) && expectedTurnId !== undefined
    && messageTurnId !== undefined && messageTurnId !== expectedTurnId) return undefined;
  const itemId = typeof item.id === "string" && item.id.length > 0 ? item.id : undefined;
  if (messageTurnId === undefined && itemId === undefined) return undefined;
  return { content: item.type === "function_call_output" ? item.output : item.content,
    ...(messageTurnId ? { turnId: messageTurnId } : {}),
    ...(itemId ? { itemId } : {}) };
}

export function latestChatGptTurnUserRevision(parsed: CodexParsedRequest, expectedTurnId?: string): ChatGptTurnUserRevision | undefined {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  if (parsed._hostTurn) {
    const current = input.findLast(value => {
      const item = record(value);
      return item?.role === "user" && (item.type === undefined || item.type === "message");
    });
    const item = record(current);
    return item ? { content: item.content, turnId: parsed._hostTurn.turnId } : undefined;
  }
  const metadata = clientTurnMetadata(parsed);
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const revision = userRevision(input[index], expectedTurnId, metadata);
    if (revision) return revision;
  }
  return recoverCompactionInstruction(parsed, extractChatGptTurnIdentity(parsed))?.source;
}

/**
 * Return the latest instruction owned by the current native Codex turn.
 *
 * Provider rounds replay the same instruction and steering appends a newer one. Remote
 * compaction uses this revision to identify and stop the superseded browser response; once Codex
 * installs the replacement history, the immediate continuation starts a fresh browser response
 * under the same logical task revision.
 */
export function extractChatGptTurnUserRevision(parsed: CodexParsedRequest): unknown {
  const identity = extractChatGptTurnIdentity(parsed);
  const turnId = identity.turnId;
  if (!turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-session replay");
  const revision = latestChatGptTurnUserRevision(parsed, turnId);
  if (!revision) throw new Error("ChatGPT web requires a current-turn user message for browser-session replay");
  // A pre-turn compact may summarize an earlier user message before native Codex continues
  // under its new turn id without adding a new human message. Accept only our exact completed
  // checkpoint; an arbitrary older prompt is still not a new instruction or a valid handoff.
  if (revision.turnId !== undefined && revision.turnId !== turnId
    && (priorChatGptAbortedTurnIds(parsed).includes(revision.turnId)
      || !isAcceptedCompactionContinuation(parsed, identity, revision))) {
    throw new Error(CHATGPT_TURN_REVISION_CONFLICT_MESSAGE);
  }
  return revision.content;
}

/** Canonical instruction order distinguishes new steering from a delayed older request. */
export function chatGptTurnUserRevisionHistory(parsed: CodexParsedRequest): ChatGptTurnUserRevision[] {
  if (parsed._hostTurn) {
    const revision = latestChatGptTurnUserRevision(parsed);
    return revision ? [revision] : [];
  }
  const body = record(parsed._rawBody);
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  const metadata = clientTurnMetadata(parsed);
  const revisions = (Array.isArray(body?.input) ? body.input : []).flatMap(value => {
    const revision = userRevision(value, turnId, metadata);
    return revision ? [revision] : [];
  });
  if (revisions.length > 0) return revisions;
  const recovered = recoverCompactionInstruction(parsed, extractChatGptTurnIdentity(parsed));
  return recovered ? [recovered.source] : [];
}

/** A remote compaction may summarize an instruction from an earlier turn. */
export function extractChatGptCompactionSourceRevision(parsed: CodexParsedRequest): ChatGptTurnUserRevision {
  if (!parsed._compactionRequest) throw new Error("ChatGPT web compaction source requires a compaction request");
  const revision = latestChatGptTurnUserRevision(parsed, extractChatGptTurnIdentity(parsed).turnId);
  if (!revision) throw new Error("ChatGPT web compaction requires a source user message");
  return revision;
}

/** A completed checkpoint binds an older instruction to this exact continuing native turn. */
export function isChatGptCompactionContinuation(parsed: CodexParsedRequest): boolean {
  const identity = extractChatGptTurnIdentity(parsed);
  const revision = latestChatGptTurnUserRevision(parsed, identity.turnId);
  return revision?.turnId !== undefined && identity.turnId !== undefined
    && revision.turnId !== identity.turnId
    && !priorChatGptAbortedTurnIds(parsed).includes(revision.turnId)
    && isAcceptedCompactionContinuation(parsed, identity, revision);
}
