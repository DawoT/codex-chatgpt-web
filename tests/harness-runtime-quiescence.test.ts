import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runStructuredCompactionOnce,
  structuredCompactionResourceDiagnostics,
} from "../src/adapters/chatgpt-web/compaction-handoff";
import { SessionActorJournal, SessionActorManager } from "../src/adapters/chatgpt-web/session-actor";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";

test("turn-session diagnostics expose waiters and physical retained releases until settlement", async () => {
  const sessions = new ChatGptTurnSessions();
  const trace = new ChatGptTraceFeed();
  const text = new ChatGptTextFeed();
  let releasePhysical!: () => void;
  const physicalSettlement = new Promise<void>((resolve) => {
    releasePhysical = resolve;
  });

  sessions.getOrCreate("diagnostic-turn", () => ({
    mode: "read-only",
    browser: Promise.resolve("done"),
    physicalSettlement,
    trace,
    text,
    conversationKey: "conversation-a",
    releaseRetainedConversation: async () => {},
    cancel: () => {},
  }));
  const traceWait = trace.wait();
  const textWait = text.wait();

  expect(sessions.resourceDiagnostics()).toMatchObject({
    pending_waiters: 2,
    pending_retirements: 0,
    retained_releases: 0,
  });

  const retirement = sessions.retireConversationAndWait("conversation-a");
  await Bun.sleep(0);
  expect(sessions.resourceDiagnostics()).toMatchObject({
    pending_retirements: 1,
    retained_releases: 1,
  });

  trace.close();
  text.close();
  releasePhysical();
  await Promise.all([traceWait, textWait, retirement]);
  expect(sessions.resourceDiagnostics()).toEqual({
    pending_waiters: 0,
    pending_retirements: 0,
    retained_releases: 0,
  });
});

test("turn-broker diagnostics expose pending compaction transactions and telemetry queue health", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-runtime-quiescence-"));
  const broker = TurnBroker.forSocket(join(root, "broker.sock"));
  try {
    expect(broker.resourceDiagnostics()).toMatchObject({
      pending_waiters: 0,
      pending_timers: 0,
      pending_transactions: 0,
    });
    expect(broker.telemetryHealth()).toEqual({
      status: "healthy",
      pendingRecords: 0,
      pendingBytes: 0,
      failedWrites: 0,
      droppedRecords: 0,
    });

    const transaction = await broker.beginCompactionTransaction("trace-diagnostics", 5_000);
    expect(broker.resourceDiagnostics()).toMatchObject({
      pending_timers: 1,
      pending_transactions: 1,
    });
    broker.abortCompactionTransaction(transaction.token);
    expect(broker.resourceDiagnostics()).toMatchObject({
      pending_timers: 0,
      pending_transactions: 0,
    });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("session actor manager reports queued journal persistence until it settles", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-actor-quiescence-"));
  const journal = new SessionActorJournal(join(root, "events.sqlite"));
  const manager = new SessionActorManager(journal);
  try {
    const pending = manager.beginTurn("session-a", "turn-a");
    expect(manager.resourceDiagnostics()).toEqual({
      pending_persistences: 1,
      pending_effects: 0,
    });
    await pending;
    expect(manager.resourceDiagnostics()).toEqual({
      pending_persistences: 0,
      pending_effects: 0,
    });
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("structured compaction diagnostics remain active through retained physical settlement", async () => {
  let releasePhysical!: () => void;
  const physical = new Promise<void>((resolve) => {
    releasePhysical = resolve;
  });
  const key = `quiescence-${crypto.randomUUID()}`;
  const run = runStructuredCompactionOnce(
    key,
    { ownerKey: `owner-${key}`, traceIds: [`trace-${key}`] },
    async (_signal, retainOwnershipUntil) => {
      retainOwnershipUntil(physical);
      return "handoff";
    },
  );

  expect(await run).toBe("handoff");
  await Bun.sleep(0);
  expect(structuredCompactionResourceDiagnostics()).toMatchObject({
    active_runs: 1,
    retained_owner_settlements: 1,
  });

  releasePhysical();
  await Bun.sleep(0);
  expect(structuredCompactionResourceDiagnostics()).toMatchObject({
    active_runs: 0,
    retained_owner_settlements: 0,
  });
});
