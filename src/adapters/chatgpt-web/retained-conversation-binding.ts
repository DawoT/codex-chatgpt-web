import { createHash } from "node:crypto";
import { SUMMARY_PREFIX } from "../../responses/compaction";
import type { CodexParsedRequest } from "../../types";
import type { SessionActor } from "./session-actor/actor";
import type { SessionActorJournal } from "./session-actor/journal";

export class RetainedConversationBindings {
  constructor(
    private readonly journal: SessionActorJournal,
    private readonly actorFor: (sessionId: string) => SessionActor,
  ) {}

  async bind(
    sessionId: string,
    turnId: string,
    operationId: string,
    summary: string,
    conversationKey: string,
    remoteContextTokens: number,
    parsed: CodexParsedRequest,
  ): Promise<void> {
    const owner = this.journal.snapshot(sessionId);
    if (!owner || owner.turnId !== turnId) throw new Error("Retained conversation binding ownership mismatch");
    const acknowledgement = await this.actorFor(sessionId).recordLocal(
      "conversation_binding_recorded",
      turnId,
      operationId,
      {
        retainedConversationKey: conversationKey,
        compactedSummaryHash: this.hash(summary),
        remoteContextTokens,
        modelId: parsed.modelId,
        reasoning: parsed.options.reasoning,
        modelFamily: parsed._chatgptModelFamily,
      },
      owner.generation,
    );
    if (acknowledgement.status !== "accepted") throw new Error("Retained conversation binding requires reconciliation");
  }

  resolve(
    sessionId: string,
    parsed: CodexParsedRequest,
  ):
    | {
        conversationKey: string;
        remoteContextTokens: number;
      }
    | undefined {
    const owner = this.journal.snapshot(sessionId);
    if (!owner) return undefined;
    const binding = this.journal.latestConversationBinding(sessionId, owner.generation);
    if (
      !binding ||
      binding.modelId !== parsed.modelId ||
      binding.reasoning !== parsed.options.reasoning ||
      binding.modelFamily !== parsed._chatgptModelFamily
    )
      return undefined;
    const checkpoint = this.journal.compaction(sessionId, owner.generation, binding.operationId);
    if (checkpoint?.state !== "accepted" || checkpoint.turnId !== binding.turnId) return undefined;
    const summary = parsed.context.messages.findLast((message) => {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("");
      return (
        message.role === "user" && (message.origin === "compaction_summary" || text.startsWith(`${SUMMARY_PREFIX}\n`))
      );
    });
    if (!summary) return undefined;
    const text =
      typeof summary.content === "string"
        ? summary.content
        : summary.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
    if (this.hash(text) !== binding.compactedSummaryHash) return undefined;
    return { conversationKey: binding.retainedConversationKey!, remoteContextTokens: binding.remoteContextTokens! };
  }

  private hash(text: string): string {
    return createHash("sha256")
      .update(text.startsWith(`${SUMMARY_PREFIX}\n`) ? text.slice(SUMMARY_PREFIX.length).trimStart() : text)
      .digest("hex");
  }
}
