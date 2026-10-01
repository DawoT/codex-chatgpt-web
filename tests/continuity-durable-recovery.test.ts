import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SESSION_ACTOR_PROTOCOL_VERSION,
  SessionActorJournal,
  SessionActorManager,
  SessionResultStore,
} from "../src/adapters/chatgpt-web/session-actor";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "continuity-recovery-"));
  const path = join(root, "private", "journal.sqlite");
  let journal = new SessionActorJournal(path);
  const results = new SessionResultStore(join(root, "private", "results"));
  return {
    root,
    get journal() {
      return journal;
    },
    results,
    manager() {
      return new SessionActorManager(journal, results);
    },
    restart() {
      journal.close();
      journal = new SessionActorJournal(path);
      return new SessionActorManager(journal, results);
    },
    close() {
      journal.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const recovery of ["startup", "session"] as const) {
  test(`${recovery} recovery preserves accepted send without final result after crash`, async () => {
    const home = fixture();
    try {
      const manager = home.manager();
      await manager.beginTurn("accepted", "turn-1");
      await manager.actor("accepted").recordLocal("operation_intent", "turn-1", "send", {
        operationKind: "browser_send",
        historyRevision: 0,
      });
      // Acceptance is a historical witness regardless of which producer wrote it.
      await manager.actor("accepted").dispatch({
        protocolVersion: SESSION_ACTOR_PROTOCOL_VERSION,
        sessionId: "accepted",
        generation: 1,
        turnId: "turn-1",
        operationId: "send",
        producerId: "acceptance-observer",
        producerSequence: 1,
        type: "operation_accepted",
      });
      const restarted = home.restart();
      if (recovery === "startup") restarted.recoverUncertainOperations();
      else restarted.recoverUncertainOperationsForSession("accepted");
      expect(home.journal.operation("accepted", 1, "send")?.state).toBe("uncertain");
      expect(home.journal.wasOperationAccepted("accepted", 1, "send")).toBe(true);
      let effects = 0;
      await expect(
        restarted.runBrowserTurn("accepted", "turn-1", "send", async () => {
          effects += 1;
          return "duplicate";
        }),
      ).rejects.toThrow("reconciliation");
      await expect(
        restarted.runBrowserTurn("accepted", "turn-2", "other", async () => {
          effects += 1;
          return "duplicate";
        }),
      ).rejects.toThrow("reconciliation");
      expect(effects).toBe(0);
      expect(home.journal.operation("accepted", 1, "send")?.state).toBe("uncertain");
    } finally {
      home.close();
    }
  });
}

test("legacy intent without positive non-send evidence remains uncertain", async () => {
  const home = fixture();
  try {
    const manager = home.manager();
    await manager.beginTurn("legacy", "turn-1");
    await manager.actor("legacy").dispatch({
      protocolVersion: SESSION_ACTOR_PROTOCOL_VERSION,
      sessionId: "legacy",
      generation: 1,
      turnId: "turn-1",
      operationId: "send",
      producerId: "legacy",
      producerSequence: 1,
      type: "operation_intent",
      operationKind: "browser_send",
      historyRevision: 0,
    });
    const restarted = home.restart();
    restarted.recoverUncertainOperations();
    expect(home.journal.operation("legacy", 1, "send")?.state).toBe("uncertain");
    let effects = 0;
    await expect(
      restarted.runBrowserTurn("legacy", "turn-1", "send", async () => {
        effects += 1;
        return "duplicate";
      }),
    ).rejects.toThrow("reconciliation");
    expect(effects).toBe(0);
  } finally {
    home.close();
  }
});

test("pre-Send activation is persisted before effect and survives ambiguous failure", async () => {
  const home = fixture();
  try {
    const manager = home.manager();
    await expect(
      manager.runBrowserTurn(
        "ambiguous",
        "turn-1",
        "send",
        async (_accepted, _batch, _leased, _released, _ready, onSendActivated) => {
          expect(typeof onSendActivated).toBe("function");
          await onSendActivated();
          expect(home.journal.findLocalTransition("ambiguous", 1, "operation_send_activated", "send")).not.toBeNull();
          throw new Error("acceptance observation lost");
        },
      ),
    ).rejects.toThrow("acceptance observation lost");
    const restarted = home.restart();
    restarted.recoverUncertainOperations();
    restarted.recoverUncertainOperationsForSession("ambiguous");
    expect(home.journal.operation("ambiguous", 1, "send")?.state).toBe("uncertain");
    let sends = 0;
    await expect(
      restarted.runBrowserTurn("ambiguous", "turn-1", "send", async () => {
        sends += 1;
        return "duplicate";
      }),
    ).rejects.toThrow("reconciliation");
    expect(sends).toBe(0);
  } finally {
    home.close();
  }
});

test("prepared operation failing before activation has positive no-send evidence and may retry", async () => {
  const home = fixture();
  try {
    const manager = home.manager();
    await expect(
      manager.runBrowserTurn("prepared", "turn-1", "send", async () => {
        expect(home.journal.findLocalTransition("prepared", 1, "operation_prepared", "send")).not.toBeNull();
        throw new Error("navigation failed before Send");
      }),
    ).rejects.toThrow("navigation failed before Send");
    const restarted = home.restart();
    restarted.recoverUncertainOperations();
    expect(home.journal.operation("prepared", 1, "send")?.state).toBe("abandoned");
    let sends = 0;
    expect(
      await restarted.runBrowserTurn("prepared", "turn-1", "send", async (accepted) => {
        sends += 1;
        await accepted();
        return "safe retry";
      }),
    ).toBe("safe retry");
    expect(sends).toBe(1);
  } finally {
    home.close();
  }
});

test("accepted durable result replays after restart without browser or surface effects", async () => {
  const home = fixture();
  try {
    const manager = home.manager();
    await expect(
      manager.runBrowserTurn("result", "turn-1", "send", async (accepted, _batch, _leased, _released, ready) => {
        await accepted();
        await ready("exact recovered answer");
        throw new Error("crash before completed journal event");
      }),
    ).rejects.toThrow("crash before completed");
    const restarted = home.restart();
    restarted.recoverUncertainOperations();
    let effects = 0;
    expect(
      await restarted.runBrowserTurn("result", "turn-1", "send", async () => {
        effects += 1;
        return "wrong answer";
      }),
    ).toBe("exact recovered answer");
    expect(effects).toBe(0);
    expect(home.journal.operation("result", 1, "send")?.state).toBe("completed");
  } finally {
    home.close();
  }
});

test("fresh process rehydrates only accepted checkpoint with exact source scope, hash and owner", async () => {
  const home = fixture();
  try {
    const continuation = await import("../src/adapters/chatgpt-web/compaction-continuation");
    const { parseRequest } = await import("../src/responses/parser");
    const { chatGptNativeThreadOwnershipKey } = await import("../src/adapters/chatgpt-web/turn-execution/keys");
    const compact = {
      ...parseRequest({
        model: "gpt-5.6-sol",
        reasoning: { effort: "high" },
        input: [
          {
            type: "message",
            role: "user",
            id: "original-instruction",
            content: [{ type: "input_text", text: "Preserve the source task and do not deploy." }],
            internal_chat_message_metadata_passthrough: { turn_id: "source-turn" },
          },
        ],
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({ thread_id: "recovery-thread", turn_id: "compact-turn" }),
        },
      }),
      _compactionRequest: true,
    };
    const manager = home.manager();
    const sessionId = `recovery:${chatGptNativeThreadOwnershipKey("recovery-thread")}`;
    // Source scope is recorded separately from the accepted checkpoint, in the same journal.
    await continuation.recordCompactionContinuationSource(manager, sessionId, compact);
    const { createHash } = await import("node:crypto");
    const { chatGptTurnExecutionKey } = await import("../src/adapters/chatgpt-web/turn-execution/keys");
    const traceId = createHash("sha256")
      .update(`recovery:${chatGptTurnExecutionKey(compact)}`)
      .digest("hex")
      .slice(0, 12);
    const operationId = `checkpoint:${traceId}`;
    const summary = "Accepted durable handoff for the exact source task.";
    for (const phase of [
      "compaction_prepared",
      "compaction_received",
      "compaction_validated",
      "compaction_persisted",
      "compaction_accepted",
    ] as const) {
      await manager.compactionTransition(
        sessionId,
        "compact-turn",
        operationId,
        phase,
        phase === "compaction_received" ? summary : undefined,
      );
    }
    // A separate process has neither the route's in-memory registry nor this manager's mailboxes.
    home.journal.close();
    const script = `
      import { SessionActorJournal, SessionActorManager, SessionResultStore } from "./src/adapters/chatgpt-web/session-actor";
      import * as continuation from "./src/adapters/chatgpt-web/compaction-continuation";
      import { parseRequest } from "./src/responses/parser";
      import { encodeCompactionSummary } from "./src/responses/compaction";
      const [root, sessionId, summary] = JSON.parse(process.argv[1]);
      const journal = new SessionActorJournal(root + "/private/journal.sqlite");
      const manager = new SessionActorManager(journal, new SessionResultStore(root + "/private/results"));
      const request = (thread = "recovery-thread", turn = "compact-turn", effort = "high", text = summary, owner = turn) => parseRequest({
        model: "gpt-5.6-sol",
        reasoning: { effort },
        input: [{ type: "compaction", encrypted_content: encodeCompactionSummary(text), internal_chat_message_metadata_passthrough: { turn_id: owner } }],
        client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, turn_id: turn }) },
      });
      const identity = { threadId: "recovery-thread", turnId: "compact-turn" };
      const parsed = request();
      continuation.rehydrateCompactionContinuation(manager, sessionId, parsed, identity);
      const recovered = continuation.recoverCompactionInstruction(parsed, identity);
      const rejected = [
        { ...parsed, modelId: "gpt-5.6-other" },
        request("other-thread"), request("recovery-thread", "other-turn"),
        request("recovery-thread", "compact-turn", "medium"),
        request("recovery-thread", "compact-turn", "high", "forged summary"),
        request("recovery-thread", "compact-turn", "high", summary, "wrong-owner"),
      ].map((candidate) => continuation.recoverCompactionInstruction(candidate, {
        threadId: JSON.parse(candidate._rawBody.client_metadata["x-codex-turn-metadata"]).thread_id,
        turnId: JSON.parse(candidate._rawBody.client_metadata["x-codex-turn-metadata"]).turn_id,
      }) ?? null);
      await manager.revokeAdmittedTurn(sessionId, "compact-turn", "revoke-test");
      const revoked = continuation.recoverCompactionInstruction(parsed, identity);
      continuation.rememberCompactionContinuation({ ...parsed, _compactionRequest: true }, identity, [{ content: "stale route cache" }], summary);
      continuation.rehydrateCompactionContinuation(manager, sessionId, parsed, identity);
      const staleRoute = continuation.recoverCompactionInstruction(parsed, identity);
      console.log(JSON.stringify({ recovered: recovered ?? null, rejected, revoked: revoked ?? null, staleRoute: staleRoute ?? null }));
      journal.close();
    `;
    const child = Bun.spawnSync([process.execPath, "--eval", script, JSON.stringify([home.root, sessionId, summary])], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
    const observed = JSON.parse(child.stdout.toString().trim());
    expect(observed.recovered).toEqual({
      source: {
        content: [{ type: "input_text", text: "Preserve the source task and do not deploy." }],
        turnId: "source-turn",
        itemId: "original-instruction",
      },
      summaryIndex: 0,
    });
    expect(observed.rejected).toEqual([null, null, null, null, null, null]);
    expect(observed.revoked).toBeNull();
    expect(observed.staleRoute).toBeNull();
  } finally {
    home.close();
  }
});

test("durable replay performs no surface release even with an older revoked reservation", async () => {
  const home = fixture();
  try {
    const manager = home.manager();
    await expect(
      manager.runBrowserTurn("replay", "old-turn", "old-send", async (_accepted, _batch, leased) => {
        await leased("old-surface");
        throw new Error("before activation");
      }),
    ).rejects.toThrow("before activation");
    await manager.revokeAdmittedTurn("replay", "old-turn", "old-revocation");
    manager.recoverUncertainOperations();
    await manager.beginTurn("replay", "current-turn");
    await manager.actor("replay").recordLocal("operation_intent", "current-turn", "current-send", {
      operationKind: "browser_send",
      historyRevision: 0,
    });
    await manager.actor("replay").recordLocal("operation_accepted", "current-turn", "current-send");
    home.results.put({
      sessionId: "replay",
      generation: 2,
      turnId: "current-turn",
      operationId: "current-send",
      text: "durable replay",
    });
    home.restart();
    let effects = 0;
    const restarted = new SessionActorManager(
      home.journal,
      home.results,
      () => true,
      () => {
        effects += 1;
        return true;
      },
    );
    // Surface queries and writes must be skipped as well as external browser effects.
    const sequence = home.journal.snapshot("replay")!.sequence;
    expect(
      await restarted.runBrowserTurn("replay", "current-turn", "current-send", async () => {
        effects += 1;
        return "duplicate";
      }),
    ).toBe("durable replay");
    expect(effects).toBe(0);
    expect(home.journal.surfaceOwner("old-surface")).toEqual({ sessionId: "replay", generation: 1 });
    expect(home.journal.snapshot("replay")!.sequence).toBe(sequence + 1);
  } finally {
    home.close();
  }
});

for (const state of [
  "prepared",
  "received",
  "validated",
  "persisted",
  "rejected",
  "accepted-without-source",
] as const) {
  test(`checkpoint query does not authorize ${state} continuation`, async () => {
    const home = fixture();
    try {
      const { chatGptNativeThreadOwnershipKey } = await import("../src/adapters/chatgpt-web/turn-execution/keys");
      const manager = home.manager();
      const sessionId = `query:${chatGptNativeThreadOwnershipKey("query-thread")}`;
      if (state !== "accepted-without-source") {
        await manager.recordCompactionContinuationSource(sessionId, "turn", "checkpoint", {
          threadId: "query-thread",
          modelId: "gpt-5.6-sol",
          reasoning: "high",
          sources: [{ content: "original task", turnId: "source-turn", itemId: "source-item" }],
        });
      }
      await manager.compactionTransition(sessionId, "turn", "checkpoint", "compaction_prepared");
      if (state !== "prepared") {
        await manager.compactionTransition(sessionId, "turn", "checkpoint", "compaction_received", "unproven summary");
      }
      if (["validated", "persisted", "accepted-without-source"].includes(state)) {
        await manager.compactionTransition(sessionId, "turn", "checkpoint", "compaction_validated");
      }
      if (["persisted", "accepted-without-source"].includes(state)) {
        await manager.compactionTransition(sessionId, "turn", "checkpoint", "compaction_persisted");
      }
      if (state === "rejected") {
        await manager.compactionTransition(sessionId, "turn", "checkpoint", "compaction_rejected");
      }
      if (state === "accepted-without-source") {
        await manager.compactionTransition(sessionId, "turn", "checkpoint", "compaction_accepted");
      }
      const restarted = home.restart();
      expect(restarted.acceptedCompactionContinuations(sessionId, "turn")).toEqual([]);
      expect(restarted.acceptedCompactionContinuations(sessionId, "wrong-turn")).toEqual([]);
      expect(restarted.acceptedCompactionContinuations("wrong-session", "turn")).toEqual([]);
    } finally {
      home.close();
    }
  });
}

test("queued generation revocation prevents an old result from returning during replay", async () => {
  const home = fixture();
  try {
    const manager = home.manager();
    await expect(
      manager.runBrowserTurn("race", "turn", "send", async (accepted, _batch, _leased, _released, ready) => {
        await accepted();
        await ready("old answer");
        throw new Error("interrupted completion");
      }),
    ).rejects.toThrow("interrupted completion");
    const revoked = manager.actor("race").recordLocal("generation_revoked", "turn", "queued-revocation");
    let effects = 0;
    const replay = manager.runBrowserTurn("race", "turn", "send", async () => {
      effects += 1;
      return "duplicate";
    });
    await revoked;
    await expect(replay).rejects.toThrow("ownership changed");
    expect(effects).toBe(0);
    expect(home.journal.snapshot("race")?.generation).toBe(2);
  } finally {
    home.close();
  }
});

test("restart selects the exact accepted summary for repeated summary-only compact requests", async () => {
  const home = fixture();
  try {
    const { parseRequest } = await import("../src/responses/parser");
    const { encodeCompactionSummary } = await import("../src/responses/compaction");
    const { extractChatGptTurnIdentity } = await import("../src/adapters/chatgpt-web/environment");
    const { chatGptNativeThreadOwnershipKey, chatGptTurnExecutionKey } = await import(
      "../src/adapters/chatgpt-web/turn-execution/keys"
    );
    const { createHash } = await import("node:crypto");
    const continuation = await import("../src/adapters/chatgpt-web/compaction-continuation");
    const compact = (input: unknown[]) => ({
      ...parseRequest({
        model: "gpt-5.6-sol",
        reasoning: { effort: "high" },
        input,
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({ thread_id: "repeat-thread", turn_id: "repeat-turn" }),
        },
      }),
      _compactionRequest: true,
    });
    const first = compact([
      {
        type: "message",
        role: "user",
        id: "source-instruction",
        content: [{ type: "input_text", text: "Continue the exact original task." }],
        internal_chat_message_metadata_passthrough: { turn_id: "source-turn" },
      },
    ]);
    const sessionId = `repeat:${chatGptNativeThreadOwnershipKey("repeat-thread")}`;
    const manager = home.manager();
    const accept = async (parsed: typeof first, summary: string) => {
      await continuation.recordCompactionContinuationSource(manager, sessionId, parsed);
      const trace = createHash("sha256")
        .update(`repeat:${chatGptTurnExecutionKey(parsed)}`)
        .digest("hex")
        .slice(0, 12);
      for (const phase of [
        "compaction_prepared",
        "compaction_received",
        "compaction_validated",
        "compaction_persisted",
        "compaction_accepted",
      ] as const) {
        await manager.compactionTransition(
          sessionId,
          "repeat-turn",
          `checkpoint:${trace}`,
          phase,
          phase === "compaction_received" ? summary : undefined,
        );
      }
    };
    await accept(first, "summary-one");
    const second = compact([{ type: "compaction", encrypted_content: encodeCompactionSummary("summary-one") }]);
    const identity = extractChatGptTurnIdentity(second);
    continuation.rehydrateCompactionContinuation(manager, sessionId, second, identity);
    await accept(second, "summary-two");
    const restarted = home.restart();
    continuation.rehydrateCompactionContinuation(restarted, sessionId, second, identity);
    expect(continuation.recoverCompactionInstruction(second, identity)?.source).toEqual({
      content: [{ type: "input_text", text: "Continue the exact original task." }],
      turnId: "source-turn",
      itemId: "source-instruction",
    });
    // The second checkpoint's operation identity must still be reproducible from S1.
    await continuation.recordCompactionContinuationSource(restarted, sessionId, second);
    expect(restarted.acceptedCompactionContinuations(sessionId, "repeat-turn")).toHaveLength(2);
  } finally {
    home.close();
  }
});
