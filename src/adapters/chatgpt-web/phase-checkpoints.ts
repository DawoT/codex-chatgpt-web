import { createHash } from "node:crypto";
import { estimateTokens } from "../../lib/token-estimate";
import {
  extractStructuredCompactionHandoff,
  LATEST_USER_PROMPT_MARKER,
  ORIGINAL_USER_REQUEST_MARKER,
} from "../../responses/compaction";
import type { CodexMessage, CodexParsedRequest } from "../../types";
import { buildCompactionEvidenceIndex } from "./compaction-evidence";
import { inspectCompactionCheckpoint } from "./compaction-policy";
import { compactionOriginalRequest } from "./compaction-source";
import { extractChatGptTurnIdentity } from "./environment";
import { hashChatGptLunaAnswer, parentAssistantAnswer } from "./rolling-checkpoint";
import type { SessionActor } from "./session-actor/actor";
import type { SessionActorJournal } from "./session-actor/journal";
import type { SessionResultStore } from "./session-actor/results";

export const PHASE_CHECKPOINT_TOKEN_BUDGET = 4_000;
export const PHASE_CHECKPOINT_WIRE_NAME = "codex.control.phase_checkpoint";

interface PhaseCheckpoint {
  version: 1;
  threadId: string;
  sourceTurnId: string;
  modelId: string;
  reasoning?: string;
  modelFamily?: "5.6" | "6";
  answerHash: string;
  sourceHash: string;
  sourceCount: number;
  summary: string;
  source: CodexParsedRequest;
}

function text(message: CodexMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function sourceHash(messages: readonly CodexMessage[]): string {
  return createHash("sha256")
    .update(JSON.stringify(messages.map(({ timestamp: _timestamp, ...message }) => message)))
    .digest("hex");
}

function lightweightSummary(summary: string): string {
  let end = summary.length;
  for (const marker of [ORIGINAL_USER_REQUEST_MARKER, LATEST_USER_PROMPT_MARKER]) {
    const offset = summary.indexOf(`\n${marker}\n`);
    if (offset >= 0) end = Math.min(end, offset);
  }
  return summary.slice(0, end).trim();
}

/** Checkpoints are immutable results referenced by the existing session journal. */
export class PhaseCheckpointStore {
  constructor(
    private readonly journal: SessionActorJournal,
    private readonly results: SessionResultStore,
    private readonly actorFor: (sessionId: string) => SessionActor,
    private readonly tokenBudget = PHASE_CHECKPOINT_TOKEN_BUDGET,
  ) {}

  async commit(
    sessionId: string,
    generation: number,
    parsed: CodexParsedRequest,
    draft: string,
    answer: string,
  ): Promise<void> {
    const identity = extractChatGptTurnIdentity(parsed);
    const owner = this.journal.snapshot(sessionId);
    if (
      !identity.threadId ||
      !identity.turnId ||
      owner?.generation !== generation ||
      owner.turnId !== identity.turnId
    ) {
      throw new Error("Phase checkpoint ownership mismatch");
    }
    if (!answer.trim()) throw new Error("Phase checkpoint requires a confirmed final answer");
    const summary = this.validate(parsed, draft);
    const confirmedRef = this.journal.completedBrowserResult(sessionId, generation, identity.turnId);
    if (!confirmedRef || hashChatGptLunaAnswer(this.results.get(confirmedRef).text) !== hashChatGptLunaAnswer(answer)) {
      throw new Error("Phase checkpoint has a conflicting or unconfirmed browser answer");
    }
    const checkpoint: PhaseCheckpoint = {
      version: 1,
      threadId: identity.threadId,
      sourceTurnId: identity.turnId,
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      modelFamily: parsed._chatgptModelFamily,
      answerHash: hashChatGptLunaAnswer(answer),
      sourceHash: sourceHash(parsed.context.messages),
      sourceCount: parsed.context.messages.length,
      summary,
      source: parsed,
    };
    const checkpointRef = this.results.put({
      sessionId,
      generation,
      turnId: identity.turnId,
      operationId: `phase-checkpoint:${identity.turnId}`,
      text: JSON.stringify(checkpoint),
    });
    const acknowledgement = await this.actorFor(sessionId).recordLocal(
      "phase_checkpoint_committed",
      identity.turnId,
      `phase-checkpoint:${identity.turnId}`,
      { checkpointRef },
      generation,
    );
    if (acknowledgement.status !== "accepted") throw new Error("Phase checkpoint requires reconciliation");
  }

  validate(parsed: CodexParsedRequest, draft: string): string {
    const identity = extractChatGptTurnIdentity(parsed);
    const inspection = inspectCompactionCheckpoint({ ...parsed, _compactionRequest: true }, draft, identity.threadId);
    if (!inspection.valid) throw new Error(`Invalid phase checkpoint: ${inspection.issues.join("; ")}`);
    const summary = lightweightSummary(inspection.summary);
    if (estimateTokens(summary, parsed.modelId) > this.tokenBudget) {
      throw new Error("Phase checkpoint essential state exceeds its token budget");
    }
    const requirements = extractStructuredCompactionHandoff(summary).state?.requirements ?? [];
    for (const message of parsed.context.messages) {
      if (message.role !== "user" || message.origin === "codex_skill" || message.origin === "compaction_summary")
        continue;
      const source = text(message).trim();
      if (!source || /^<environment_context>[\s\S]*<\/environment_context>$/.test(source)) continue;
      if (!requirements.some((requirement) => requirement.source.includes(source))) {
        throw new Error("Phase checkpoint omitted a literal user requirement");
      }
    }
    return summary;
  }

  read(
    sessionId: string,
    checkpointRef: string,
    ref: string,
    offset = 0,
    limit = 6_000,
  ): {
    text: string;
    totalChars: number;
    nextOffset: number | null;
    sha256: string;
  } {
    const owner = this.journal.snapshot(sessionId);
    const stored = this.results.get(checkpointRef);
    if (
      !owner ||
      stored.sessionId !== sessionId ||
      stored.generation !== owner.generation ||
      this.journal.findLocalTransition(
        sessionId,
        owner.generation,
        "phase_checkpoint_committed",
        stored.operationId,
        stored.turnId,
      )?.command.checkpointRef !== checkpointRef
    ) {
      throw new Error("Phase checkpoint evidence ownership mismatch");
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20_000) {
      throw new Error("Phase checkpoint evidence page is invalid");
    }
    const checkpoint = JSON.parse(stored.text) as PhaseCheckpoint;
    return this.readSource(checkpoint.source, checkpoint.threadId, ref, offset, limit);
  }

  readCurrent(
    sessionId: string,
    generation: number,
    parsed: CodexParsedRequest,
    ref: string,
    offset = 0,
    limit = 6_000,
  ) {
    const identity = extractChatGptTurnIdentity(parsed);
    const owner = this.journal.snapshot(sessionId);
    if (
      !identity.threadId ||
      !identity.turnId ||
      owner?.generation !== generation ||
      owner.turnId !== identity.turnId
    ) {
      throw new Error("Current phase evidence ownership mismatch");
    }
    return this.readSource(parsed, identity.threadId, ref, offset, limit);
  }

  private readSource(parsed: CodexParsedRequest, threadId: string, ref: string, offset: number, limit: number) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20_000) {
      throw new Error("Phase checkpoint evidence page is invalid");
    }
    const evidence = buildCompactionEvidenceIndex(parsed.context.messages, threadId);
    let value: string | undefined;
    if (ref === "original_request") value = compactionOriginalRequest(parsed);
    else if (ref === "manifest") {
      value = JSON.stringify({
        messages: parsed.context.messages.map((message, index) => ({
          index,
          role: message.role,
          ref: `message:${index}`,
        })),
        observations: evidence.map(({ excerpt: _excerpt, ...observation }) => observation),
      });
    } else {
      const match = /^message:(\d+)$/.exec(ref);
      const index = match ? Number(match[1]) : evidence.find((item) => item.ref === ref)?.messageIndex;
      const message = index === undefined ? undefined : parsed.context.messages[index];
      if (message) value = JSON.stringify(message);
    }
    if (value === undefined) throw new Error("Phase checkpoint evidence reference is unavailable");
    if (offset > value.length) throw new Error("Phase checkpoint evidence offset is out of range");
    return {
      text: value.slice(offset, offset + limit),
      totalChars: value.length,
      nextOffset: offset + limit < value.length ? offset + limit : null,
      sha256: createHash("sha256").update(value).digest("hex"),
    };
  }

  apply(
    sessionId: string,
    parsed: CodexParsedRequest,
  ): { parsed: CodexParsedRequest; applied: boolean; checkpointRef?: string } {
    const identity = extractChatGptTurnIdentity(parsed);
    const owner = this.journal.snapshot(sessionId);
    if (!owner || !identity.threadId || !identity.turnId) return { parsed, applied: false };
    const event = this.journal.latestPhaseCheckpoint(sessionId, owner.generation);
    if (!event?.checkpointRef) return { parsed, applied: false };
    const stored = this.results.get(event.checkpointRef);
    if (stored.sessionId !== sessionId || stored.generation !== owner.generation || stored.turnId !== event.turnId) {
      throw new Error("Phase checkpoint durable ownership mismatch");
    }
    const checkpoint = JSON.parse(stored.text) as PhaseCheckpoint;
    const parent = parentAssistantAnswer(parsed, identity.turnId);
    if (
      checkpoint.version !== 1 ||
      checkpoint.threadId !== identity.threadId ||
      checkpoint.modelId !== parsed.modelId ||
      checkpoint.reasoning !== parsed.options.reasoning ||
      checkpoint.modelFamily !== parsed._chatgptModelFamily ||
      parent?.turnId !== checkpoint.sourceTurnId ||
      hashChatGptLunaAnswer(parent.answer) !== checkpoint.answerHash
    ) {
      return { parsed, applied: false };
    }
    const messages = parsed.context.messages;
    const boundary = checkpoint.sourceCount;
    if (sourceHash(messages.slice(0, boundary)) !== checkpoint.sourceHash) return { parsed, applied: false };
    let parentIndex = boundary;
    while (parentIndex < messages.length) {
      const candidate = messages[parentIndex]!;
      if (candidate.role !== "assistant" || candidate.content.some((part) => part.type === "toolCall")) {
        return { parsed, applied: false };
      }
      if (hashChatGptLunaAnswer(text(candidate)) === checkpoint.answerHash) break;
      parentIndex += 1;
    }
    const parentMessage = messages[parentIndex];
    if (!parentMessage) return { parsed, applied: false };
    const authority = messages
      .slice(0, boundary)
      .filter(
        (message) => message.role === "developer" || (message.role === "user" && message.origin === "codex_skill"),
      );
    return {
      applied: true,
      checkpointRef: event.checkpointRef,
      parsed: {
        ...parsed,
        context: {
          ...parsed.context,
          messages: [
            ...authority,
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: `[Confirmed prior phase checkpoint; current instructions remain authoritative.]\ncheckpoint_ref ${event.checkpointRef}\nRetrieve omitted source only through codex.control.checkpoint_evidence using this checkpoint_ref and ref original_request, manifest, message:<index>, or a supplied evidence ref.\n${checkpoint.summary}`,
                },
              ],
              timestamp: parentMessage.timestamp,
            },
            ...messages.slice(boundary, parentIndex),
            ...messages.slice(parentIndex + 1),
          ],
        },
      },
    };
  }
}
