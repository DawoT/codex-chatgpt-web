import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  SessionActorJournal,
  SessionActorManager,
  SessionResultStore,
} from "../src/adapters/chatgpt-web/session-actor";
import { chatGptThreadOwnershipKey } from "../src/adapters/chatgpt-web/turn-execution";
import { SUMMARY_PREFIX } from "../src/responses/compaction";
import { parseRequest } from "../src/responses/parser";

// Native local revision changes may reuse only an accepted, same-owner remote binding.
test("a durable remote binding survives local compaction without authorizing a different summary or generation", async () => {
  const root = mkdtempSync("/tmp/cgw-revision-");
  const path = join(root, "private", "journal.sqlite");
  let journal = new SessionActorJournal(path);
  const results = new SessionResultStore(join(root, "private", "results"));
  let manager = new SessionActorManager(journal, results);
  const summary = `${SUMMARY_PREFIX}\nA confirmed checkpoint`;
  const parsed = parseRequest({
    model: "gpt-5.6-sol",
    input: [
      { type: "message", role: "user", content: summary },
      {
        type: "message",
        role: "user",
        content: "Continue",
        internal_chat_message_metadata_passthrough: { turn_id: "next" },
      },
    ],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "mission", turn_id: "next" }) },
  });
  const sessionId = `namespace:${chatGptThreadOwnershipKey(parsed)}`;
  const key = "a".repeat(64);
  try {
    for (const phase of [
      "compaction_prepared",
      "compaction_received",
      "compaction_validated",
      "compaction_persisted",
    ] as const) {
      await manager.compactionTransition(
        sessionId,
        "compact",
        "revision",
        phase,
        phase === "compaction_received" ? summary : undefined,
      );
    }
    await manager.bindRetainedConversation(sessionId, "compact", "revision", summary, key, 12_000, parsed);
    expect(manager.retainedConversationBinding(sessionId, parsed)).toBeUndefined();
    await manager.compactionTransition(sessionId, "compact", "revision", "compaction_accepted");
    journal.close();
    journal = new SessionActorJournal(path);
    manager = new SessionActorManager(journal, results);
    expect(manager.retainedConversationBinding(sessionId, parsed)).toMatchObject({
      conversationKey: key,
      remoteContextTokens: 12_000,
    });
    const changed = structuredClone(parsed);
    changed.context.messages[0]!.content = `${SUMMARY_PREFIX}\nUnconfirmed checkpoint`;
    expect(manager.retainedConversationBinding(sessionId, changed)).toBeUndefined();
    changed.context.messages[0]!.content = summary;
    changed.modelId = "gpt-5.6-pro";
    expect(manager.retainedConversationBinding(sessionId, changed)).toBeUndefined();
    await manager.beginTurn(sessionId, "next");
    await manager.actor(sessionId).recordLocal("generation_revoked", "next", "cancel");
    expect(manager.retainedConversationBinding(sessionId, parsed)).toBeUndefined();
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});
