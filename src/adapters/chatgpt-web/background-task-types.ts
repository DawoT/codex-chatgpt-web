import type { ChildProcess } from "node:child_process";
import type { TaskLog } from "./background-task-log";
import type { CommandCgroup } from "./command-cgroup";

export interface BackgroundTask {
  id: string;
  cmd: string;
  cwd: string;
  pid?: number;
  status: "running" | "terminating" | "completed" | "failed" | "killed";
  exitCode: number | null;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  logFile: string;
  fullLogPath: string;
}

export interface TaskWaitOptions {
  ownerId?: string;
  signal?: AbortSignal;
}

export interface TaskRuntimeRecord {
  task: BackgroundTask;
  ownerId?: string;
  child?: ChildProcess;
  cgroup?: CommandCgroup;
  logFd?: number;
  log: TaskLog;
  closed: boolean;
  completionWaiters: Set<() => void>;
  logDeleted?: boolean;
}
