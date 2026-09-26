import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundTaskManager, type BackgroundTask } from "../src/adapters/chatgpt-web/background-task-manager";

describe("BackgroundTaskManager", () => {
  test("starts a task in background, streams output to log file, and completes", async () => {
    const root = mkdtempSync(join(tmpdir(), "bg-task-test-"));
    const manager = new BackgroundTaskManager();

    try {
      const task = manager.startTask({
        cmd: "echo 'first line'; echo 'second line'",
        cwd: root,
        roots: [root],
        writableRoots: [root],
      });

      expect(task.id).toMatch(/^task_\d+_[0-9a-f]+$/);
      expect(task.status).toBe("running");
      expect(task.logFile).toContain(".codex-tmp/tasks");

      // Poll with waitMs to allow completion
      const polled = await manager.pollTask(task.id, 2_000, 10);
      expect(polled).not.toBeNull();
      expect(polled!.task.status).toBe("completed");
      expect(polled!.task.exitCode).toBe(0);
      expect(polled!.tail).toContain("first line");
      expect(polled!.tail).toContain("second line");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("can terminate a running background task", async () => {
    const root = mkdtempSync(join(tmpdir(), "bg-task-kill-"));
    const manager = new BackgroundTaskManager();

    try {
      const task = manager.startTask({
        cmd: "sleep 10",
        cwd: root,
        roots: [root],
        writableRoots: [root],
      });

      expect(task.status).toBe("running");

      const killed = manager.killTask(task.id);
      expect(killed).toBe(true);

      const status = manager.getTask(task.id);
      expect(status?.status).toBe("killed");
      expect(status?.exitCode).toBe(137);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("lists recent tasks in descending start order", async () => {
    const root = mkdtempSync(join(tmpdir(), "bg-task-list-"));
    const manager = new BackgroundTaskManager();

    try {
      const t1 = manager.startTask({ cmd: "echo 1", cwd: root, roots: [root], writableRoots: [root] });
      // startedAt has millisecond precision; guarantee the two starts land in different
      // milliseconds so the descending order is well defined.
      await Bun.sleep(2);
      const t2 = manager.startTask({ cmd: "echo 2", cwd: root, roots: [root], writableRoots: [root] });

      const list = manager.listTasks();
      expect(list.length).toBe(2);
      expect(list[0]!.id).toBe(t2.id);
      expect(list[1]!.id).toBe(t1.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("onCompletion fires with a snapshot on completion and unsubscribe works", async () => {
    const root = mkdtempSync(join(tmpdir(), "bg-task-oncompletion-"));
    const manager = new BackgroundTaskManager();

    try {
      const events: BackgroundTask[] = [];
      const unsubscribe = manager.onCompletion(task => events.push(task));

      const task = manager.startTask({
        cmd: "echo 'completion test'",
        cwd: root,
        roots: [root],
        writableRoots: [root],
      });
      await manager.pollTask(task.id, 2_000, 5);

      expect(events.length).toBe(1);
      const event = events[0]!;
      expect(event.id).toBe(task.id);
      expect(event.status).toBe("completed");
      expect(event.exitCode).toBe(0);
      expect(event.completedAt).toBeDefined();
      expect(event.durationMs).toBeDefined();
      expect(event.logFile).toBe(task.logFile);
      // Snapshot: not the same mutable object the manager keeps.
      expect(event).not.toBe(manager.getTask(task.id));

      unsubscribe();
      const second = manager.startTask({
        cmd: "echo 'after unsubscribe'",
        cwd: root,
        roots: [root],
        writableRoots: [root],
      });
      await manager.pollTask(second.id, 2_000, 5);
      expect(events.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("onCompletion isolates listeners that throw", async () => {
    const root = mkdtempSync(join(tmpdir(), "bg-task-listener-error-"));
    const manager = new BackgroundTaskManager();

    try {
      const events: BackgroundTask[] = [];
      manager.onCompletion(() => {
        throw new Error("listener boom");
      });
      const unsubscribe = manager.onCompletion(task => events.push(task));

      const task = manager.startTask({
        cmd: "echo 'listener isolation'",
        cwd: root,
        roots: [root],
        writableRoots: [root],
      });
      await manager.pollTask(task.id, 2_000, 5);

      expect(events.length).toBe(1);
      expect(events[0]!.id).toBe(task.id);
      unsubscribe();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("startTask enforces maxConcurrent and reports the running count", () => {
    const root = mkdtempSync(join(tmpdir(), "bg-task-concurrent-"));
    const manager = new BackgroundTaskManager();
    const running: string[] = [];

    try {
      const first = manager.startTask({
        cmd: "sleep 5",
        cwd: root,
        roots: [root],
        writableRoots: [root],
        maxConcurrent: 2,
      });
      running.push(first.id);
      const second = manager.startTask({
        cmd: "sleep 5",
        cwd: root,
        roots: [root],
        writableRoots: [root],
        maxConcurrent: 2,
      });
      running.push(second.id);

      expect(() => manager.startTask({ cmd: "sleep 5", cwd: root, roots: [root], writableRoots: [root], maxConcurrent: 2 }))
        .toThrow(/2 task\(s\) running \(maxConcurrent=2\)/);
      expect(() => manager.startTask({ cmd: "sleep 5", cwd: root, roots: [root], writableRoots: [root], maxConcurrent: 2 }))
        .toThrow(/codex_poll_task/);

      // Freeing a slot (kill flips status to "killed") allows starting again.
      expect(manager.killTask(first.id)).toBe(true);
      running.splice(running.indexOf(first.id), 1);
      const third = manager.startTask({ cmd: "sleep 5", cwd: root, roots: [root], writableRoots: [root], maxConcurrent: 2 });
      running.push(third.id);
      expect(third.status).toBe("running");
    } finally {
      for (const id of running) manager.killTask(id);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("expired logs of finished tasks are garbage collected; running task logs survive", async () => {
    const root = mkdtempSync(join(tmpdir(), "bg-task-gc-"));
    const manager = new BackgroundTaskManager();
    const toKill: string[] = [];

    try {
      const finished = manager.startTask({ cmd: "echo 'gc target'", cwd: root, roots: [root], writableRoots: [root] });
      await manager.pollTask(finished.id, 2_000, 5);
      expect(existsSync(finished.fullLogPath)).toBe(true);

      const running = manager.startTask({
        cmd: "sleep 5",
        cwd: root,
        roots: [root],
        writableRoots: [root],
        logRetentionHours: 1,
      });
      toKill.push(running.id);
      expect(existsSync(running.fullLogPath)).toBe(true);

      // Simulate an old completion for the finished task (retention is 1 hour).
      manager.getTask(finished.id)!.completedAt = new Date(Date.now() - 100 * 3_600_000).toISOString();

      // Starting another task triggers the log GC pass (pruneOldTasks).
      const trigger = manager.startTask({
        cmd: "echo 'gc trigger'",
        cwd: root,
        roots: [root],
        writableRoots: [root],
        logRetentionHours: 1,
      });
      toKill.push(trigger.id);

      expect(existsSync(finished.fullLogPath)).toBe(false);
      expect(existsSync(running.fullLogPath)).toBe(true);
    } finally {
      for (const id of toKill) manager.killTask(id);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
