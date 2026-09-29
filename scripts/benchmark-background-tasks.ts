import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundTaskManager } from "../src/adapters/chatgpt-web/background-task-manager";
import type { TaskWaitOptions } from "../src/adapters/chatgpt-web/background-task-types";
import { waitOnTasks } from "../src/adapters/chatgpt-web/mcp/tasks";

class MeasuredManager extends BackgroundTaskManager {
  logReads = 0;

  override async pollTask(taskId: string, waitMs = 0, lines = 100, options: TaskWaitOptions = {}) {
    const result = await super.pollTask(taskId, waitMs, lines, options);
    if (result) this.logReads++;
    return result;
  }

  override getTaskLog(taskId: string, lines = 100, ownerId?: string) {
    const result = super.getTaskLog(taskId, lines, ownerId);
    if (result) this.logReads++;
    return result;
  }
}

// Historical waiting algorithm, using the same current manager and fixture for comparison.
async function pollingBaseline(manager: MeasuredManager, ids: string[], waitMs: number) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const running = ids.filter((id) => manager.getTask(id)?.status === "running");
    if (!running.length) break;
    await manager.pollTask(running[0]!, Math.min(5000, Math.max(0, deadline - Date.now())), 30);
  }
  for (const id of ids) manager.getTaskLog(id, 30);
}

const sourceHash = createHash("sha256");
for (const path of [
  "scripts/benchmark-background-tasks.ts",
  "src/adapters/chatgpt-web/background-task-manager.ts",
  "src/adapters/chatgpt-web/background-task-types.ts",
  "src/adapters/chatgpt-web/background-task-wait.ts",
  "src/adapters/chatgpt-web/background-task-log.ts",
  "src/adapters/chatgpt-web/mcp/tasks.ts",
]) {
  sourceHash.update(path);
  sourceHash.update(readFileSync(path));
}
const samples = [];
for (let repetition = 0; repetition < 3; repetition++) {
  for (const mode of ["polling-baseline", "completion-events"] as const) {
    const root = mkdtempSync(join(tmpdir(), "task-wait-benchmark-"));
    const manager = new MeasuredManager();
    const task = manager.startTask({
      cmd: process.platform === "win32" ? "echo ready & ping -n 9 127.0.0.1 > NUL" : "echo ready; sleep 8",
      cwd: root,
      roots: [root],
      writableRoots: [root],
    });
    try {
      const start = performance.now();
      if (mode === "polling-baseline") await pollingBaseline(manager, [task.id], 5200);
      else await waitOnTasks(manager, [task.id], 5200);
      const elapsedMs = performance.now() - start;
      const logReads = manager.logReads;
      assert.equal(manager.getTask(task.id)?.status, "running");
      assert.equal(logReads, mode === "polling-baseline" ? 3 : 1);
      const controller = new AbortController();
      const pending = manager.pollTask(task.id, 30_000, 30, { signal: controller.signal });
      const cancelledAt = performance.now();
      controller.abort(new Error("benchmark cancellation"));
      await assert.rejects(pending, /benchmark cancellation/);
      samples.push({ repetition, mode, elapsedMs, logReads, cancellationMs: performance.now() - cancelledAt });
    } finally {
      manager.killTask(task.id);
      await manager.pollTask(task.id, 2000);
      rmSync(root, { recursive: true, force: true });
    }
  }
}
console.log(
  JSON.stringify(
    {
      sourceSha256: sourceHash.digest("hex"),
      generatedAt: new Date().toISOString(),
      runtime: process.version,
      platform: process.platform,
      description:
        "One real 8-second task, 5.2-second wait. Baseline reproduces the former polling algorithm against the current manager. Counts successful log-tail reads, not disk-cache misses. Cancellation samples exercise the current manager in both modes. No model calls or throughput claim.",
      samples,
    },
    null,
    2,
  ),
);
