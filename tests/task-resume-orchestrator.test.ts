import { describe, expect, test } from "bun:test";
import {
  buildTaskResumeNote,
  parseTaskCompletionPayload,
  TaskResumeOrchestrator,
  type TaskCompletion,
  type TaskCompletionPayload,
  type TaskResumeConversationHead,
} from "../src/adapters/chatgpt-web/task-resume-orchestrator";

let taskSeq = 0;

function makeTask(overrides: Partial<TaskCompletion> = {}): TaskCompletion {
  taskSeq += 1;
  return {
    id: `T${taskSeq}`,
    cmd: "bun test",
    cwd: "/repo",
    status: "completed",
    exitCode: 0,
    startedAt: "2026-09-25T10:00:00Z",
    completedAt: "2026-09-25T10:01:00Z",
    logPath: `/tmp/task-${taskSeq}.log`,
    ...overrides,
  };
}

function makePayload(overrides: {
  task?: Partial<TaskCompletion>;
  summary?: string;
  traceId?: string;
  turnToken?: string;
} = {}): TaskCompletionPayload {
  const task = makeTask(overrides.task);
  const payload: TaskCompletionPayload = { source: "chatgpt-web-mcp", task };
  if (overrides.summary !== undefined) payload.summary = overrides.summary;
  if (overrides.traceId !== undefined) payload.traceId = overrides.traceId;
  if (overrides.turnToken !== undefined) payload.turnToken = overrides.turnToken;
  return payload;
}

function makeHead(conversationKey: string | undefined): TaskResumeConversationHead {
  return {
    conversationKey: () => conversationKey,
    physicalSettlement: Promise.resolve(),
    settledOutcome: () => ({ type: "final" }),
  };
}

interface HarnessOptions {
  maxQueue?: number;
  resumeNotes?: boolean;
  waitForSettlement?: (head: TaskResumeConversationHead) => Promise<void>;
}

function makeHarness(options: HarnessOptions = {}) {
  const heads = new Map<string, TaskResumeConversationHead>();
  const findConversationHead = (traceId?: string, turnToken?: string): TaskResumeConversationHead | undefined =>
    (traceId ? heads.get(traceId) : undefined) ?? (turnToken ? heads.get(turnToken) : undefined);
  const sentNotes: Array<{ conversationKey: string; note: string }> = [];
  const orchestrator = new TaskResumeOrchestrator({
    findConversationHead,
    runResumeTurn: async (conversationKey, noteText) => {
      sentNotes.push({ conversationKey, note: noteText });
    },
    ...(options.waitForSettlement ? { waitForSettlement: options.waitForSettlement } : {}),
    ...(options.maxQueue !== undefined ? { maxQueue: options.maxQueue } : {}),
    ...(options.resumeNotes !== undefined ? { resumeNotes: options.resumeNotes } : {}),
  });
  return { orchestrator, heads, sentNotes };
}

async function until(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met before timeout");
    await Bun.sleep(1);
  }
}

describe("Sprint H3: TaskResumeOrchestrator (daemon push + observability)", () => {
  test("single event produces one note with the prepared summary and conversation key after settlement", async () => {
    const harness = makeHarness();
    harness.heads.set("trace-1", makeHead("ck-1"));
    const payload = makePayload({
      traceId: "trace-1",
      summary: "exit 0 — 42 pass, 1 fail",
      task: { logPath: "/tmp/t1.log" },
    });
    harness.orchestrator.recordCompletion(payload);
    harness.orchestrator.drainNow();
    await until(() => harness.sentNotes.length === 1);

    expect(harness.sentNotes[0]!.conversationKey).toBe("ck-1");
    expect(harness.sentNotes[0]!.note).toBe(
      `Background tasks finished: [${payload.task.id}] exit 0 — 42 pass, 1 fail (log: /tmp/t1.log).`,
    );
    const stats = harness.orchestrator.getStats();
    expect(stats.events_received).toBe(1);
    expect(stats.notes_sent).toBe(1);
    expect(stats.notes_failed).toBe(0);
    expect(stats.skipped_no_session).toBe(0);
    expect(stats.last_event_at).not.toBeNull();
    expect(stats.last_note_at).not.toBeNull();
  });

  test("three completions for one conversation inside the window coalesce into ONE combined note", async () => {
    const harness = makeHarness();
    harness.heads.set("trace-2", makeHead("ck-2"));
    harness.orchestrator.recordCompletion(makePayload({ traceId: "trace-2", summary: "exit 0 — ok" }));
    harness.orchestrator.recordCompletion(makePayload({ traceId: "trace-2", summary: "exit 1 — build error" }));
    harness.orchestrator.recordCompletion(makePayload({ traceId: "trace-2", summary: "exit 0 — lint clean" }));
    harness.orchestrator.drainNow();
    await until(() => harness.sentNotes.length === 1);
    await Bun.sleep(5);

    expect(harness.sentNotes.length).toBe(1);
    const { note, conversationKey } = harness.sentNotes[0]!;
    expect(conversationKey).toBe("ck-2");
    expect(note).toContain("exit 0 — ok");
    expect(note).toContain("exit 1 — build error");
    expect(note).toContain("exit 0 — lint clean");
    const stats = harness.orchestrator.getStats();
    expect(stats.events_received).toBe(3);
    expect(stats.notes_sent).toBe(1);
    expect(stats.coalesced_groups).toBe(1);
  });

  test("an unresolvable head never sends; the event is dropped as skipped_no_session at the queue bound", async () => {
    const harness = makeHarness({ maxQueue: 2 });
    harness.orchestrator.recordCompletion(makePayload({ traceId: "ghost-1", summary: "exit 0 — ghost" }));
    harness.orchestrator.drainNow();
    await Bun.sleep(5);

    // Still buffered: every drain retries the resolution before giving up.
    expect(harness.sentNotes.length).toBe(0);
    expect(harness.orchestrator.getStats().skipped_no_session).toBe(0);

    harness.orchestrator.recordCompletion(makePayload({ traceId: "ghost-2", summary: "exit 0 — ghost 2" }));
    harness.orchestrator.recordCompletion(makePayload({ traceId: "ghost-3", summary: "exit 0 — ghost 3" }));
    harness.orchestrator.drainNow();
    await Bun.sleep(5);

    expect(harness.sentNotes.length).toBe(0);
    const stats = harness.orchestrator.getStats();
    expect(stats.skipped_no_session).toBe(1);
    expect(stats.notes_sent).toBe(0);
    expect(stats.events_received).toBe(3);
  });

  test("a completion arriving while the conversation is mid-turn joins the pending note (one dispatch after settlement)", async () => {
    let releaseSettlement!: () => void;
    const settlement = new Promise<void>(resolve => {
      releaseSettlement = resolve;
    });
    const harness = makeHarness();
    harness.heads.set("trace-4", {
      conversationKey: () => "ck-4",
      physicalSettlement: settlement,
      settledOutcome: () => ({ type: "final" }),
    });

    harness.orchestrator.recordCompletion(makePayload({ traceId: "trace-4", summary: "exit 0 — first" }));
    harness.orchestrator.drainNow();
    await Bun.sleep(5); // dispatch started and is waiting for the physical settlement

    expect(harness.sentNotes.length).toBe(0);
    // Same conversation completes another task while the note is pending: it must join the note
    // instead of triggering a second turn.
    harness.orchestrator.recordCompletion(makePayload({ traceId: "trace-4", summary: "exit 1 — second" }));
    harness.orchestrator.drainNow(); // must not dispatch a duplicate for the draining group
    releaseSettlement();
    await until(() => harness.sentNotes.length === 1);
    await Bun.sleep(5);

    expect(harness.sentNotes.length).toBe(1);
    const { note } = harness.sentNotes[0]!;
    expect(note).toContain("exit 0 — first");
    expect(note).toContain("exit 1 — second");
    expect(harness.orchestrator.getStats().notes_sent).toBe(1);
    expect(harness.orchestrator.getStats().coalesced_groups).toBe(1);
  });

  test("runResumeTurn failures count as notes_failed and never propagate", async () => {
    const head = makeHead("ck-5");
    let attempts = 0;
    const orchestrator = new TaskResumeOrchestrator({
      findConversationHead: traceId => (traceId ? head : undefined),
      runResumeTurn: async () => {
        attempts += 1;
        throw new Error("browser gone");
      },
    });
    orchestrator.recordCompletion(makePayload({ traceId: "trace-5", summary: "exit 1 — boom" }));

    expect(() => orchestrator.drainNow()).not.toThrow();
    await until(() => attempts === 1);
    expect(orchestrator.getStats().notes_failed).toBe(1);
    expect(orchestrator.getStats().notes_sent).toBe(0);

    // The orchestrator stays healthy after a failed note turn.
    orchestrator.recordCompletion(makePayload({ traceId: "trace-5", summary: "exit 0 — retry" }));
    expect(() => orchestrator.drainNow()).not.toThrow();
    await until(() => attempts === 2);
    expect(orchestrator.getStats().notes_failed).toBe(2);
  });

  test("resumeNotes=false never calls runResumeTurn but still accounts for events", async () => {
    const harness = makeHarness({ resumeNotes: false });
    harness.heads.set("trace-6", makeHead("ck-6"));
    harness.orchestrator.recordCompletion(makePayload({ traceId: "trace-6", summary: "exit 0 — muted" }));
    harness.orchestrator.drainNow();
    await Bun.sleep(5);

    expect(harness.sentNotes.length).toBe(0);
    const stats = harness.orchestrator.getStats();
    expect(stats.events_received).toBe(1);
    expect(stats.notes_sent).toBe(0);
    expect(stats.last_event_at).not.toBeNull();
    expect(stats.last_note_at).toBeNull();
  });

  test("invalid payloads throw so the endpoint can answer 400", () => {
    const harness = makeHarness();
    expect(() => harness.orchestrator.recordCompletion("nope")).toThrow();
    expect(() => harness.orchestrator.recordCompletion({ source: "somewhere-else", task: makeTask() })).toThrow();
    expect(() => harness.orchestrator.recordCompletion({ source: "chatgpt-web-mcp" })).toThrow(/task/);
    expect(() => harness.orchestrator.recordCompletion({
      source: "chatgpt-web-mcp",
      task: makeTask({ status: "exploded" as TaskCompletion["status"] }),
    })).toThrow(/status/);
    expect(() => harness.orchestrator.recordCompletion({
      source: "chatgpt-web-mcp",
      task: makeTask({ exitCode: "0" as unknown as number }),
    })).toThrow(/exitCode/);
    expect(() => harness.orchestrator.recordCompletion({
      source: "chatgpt-web-mcp",
      task: makeTask({ id: "" }),
    })).toThrow(/id/);
    expect(() => parseTaskCompletionPayload({
      source: "chatgpt-web-mcp",
      task: makeTask(),
      traceId: 42,
    })).toThrow(/traceId/);

    const valid = makePayload({ traceId: "trace-7", summary: "exit 0 — fine" });
    expect(() => parseTaskCompletionPayload(valid)).not.toThrow();
    // Rejected payloads must not advance the counters.
    expect(harness.orchestrator.getStats().events_received).toBe(0);
  });

  test("the combined note is bounded (~1200 chars) and keeps task ids, log paths and exit codes", () => {
    const events = Array.from({ length: 5 }, (_, index) => makePayload({
      task: {
        id: `JOB-${index + 1}`,
        cmd: "bun run build",
        exitCode: index % 2,
        logPath: `/tmp/logs/job-${index + 1}.log`,
      },
      summary: `exit ${index % 2} — step ${index + 1} finished`,
    }));
    const note = buildTaskResumeNote(events);

    expect(note.length).toBeLessThanOrEqual(1200);
    expect(note.startsWith("Background tasks finished:")).toBe(true);
    for (const event of events) {
      expect(note).toContain(event.task.id);
      expect(note).toContain(event.task.logPath);
      expect(note).toContain(`exit ${event.task.exitCode}`);
    }
  });

  test("without a summary the note derives the line from the task (status + exit code + truncated cmd + log)", () => {
    const payload = makePayload({
      task: {
        cmd: `bun run ${"x".repeat(120)}`,
        status: "failed",
        exitCode: 1,
        logPath: "/tmp/derived.log",
      },
    });
    const note = buildTaskResumeNote([payload]);

    expect(note).toContain(`[${payload.task.id}] failed (exit 1) — `);
    expect(note).toContain("(log: /tmp/derived.log)");
    // The command is truncated to ~60 chars: the full 120-char run never appears.
    expect(note).not.toContain("x".repeat(120));
    expect(note).toContain("…");
  });
});
