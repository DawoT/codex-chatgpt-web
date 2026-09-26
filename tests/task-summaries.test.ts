import { describe, expect, test } from "bun:test";
import type { BackgroundTask } from "../src/adapters/chatgpt-web/background-task-manager";
import { summarizeTask } from "../src/adapters/chatgpt-web/task-summaries";

function makeTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "task_1",
    cmd: "bun test",
    cwd: "/repo",
    status: "completed",
    exitCode: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.500Z",
    durationMs: 1500,
    logFile: ".codex-tmp/tasks/task_1.log",
    fullLogPath: "/repo/.codex-tmp/tasks/task_1.log",
    ...overrides,
  };
}

describe("summarizeTask", () => {
  test("bun: parses pass/fail counts from the bun summary line", () => {
    const task = makeTask({ status: "completed", exitCode: 1 });
    const summary = summarizeTask(task, "Ran 4 tests across 2 files.\n 3 pass; 1 fail; 0 skip\n");
    expect(summary).toBe("completed (exit 1, 1.5s) | bun: 3 pass, 1 fail | log=/repo/.codex-tmp/tasks/task_1.log");
  });

  test("jest: parses 'Tests: N passed, M failed'", () => {
    const task = makeTask();
    const summary = summarizeTask(task, "PASS src/a.test.ts\nTests:  5 passed, 2 failed, 7 total\nTime: 1.2s\n");
    expect(summary).toBe("completed (exit 0, 1.5s) | jest: 5 passed, 2 failed | log=/repo/.codex-tmp/tasks/task_1.log");
  });

  test("jest: parses 'Tests: N passed' without failures", () => {
    const task = makeTask();
    const summary = summarizeTask(task, "PASS src/a.test.ts\nTests:  5 passed\nSnapshots: 0 total\n");
    expect(summary).toContain("jest: 5 passed");
    expect(summary).not.toContain("failed");
  });

  test("pytest: parses 'N passed, M failed'", () => {
    const task = makeTask();
    const tail = "============================= test session starts ==============================\n"
      + "collected 4 items\n\n"
      + "========================= 3 passed, 1 failed in 0.50s =========================\n";
    const summary = summarizeTask(task, tail);
    expect(summary).toBe("completed (exit 0, 1.5s) | pytest: 3 passed, 1 failed | log=/repo/.codex-tmp/tasks/task_1.log");
  });

  test("pytest: parses 'N failed, M passed' summary order", () => {
    const task = makeTask();
    const summary = summarizeTask(task, "========================= 2 failed, 3 passed in 0.42s =========================\n");
    expect(summary).toContain("pytest: 3 passed, 2 failed");
  });

  test("cargo: parses 'test result:' counts", () => {
    const task = makeTask();
    const tail = "   Compiling serde v1.0.0\n"
      + "    Finished `test` profile [unoptimized + debuginfo]\n"
      + "     Running unittests src/lib.rs\n\n"
      + "test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\n";
    const summary = summarizeTask(task, tail);
    expect(summary).toBe("completed (exit 0, 1.5s) | cargo: 10 passed, 0 failed | log=/repo/.codex-tmp/tasks/task_1.log");
  });

  test("go: counts per-package ok/FAIL lines", () => {
    const task = makeTask();
    const tail = "ok  \texample.com/a\t0.5s\nFAIL\texample.com/b\t0.1s\nok  \texample.com/c\t1.2s\n";
    const summary = summarizeTask(task, tail);
    expect(summary).toBe("completed (exit 0, 1.5s) | go: 2 ok, 1 failed | log=/repo/.codex-tmp/tasks/task_1.log");
  });

  test("falls back to the last two log lines when nothing parses", () => {
    const task = makeTask({ status: "running", exitCode: null, completedAt: undefined, durationMs: undefined });
    const summary = summarizeTask(task, "step one\n\nstep two done\n");
    expect(summary).toBe("running | step two done | log=/repo/.codex-tmp/tasks/task_1.log");
  });

  test("includes the first error line trimmed to 120 chars", () => {
    const task = makeTask({ status: "failed", exitCode: 1 });
    const summary = summarizeTask(task, "starting work\nError: connection refused at main.ts:42\nretrying later\n");
    expect(summary).toBe(
      "failed (exit 1, 1.5s) | error: Error: connection refused at main.ts:42 | log=/repo/.codex-tmp/tasks/task_1.log",
    );
  });

  test("clamps an over-long error line to 120 chars", () => {
    const task = makeTask({ status: "failed", exitCode: 1 });
    const longError = `ERROR ${"x".repeat(300)}`;
    const summary = summarizeTask(task, longError);
    const errorSegment = summary.split("error: ")[1]!.split(" | ")[0]!;
    expect(errorSegment.length).toBe(120);
    expect(errorSegment.endsWith("...")).toBe(true);
  });

  test("clamps summaries longer than 300 chars and keeps the log path intent", () => {
    const task = makeTask({ fullLogPath: `/repo/${"x".repeat(300)}/task_1.log` });
    const summary = summarizeTask(task, "Ran 4 tests across 2 files.\n 3 pass; 1 fail; 0 skip\n");
    expect(summary.length).toBe(300);
    expect(summary.startsWith("completed (exit 0, 1.5s)")).toBe(true);
    expect(summary.endsWith("...")).toBe(true);
  });

  test("empty log tail still yields status and log path", () => {
    const task = makeTask();
    const summary = summarizeTask(task, "");
    expect(summary).toBe("completed (exit 0, 1.5s) | log=/repo/.codex-tmp/tasks/task_1.log");
  });

  test("never throws on hostile input", () => {
    const task = makeTask();
    expect(() => summarizeTask(task, null as unknown as string)).not.toThrow();
    expect(() => summarizeTask(task, { split: 1 } as unknown as string)).not.toThrow();
    expect(summarizeTask(task, null as unknown as string)).toContain("log=/repo/.codex-tmp/tasks/task_1.log");
  });
});
