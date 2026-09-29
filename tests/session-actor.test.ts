import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  SessionActor,
  SessionActorJournal,
  SessionActorManager,
  SessionResultStore,
} from "../src/adapters/chatgpt-web/session-actor";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-session-actor-"));
  const path = join(root, "private", "events.sqlite");
  const journal = new SessionActorJournal(path);
  return {
    journal,
    path,
    close() {
      journal.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function command(
  sessionId: string,
  producerSequence: number,
  type: "turn_started" | "operation_intent" | "operation_accepted" | "operation_completed" | "tool_batch_observed" | "surface_claimed" | "surface_released" | "generation_revoked" | "compaction_prepared" | "compaction_received" | "compaction_validated" | "compaction_persisted" | "compaction_accepted" | "compaction_rejected",
  extra: Record<string, unknown> = {},
) {
  return {
    protocolVersion: 3,
    sessionId,
    generation: 1,
    turnId: "turn-1",
    operationId: `operation-${producerSequence}`,
    producerId: "test",
    producerSequence,
    type,
    ...extra,
  } as const;
}

test("actor persists ordered events, replays duplicate acknowledgement, and requests gap recovery", async () => {
  const home = fixture();
  try {
    const actor = new SessionActor(home.journal, "namespace/thread-A");
    const first = await actor.dispatch(command("namespace/thread-A", 1, "turn_started"));
    expect(first).toEqual({ status: "accepted", sequence: 1 });
    expect(await actor.dispatch(command("namespace/thread-A", 1, "turn_started"))).toEqual(first);
    expect(await actor.dispatch(command("namespace/thread-A", 3, "operation_intent"))).toEqual({
      status: "recovery_required",
      expectedProducerSequence: 2,
    });
    expect(await actor.dispatch(command("namespace/thread-A", 2, "operation_intent", {
      operationId: "send-1",
      operationKind: "browser_send",
      historyRevision: 0,
    }))).toEqual({ status: "accepted", sequence: 2 });
    expect(home.journal.operation("namespace/thread-A", 1, "send-1")?.state).toBe("intent");
    expect(statSync(home.path).mode & 0o077).toBe(0);
    expect(statSync(dirname(home.path)).mode & 0o077).toBe(0);
  } finally {
    home.close();
  }
});

test("generation revocation rejects late results and does not affect another session", async () => {
  const home = fixture();
  try {
    const a = new SessionActor(home.journal, "namespace/thread-A");
    const b = new SessionActor(home.journal, "namespace/thread-B");
    await a.dispatch(command("namespace/thread-A", 1, "turn_started"));
    await b.dispatch(command("namespace/thread-B", 1, "turn_started"));
    await a.dispatch(command("namespace/thread-A", 2, "operation_intent", {
      operationId: "send-A",
      operationKind: "browser_send",
      historyRevision: 0,
    }));
    await a.dispatch(command("namespace/thread-A", 3, "generation_revoked"));
    expect(await a.dispatch(command("namespace/thread-A", 4, "operation_completed", {
      operationId: "send-A",
      resultRef: "result-A",
    }))).toEqual({ status: "stale_generation", currentGeneration: 2 });
    expect(home.journal.operation("namespace/thread-A", 1, "send-A")?.state).toBe("uncertain");
    expect(await b.dispatch(command("namespace/thread-B", 2, "operation_intent", {
      operationId: "send-B",
      operationKind: "browser_send",
      historyRevision: 0,
    }))).toEqual({ status: "accepted", sequence: 2 });
  } finally {
    home.close();
  }
});

test("restart marks unconfirmed effects uncertain without replaying them", async () => {
  const home = fixture();
  try {
    const actor = new SessionActor(home.journal, "namespace/thread-A");
    await actor.dispatch(command("namespace/thread-A", 1, "turn_started"));
    await actor.dispatch(command("namespace/thread-A", 2, "operation_intent", {
      operationId: "send-A",
      operationKind: "browser_send",
      historyRevision: 0,
    }));
    home.journal.close();
    const restarted = new SessionActorJournal(home.path);
    try {
      expect(restarted.operation("namespace/thread-A", 1, "send-A")?.state).toBe("uncertain");
      const duplicate = await new SessionActor(restarted, "namespace/thread-A").dispatch(
        command("namespace/thread-A", 2, "operation_intent", {
          operationId: "send-A",
          operationKind: "browser_send",
          historyRevision: 0,
        }),
      );
      expect(duplicate).toEqual({ status: "accepted", sequence: 2 });
      expect(restarted.operation("namespace/thread-A", 1, "send-A")?.state).toBe("uncertain");
    } finally {
      restarted.close();
    }
  } finally {
    home.close();
  }
});

test("a browser surface has one session and generation owner", async () => {
  const home = fixture();
  try {
    const a = new SessionActor(home.journal, "namespace/thread-A");
    const b = new SessionActor(home.journal, "namespace/thread-B");
    await a.dispatch(command("namespace/thread-A", 1, "turn_started"));
    await b.dispatch(command("namespace/thread-B", 1, "turn_started"));
    await a.dispatch(command("namespace/thread-A", 2, "surface_claimed", { surfaceId: "surface-1" }));
    await expect(b.dispatch(command("namespace/thread-B", 2, "surface_claimed", {
      surfaceId: "surface-1",
    }))).rejects.toThrow("already owned");
    await a.dispatch(command("namespace/thread-A", 3, "surface_released", { surfaceId: "surface-1" }));
    expect(await b.dispatch(command("namespace/thread-B", 2, "surface_claimed", {
      surfaceId: "surface-1",
    }))).toEqual({ status: "accepted", sequence: 2 });
  } finally {
    home.close();
  }
});

test("checkpoint rejection preserves history and a valid persisted checkpoint advances it once", async () => {
  const home = fixture();
  try {
    const actor = new SessionActor(home.journal, "namespace/thread-A");
    await actor.dispatch(command("namespace/thread-A", 1, "turn_started"));
    await actor.dispatch(command("namespace/thread-A", 2, "compaction_prepared", { operationId: "compact-1" }));
    await actor.dispatch(command("namespace/thread-A", 3, "compaction_received", {
      operationId: "compact-1",
      checkpointRef: "summary-1",
    }));
    await actor.dispatch(command("namespace/thread-A", 4, "compaction_rejected", { operationId: "compact-1" }));
    expect(home.journal.snapshot("namespace/thread-A")?.historyRevision).toBe(0);
    await expect(actor.dispatch(command("namespace/thread-A", 5, "compaction_accepted", {
      operationId: "compact-1",
    }))).rejects.toThrow("out of order");

    await actor.dispatch(command("namespace/thread-A", 5, "compaction_prepared", { operationId: "compact-2" }));
    await actor.dispatch(command("namespace/thread-A", 6, "compaction_received", {
      operationId: "compact-2",
      checkpointRef: "summary-2",
    }));
    await actor.dispatch(command("namespace/thread-A", 7, "compaction_validated", {
      operationId: "compact-2",
    }));
    await actor.dispatch(command("namespace/thread-A", 8, "compaction_persisted", {
      operationId: "compact-2",
    }));
    expect(home.journal.snapshot("namespace/thread-A")?.historyRevision).toBe(0);
    await actor.dispatch(command("namespace/thread-A", 9, "compaction_accepted", {
      operationId: "compact-2",
    }));
    expect(home.journal.snapshot("namespace/thread-A")?.historyRevision).toBe(1);
    expect(home.journal.snapshot("namespace/thread-A")?.compactionEpoch).toBe(1);
  } finally {
    home.close();
  }
});

test("a session cannot silently claim a second browser surface", async () => {
  const home = fixture();
  try {
    const actor = new SessionActor(home.journal, "namespace/thread-A");
    await actor.dispatch(command("namespace/thread-A", 1, "turn_started"));
    await actor.dispatch(command("namespace/thread-A", 2, "surface_claimed", { surfaceId: "surface-1" }));
    await expect(actor.dispatch(command("namespace/thread-A", 3, "surface_claimed", {
      surfaceId: "surface-2",
    }))).rejects.toThrow("already owns");
  } finally {
    home.close();
  }
});

test("actor starts one external effect outside its mailbox and rejects its late result after revocation", async () => {
  const home = fixture();
  try {
    const a = new SessionActor(home.journal, "namespace/thread-A");
    const b = new SessionActor(home.journal, "namespace/thread-B");
    await a.dispatch(command("namespace/thread-A", 1, "turn_started"));
    await b.dispatch(command("namespace/thread-B", 1, "turn_started"));
    let releaseEffect: () => void = () => {};
    const effectGate = new Promise<void>(resolve => { releaseEffect = resolve; });
    let starts = 0;
    const intent = command("namespace/thread-A", 2, "operation_intent", {
      operationId: "send-A",
      operationKind: "browser_send",
      historyRevision: 0,
    });
    const first = await a.launch(intent, async emit => {
      starts += 1;
      await effectGate;
      await emit("operation_accepted");
      await emit("operation_completed", "result-A");
    });
    const duplicate = await a.launch(intent, async () => { starts += 1; });
    expect(first.acknowledgement).toEqual(duplicate.acknowledgement);
    expect(starts).toBe(1);
    expect(await b.dispatch(command("namespace/thread-B", 2, "operation_intent", {
      operationId: "send-B",
      operationKind: "browser_send",
      historyRevision: 0,
    }))).toEqual({ status: "accepted", sequence: 2 });
    await a.dispatch(command("namespace/thread-A", 3, "generation_revoked"));
    releaseEffect();
    await expect(first.settled).rejects.toThrow("stale generation");
    expect(home.journal.operation("namespace/thread-A", 1, "send-A")?.state).toBe("uncertain");
  } finally {
    home.close();
  }
});

test("an uncertain browser effect blocks another send until evidence reconciles it", async () => {
  const home = fixture();
  try {
    const actor = new SessionActor(home.journal, "namespace/thread-A");
    await actor.dispatch(command("namespace/thread-A", 1, "turn_started"));
    await actor.dispatch(command("namespace/thread-A", 2, "operation_intent", {
      operationId: "send-A",
      operationKind: "browser_send",
      historyRevision: 0,
    }));
    home.journal.close();
    const restarted = new SessionActorJournal(home.path);
    try {
      const resumed = new SessionActor(restarted, "namespace/thread-A");
      await expect(resumed.dispatch(command("namespace/thread-A", 3, "operation_intent", {
        operationId: "send-B",
        operationKind: "browser_send",
        historyRevision: 0,
      }))).rejects.toThrow("requires reconciliation");
      await resumed.reconcile("send-A", 1, "not_sent", "evidence-A");
      expect(restarted.operation("namespace/thread-A", 1, "send-A")?.state).toBe("abandoned");
      expect(await resumed.dispatch(command("namespace/thread-A", 3, "operation_intent", {
        operationId: "send-B",
        operationKind: "browser_send",
        historyRevision: 0,
      }))).toEqual({ status: "accepted", sequence: 5 });
    } finally {
      restarted.close();
    }
  } finally {
    home.close();
  }
});

test("a completed effect returns its original acknowledgement without rerunning", async () => {
  const home = fixture();
  try {
    const actor = new SessionActor(home.journal, "namespace/thread-A");
    await actor.dispatch(command("namespace/thread-A", 1, "turn_started"));
    const intent = command("namespace/thread-A", 2, "operation_intent", {
      operationId: "send-A",
      operationKind: "browser_send",
      historyRevision: 0,
    });
    let executions = 0;
    const first = await actor.launch(intent, async emit => {
      executions += 1;
      await emit("operation_accepted");
      await emit("operation_completed", "result-A");
    });
    await first.settled;
    const replay = await actor.launch(intent, async () => { executions += 1; });
    await replay.settled;
    expect(replay.acknowledgement).toEqual(first.acknowledgement);
    expect(executions).toBe(1);
  } finally {
    home.close();
  }
});

test("one daemon owns the WAL journal writer until it closes", () => {
  const home = fixture();
  try {
    expect(() => new SessionActorJournal(home.path)).toThrow("already owned");
    home.journal.close();
    const replacement = new SessionActorJournal(home.path);
    replacement.close();
  } finally {
    home.close();
  }
});

test("an abruptly killed writer releases its database lock and leaves the effect uncertain", async () => {
  if (process.platform !== "linux") return;
  const home = fixture();
  home.journal.close();
  const modulePath = join(import.meta.dir, "../src/adapters/chatgpt-web/session-actor/index.ts");
  const script = `
    import { SessionActorJournal } from ${JSON.stringify(modulePath)};
    const journal = new SessionActorJournal(${JSON.stringify(home.path)});
    journal.apply({
      protocolVersion: 3,
      sessionId: "namespace/thread-A",
      generation: 1,
      turnId: "turn-1",
      operationId: "start",
      producerId: "child",
      producerSequence: 1,
      type: "turn_started",
    });
    journal.apply({
      protocolVersion: 3,
      sessionId: "namespace/thread-A",
      generation: 1,
      turnId: "turn-1",
      operationId: "send-A",
      producerId: "child",
      producerSequence: 2,
      type: "operation_intent",
      operationKind: "browser_send",
      historyRevision: 0,
    });
    process.stdout.write("ready\\n");
    setInterval(() => {}, 60_000);
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const reader = child.stdout.getReader();
    const readiness = await reader.read();
    expect(new TextDecoder().decode(readiness.value)).toContain("ready");
    child.kill("SIGKILL");
    await child.exited;
    const recovered = new SessionActorJournal(home.path);
    try {
      expect(recovered.operation("namespace/thread-A", 1, "send-A")?.state).toBe("uncertain");
    } finally {
      recovered.close();
    }
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    home.close();
  }
});

test("session manager records one native turn transition across concurrent request retries", async () => {
  const home = fixture();
  try {
    const manager = new SessionActorManager(home.journal);
    const [first, duplicate] = await Promise.all([
      manager.beginTurn("namespace/thread-A", "native-turn-1"),
      manager.beginTurn("namespace/thread-A", "native-turn-1"),
    ]);
    expect(first).toEqual({ status: "accepted", sequence: 1 });
    expect(duplicate).toEqual(first);
    expect(home.journal.snapshot("namespace/thread-A")?.sequence).toBe(1);
    expect(await manager.beginTurn("namespace/thread-B", "native-turn-1"))
      .toEqual({ status: "accepted", sequence: 1 });
    expect(await manager.beginTurn("namespace/thread-A", "native-turn-2"))
      .toEqual({ status: "accepted", sequence: 2 });
  } finally {
    home.close();
  }
});

test("result store writes immutable private content and rejects conflicting operation reuse", () => {
  const home = fixture();
  try {
    const results = new SessionResultStore(join(dirname(home.path), "results"));
    const identity = {
      sessionId: "namespace/thread-A",
      generation: 1,
      turnId: "native-turn-1",
      operationId: "send-A",
    };
    const ref = results.put({ ...identity, text: "Browser answer" });
    expect(results.get(ref)).toEqual({ ...identity, text: "Browser answer" });
    expect(results.put({ ...identity, text: "Browser answer" })).toBe(ref);
    expect(results.put({
      text: "Browser answer",
      operationId: identity.operationId,
      turnId: identity.turnId,
      generation: identity.generation,
      sessionId: identity.sessionId,
    })).toBe(ref);
    expect(() => results.put({ ...identity, text: "Different answer" })).toThrow("conflicting result");
    expect(statSync(join(dirname(home.path), "results")).mode & 0o077).toBe(0);
    expect(statSync(join(dirname(home.path), "results", `${ref}.json`)).mode & 0o077).toBe(0);
  } finally {
    home.close();
  }
});

test("result store detects disk content tampering before returning a recovered answer", () => {
  const home = fixture();
  try {
    const directory = join(dirname(home.path), "results");
    const results = new SessionResultStore(directory);
    const ref = results.put({
      sessionId: "namespace/thread-A",
      generation: 1,
      turnId: "native-turn-1",
      operationId: "send-A",
      text: "Verified answer",
    });
    const path = join(directory, `${ref}.json`);
    const stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    stored.text = "Tampered answer";
    writeFileSync(path, JSON.stringify(stored));
    expect(() => results.get(ref)).toThrow("integrity check failed");
  } finally {
    home.close();
  }
});

test("manager records intent before browser work and persists its accepted result", async () => {
  const home = fixture();
  try {
    const results = new SessionResultStore(join(dirname(home.path), "results"));
    const manager = new SessionActorManager(home.journal, results);
    let releaseBrowser: () => void = () => {};
    const browserGate = new Promise<void>(resolve => { releaseBrowser = resolve; });
    let starts = 0;
    const run = manager.runBrowserTurn(
      "namespace/thread-A",
      "native-turn-1",
      "browser-1",
      async onAccepted => {
        starts += 1;
        expect(home.journal.operation("namespace/thread-A", 1, "browser-1")?.state).toBe("intent");
        await onAccepted();
        await browserGate;
        return "Browser answer";
      },
    );
    const other = await manager.beginTurn("namespace/thread-B", "native-turn-1");
    expect(other).toEqual({ status: "accepted", sequence: 1 });
    const replay = manager.runBrowserTurn(
      "namespace/thread-A",
      "native-turn-1",
      "browser-1",
      async () => {
        starts += 1;
        return "unexpected duplicate";
      },
    );
    releaseBrowser();
    expect(await run).toBe("Browser answer");
    expect(await replay).toBe("Browser answer");
    expect(starts).toBe(1);
    const operation = home.journal.operation("namespace/thread-A", 1, "browser-1");
    expect(operation?.state).toBe("completed");
    expect(results.get(operation!.resultRef!).text).toBe("Browser answer");
  } finally {
    home.close();
  }
});

test("restart reconciles a persisted browser result without sending again", async () => {
  const home = fixture();
  const sessionId = "namespace/thread-A";
  const turnId = "native-turn-1";
  const operationId = "browser-1";
  const results = new SessionResultStore(join(dirname(home.path), "results"));
  try {
    const manager = new SessionActorManager(home.journal, results);
    await manager.beginTurn(sessionId, turnId);
    const actor = manager.actor(sessionId);
    await actor.dispatch({
      ...command(sessionId, 1, "operation_intent"),
      turnId,
      operationId,
      producerId: `operation:${operationId}`,
      operationKind: "browser_send",
      historyRevision: 0,
    });
    await actor.dispatch({
      ...command(sessionId, 1, "operation_accepted"),
      turnId,
      operationId,
      producerId: `effect:${operationId}`,
    });
    const ref = results.put({ sessionId, generation: 1, turnId, operationId, text: "Recovered answer" });
    home.journal.close();
    const restarted = new SessionActorJournal(home.path);
    try {
      expect(restarted.operation(sessionId, 1, operationId)?.state).toBe("uncertain");
      let sends = 0;
      const answer = await new SessionActorManager(restarted, results).runBrowserTurn(
        sessionId,
        turnId,
        operationId,
        async () => {
          sends += 1;
          return "Duplicate answer";
        },
      );
      expect(answer).toBe("Recovered answer");
      expect(sends).toBe(0);
      expect(restarted.operation(sessionId, 1, operationId)?.state).toBe("completed");
      expect(restarted.operation(sessionId, 1, operationId)?.resultRef).toBe(ref);
    } finally {
      restarted.close();
    }
  } finally {
    home.close();
  }
});

test("restart with only browser acceptance leaves the effect uncertain", async () => {
  const home = fixture();
  const sessionId = "namespace/thread-A";
  const turnId = "native-turn-1";
  const operationId = "browser-1";
  try {
    const manager = new SessionActorManager(home.journal);
    await manager.beginTurn(sessionId, turnId);
    const actor = manager.actor(sessionId);
    await actor.dispatch({
      ...command(sessionId, 1, "operation_intent"),
      turnId,
      operationId,
      producerId: `operation:${operationId}`,
      operationKind: "browser_send",
      historyRevision: 0,
    });
    await actor.dispatch({
      ...command(sessionId, 1, "operation_accepted"),
      turnId,
      operationId,
      producerId: `effect:${operationId}`,
    });
    home.journal.close();
    const restarted = new SessionActorJournal(home.path);
    try {
      let sends = 0;
      const resumed = new SessionActorManager(
        restarted,
        new SessionResultStore(join(dirname(home.path), "results")),
      );
      await expect(resumed.runBrowserTurn(sessionId, turnId, operationId, async () => {
        sends += 1;
        return "Duplicate answer";
      })).rejects.toThrow("reconciliation");
      expect(sends).toBe(0);
      expect(restarted.operation(sessionId, 1, operationId)?.state).toBe("uncertain");
    } finally {
      restarted.close();
    }
  } finally {
    home.close();
  }
});

test("tool observation is durably acknowledged before the browser result and deduplicates retries", async () => {
  const home = fixture();
  try {
    const manager = new SessionActorManager(
      home.journal,
      new SessionResultStore(join(dirname(home.path), "results")),
    );
    const answer = await manager.runBrowserTurn(
      "namespace/thread-A",
      "native-turn-1",
      "browser-1",
      async (onAccepted, onToolBatchObserved) => {
        await onAccepted();
        const first = await onToolBatchObserved(7, 2);
        const duplicate = await onToolBatchObserved(7, 2);
        expect(duplicate).toEqual(first);
        await expect(onToolBatchObserved(7, 3)).rejects.toThrow("different contents");
        return "Answer after tools";
      },
    );
    expect(answer).toBe("Answer after tools");
    expect(home.journal.snapshot("namespace/thread-A")?.sequence).toBe(5);
  } finally {
    home.close();
  }
});

test("a tool observation from a revoked generation cannot cross into another session", async () => {
  const home = fixture();
  try {
    const a = new SessionActor(home.journal, "namespace/thread-A");
    const b = new SessionActor(home.journal, "namespace/thread-B");
    await a.dispatch(command("namespace/thread-A", 1, "turn_started"));
    await b.dispatch(command("namespace/thread-B", 1, "turn_started"));
    await a.dispatch(command("namespace/thread-A", 2, "operation_intent", {
      operationId: "browser-A",
      operationKind: "browser_send",
      historyRevision: 0,
    }));
    await a.dispatch(command("namespace/thread-A", 3, "operation_accepted", {
      operationId: "browser-A",
    }));
    const observed = command("namespace/thread-A", 4, "tool_batch_observed", {
      operationId: "batch-A",
      parentOperationId: "browser-A",
      historyRevision: 0,
      toolBatchRevision: 2,
    });
    expect(await a.dispatch(observed)).toEqual({ status: "accepted", sequence: 4 });
    await expect(a.dispatch(command("namespace/thread-A", 5, "tool_batch_observed", {
      operationId: "batch-B",
      parentOperationId: "browser-A",
      historyRevision: 0,
      toolBatchRevision: 0,
    }))).rejects.toThrow("owner or revision mismatch");
    await a.dispatch(command("namespace/thread-A", 5, "generation_revoked"));
    expect(await a.dispatch(observed)).toEqual({ status: "stale_generation", currentGeneration: 2 });
    expect(await a.dispatch(command("namespace/thread-A", 6, "tool_batch_observed", {
      operationId: "batch-late",
      parentOperationId: "browser-A",
      historyRevision: 0,
      toolBatchRevision: 3,
    }))).toEqual({ status: "stale_generation", currentGeneration: 2 });
    expect(await b.dispatch(command("namespace/thread-B", 2, "operation_intent", {
      operationId: "browser-B",
      operationKind: "browser_send",
      historyRevision: 0,
    }))).toEqual({ status: "accepted", sequence: 2 });
  } finally {
    home.close();
  }
});

test("browser work claims its leased surface before Send and releases it after turn end", async () => {
  const home = fixture();
  try {
    const manager = new SessionActorManager(
      home.journal,
      new SessionResultStore(join(dirname(home.path), "results")),
    );
    const sessionId = "namespace/thread-A";
    const answer = await manager.runBrowserTurn(
      sessionId,
      "native-turn-1",
      "browser-1",
      async (onAccepted, _onToolBatchObserved, onSurfaceLeased, onSurfaceReleased) => {
        await onSurfaceLeased("surface-A");
        expect(home.journal.surfaceOwner("surface-A")).toEqual({ sessionId, generation: 1 });
        await onAccepted();
        await onSurfaceReleased("surface-A");
        expect(home.journal.surfaceOwner("surface-A")).toBeNull();
        return "Finished";
      },
    );
    expect(answer).toBe("Finished");
  } finally {
    home.close();
  }
});

test("browser answer is durable before the launcher releases its surface", async () => {
  const home = fixture();
  try {
    const results = new SessionResultStore(join(dirname(home.path), "results"));
    const manager = new SessionActorManager(home.journal, results);
    const sessionId = "namespace/thread-A";
    const answer = await manager.runBrowserTurn(
      sessionId,
      "native-turn-1",
      "browser-1",
      async (onAccepted, _onTools, onSurfaceLeased, onSurfaceReleased, onResultReady) => {
        await onSurfaceLeased("surface-A");
        await onAccepted();
        await onResultReady("Persisted before release");
        const ref = results.referenceFor({
          sessionId,
          generation: 1,
          turnId: "native-turn-1",
          operationId: "browser-1",
        });
        expect(results.get(ref).text).toBe("Persisted before release");
        expect(home.journal.operation(sessionId, 1, "browser-1")?.state).toBe("accepted");
        await onSurfaceReleased("surface-A");
        return "Persisted before release";
      },
    );
    expect(answer).toBe("Persisted before release");
    expect(home.journal.operation(sessionId, 1, "browser-1")?.state).toBe("completed");
  } finally {
    home.close();
  }
});

test("a missing retained surface is reconciled before its session claims a replacement", async () => {
  const home = fixture();
  try {
    const sessionId = "namespace/thread-A";
    const missing: string[] = [];
    const manager = new SessionActorManager(
      home.journal,
      new SessionResultStore(join(dirname(home.path), "results")),
      surfaceId => {
        missing.push(surfaceId);
        return surfaceId === "old-surface";
      },
    );
    await manager.runBrowserTurn(sessionId, "turn-1", "browser-1", async (
      onAccepted,
      _onTools,
      onSurfaceLeased,
    ) => {
      await onSurfaceLeased("old-surface");
      await onAccepted();
      return "Retained answer";
    });
    expect(home.journal.surfaceOwner("old-surface")).toEqual({ sessionId, generation: 1 });
    await manager.runBrowserTurn(sessionId, "turn-2", "browser-2", async (
      onAccepted,
      _onTools,
      onSurfaceLeased,
      onSurfaceReleased,
    ) => {
      await onSurfaceLeased("new-surface");
      expect(home.journal.surfaceOwner("old-surface")).toBeNull();
      expect(home.journal.surfaceOwner("new-surface")).toEqual({ sessionId, generation: 1 });
      await onAccepted();
      await onSurfaceReleased("new-surface");
      return "New answer";
    });
    expect(missing).toEqual(["old-surface"]);
  } finally {
    home.close();
  }
});

test("a retained surface still present in the launcher blocks a replacement claim", async () => {
  const home = fixture();
  try {
    const manager = new SessionActorManager(
      home.journal,
      new SessionResultStore(join(dirname(home.path), "results")),
      () => false,
    );
    const sessionId = "namespace/thread-A";
    await manager.runBrowserTurn(sessionId, "turn-1", "browser-1", async (
      onAccepted,
      _onTools,
      onSurfaceLeased,
    ) => {
      await onSurfaceLeased("old-surface");
      await onAccepted();
      return "Retained answer";
    });
    await expect(manager.runBrowserTurn(sessionId, "turn-2", "browser-2", async (
      _onAccepted,
      _onTools,
      onSurfaceLeased,
    ) => {
      await onSurfaceLeased("new-surface");
      return "must not send";
    })).rejects.toThrow("still owns this session");
    expect(home.journal.surfaceOwner("old-surface")).toEqual({ sessionId, generation: 1 });
    expect(home.journal.surfaceOwner("new-surface")).toBeNull();
  } finally {
    home.close();
  }
});
