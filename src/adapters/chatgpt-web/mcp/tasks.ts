import type { BackgroundTaskManager } from "../background-task-manager";
import { summarizeTask } from "../task-summaries";

export async function waitOnTasks(
  manager: BackgroundTaskManager,
  taskIds: string[],
  waitMs: number,
  lines = 30,
  options: { ownerId?: string; signal?: AbortSignal } = {},
): Promise<{
  tasks: Array<{
    task_id: string;
    status: string;
    exit_code: number | null;
    summary: string;
    log_path: string;
  }>;
  pending: number;
}> {
  await manager.waitForTasks(taskIds, waitMs, options);

  const results = taskIds.map((id) => {
    const task = manager.getTask(id, options.ownerId);
    if (!task) {
      return {
        task_id: id,
        status: "not_found",
        exit_code: null,
        summary: `Task not found: ${id}`,
        log_path: "",
      };
    }
    const logInfo = manager.getTaskLog(task.id, lines, options.ownerId);
    const summary = summarizeTask(task, logInfo?.logTail ?? "");
    return {
      task_id: task.id,
      status: task.status,
      exit_code: task.exitCode,
      summary,
      log_path: task.fullLogPath,
    };
  });

  const pending = results.filter((r) => r.status === "running" || r.status === "terminating").length;
  return { tasks: results, pending };
}
