import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompactionCheckpointTransaction } from "../src/adapters/chatgpt-web/adapter/compaction-checkpoint";
import {
  SessionActorJournal,
  SessionActorManager,
  SessionResultStore,
} from "../src/adapters/chatgpt-web/session-actor";

async function withCheckpoint(run: (state: ReturnType<typeof fixture>) => Promise<void>) {
  const f = fixture();
  try {
    await run(f);
  } finally {
    f.journal.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cgw-checkpoint-seam-"));
  const journal = new SessionActorJournal(join(root, "events.sqlite"));
  const results = new SessionResultStore(join(root, "results"));
  const manager = new SessionActorManager(journal, results);
  const transaction = new CompactionCheckpointTransaction(manager, "thread", "turn", "operation");
  return { root, journal, results, manager, transaction };
}

test("history advances only after checkpoint persistence and acceptance", async () => {
  await withCheckpoint(async ({ transaction, journal }) => {
    await transaction.transition("compaction_prepared");
    await transaction.receiveAndValidate("durable checkpoint");
    expect(transaction.recovery()).toEqual({ state: "validated" });
    const historyRevision = journal.snapshot("thread")!.historyRevision;
    expect(
      await transaction.persist(() => {
        expect(journal.snapshot("thread")!.historyRevision).toBe(historyRevision);
        return true;
      }),
    ).toBe(true);
    expect(transaction.recovery()).toEqual({ state: "persisted" });
    expect(journal.snapshot("thread")!.historyRevision).toBe(historyRevision);
    await transaction.transition("compaction_accepted");
    expect(transaction.recovery()).toEqual({ state: "accepted", summary: "durable checkpoint" });
    expect(journal.snapshot("thread")!.historyRevision).toBe(historyRevision + 1);
    await transaction.rejectIfOpen();
    expect(transaction.recovery()?.state).toBe("accepted");
  });
});

test("failed persistence leaves canonical history intact and can reject the open checkpoint", async () => {
  await withCheckpoint(async ({ transaction, journal }) => {
    await transaction.transition("compaction_prepared");
    await transaction.receiveAndValidate("checkpoint");
    const revision = journal.snapshot("thread")!.historyRevision;
    const failure = new Error("disk full");
    await expect(
      transaction.persist(() => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(transaction.recovery()?.state).toBe("validated");
    expect(journal.snapshot("thread")!.historyRevision).toBe(revision);
    await transaction.rejectIfOpen();
    expect(transaction.recovery()?.state).toBe("rejected");
  });
});

test("persisted checkpoints survive actor restart and cannot be rejected by late cleanup", async () => {
  await withCheckpoint(async ({ transaction, journal, results }) => {
    await transaction.transition("compaction_prepared");
    await transaction.receiveAndValidate("checkpoint");
    await transaction.persist(() => true);
    const restarted = new CompactionCheckpointTransaction(
      new SessionActorManager(journal, results),
      "thread",
      "turn",
      "operation",
    );
    expect(restarted.recovery()?.state).toBe("persisted");
    await restarted.rejectIfOpen();
    expect(restarted.recovery()?.state).toBe("persisted");
    await restarted.transition("compaction_accepted");
    const sequence = journal.snapshot("thread")!.sequence;
    await restarted.transition("compaction_accepted");
    expect(journal.snapshot("thread")!.sequence).toBe(sequence);
  });
});

test("legacy operation without an actor preserves persistence and requires no new journal", async () => {
  const transaction = new CompactionCheckpointTransaction(undefined, "thread", undefined, "operation");
  expect(transaction.recovery()).toBeNull();
  await transaction.receiveAndValidate("checkpoint");
  expect(await transaction.persist(() => false)).toBe(false);
  await transaction.rejectIfOpen();
});

test("structured ownership is mandatory when an actor manager is present", async () => {
  await withCheckpoint(async ({ manager }) => {
    const transaction = new CompactionCheckpointTransaction(manager, "thread", undefined, "operation");
    await expect(transaction.transition("compaction_prepared")).rejects.toThrow("native turn ownership");
  });
});

test("cancellation during persistence records recoverable state without accepting history", async () => {
  await withCheckpoint(async ({ transaction, journal }) => {
    await transaction.transition("compaction_prepared");
    await transaction.receiveAndValidate("checkpoint");
    const before = journal.snapshot("thread")!.historyRevision;
    const abort = new AbortController();
    await expect(
      transaction.persist(
        () => {
          abort.abort();
          return true;
        },
        undefined,
        abort.signal,
      ),
    ).rejects.toThrow("aborted");
    expect(transaction.recovery()?.state).toBe("persisted");
    expect(journal.snapshot("thread")!.historyRevision).toBe(before);
    await transaction.rejectIfOpen();
    expect(transaction.recovery()?.state).toBe("persisted");
  });
});

test("already cancelled persistence never invokes its local write", async () => {
  await withCheckpoint(async ({ transaction }) => {
    await transaction.transition("compaction_prepared");
    await transaction.receiveAndValidate("checkpoint");
    let writes = 0;
    await expect(
      transaction.persist(
        () => {
          writes += 1;
          return true;
        },
        undefined,
        AbortSignal.abort(),
      ),
    ).rejects.toThrow("aborted");
    expect(writes).toBe(0);
    expect(transaction.recovery()?.state).toBe("validated");
  });
});
