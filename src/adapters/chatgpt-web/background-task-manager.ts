import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";

export interface BackgroundTask {
  id: string;
  cmd: string;
  cwd: string;
  pid?: number;
  status: "running" | "completed" | "failed" | "killed";
  exitCode: number | null;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  logFile: string; // Relative path from cwd
  fullLogPath: string;
}

interface TaskRuntimeRecord {
  task: BackgroundTask;
  child?: ChildProcess;
  logFd?: number;
  completionWaiters: Array<() => void>;
  listenersNotified?: boolean;
  logDeleted?: boolean;
}

export class BackgroundTaskManager {
  private readonly tasks = new Map<string, TaskRuntimeRecord>();
  private readonly maxRetainedTasks = 50;
  private readonly completionListeners: Array<(task: BackgroundTask) => void> = [];
  private maxConcurrentLimit?: number;
  private logRetentionHours?: number;

  startTask(options: {
    cmd: string;
    cwd: string;
    workdir?: string;
    roots: string[];
    writableRoots: string[];
    maxConcurrent?: number;
    logRetentionHours?: number;
  }): BackgroundTask {
    const { cmd, cwd } = options;
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
      const runningCount = Array.from(this.tasks.values()).filter(r => r.task.status === "running").length;
      if (runningCount >= this.maxConcurrentLimit) {
        throw new Error(
          `Background task limit reached: ${runningCount} task(s) running (maxConcurrent=${this.maxConcurrentLimit}). `
            + "Wait for results with codex_poll_task or stop tasks with codex_kill_task, then start again.",
        );
      }
    }
    const taskId = `task_${Date.now()}_${randomBytes(4).toString("hex")}`;
    const taskDir = join(cwd, ".codex-tmp", "tasks");
    mkdirSync(taskDir, { recursive: true });

    const fullLogPath = join(taskDir, `${taskId}.log`);
    const logFd = openSync(fullLogPath, "a");
    const logFile = relative(cwd, fullLogPath);

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
      completionWaiters: [],
    };

    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/bash";
    const shellArgs = process.platform === "win32" ? ["/c", cmd] : ["-c", cmd];

    try {
      const child = spawn(shell, shellArgs, {
        cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", logFd, logFd],
        env: { ...process.env },
      });

      task.pid = child.pid;
      record.child = child;

      child.on("close", (code, signal) => {
        const exitCode = code ?? (signal ? 1 : 0);
        task.exitCode = exitCode;
        if (task.status === "running") {
          task.status = exitCode === 0 ? "completed" : "failed";
        }
        task.completedAt = new Date().toISOString();
        task.durationMs = Date.now() - new Date(task.startedAt).getTime();

        try {
          if (record.logFd !== undefined) {
            closeSync(record.logFd);
            record.logFd = undefined;
          }
        } catch {}

        for (const waiter of record.completionWaiters) {
          try {
            waiter();
          } catch {}
        }
        record.completionWaiters = [];

        if (!record.listenersNotified) {
          record.listenersNotified = true;
          const snapshot: BackgroundTask = { ...task };
          for (const listener of this.completionListeners) {
            try {
              listener(snapshot);
            } catch {}
          }
        }
        this.gcExpiredLogs();
      });

      child.on("error", err => {
        task.status = "failed";
        task.exitCode = 1;
        task.completedAt = new Date().toISOString();
        task.durationMs = Date.now() - new Date(task.startedAt).getTime();
        for (const waiter of record.completionWaiters) {
          try {
            waiter();
          } catch {}
        }
        record.completionWaiters = [];

        if (!record.listenersNotified) {
          record.listenersNotified = true;
          const snapshot: BackgroundTask = { ...task };
          for (const listener of this.completionListeners) {
            try {
              listener(snapshot);
            } catch {}
          }
        }
        this.gcExpiredLogs();
      });

      // Detach from event loop so background task outlives short-lived callers if needed
      if (typeof child.unref === "function") {
        child.unref();
      }
    } catch (err) {
      task.status = "failed";
      task.exitCode = 1;
      task.completedAt = new Date().toISOString();
      task.durationMs = 0;
      try {
        if (record.logFd !== undefined) {
          closeSync(record.logFd);
          record.logFd = undefined;
        }
      } catch {}
    }

    this.tasks.set(taskId, record);
    this.pruneOldTasks();
    return task;
  }

  getTask(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId)?.task;
  }

  listTasks(): BackgroundTask[] {
    return Array.from(this.tasks.values())
      .map(r => r.task)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  killTask(taskId: string): boolean {
    const record = this.tasks.get(taskId);
    if (!record || !record.child || record.task.status !== "running") {
      return false;
    }

    const child = record.child;
    record.task.status = "killed";
    record.task.exitCode = 137;
    record.task.completedAt = new Date().toISOString();
    record.task.durationMs = Date.now() - new Date(record.task.startedAt).getTime();

    try {
      if (process.platform === "win32") {
        child.kill("SIGTERM");
      } else if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        setTimeout(() => {
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {
            try {
              child.kill("SIGKILL");
            } catch {}
          }
        }, 1_500).unref();
      }
    } catch {}

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

  async pollTask(taskId: string, waitMs = 0, lines = 100): Promise<{
    task: BackgroundTask;
    tail: string;
  } | null> {
    const record = this.tasks.get(taskId);
    if (!record) return null;

    if (waitMs > 0 && record.task.status === "running") {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          const idx = record.completionWaiters.indexOf(done);
          if (idx !== -1) record.completionWaiters.splice(idx, 1);
          resolve();
        }, Math.min(waitMs, 30_000));

        const done = () => {
          clearTimeout(timer);
          resolve();
        };

        record.completionWaiters.push(done);
      });
    }

    const tail = this.readLogTail(record.task.fullLogPath, lines);
    return {
      task: record.task,
      tail,
    };
  }

  getTaskLog(taskId: string, lines = 100): { task: BackgroundTask; logTail: string } | null {
    const record = this.tasks.get(taskId);
    if (!record) return null;
    return {
      task: record.task,
      logTail: this.readLogTail(record.task.fullLogPath, lines),
    };
  }

  private readLogTail(filePath: string, maxLines: number): string {
    if (!existsSync(filePath)) return "";
    try {
      const stats = statSync(filePath);
      const readSize = Math.min(stats.size, 128 * 1024); // read last 128KB max
      const fd = openSync(filePath, "r");
      const buffer = Buffer.alloc(readSize);
      try {
        const bytesRead = readFileSync(filePath, "utf8");
        const allLines = bytesRead.split("\n");
        return allLines.slice(-maxLines).join("\n");
      } finally {
        try {
          closeSync(fd);
        } catch {}
      }
    } catch {
      return "";
    }
  }

  private pruneOldTasks(): void {
    this.gcExpiredLogs();
    if (this.tasks.size <= this.maxRetainedTasks) return;
    const sorted = Array.from(this.tasks.entries())
      .filter(([_, r]) => r.task.status !== "running")
      .sort((a, b) => a[1].task.startedAt.localeCompare(b[1].task.startedAt));

    const toDeleteCount = this.tasks.size - this.maxRetainedTasks;
    for (let i = 0; i < Math.min(toDeleteCount, sorted.length); i++) {
      this.tasks.delete(sorted[i]![0]);
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
      if (task.status === "running" || !task.completedAt) continue;
      const completedMs = new Date(task.completedAt).getTime();
      if (!Number.isFinite(completedMs) || completedMs > cutoffMs) continue;
      try {
        if (!existsSync(task.fullLogPath)) {
          record.logDeleted = true;
          continue;
        }
        unlinkSync(task.fullLogPath);
        record.logDeleted = true;
      } catch (err) {
        console.error(`[background-task-manager] failed to prune expired log for task ${task.id} at ${task.fullLogPath}:`, err);
      }
    }
  }
}

export const globalBackgroundTaskManager = new BackgroundTaskManager();
