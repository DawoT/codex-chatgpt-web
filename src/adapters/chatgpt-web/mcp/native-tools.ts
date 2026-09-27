import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { loadConfig } from "../../../config";
import { globalBackgroundTaskManager } from "../background-task-manager";
import { summarizeTask } from "../task-summaries";
import { workspaceFileCache } from "../fast-path-cache";
import { CODEX_COMPACTION_CONTROL_WIRE_NAME } from "../native-compaction-control";
import type { TaskCompletionPayload } from "../task-resume-orchestrator";
import { callTurnBroker } from "../turn-broker";
import {
  handleGrep,
  handleListDir,
  handlePatchFile,
  handleReadFile,
  handleWriteFile,
  resolveSafeWorkspacePath,
  result,
} from "../fast-path-handlers";
import {
  execCommandGatewayProgram,
  execGatewayProgram,
  gatewayToolCatalogPage,
  gatewayToolCatalogProgram,
  gatewayToolDescription,
  transportBoundRawExecProgram,
} from "./gateway-programs";
import {
  afterSafeStart,
  CHATGPT_WEB_AGENT_WAIT_POLL_MS,
} from "./instructions";
import { asMcpResult, chatGptMcpInvocationTimeout } from "./results";
import { waitOnTasks } from "./tasks";
import {
  assertBrowserToolArguments,
  assertGatewayToolArguments,
  browserToolDescription,
  browserToolParameters,
  exactTool,
  execGateway,
  gatewayToolNameIsValid,
  isGatewayAgentWaitTool,
  jsonArgumentsSchema,
  requestScopeSummary,
  safeVisibleTools,
  turnReference,
  turnReferenceInput,
  turnTokenSchema,
  wireName,
} from "./tool-visibility";
import type { TurnCoordinator } from "./turn-coordinator";

export function registerNativeAndSafeTools(
  server: McpServer,
  coordinator: TurnCoordinator,
): void {
  const contract = coordinator.contract;

  if (contract === "safe") {
    server.registerTool(
      "codex_turn_start",
      {
        title: "Connect a Codex Zero Risk request",
        description: "Connect the request_id included in the pasted Codex Web GPT request so its Codex tools can be used.",
        inputSchema: {
          request_id: turnTokenSchema,
        },
        outputSchema: {
          started: z.literal(true),
          duplicate: z.boolean(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ request_id }, extra) => {
        console.error(`[chatgpt-web-mcp] codex_turn_start scope=${requestScopeSummary(extra)}`);
        const response = await callTurnBroker<{ started: true; duplicate: boolean }>(coordinator.brokerSocketPath, {
          method: "safe_start",
          token: request_id,
        }, 5_000, extra.signal);
        return result(response);
      },
    );
  }

  if (contract !== "chat-first") {
    server.registerTool(
      "codex_exec",
      {
        title: "Run a native Codex command",
        description: afterSafeStart(contract, "Invoke the command tool advertised by the current outer Codex harness. A long-running command returns its native session_id."),
        inputSchema: {
          ...turnReferenceInput(contract),
          cmd: z.string().min(1).max(100_000),
          workdir: z.string().max(16_384).optional(),
          background: z.boolean().default(false).optional()
            .describe("If true, runs command asynchronously in background and returns task_id immediately. Use codex_wait_tasks to pause until finished."),
          yield_time_ms: z.number().int().min(250).max(30_000).optional(),
          max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
          tty: z.boolean().optional(),
          sandbox_permissions: z.enum(["use_default", "require_escalated"]).optional()
            .describe("Native Codex sandbox request, only when the current command tool supports it. Codex decides whether to approve."),
          justification: z.string().optional()
            .describe("Approval question for a native require_escalated request; omit otherwise."),
          prefix_rule: z.array(z.string()).optional()
            .describe("Optional native approval prefix for require_escalated; Codex owns its approval and persistence."),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      async (input, extra) => coordinator.withClaimedTurn(
        "codex_exec",
        turnReference(contract, input),
        extra,
        async claimed => {
          const { cmd, workdir, background, yield_time_ms, max_output_tokens, tty, sandbox_permissions, justification, prefix_rule } = input;
          const bound = claimed.environment;

          if (background) {
            const policyType = bound.sandboxPolicy.type;
            if (policyType !== "dangerFullAccess" && policyType !== "workspaceWrite") {
              throw new Error("background requires write-capable sandbox");
            }
            const targetCwd = workdir ? resolveSafeWorkspacePath(workdir, bound.cwd, bound.roots) : bound.cwd;
            const task = globalBackgroundTaskManager.startTask({
              cmd,
              cwd: targetCwd,
              roots: bound.roots,
              writableRoots: bound.writableRoots,
            });

            const traceId = claimed.traceId;
            const turnToken = turnReference(contract, input);
            const unsubscribe = globalBackgroundTaskManager.onCompletion(async completedTask => {
              if (completedTask.id !== task.id) return;
              unsubscribe();
              try {
                const logInfo = globalBackgroundTaskManager.getTaskLog(task.id, 50);
                const summary = summarizeTask(completedTask, logInfo?.logTail ?? "");
                const envPort = Number(process.env.CODEX_CHATGPT_WEB_PORT);
                let daemonPort = Number.isInteger(envPort) && envPort > 0 ? envPort : undefined;
                if (!daemonPort) {
                  try {
                    daemonPort = loadConfig().port;
                  } catch {}
                }
                daemonPort ??= 17841;
                const payload: TaskCompletionPayload = {
                  source: "chatgpt-web-mcp",
                  task: {
                    id: completedTask.id,
                    cmd: completedTask.cmd,
                    cwd: completedTask.cwd,
                    status: completedTask.status === "running" ? "completed" : completedTask.status,
                    exitCode: completedTask.exitCode,
                    startedAt: completedTask.startedAt,
                    completedAt: completedTask.completedAt ?? new Date().toISOString(),
                    logPath: completedTask.fullLogPath,
                  },
                  summary,
                  ...(traceId ? { traceId } : {}),
                  turnToken,
                };
                await fetch(`http://127.0.0.1:${daemonPort}/internal/tasks/completed`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(payload),
                });
              } catch {
                // fire-and-forget: notification failure never throws
              }
            });

            const ack = {
              task_id: task.id,
              status: task.status,
              cmd: task.cmd,
              pid: task.pid,
              log_path: task.fullLogPath,
              message: "Command started in background. Use codex_wait_tasks to wait for completion or codex_read_file to view the log.",
            };
            workspaceFileCache.clear();
            return result(ack);
          }

          const requestedTimeoutMs = yield_time_ms !== undefined ? yield_time_ms + 15_000 : undefined;
          const permissions = {
            ...(sandbox_permissions !== undefined ? { sandbox_permissions } : {}),
            ...(justification !== undefined ? { justification } : {}),
            ...(prefix_rule !== undefined ? { prefix_rule } : {}),
          };
          const execCommandArguments = {
            cmd,
            ...(workdir ? { workdir } : {}),
            ...(yield_time_ms !== undefined ? { yield_time_ms } : {}),
            ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
            ...(tty !== undefined ? { tty } : {}),
            ...permissions,
          };
          const shellCommandArguments = {
            command: cmd,
            ...(workdir ? { workdir } : {}),
            ...(yield_time_ms !== undefined ? { timeout_ms: yield_time_ms } : {}),
            ...permissions,
          };
          const tool = exactTool(bound, "exec_command") ?? exactTool(bound, "shell_command");
          if (tool) {
            // Never silently discard an approval request on a native registry that cannot express it.
            const properties = tool.parameters.properties;
            for (const key of Object.keys(permissions)) {
              if (!properties || typeof properties !== "object" || !Object.hasOwn(properties, key)) {
                throw new Error(`The current native ${tool.name} tool does not support ${key}`);
              }
            }
            const args = tool.name === "exec_command" ? execCommandArguments : shellCommandArguments;
            const res = await coordinator.invoke(claimed.bindingId, bound, tool, { arguments: args }, extra.signal, requestedTimeoutMs);
            workspaceFileCache.clear();
            return res;
          }
          const gateway = execGateway(bound);
          if (!gateway) {
            throw new Error("This Codex turn did not advertise a native command tool or the native exec gateway");
          }
          const res = await coordinator.invoke(claimed.bindingId, bound, gateway, {
            input: execCommandGatewayProgram(execCommandArguments, shellCommandArguments),
          }, extra.signal, requestedTimeoutMs);
          workspaceFileCache.clear();
          return res;
        },
      ),
    );

    server.registerTool(
      "codex_wait_tasks",
      {
        title: "Wait for background tasks and return compact summaries",
        description: afterSafeStart(contract, "Wait for background command tasks to finish or until wait_ms expires. Returns a compact single-line summary for each task and the count of pending tasks."),
        inputSchema: {
          ...turnReferenceInput(contract),
          task_ids: z.array(z.string().min(1)).min(1).max(10).describe("List of 1 to 10 background task IDs to wait for."),
          wait_ms: z.number().int().min(0).max(90_000).default(60_000).optional().describe("Milliseconds to wait for completion (clamped <= 90000, default 60000)."),
          lines: z.number().int().min(1).max(500).default(30).optional().describe("Trailing log lines to inspect for summarizing (default 30)."),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (input, extra) => coordinator.withClaimedTurn(
        "codex_wait_tasks",
        turnReference(contract, input),
        extra,
        async claimed => {
          const rawWait = input.wait_ms ?? 60_000;
          const clampedWait = Math.min(Math.max(rawWait, 0), 90_000);
          const effectiveWaitMs = Math.min(
            clampedWait,
            chatGptMcpInvocationTimeout(claimed.environment, Date.now(), clampedWait),
          );
          const res = await waitOnTasks(input.task_ids, effectiveWaitMs, input.lines ?? 30);
          return result(res);
        },
      ),
    );

    server.registerTool(
      "codex_write_stdin",
      {
        title: "Continue a native Codex command session",
        description: afterSafeStart(contract, "Write characters to, or poll, a session_id returned by codex_exec."),
        inputSchema: {
          ...turnReferenceInput(contract),
          session_id: z.number().int().nonnegative(),
          chars: z.string().max(1_000_000).optional(),
          yield_time_ms: z.number().int().min(250).max(300_000).optional(),
          max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      async (input, extra) => coordinator.withClaimedTurn(
        "codex_write_stdin",
        turnReference(contract, input),
        extra,
        async claimed => {
          const { session_id, chars, yield_time_ms, max_output_tokens } = input;
          const bound = claimed.environment;
          const requestedTimeoutMs = yield_time_ms !== undefined ? yield_time_ms + 15_000 : undefined;
          const tool = exactTool(bound, "write_stdin");
          const payload = { arguments: {
            session_id,
            ...(chars !== undefined ? { chars } : {}),
            ...(yield_time_ms !== undefined ? { yield_time_ms } : {}),
            ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
          } };
          const res = await (tool
            ? coordinator.invoke(claimed.bindingId, bound, tool, payload, extra.signal, requestedTimeoutMs)
            : coordinator.invokeNestedNative(claimed.bindingId, bound, "write_stdin", false, payload, extra.signal, requestedTimeoutMs));
          if (chars !== undefined) {
            workspaceFileCache.clear();
          }
          return res;
        },
      ),
    );

    server.registerTool(
      "codex_apply_patch",
      {
        title: "Apply a native Codex patch",
        description: afterSafeStart(contract, "Invoke the outer Codex apply_patch tool, producing a native file-change item in the Codex task."),
        inputSchema: { ...turnReferenceInput(contract), patch: z.string().min(1).max(5_000_000) },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async (input, extra) => coordinator.withClaimedTurn(
        "codex_apply_patch",
        turnReference(contract, input),
        extra,
        async claimed => {
          const { patch } = input;
          const bound = claimed.environment;
          const tool = exactTool(bound, "apply_patch");
          let res;
          if (!tool) {
            res = await coordinator.invokeNestedNative(claimed.bindingId, bound, "apply_patch", true, { input: patch }, extra.signal);
          } else {
            res = tool.freeform
              ? await coordinator.invoke(claimed.bindingId, bound, tool, { input: patch }, extra.signal)
              : await coordinator.invoke(claimed.bindingId, bound, tool, { arguments: { input: patch } }, extra.signal);
          }
          workspaceFileCache.clear();
          return res;
        },
      ),
    );

    server.registerTool(
      "codex_view_image",
      {
        title: "View an image through native Codex",
        description: afterSafeStart(contract, "Invoke the outer Codex view_image tool and return its multimodal result to this same ChatGPT response."),
        inputSchema: {
          ...turnReferenceInput(contract),
          path: z.string().min(1).max(16_384),
          detail: z.enum(["high", "original"]).optional(),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (input, extra) => coordinator.withClaimedTurn(
        "codex_view_image",
        turnReference(contract, input),
        extra,
        async claimed => {
          const { path, detail } = input;
          const bound = claimed.environment;
          const tool = exactTool(bound, "view_image");
          const payload = { arguments: { path, ...(detail ? { detail } : {}) } };
          return tool
            ? coordinator.invoke(claimed.bindingId, bound, tool, payload, extra.signal)
            : coordinator.invokeNestedNative(claimed.bindingId, bound, "view_image", false, payload, extra.signal);
        },
      ),
    );

    server.registerTool(
      "codex_read_file",
      {
        title: "Read a file directly from the workspace",
        description: afterSafeStart(
          contract,
          "Read file content directly from the workspace filesystem without shell overhead. Supports line offset and limit.",
        ),
        inputSchema: {
          ...turnReferenceInput(contract),
          path: z.string().min(1).max(16_384).describe("Path to the file (relative to working directory or absolute within sandbox roots)."),
          offset: z.number().int().min(1).default(1).optional().describe("1-indexed line number to start reading from (default: 1)."),
          limit_lines: z.number().int().min(1).max(2_000).default(500).optional().describe("Maximum number of lines to read (default: 500, max: 2000)."),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (input, extra) => coordinator.withClaimedTurn(
        "codex_read_file",
        turnReference(contract, input),
        extra,
        claimed => {
          const { path, offset, limit_lines } = input;
          const bound = claimed.environment;
          const res = handleReadFile({ path, offset, limit_lines, cwd: bound.cwd, roots: bound.roots, cache: workspaceFileCache });
          return asMcpResult(res, { toolName: "codex_read_file", workspaceRoot: bound.cwd });
        },
      ),
    );

    server.registerTool(
      "codex_write_file",
      {
        title: "Write a file directly to the workspace",
        description: afterSafeStart(
          contract,
          "Write complete text content directly to a workspace file without shell overhead. Refuses to clobber an existing file unless overwrite is true.",
        ),
        inputSchema: {
          ...turnReferenceInput(contract),
          path: z.string().min(1).max(16_384).describe("Path to the file (relative to working directory or absolute within sandbox roots)."),
          content: z.string().min(1).max(5_000_000).describe("Complete text content to write to the file."),
          overwrite: z.boolean().default(false).optional().describe("Allow replacing an existing file (default: false)."),
          create_parents: z.boolean().default(false).optional().describe("Create missing parent directories (default: false)."),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async (input, extra) => coordinator.withClaimedTurn(
        "codex_write_file",
        turnReference(contract, input),
        extra,
        claimed => {
          const { path, content, overwrite, create_parents } = input;
          const bound = claimed.environment;
          const res = handleWriteFile({ path, content, overwrite, create_parents, cwd: bound.cwd, roots: bound.roots, writableRoots: bound.writableRoots ?? bound.roots, cache: workspaceFileCache });
          return asMcpResult(res, { toolName: "codex_write_file", workspaceRoot: bound.cwd });
        },
      ),
    );

    server.registerTool(
      "codex_patch_file",
      {
        title: "Patch a workspace file in place",
        description: afterSafeStart(
          contract,
          "Replace the first exact occurrence of target_content with replacement_content in a workspace file without shell overhead.",
        ),
        inputSchema: {
          ...turnReferenceInput(contract),
          path: z.string().min(1).max(16_384).describe("Path to the file (relative to working directory or absolute within sandbox roots)."),
          target_content: z.string().min(1).max(1_000_000).describe("Exact text to replace, including whitespace and indentation. Only the first occurrence is replaced."),
          replacement_content: z.string().max(1_000_000).describe("Replacement text; an empty string deletes the matched target."),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async (input, extra) => coordinator.withClaimedTurn(
        "codex_patch_file",
        turnReference(contract, input),
        extra,
        claimed => {
          const { path, target_content, replacement_content } = input;
          const bound = claimed.environment;
          const res = handlePatchFile({ path, target_content, replacement_content, cwd: bound.cwd, roots: bound.roots, writableRoots: bound.writableRoots ?? bound.roots, cache: workspaceFileCache });
          return asMcpResult(res, { toolName: "codex_patch_file", workspaceRoot: bound.cwd });
        },
      ),
    );

    server.registerTool(
      "codex_list_dir",
      {
        title: "List directory contents directly",
        description: afterSafeStart(
          contract,
          "List directory contents directly from the filesystem without shell overhead. Supports depth and entry limits.",
        ),
        inputSchema: {
          ...turnReferenceInput(contract),
          path: z.string().max(16_384).default(".").optional().describe("Directory path to list (default: current working directory)."),
          depth: z.number().int().min(1).max(4).default(1).optional().describe("Maximum directory depth to traverse (default: 1 = immediate children)."),
          limit: z.number().int().min(1).max(500).default(100).optional().describe("Maximum number of entries to return (default: 100, max: 500)."),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (input, extra) => coordinator.withClaimedTurn(
        "codex_list_dir",
        turnReference(contract, input),
        extra,
        claimed => {
          const { path, depth, limit } = input;
          const bound = claimed.environment;
          const res = handleListDir({ path, depth, limit, cwd: bound.cwd, roots: bound.roots });
          return asMcpResult(res, { toolName: "codex_list_dir", workspaceRoot: bound.cwd });
        },
      ),
    );

    server.registerTool(
      "codex_grep",
      {
        title: "Search file contents directly",
        description: afterSafeStart(
          contract,
          "Fast workspace text search using ripgrep without shell overhead. Returns matched lines with line numbers.",
        ),
        inputSchema: {
          ...turnReferenceInput(contract),
          query: z.string().min(1).max(1_000).describe("Search string or regular expression pattern."),
          path: z.string().max(16_384).default(".").optional().describe("Directory or file to search in (default: current working directory)."),
          max_results: z.number().int().min(1).max(200).default(50).optional().describe("Maximum matching lines to return (default: 50, max: 200)."),
          case_sensitive: z.boolean().default(false).optional().describe("Whether search is case-sensitive (default: false)."),
          file_pattern: z.string().max(256).optional().describe("Optional glob pattern to filter files (e.g. '*.ts', 'src/**')."),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (input, extra) => coordinator.withClaimedTurn(
        "codex_grep",
        turnReference(contract, input),
        extra,
        claimed => {
          const { query, path, max_results, case_sensitive, file_pattern } = input;
          const bound = claimed.environment;
          const res = handleGrep({ query, path, max_results, case_sensitive, file_pattern, cwd: bound.cwd, roots: bound.roots });
          return asMcpResult(res, { toolName: "codex_grep", workspaceRoot: bound.cwd });
        },
      ),
    );

    server.registerTool(
      "codex_tool_inventory",
      {
        title: "Discover tools from the current Codex harness",
        description: contract === "safe"
          ? "List tools available to the connected Zero Risk request, including configured MCP and app tools."
          : "Search the exact tool registry supplied to the current outer Codex turn, including configured MCP/app tools.",
        inputSchema: {
          ...turnReferenceInput(contract),
          query: z.string().max(500).optional(),
          offset: z.number().int().min(0).max(100_000).default(0),
          limit: z.number().int().min(1).max(50).default(20),
          include_schema: z.boolean().default(true),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (input, extra) => coordinator.withClaimedTurn(
        "codex_tool_inventory",
        turnReference(contract, input),
        extra,
        async claimed => {
          const { query, offset, limit, include_schema } = input;
          const bound = claimed.environment;
          const needle = query?.trim().toLowerCase();
          const visibleTools = safeVisibleTools(bound, contract);
          const directMatches = visibleTools.filter(tool => !needle || [
            wireName(tool),
            tool.name,
            tool.namespace ?? "",
            tool.description,
          ].join("\n").toLowerCase().includes(needle));
          const directPage = directMatches.slice(offset, offset + limit).map(tool => ({
            wire_name: wireName(tool),
            name: tool.name,
            namespace: tool.namespace ?? null,
            description: browserToolDescription(tool),
            kind: tool.freeform ? "freeform" : tool.toolSearch ? "tool_search" : "function",
            ...(include_schema ? { parameters: browserToolParameters(tool) } : {}),
          }));
          let nestedTotal = 0;
          let nestedPage: Array<Record<string, unknown>> = [];
          const gateway = execGateway(bound);
          if (gateway) {
            const excludedGatewayNames = bound.tools.map(wireName);
            const nestedOffset = Math.max(0, offset - directMatches.length);
            const nestedLimit = Math.max(0, limit - directPage.length);
            const response = await coordinator.invoke(claimed.bindingId, bound, gateway, {
              input: gatewayToolCatalogProgram({
                query,
                offset: nestedOffset,
                limit: nestedLimit,
                // A gateway-discovered entry may supplement the outer registry, but it must never
                // duplicate or reopen an outer tool that this contract deliberately hid (including
                // our own MCP namespace in Zero Risk).
                excludedNames: excludedGatewayNames,
              }),
            }, extra.signal);
            const catalog = gatewayToolCatalogPage(response, new Set(excludedGatewayNames));
            nestedTotal = catalog.total;
            nestedPage = catalog.tools.map(tool => ({
              wire_name: tool.name,
              name: tool.name,
              namespace: null,
              description: gatewayToolDescription(tool),
              kind: "gateway",
              ...(include_schema ? {
                parameters: {
                  type: "object",
                  additionalProperties: true,
                  description: "Pass the exact structured arguments declared in this tool's description. For a declared freeform tool, use codex_tool_call.input instead.",
                },
              } : {}),
            }));
          }
          const page = [...directPage, ...nestedPage];
          const total = directMatches.length + nestedTotal;
          // A filtered registry miss does not mean deferred tools are unavailable. Expose the
          // actual native discovery entry separately; it is not a query match or an automatic call.
          const discoveryTools = needle && total === 0
            ? visibleTools.filter(tool => tool.toolSearch).map(tool => ({
              wire_name: wireName(tool),
              name: tool.name,
              namespace: tool.namespace ?? null,
              description: browserToolDescription(tool),
              kind: "tool_search",
              ...(include_schema ? { parameters: browserToolParameters(tool) } : {}),
            }))
            : [];
          return result({
            tools: page,
            total,
            next_offset: offset + page.length < total ? offset + page.length : null,
            ...(discoveryTools.length > 0 ? { discovery_tools: discoveryTools } : {}),
          });
        },
      ),
    );

    server.registerTool(
      "codex_tool_call",
      {
        title: "Call any tool from the current Codex harness",
        description: afterSafeStart(contract, [
          "Invoke an exact wire_name returned by codex_tool_inventory. The outer Codex runtime performs the call, approvals, and UI lifecycle.",
          ...(contract === "native" ? [
            `A pending context-compaction request can also provide the reserved ${CODEX_COMPACTION_CONTROL_WIRE_NAME} operation, which is not listed by inventory.`,
            "Use only that request's issued control token and arguments {handoff_id, summary}. This operation submits the conversation summary to the pending Codex task; it does not execute commands, access files, or invoke other tools.",
          ] : []),
        ].join(" ")),
        inputSchema: {
          ...turnReferenceInput(contract),
          wire_name: z.string().min(1).max(1_000),
          arguments: jsonArgumentsSchema.optional(),
          input: z.string().max(5_000_000).optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      async (toolInput, extra) => {
        const { wire_name, arguments: args, input } = toolInput;
        const requestId = turnReference(contract, toolInput);
        if (contract === "native" && wire_name === CODEX_COMPACTION_CONTROL_WIRE_NAME) {
          if (input !== undefined) {
            throw new Error("Compaction control handoff does not accept freeform input");
          }
          const handoffId = args?.handoff_id;
          const summary = args?.summary;
          if (typeof handoffId !== "string" || handoffId.length === 0) {
            throw new Error("Compaction control handoff requires handoff_id");
          }
          if (typeof summary !== "string") {
            throw new Error("Compaction control handoff requires summary");
          }
          await callTurnBroker(coordinator.brokerSocketPath, {
            method: "submit_compaction_handoff",
            token: requestId,
            handoffId,
            summary,
          }, 5_000, extra.signal);
          return result({ submitted: true });
        }
        return coordinator.withClaimedTurn("codex_tool_call", requestId, extra, async claimed => {
          const bound = claimed.environment;
          const tool = safeVisibleTools(bound, contract)
            .find(candidate => wireName(candidate) === wire_name);
          if (!tool) {
            const gateway = execGateway(bound);
            const hiddenOuterTool = bound.tools.some(candidate => wireName(candidate) === wire_name);
            if (!gateway || hiddenOuterTool || !gatewayToolNameIsValid(wire_name)) {
              throw new Error(`Codex tool is not available in this turn: ${wire_name}`);
            }
            if (input !== undefined && args && Object.keys(args).length > 0) {
              throw new Error(`Codex nested tool ${wire_name} accepts either arguments or freeform input, not both`);
            }
            if (isGatewayAgentWaitTool(wire_name) && input !== undefined) {
              throw new Error(`ChatGPT Web wait_agent requires structured arguments and timeout_ms=${CHATGPT_WEB_AGENT_WAIT_POLL_MS}`);
            }
            const invocationArguments = args ?? {};
            assertGatewayToolArguments(wire_name, invocationArguments);
            const requested = typeof invocationArguments.yield_time_ms === "number"
              ? invocationArguments.yield_time_ms
              : (typeof invocationArguments.timeout_ms === "number" ? invocationArguments.timeout_ms : undefined);
            const requestedTimeoutMs = requested !== undefined ? requested + 15_000 : undefined;
            return coordinator.invoke(claimed.bindingId, bound, gateway, {
              input: execGatewayProgram(wire_name, input !== undefined, {
                ...(input !== undefined ? { input } : { arguments: invocationArguments }),
              }, bound.tools.map(wireName)),
            }, extra.signal, requestedTimeoutMs);
          }
          if (tool.freeform) {
            if (input === undefined) throw new Error(`Freeform Codex tool ${wire_name} requires input`);
            if (args && Object.keys(args).length > 0) throw new Error(`Freeform Codex tool ${wire_name} does not accept arguments`);
            return coordinator.invoke(claimed.bindingId, bound, tool, {
              input: tool === execGateway(bound) ? transportBoundRawExecProgram(input, wireName(tool)) : input,
            }, extra.signal);
          }
          if (input !== undefined) throw new Error(`Function Codex tool ${wire_name} does not accept freeform input`);
          const invocationArguments = args ?? {};
          assertBrowserToolArguments(tool, invocationArguments);
          const requested = typeof invocationArguments.yield_time_ms === "number"
            ? invocationArguments.yield_time_ms
            : (typeof invocationArguments.timeout_ms === "number" ? invocationArguments.timeout_ms : undefined);
          const requestedTimeoutMs = requested !== undefined ? requested + 15_000 : undefined;
          return coordinator.invoke(claimed.bindingId, bound, tool, { arguments: invocationArguments }, extra.signal, requestedTimeoutMs);
        });
      },
    );
  }

  if (contract === "safe") {
    server.registerTool(
      "codex_turn_complete",
      {
        title: "Return the result to Codex",
        description: "Send the complete answer back to the connected Codex request after its work is finished. For compaction, send the requested compacted summary.",
        inputSchema: {
          request_id: turnTokenSchema,
          final_answer: z.string().min(1).max(5_000_000),
        },
        outputSchema: {
          completed: z.literal(true),
          duplicate: z.boolean(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ request_id, final_answer }, extra) => {
        console.error(`[chatgpt-web-mcp] codex_turn_complete scope=${requestScopeSummary(extra)}`);
        const response = await callTurnBroker<{ completed: true; duplicate: boolean }>(coordinator.brokerSocketPath, {
          method: "safe_complete",
          token: request_id,
          finalAnswer: final_answer,
        }, null, extra.signal);
        return result(response);
      },
    );
  }
}
