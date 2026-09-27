import { globalBackgroundTaskManager } from "../background-task-manager";
import { summarizeTask } from "../task-summaries";

export async function waitOnTasks(taskIds: string[], waitMs: number, lines = 30): Promise<{
  tasks: Array<{
    task_id: string;
    status: string;
    exit_code: number | null;
    summary: string;
    log_path: string;
  }>;
  pending: number;
}> {
  const deadline = Date.now() + Math.max(0, waitMs);
  while (Date.now() < deadline) {
    const running = taskIds
      .map(id => globalBackgroundTaskManager.getTask(id))
      .filter((t): t is NonNullable<typeof t> => t !== undefined && t.status === "running");
    if (running.length === 0) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const slice = Math.min(remaining, 5_000);
    await globalBackgroundTaskManager.pollTask(running[0]!.id, slice, lines);
  }

  const results = taskIds.map(id => {
    const task = globalBackgroundTaskManager.getTask(id);
    if (!task) {
      return {
        task_id: id,
        status: "not_found",
        exit_code: null,
        summary: `Task not found: ${id}`,
        log_path: "",
      };
    }
    const logInfo = globalBackgroundTaskManager.getTaskLog(task.id, lines);
    const summary = summarizeTask(task, logInfo?.logTail ?? "");
    return {
      task_id: task.id,
      status: task.status,
      exit_code: task.exitCode,
      summary,
      log_path: task.fullLogPath,
    };
  });

  const pending = results.filter(r => r.status === "running").length;
  return { tasks: results, pending };
}
