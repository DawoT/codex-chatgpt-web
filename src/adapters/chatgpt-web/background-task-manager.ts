import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, realpathSync, statSync } from "node:fs";
import { relative } from "node:path";
import { createTaskLog, readTaskLogTail, removeTaskLog } from "./background-task-log";
import type { BackgroundTask, TaskRuntimeRecord, TaskWaitOptions } from "./background-task-types";
import { waitForTaskRecords } from "./background-task-wait";
import { CGROUP_SHELL_COMMAND, commandCgroupEnv, createCommandCgroup } from "./command-cgroup";
import { assertWritableRootContainment, resolveSafeWorkspacePath } from "./fast-path/sandbox";

export type { BackgroundTask } from "./background-task-types";

export class BackgroundTaskManager {
  private readonly tasks = new Map<string, TaskRuntimeRecord>();
  private readonly maxRetainedTasks = 50;
  private readonly completionListeners: Array<(task: BackgroundTask) => void> = [];
  private maxConcurrentLimit?: number;
  private logRetentionHours?: number;

  startTask(options: {
    cmd: string;
    cwd: string;
    ownerId?: string;
    workdir?: string;
    roots: string[];
    writableRoots: string[];
    maxConcurrent?: number;
    keepAlive?: boolean;
    logRetentionHours?: number;
  }): BackgroundTask {
    const { cmd } = options;
    const requestedCwd = resolveSafeWorkspacePath(options.workdir?.trim() || ".", options.cwd, options.roots);
    assertWritableRootContainment(requestedCwd, requestedCwd, options.writableRoots);
    const cwd = realpathSync(requestedCwd);
    if (!statSync(cwd).isDirectory()) throw new Error("Task workdir must be a directory");
    if (options.maxConcurrent !== undefined) {
      if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
        throw new Error(`Invalid maxConcurrent ${options.maxConcurrent}; it must be an integer >= 1`);
      }
      this.maxConcurrentLimit = options.maxConcurrent;
    }
    if (options.logRetentionHours !== undefined) {
      if (!Number.isInteger(options.logRetentionHours) || options.logRetentionHours < 1) {
        throw new Error(`Invalid logRetentionHours ${options.logRetentionHours}; it must be an integer >= 1`);
      }
      this.logRetentionHours = options.logRetentionHours;
    }
    if (this.maxConcurrentLimit !== undefined) {
      const runningCount = Array.from(this.tasks.values()).filter((r) => !r.closed).length;
      if (runningCount >= this.maxConcurrentLimit) {
        throw new Error(
          `Background task limit reached: ${runningCount} task(s) running (maxConcurrent=${this.maxConcurrentLimit}). ` +
            "Wait for results with codex_poll_task or stop tasks with codex_kill_task, then start again.",
        );
      }
    }
    this.pruneOldTasks(this.maxRetainedTasks - 1);
    if (this.tasks.size >= this.maxRetainedTasks) {
      throw new Error("Background task retention limit reached; owned logs could not be reclaimed");
    }
    const taskId = `task_${Date.now()}_${randomBytes(4).toString("hex")}`;
    const log = createTaskLog(cwd, taskId);
    const fullLogPath = log.path;
    const logFd = log.fd;
    const logFile = relative(options.cwd, fullLogPath);

    const startedAt = new Date().toISOString();
    const task: BackgroundTask = {
      id: taskId,
      cmd,
      cwd,
      status: "running",
      exitCode: null,
      startedAt,
      logFile,
      fullLogPath,
    };

    const record: TaskRuntimeRecord = {
      task,
      logFd,
      log,
      ownerId: options.ownerId,
      closed: false,
      completionWaiters: new Set(),
    };

    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/bash";
    const cgroup = createCommandCgroup();
    record.cgroup = cgroup;
    const shellArgs = process.platform === "win32" ? ["/c", cmd] : ["-c", cgroup ? CGROUP_SHELL_COMMAND : cmd];

    try {
      const child = spawn(shell, shellArgs, {
        cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", logFd, logFd],
        env: { ...process.env, ...(cgroup ? commandCgroupEnv(cgroup, cmd) : {}) },
      });

      task.pid = child.pid;
      record.child = child;

      child.on("close", (code, signal) => {
        this.finishTask(record, code ?? (signal ? 1 : 0));
      });
      child.on("error", () => {
        this.finishTask(record, 1);
      });

      // Detach from event loop so background task outlives short-lived callers if needed
      if (!options.keepAlive && typeof child.unref === "function") {
        child.unref();
      }
    } catch {
      this.finishTask(record, 1);
    }

    this.tasks.set(taskId, record);
    this.pruneOldTasks();
    return task;
  }

  getTask(taskId: string, ownerId?: string): BackgroundTask | undefined {
    return this.ownedRecord(taskId, ownerId)?.task;
  }

  listTasks(ownerId?: string): BackgroundTask[] {
    return Array.from(this.tasks.values())
      .filter((record) => record.ownerId === ownerId)
      .map((r) => r.task)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  killTask(taskId: string, ownerId?: string): boolean {
    const record = this.ownedRecord(taskId, ownerId);
    if (!record?.child || record.task.status !== "running") {
      return false;
    }

    const child = record.child;
    // An explicit kill is forceful: do not leave an escalation timer targeting a recycled PID.
    const cgroupSignalled = record.cgroup?.kill() ?? false;
    try {
      if (process.platform === "win32") {
        if (!child.kill("SIGKILL")) return false;
      } else if (child.pid) {
        process.kill(-child.pid, "SIGKILL");
      } else if (!cgroupSignalled) {
        return false;
      }
    } catch {
      if (!cgroupSignalled) return false;
    }
    record.task.status = "terminating";

    this.gcExpiredLogs();
    return true;
  }

  /**
   * Registers a listener invoked once per finished task (status completed/failed/killed) with a
   * snapshot of the task record. Listeners run individually guarded: one that throws does not
   * affect the others or the manager. Returns an unsubscribe function.
   */
  onCompletion(listener: (task: BackgroundTask) => void): () => void {
    this.completionListeners.push(listener);
    return () => {
      const idx = this.completionListeners.indexOf(listener);
      if (idx !== -1) this.completionListeners.splice(idx, 1);
    };
  }

  async waitForTasks(taskIds: string[], waitMs: number, options: TaskWaitOptions = {}): Promise<void> {
    const records = [...new Set(taskIds)]
      .map((id) => this.ownedRecord(id, options.ownerId))
      .filter((record): record is TaskRuntimeRecord => record !== undefined);
    await waitForTaskRecords(records, waitMs, options.signal);
  }

  async pollTask(
    taskId: string,
    waitMs = 0,
    lines = 100,
    options: TaskWaitOptions = {},
  ): Promise<{
    task: BackgroundTask;
    tail: string;
  } | null> {
    options.signal?.throwIfAborted();
    const record = this.ownedRecord(taskId, options.ownerId);
    if (!record) return null;
    await waitForTaskRecords([record], Math.min(waitMs, 30_000), options.signal);
    return { task: record.task, tail: readTaskLogTail(record.log, lines) };
  }

  getTaskLog(taskId: string, lines = 100, ownerId?: string): { task: BackgroundTask; logTail: string } | null {
    const record = this.ownedRecord(taskId, ownerId);
    if (!record) return null;
    return { task: record.task, logTail: readTaskLogTail(record.log, lines) };
  }

  private ownedRecord(taskId: string, ownerId?: string): TaskRuntimeRecord | undefined {
    const record = this.tasks.get(taskId);
    return record?.ownerId === ownerId ? record : undefined;
  }

  private finishTask(record: TaskRuntimeRecord, exitCode: number): void {
    if (record.closed) return;
    record.cgroup?.kill();
    record.cgroup?.release();
    record.closed = true;
    const { task } = record;
    if (task.status === "terminating") {
      task.status = "killed";
      task.exitCode = 137;
    } else {
      task.exitCode = exitCode;
      task.status = exitCode === 0 ? "completed" : "failed";
    }
    task.completedAt = new Date().toISOString();
    task.durationMs = Date.now() - new Date(task.startedAt).getTime();
    if (record.logFd !== undefined) {
      try {
        closeSync(record.logFd);
      } catch {}
      record.logFd = undefined;
    }
    for (const waiter of [...record.completionWaiters]) waiter();
    record.completionWaiters.clear();
    for (const listener of [...this.completionListeners]) {
      try {
        listener({ ...task });
      } catch {}
    }
    this.gcExpiredLogs();
  }

  private pruneOldTasks(target = this.maxRetainedTasks): void {
    this.gcExpiredLogs();
    if (this.tasks.size <= target) return;
    const sorted = Array.from(this.tasks.entries())
      .filter(([_, r]) => r.closed)
      .sort((a, b) => a[1].task.startedAt.localeCompare(b[1].task.startedAt));

    for (const [id, record] of sorted) {
      if (this.tasks.size <= target) break;
      if (record.logDeleted || removeTaskLog(record.log)) this.tasks.delete(id);
    }
  }

  /**
   * Deletes log files of finished tasks whose completedAt is older than logRetentionHours.
   * No-op when no retention was configured. Running tasks (and tasks without a completedAt)
   * are never touched; unlink failures fail open with console.error.
   */
  private gcExpiredLogs(): void {
    const retentionHours = this.logRetentionHours;
    if (retentionHours === undefined) return;
    const cutoffMs = Date.now() - retentionHours * 3_600_000;
    for (const record of this.tasks.values()) {
      if (record.logDeleted) continue;
      const { task } = record;
      if (!record.closed || !task.completedAt) continue;
      const completedMs = new Date(task.completedAt).getTime();
      if (!Number.isFinite(completedMs) || completedMs > cutoffMs) continue;
      record.logDeleted = removeTaskLog(record.log);
    }
  }
}
