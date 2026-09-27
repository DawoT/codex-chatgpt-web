import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { loadConfig } from "../../../config";
import { appendChatFirstAuditEntry } from "../chat-first-audit";
import { resolveChatFirstWorkspace } from "../chat-first-environment";
import { workspaceFileCache } from "../fast-path-cache";
import { globalBackgroundTaskManager } from "../background-task-manager";
import {
  handleGrep,
  handleListDir,
  handlePatchFile,
  handleReadFile,
  handleWriteFile,
  handleExecCommand,
  DEFAULT_EXEC_TIMEOUT_MS,
  MAX_EXEC_TIMEOUT_MS,
  MIN_EXEC_TIMEOUT_MS,
  result,
  type FastPathToolResult,
} from "../fast-path-handlers";
import { asMcpResult } from "./results";
import { waitOnTasks } from "./tasks";

export function registerChatFirstTools(
  server: McpServer,
  chatFirstConfig: ReturnType<typeof loadConfig>,
): void {
  if (!chatFirstConfig?.chatFirst?.enabled) return;

  const chatFirstSandboxMode = chatFirstConfig.chatFirst.sandboxMode;
  const chatFirstWritable = chatFirstSandboxMode !== "readOnly";
  const scopeFor = (requested?: string) => resolveChatFirstWorkspace(chatFirstConfig, requested);
  const chatFirstToolResult = (toolName: string, cwd: string, res: FastPathToolResult) =>
    asMcpResult(res, { toolName, workspaceRoot: cwd });
  // Only a completed mutation reaches the audit log; a failed call changed nothing on disk.
  const auditSuccessfulMutation = (tool: string, res: FastPathToolResult, requestedPath: string): void => {
    if (res.isError) return;
    const structured = res.structuredContent;
    appendChatFirstAuditEntry({
      tool,
      path: typeof structured.path === "string" ? structured.path : requestedPath,
      ...(typeof structured.bytes_written === "number" ? { bytes: structured.bytes_written } : {}),
    });
  };

  server.registerTool(
    "codex_read_file",
    {
      title: "Read a chat-first workspace file",
      description: "Read file content directly from the local workspace the operator configured, with no turn to connect. Supports a 1-indexed line offset and a line limit.",
      inputSchema: {
        path: z.string().min(1).max(16_384).describe("Path to the file (relative to the workspace or absolute)."),
        workspace: z.string().max(1_024).optional().describe("Optional configured workspace; omit it to use the default workspace."),
        offset: z.number().int().min(1).default(1).describe("1-indexed line number to start reading from (default: 1)."),
        limit_lines: z.number().int().min(1).max(2_000).default(500).describe("Maximum number of lines to read (default: 500, max: 2000)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async input => {
      const scope = scopeFor(input.workspace);
      const res = handleReadFile({
        path: input.path,
        offset: input.offset,
        limit_lines: input.limit_lines,
        cwd: scope.cwd,
        roots: scope.roots,
        cache: workspaceFileCache,
      });
      return chatFirstToolResult("codex_read_file", scope.cwd, res);
    },
  );

  server.registerTool(
    "codex_list_dir",
    {
      title: "List a chat-first workspace directory",
      description: "List directory contents directly from the configured local workspace, with no turn to connect. Supports traversal depth and entry limits.",
      inputSchema: {
        path: z.string().max(16_384).default(".").describe("Directory path to list (default: the workspace root)."),
        workspace: z.string().max(1_024).optional().describe("Optional configured workspace; omit it to use the default workspace."),
        depth: z.number().int().min(1).max(4).default(1).describe("Maximum directory depth to traverse (default: 1 = immediate children)."),
        limit: z.number().int().min(1).max(500).default(100).describe("Maximum number of entries to return (default: 100, max: 500)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async input => {
      const scope = scopeFor(input.workspace);
      const res = handleListDir({
        path: input.path,
        depth: input.depth,
        limit: input.limit,
        cwd: scope.cwd,
        roots: scope.roots,
      });
      return chatFirstToolResult("codex_list_dir", scope.cwd, res);
    },
  );

  server.registerTool(
    "codex_grep",
    {
      title: "Search a chat-first workspace",
      description: "Fast text search over the configured local workspace using ripgrep, with no turn to connect. Returns matched lines with line numbers.",
      inputSchema: {
        query: z.string().min(1).max(1_000).describe("Search string or regular expression pattern."),
        path: z.string().max(16_384).default(".").describe("Directory or file to search in (default: the workspace root)."),
        workspace: z.string().max(1_024).optional().describe("Optional configured workspace; omit it to use the default workspace."),
        max_results: z.number().int().min(1).max(200).default(50).describe("Maximum matching lines to return (default: 50, max: 200)."),
        case_sensitive: z.boolean().default(false).describe("Whether search is case-sensitive (default: false)."),
        file_pattern: z.string().max(256).optional().describe("Optional glob pattern to filter files (e.g. '*.ts', 'src/**')."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async input => {
      const scope = scopeFor(input.workspace);
      const res = handleGrep({
        query: input.query,
        path: input.path,
        max_results: input.max_results,
        case_sensitive: input.case_sensitive,
        file_pattern: input.file_pattern,
        cwd: scope.cwd,
        roots: scope.roots,
      });
      return chatFirstToolResult("codex_grep", scope.cwd, res);
    },
  );

  server.registerTool(
    "codex_tool_inventory",
    {
      title: "List chat-first workspace tools",
      description: "Return the static chat-first inventory: the active sandbox mode and the tools this connector exposes. No turn connection is involved.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => result({
      contract: "chat-first",
      sandboxMode: chatFirstSandboxMode,
      tools: [
        { name: "codex_read_file", description: "Read a workspace file with line offset and limit." },
        { name: "codex_list_dir", description: "List directory contents with depth and entry limits." },
        { name: "codex_grep", description: "Search workspace file contents with ripgrep." },
        { name: "codex_tool_inventory", description: "Return this inventory with the active sandbox mode." },
        ...(chatFirstWritable ? [
          { name: "codex_write_file", description: "Write a complete file; recorded in the local audit log." },
          { name: "codex_patch_file", description: "Replace an exact text occurrence in a file; recorded in the local audit log." },
          { name: "codex_exec", description: "Run a shell command (tests, builds, git) in the workspace. Supports background=true for async execution." },
          { name: "codex_poll_task", description: "Check status, retrieve output logs, wait, or kill a background task launched with codex_exec(background=true)." },
          { name: "codex_wait_tasks", description: "Wait for background tasks to complete and return compact single-line summaries." },
        ] : []),
      ],
    }),
  );

  if (chatFirstWritable) {
    server.registerTool(
      "codex_write_file",
      {
        title: "Write a chat-first workspace file",
        description: "Write complete text content directly to a file in the configured local workspace; the mutation is recorded in the local audit log. Refuses to clobber an existing file unless overwrite is true.",
        inputSchema: {
          path: z.string().min(1).max(16_384).describe("Path to the file (relative to the workspace or absolute)."),
          content: z.string().min(1).max(5_000_000).describe("Complete text content to write to the file."),
          workspace: z.string().max(1_024).optional().describe("Optional configured workspace; omit it to use the default workspace."),
          overwrite: z.boolean().default(false).describe("Allow replacing an existing file (default: false)."),
          create_parents: z.boolean().default(false).describe("Create missing parent directories (default: false)."),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async input => {
        const scope = scopeFor(input.workspace);
        const res = handleWriteFile({
          path: input.path,
          content: input.content,
          overwrite: input.overwrite,
          create_parents: input.create_parents,
          cwd: scope.cwd,
          roots: scope.roots,
          writableRoots: scope.writableRoots,
          cache: workspaceFileCache,
        });
        auditSuccessfulMutation("codex_write_file", res, input.path);
        return chatFirstToolResult("codex_write_file", scope.cwd, res);
      },
    );

    server.registerTool(
      "codex_patch_file",
      {
        title: "Patch a chat-first workspace file",
        description: "Replace the first exact occurrence of target_content with replacement_content in a configured local workspace file; the mutation is recorded in the local audit log.",
        inputSchema: {
          path: z.string().min(1).max(16_384).describe("Path to the file (relative to the workspace or absolute)."),
          target_content: z.string().min(1).max(1_000_000).describe("Exact text to replace, including whitespace and indentation. Only the first occurrence is replaced."),
          replacement_content: z.string().max(1_000_000).describe("Replacement text; an empty string deletes the matched target."),
          workspace: z.string().max(1_024).optional().describe("Optional configured workspace; omit it to use the default workspace."),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async input => {
        const scope = scopeFor(input.workspace);
        const res = handlePatchFile({
          path: input.path,
          target_content: input.target_content,
          replacement_content: input.replacement_content,
          cwd: scope.cwd,
          roots: scope.roots,
          writableRoots: scope.writableRoots,
          cache: workspaceFileCache,
        });
        auditSuccessfulMutation("codex_patch_file", res, input.path);
        return chatFirstToolResult("codex_patch_file", scope.cwd, res);
      },
    );

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
      async input => {
        const scope = scopeFor(input.workspace);
        if (input.background) {
          const task = globalBackgroundTaskManager.startTask({
            cmd: input.cmd,
            cwd: scope.cwd,
            roots: scope.roots,
            writableRoots: scope.writableRoots,
          });
          const bgPayload = {
            task_id: task.id,
            status: task.status,
            cmd: task.cmd,
            pid: task.pid,
            log_file: task.logFile,
            message: "Command started in background. The web chat does not need to wait. Use codex_poll_task to check results or inspect the log file with codex_read_file.",
          };
          auditSuccessfulMutation("codex_exec", result(bgPayload), input.cmd);
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
        });
        auditSuccessfulMutation("codex_exec", res, input.cmd);
        return chatFirstToolResult("codex_exec", scope.cwd, res);
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
      async input => {
        const scope = scopeFor(input.workspace);
        if (!input.task_id) {
          const tasks = globalBackgroundTaskManager.listTasks().map(t => ({
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
          const killed = globalBackgroundTaskManager.killTask(input.task_id);
          const task = globalBackgroundTaskManager.getTask(input.task_id);
          return chatFirstToolResult("codex_poll_task", scope.cwd, result({
            task_id: input.task_id,
            status: task?.status ?? "not_found",
            killed,
          }));
        }

        const polled = await globalBackgroundTaskManager.pollTask(input.task_id, input.wait_ms ?? 0, input.lines ?? 100);
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
      async input => {
        const scope = scopeFor(input.workspace);
        const rawWait = input.wait_ms ?? 60_000;
        const clampedWait = Math.min(Math.max(rawWait, 0), 90_000);
        const res = await waitOnTasks(input.task_ids, clampedWait, input.lines ?? 30);
        return chatFirstToolResult("codex_wait_tasks", scope.cwd, result(res));
      },
    );
  }
}
