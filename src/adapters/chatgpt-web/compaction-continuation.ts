import { createHash } from "node:crypto";
import {
  buildCompactV1Output,
  decodeCompactionSummary,
  extractCompactUserMessages,
  isReadableCompactionSummaryText,
  SUMMARY_PREFIX,
} from "../../responses/compaction";
import type { CodexParsedRequest } from "../../types";
import type { ChatGptTurnIdentity, ChatGptTurnUserRevision } from "./environment";
import { extractChatGptCompactionSourceRevision, extractChatGptTurnIdentity } from "./environment";
import type { SessionActorManager } from "./session-actor/manager";
import { chatGptTurnExecutionKey } from "./turn-execution/keys";

interface CompletedCheckpoint {
  summaryHash: string;
  sourceHashes: ReadonlySet<string>;
  source: ChatGptTurnUserRevision;
  stillAccepted?: () => boolean;
}

// Evidence of a checkpoint actually returned by this daemon, not authority inferred from text
// that happens to look like a summary. Restart recovery requires exact durable journal evidence.
const checkpoints = new Map<string, CompletedCheckpoint>();
const MAX_CHECKPOINTS = 256;

function scope(parsed: CodexParsedRequest, identity: ChatGptTurnIdentity): string | undefined {
  if (!identity.threadId || !identity.turnId) return undefined;
  return JSON.stringify([identity.threadId, identity.turnId, parsed.modelId, parsed.options.reasoning]);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sourceDigest(source: ChatGptTurnUserRevision): string {
  return digest([source.turnId, source.content]);
}

export function rememberCompactionContinuation(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  sources: readonly ChatGptTurnUserRevision[],
  summary: string,
): void {
  const key = scope(parsed, identity);
  if (!key || !parsed._compactionRequest || !summary || !sources[0]) return;
  checkpoints.delete(key);
  checkpoints.set(key, {
    summaryHash: digest(summary),
    sourceHashes: new Set(sources.map(sourceDigest)),
    source: structuredClone(sources[0]),
  });
  while (checkpoints.size > MAX_CHECKPOINTS) checkpoints.delete(checkpoints.keys().next().value!);
}

/** Wire before structured checkpoint execution; no new persistence authority is introduced. */
export async function recordCompactionContinuationSource(
  manager: SessionActorManager,
  sessionId: string,
  parsed: CodexParsedRequest,
): Promise<void> {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!parsed._compactionRequest || !identity.threadId || !identity.turnId) return;
  const source = extractChatGptCompactionSourceRevision(parsed);
  const body = parsed._rawBody as { input?: unknown[] };
  // Retained v1 user messages are independent of summary text. Drop the output summary slot.
  const retained = buildCompactV1Output(extractCompactUserMessages(body.input), "").slice(0, -1);
  const v1Source =
    retained.length > 0
      ? extractChatGptCompactionSourceRevision({ ...parsed, _rawBody: { ...body, input: retained } })
      : source;
  const namespace = sessionId.slice(0, sessionId.lastIndexOf(":"));
  const trace = createHash("sha256")
    .update(`${namespace}:${chatGptTurnExecutionKey(parsed)}`)
    .digest("hex")
    .slice(0, 12);
  await manager.recordCompactionContinuationSource(sessionId, identity.turnId, `checkpoint:${trace}`, {
    threadId: identity.threadId,
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
    sources: [source, v1Source],
  });
}

/** Recover accepted source/hash/owner evidence before environment or instruction extraction. */
export function rehydrateCompactionContinuation(
  manager: SessionActorManager,
  sessionId: string,
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
): void {
  const requestIdentity = extractChatGptTurnIdentity(parsed);
  if (
    !identity.threadId ||
    !identity.turnId ||
    requestIdentity.threadId !== identity.threadId ||
    requestIdentity.turnId !== identity.turnId
  )
    return;
  const acceptedCheckpoints = manager.acceptedCompactionContinuations(sessionId, identity.turnId);
  // The durable owner fences route-local cache entries too, including entries remembered after response delivery.
  for (const key of checkpoints.keys()) {
    const candidate: unknown = JSON.parse(key);
    if (Array.isArray(candidate) && candidate[0] === identity.threadId && candidate[1] === identity.turnId) {
      checkpoints.delete(key);
    }
  }
  for (const accepted of acceptedCheckpoints.reverse()) {
    if (accepted.source.threadId !== identity.threadId) continue;
    const key = JSON.stringify([
      identity.threadId,
      identity.turnId,
      accepted.source.modelId,
      accepted.source.reasoning,
    ]);
    const checkpoint: CompletedCheckpoint = {
      summaryHash: digest(accepted.summary),
      sourceHashes: new Set(accepted.source.sources.map(sourceDigest)),
      source: structuredClone(accepted.source.sources[0]!),
      stillAccepted: () => {
        const current = manager.journal.snapshot(sessionId);
        return (
          current?.generation === accepted.generation &&
          current.turnId === identity.turnId &&
          manager.journal.compaction(sessionId, accepted.generation, accepted.operationId)?.state === "accepted"
        );
      },
    };
    // A retry may carry S1 even after S2 was accepted. Select the incoming exact hash,
    // rather than replacing its authority with the newest checkpoint for the same mode.
    if (acceptedCheckpointForKey(parsed, identity, key, checkpoint)) {
      checkpoints.delete(key);
      checkpoints.set(key, checkpoint);
    }
  }
  while (checkpoints.size > MAX_CHECKPOINTS) checkpoints.delete(checkpoints.keys().next().value!);
}

export function isAcceptedCompactionContinuation(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  source: ChatGptTurnUserRevision,
): boolean {
  return acceptedCheckpoint(parsed, identity)?.checkpoint.sourceHashes.has(sourceDigest(source)) === true;
}

/** Native compaction may retain only its summary; recover the task solely from our completed handoff. */
export function recoverCompactionInstruction(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
): { source: ChatGptTurnUserRevision; summaryIndex: number } | undefined {
  const accepted =
    acceptedCheckpoint(parsed, identity) ??
    (parsed._compactionRequest ? acceptedCheckpointAcrossModes(parsed, identity) : undefined);
  return accepted
    ? { source: structuredClone(accepted.checkpoint.source), summaryIndex: accepted.summaryIndex }
    : undefined;
}

/** Only an exact previously accepted checkpoint may open another compact epoch in this turn. */
export function acceptedCompactionEpoch(parsed: CodexParsedRequest, identity: ChatGptTurnIdentity): string | undefined {
  const exact = acceptedCheckpoint(parsed, identity);
  if (exact) return exact.checkpoint.summaryHash;
  // A model/effort switch must not authorize a normal task continuation, but a checkpoint
  // actually returned for this same native turn still identifies its compact epoch.
  return acceptedCheckpointAcrossModes(parsed, identity)?.checkpoint.summaryHash;
}

function acceptedCheckpointAcrossModes(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
): { checkpoint: CompletedCheckpoint; summaryIndex: number } | undefined {
  if (!identity.threadId || !identity.turnId) return undefined;
  for (const [key, checkpoint] of checkpoints) {
    const candidate: unknown = JSON.parse(key);
    if (!Array.isArray(candidate) || candidate[0] !== identity.threadId || candidate[1] !== identity.turnId) continue;
    const accepted = acceptedCheckpointForKey(parsed, identity, key, checkpoint);
    if (accepted) return accepted;
  }
  return undefined;
}

function acceptedCheckpoint(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
): { checkpoint: CompletedCheckpoint; summaryIndex: number } | undefined {
  const key = scope(parsed, identity);
  const checkpoint = key ? checkpoints.get(key) : undefined;
  if (!key || !checkpoint) return undefined;
  return acceptedCheckpointForKey(parsed, identity, key, checkpoint);
}

function acceptedCheckpointForKey(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  key: string,
  checkpoint: CompletedCheckpoint,
): { checkpoint: CompletedCheckpoint; summaryIndex: number } | undefined {
  if (checkpoint.stillAccepted && !checkpoint.stillAccepted()) {
    checkpoints.delete(key);
    return undefined;
  }
  const input = (parsed._rawBody as { input?: unknown[] } | undefined)?.input;
  if (!Array.isArray(input)) return undefined;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index] as Record<string, unknown> | null;
    if (!item || typeof item !== "object") continue;
    let summary: string | null;
    if (["compaction", "compaction_summary", "context_compaction"].includes(String(item.type))) {
      summary = typeof item.encrypted_content === "string" ? decodeCompactionSummary(item.encrypted_content) : null;
    } else {
      if (item.type !== "message" || item.role !== "user") continue;
      const text =
        typeof item.content === "string"
          ? item.content
          : Array.isArray(item.content)
            ? item.content.map((part) => part?.text ?? "").join("\n")
            : "";
      if (!isReadableCompactionSummaryText(text)) continue;
      summary = text.slice(SUMMARY_PREFIX.length + 1);
    }
    const owner = (item.internal_chat_message_metadata_passthrough as { turn_id?: unknown } | undefined)?.turn_id;
    if (owner !== undefined && owner !== identity.turnId) return undefined;
    return summary !== null && acceptsSummary(key, checkpoint, summary)
      ? { checkpoint, summaryIndex: index }
      : undefined;
  }
  return undefined;
}

function acceptsSummary(key: string, checkpoint: CompletedCheckpoint, summary: string): boolean {
  if (digest(summary) !== checkpoint.summaryHash) return false;
  // A long-running continuation does not become invalid merely because time passed. Keep the
  // bounded registry ordered by actual use instead of expiring a still-active native turn.
  checkpoints.delete(key);
  checkpoints.set(key, checkpoint);
  return true;
}
