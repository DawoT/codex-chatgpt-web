import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { realpathSync } from "node:fs";
import type { AppConfig } from "../../../config";
import type { resolveChatFirstWorkspace } from "../chat-first-environment";
import { SharedCommandAdmission } from "../shared-command-admission";
import { BackgroundTaskManager } from "../background-task-manager";
import { workspaceFileCache } from "../fast-path-cache";
import { handleExecCommand, DEFAULT_EXEC_TIMEOUT_MS, MIN_EXEC_TIMEOUT_MS, MAX_EXEC_TIMEOUT_MS, result, type FastPathToolResult } from "../fast-path-handlers";
import type { McpCallResult } from "./types";
import { waitOnTasks } from "./tasks";

export function registerChatFirstTaskTools(server: McpServer, services: {
  config: AppConfig;
  scopeFor: (requested?: string) => ReturnType<typeof resolveChatFirstWorkspace>;
  toolResult: (name: string, cwd: string, result: FastPathToolResult) => McpCallResult;
  audit: (name: string, result: FastPathToolResult, path: string) => void;
}): void {
  const { config: chatFirstConfig, scopeFor, toolResult: chatFirstToolResult, audit: auditMutationOutcome } = services;
  // Keep task visibility local to this MCP process; share only execution capacity.
  const manager = new BackgroundTaskManager();
  const admission = new SharedCommandAdmission(chatFirstConfig.backgroundTasks?.maxConcurrent ?? 8);
  const backgroundLeases = new Map<string, { release: () => void; ownerId: string }>();
  const shutdown = new AbortController();
  const previousClose = server.server.onclose;
  server.server.onclose = () => {
    shutdown.abort(new Error("Chat-First MCP transport closed"));
    for (const [id, lease] of backgroundLeases) {
      manager.killTask(id, lease.ownerId);
    }
    previousClose?.();
  };
  const settleBackgroundLease = (id: string, attempt = 0): void => {
    const lease = backgroundLeases.get(id);
    if (!lease) return;
    try {
      lease.release();
      backgroundLeases.delete(id);
    } catch (error) {
      if (attempt < 4) {
        setTimeout(() => settleBackgroundLease(id, attempt + 1), 100 * (attempt + 1));
      } else {
        console.error(`Chat-First command lease ${id} could not be released: ${String(error)}`);
      }
    }
  };
  manager.onCompletion(task => {
    settleBackgroundLease(task.id);
    workspaceFileCache.clear();
  });
  const ownerFor = (cwd: string) => {
    const canonical = realpathSync(cwd);
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  };

  server.registerTool(
    "codex_exec",
    {
      title: "Run a chat-first shell command",
      description: "Execute a shell command (tests, builds, git, cli) in the configured local workspace; the execution is recorded in the local audit log. Returns stdout, stderr, and exit_code. Set background=true to run asynchronously without waiting.",
      inputSchema: {
        cmd: z.string().min(1).max(32_768).describe("Shell command string to execute."),
        workdir: z.string().max(16_384).optional().describe("Working directory (relative to workspace or absolute). Defaults to workspace root."),
        workspace: z.string().max(1_024).optional().describe("Optional configured workspace; omit it to use the default workspace."),
        background: z.boolean().default(false).optional().describe("If true, runs command asynchronously in background and returns task_id immediately without blocking web chat. Use codex_poll_task to check progress."),
        timeout_ms: z.number().int().min(MIN_EXEC_TIMEOUT_MS).max(MAX_EXEC_TIMEOUT_MS).default(DEFAULT_EXEC_TIMEOUT_MS).optional().describe("Maximum command execution time in milliseconds (for synchronous execution)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input, extra) => {
      const scope = scopeFor(input.workspace);
      const ownerId = ownerFor(scope.cwd);
      const signal = AbortSignal.any([extra.signal, shutdown.signal]);
      signal.throwIfAborted();
      const release = await admission.acquire(signal, !input.background);
      let backgroundOwnsLease = false;
      try {
        signal.throwIfAborted();
        if (input.background) {
          const task = manager.startTask({
            cmd: input.cmd,
            workdir: input.workdir,
            ownerId,
            maxConcurrent: chatFirstConfig.backgroundTasks?.maxConcurrent ?? 8,
            keepAlive: true,
            logRetentionHours: chatFirstConfig.backgroundTasks?.logRetentionHours ?? 48,
            cwd: scope.cwd,
            roots: scope.roots,
            writableRoots: scope.writableRoots,
          });
          if (task.status === "running") {
            backgroundLeases.set(task.id, { release, ownerId });
            backgroundOwnsLease = true;
          }
          workspaceFileCache.clear();
          const bgPayload = {
            task_id: task.id,
            status: task.status,
            cmd: task.cmd,
            pid: task.pid,
            log_file: task.logFile,
            message: "Command started in background. The web chat does not need to wait. Use codex_poll_task to check results or inspect the log file with codex_read_file.",
          };
          auditMutationOutcome("codex_exec", result(bgPayload), input.cmd);
          return chatFirstToolResult("codex_exec", scope.cwd, result(bgPayload));
        }

        // Clamp chat-first command execution to 55s ceiling to prevent OpenAI cloud tunnel deadline retirement
        const requestedTimeout = input.timeout_ms ?? 55_000;
        const safeTimeout = Math.min(requestedTimeout, 55_000);
        const res = await handleExecCommand({
          cmd: input.cmd,
          workdir: input.workdir,
          timeout_ms: safeTimeout,
          cwd: scope.cwd,
          roots: scope.roots,
          writableRoots: scope.writableRoots,
          cache: workspaceFileCache,
          signal,
        });
        auditMutationOutcome("codex_exec", res, input.cmd);
        return chatFirstToolResult("codex_exec", scope.cwd, res);
      } finally {
        if (!backgroundOwnsLease) release();
      }
    },
  );

  server.registerTool(
    "codex_poll_task",
    {
      title: "Poll or manage a background shell task",
      description: "Check status, retrieve output logs, wait for completion, or terminate a background command launched with codex_exec(background=true). If task_id is omitted, lists recent background tasks.",
      inputSchema: {
        task_id: z.string().optional().describe("Task ID to check or manage. If omitted, lists recent background tasks."),
        wait_ms: z.number().int().min(0).max(30_000).default(0).optional().describe("Milliseconds to wait (0-30000) for task to complete before returning (default: 0, non-blocking)."),
        kill: z.boolean().default(false).optional().describe("If true, terminates the running background task."),
        lines: z.number().int().min(1).max(500).default(100).optional().describe("Number of trailing log lines to return (default: 100)."),
        workspace: z.string().max(1_024).optional().describe("Optional configured workspace; omit it to use the default workspace."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) => {
      const scope = scopeFor(input.workspace);
      const ownerId = ownerFor(scope.cwd);
      extra.signal.throwIfAborted();
      if (!input.task_id) {
        const tasks = manager.listTasks(ownerId).map(t => ({
          task_id: t.id,
          cmd: t.cmd,
          status: t.status,
          exit_code: t.exitCode,
          started_at: t.startedAt,
          duration_ms: t.durationMs ?? (Date.now() - new Date(t.startedAt).getTime()),
          log_file: t.logFile,
        }));
        return chatFirstToolResult("codex_poll_task", scope.cwd, result({ tasks }));
      }

      if (input.kill) {
        const killed = manager.killTask(input.task_id, ownerId);
        if (killed) auditMutationOutcome("codex_poll_task", result({ killed }), input.task_id);
        const task = manager.getTask(input.task_id, ownerId);
        return chatFirstToolResult("codex_poll_task", scope.cwd, result({
          task_id: input.task_id,
          status: task?.status ?? "not_found",
          killed,
        }));
      }

      const polled = await manager.pollTask(input.task_id, input.wait_ms ?? 0, input.lines ?? 100, { ownerId, signal: extra.signal });
      if (!polled) {
        return chatFirstToolResult("codex_poll_task", scope.cwd, result({ error: `Task not found: ${input.task_id}` }, true));
      }

      return chatFirstToolResult("codex_poll_task", scope.cwd, result({
        task_id: polled.task.id,
        cmd: polled.task.cmd,
        status: polled.task.status,
        exit_code: polled.task.exitCode,
        duration_ms: polled.task.durationMs ?? (Date.now() - new Date(polled.task.startedAt).getTime()),
        started_at: polled.task.startedAt,
        completed_at: polled.task.completedAt,
        log_file: polled.task.logFile,
        output_tail: polled.tail,
      }));
    },
  );

  server.registerTool(
    "codex_wait_tasks",
    {
      title: "Wait for background tasks and return compact summaries",
      description: "Wait for background command tasks to finish or until wait_ms expires. Returns a compact single-line summary for each task and the count of pending tasks.",
      inputSchema: {
        task_ids: z.array(z.string().min(1)).min(1).max(10).describe("List of 1 to 10 background task IDs to wait for."),
        wait_ms: z.number().int().min(0).max(90_000).default(60_000).optional().describe("Milliseconds to wait for completion (clamped <= 90000, default 60000)."),
        lines: z.number().int().min(1).max(500).default(30).optional().describe("Trailing log lines to inspect for summarizing (default 30)."),
        workspace: z.string().max(1_024).optional().describe("Optional configured workspace; omit it to use the default workspace."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) => {
      const scope = scopeFor(input.workspace);
      const ownerId = ownerFor(scope.cwd);
      extra.signal.throwIfAborted();
      const rawWait = input.wait_ms ?? 60_000;
      const clampedWait = Math.min(Math.max(rawWait, 0), 90_000);
      const res = await waitOnTasks(manager, input.task_ids, clampedWait, input.lines ?? 30, { ownerId, signal: extra.signal });
      return chatFirstToolResult("codex_wait_tasks", scope.cwd, result(res));
    },
  );
}
