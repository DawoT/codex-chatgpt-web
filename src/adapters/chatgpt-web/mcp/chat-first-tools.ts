import { registerChatFirstTaskTools } from "./chat-first-task-tools";
import { registerImageTools } from "./image-tools";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { loadConfig } from "../../../config";
import { appendChatFirstAuditEntry } from "../chat-first-audit";
import { resolveChatFirstWorkspace } from "../chat-first-environment";
import { workspaceFileCache } from "../fast-path-cache";
import {
  handleGrep,
  handleListDir,
  handlePatchFile,
  handleReadFile,
  handleWriteFile,
  result,
  type FastPathToolResult,
} from "../fast-path-handlers";
import { asMcpResult } from "./results";

export function registerChatFirstTools(
  server: McpServer,
  chatFirstConfig: ReturnType<typeof loadConfig>,
): void {
  if (!chatFirstConfig?.chatFirst?.enabled) return;

  const chatFirstSandboxMode = chatFirstConfig.chatFirst.sandboxMode;
  const chatFirstWritable = chatFirstSandboxMode !== "readOnly";
  const scopeFor = (requested?: string) => resolveChatFirstWorkspace(chatFirstConfig, requested);
  const chatFirstToolResult = (toolName: string, cwd: string, res: FastPathToolResult) =>
    asMcpResult(res, { toolName, offload: false });
  // Shell failures and cancellation can follow filesystem effects; record their outcomes too.
  const auditMutationOutcome = (tool: string, res: FastPathToolResult, requestedPath: string): void => {
    if (res.isError && tool !== "codex_exec") return;
    const structured = res.structuredContent;
    appendChatFirstAuditEntry({
      tool,
      ...(tool === "codex_exec" ? { detail: res.isError ? "error" : "success" } : {}),
      path: typeof structured.path === "string" ? structured.path : requestedPath,
      ...(typeof structured.bytes_written === "number" ? { bytes: structured.bytes_written } : {}),
    });
  };

  server.registerTool(
    "codex_read_file",
    {
      title: "Read a chat-first workspace file",
      description: "Read file content directly from the configured workspace. Choose line paging (offset/limit_lines) or bounded UTF-8 byte paging (offset_bytes/max_bytes); resume byte pages with next_offset_bytes. Do not mix modes.",
      inputSchema: {
        path: z.string().min(1).max(16_384).describe("Path to the file (relative to the workspace or absolute)."),
        workspace: z.string().max(1_024).optional().describe("Optional configured workspace; omit it to use the default workspace."),
        offset: z.number().int().min(1).optional().describe("1-indexed line offset, default 1; mutually exclusive with byte pagination."),
        limit_lines: z.number().int().min(1).max(2_000).optional().describe("Line limit, default 500; mutually exclusive with byte pagination."),
        offset_bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe("UTF-8 byte offset; continue with next_offset_bytes from the prior page."),
        max_bytes: z.number().int().min(1).max(131072).optional().describe("Byte page budget, at most 128 KiB. Byte mode defaults to 128 KiB when offset_bytes is supplied."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async input => {
      const scope = scopeFor(input.workspace);
      const res = handleReadFile({
        path: input.path,
        offset: input.offset,
        limit_lines: input.limit_lines,
        offset_bytes: input.offset_bytes,
        max_bytes: input.max_bytes,
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
          { name: "codex_image_generate", description: "Generate an image from a text prompt and save it directly to disk (PNG)." },
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
        auditMutationOutcome("codex_write_file", res, input.path);
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
        auditMutationOutcome("codex_patch_file", res, input.path);
        return chatFirstToolResult("codex_patch_file", scope.cwd, res);
      },
    );

    registerChatFirstTaskTools(server, {
      config: chatFirstConfig,
      scopeFor,
      toolResult: chatFirstToolResult,
      audit: auditMutationOutcome,
    });

    registerImageTools(server, {
      scopeFor,
    });
  }
}
