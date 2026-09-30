import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { workspaceFileCache } from "../fast-path-cache";
import { handleGrep, handleListDir, handlePatchFile, handleReadFile, handleWriteFile } from "../fast-path-handlers";
import { afterSafeStart } from "./instructions";
import { asMcpResult } from "./results";
import { exactTool, turnReference, turnReferenceInput } from "./tool-visibility";
import type { TurnCoordinator } from "./turn-coordinator";

export function registerLegacyFilesystemTools(server: McpServer, coordinator: TurnCoordinator): void {
  const contract = coordinator.contract;

  server.registerTool(
    "codex_apply_patch",
    {
      title: "Apply a native Codex patch",
      description: afterSafeStart(
        contract,
        "Invoke the outer Codex apply_patch tool, producing a native file-change item in the Codex task.",
      ),
      inputSchema: { ...turnReferenceInput(contract), patch: z.string().min(1).max(5_000_000) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input, extra) =>
      coordinator.withClaimedTurn("codex_apply_patch", turnReference(contract, input), extra, async (claimed) => {
        const { patch } = input;
        const bound = claimed.environment;
        const tool = exactTool(bound, "apply_patch");
        let res: Awaited<ReturnType<typeof coordinator.invoke>>;
        if (!tool) {
          res = await coordinator.invokeNestedNative(
            claimed.bindingId,
            bound,
            "apply_patch",
            true,
            { input: patch },
            extra.signal,
          );
        } else {
          res = tool.freeform
            ? await coordinator.invoke(claimed.bindingId, bound, tool, { input: patch }, extra.signal)
            : await coordinator.invoke(claimed.bindingId, bound, tool, { arguments: { input: patch } }, extra.signal);
        }
        workspaceFileCache.clear();
        return res;
      }),
  );

  server.registerTool(
    "codex_view_image",
    {
      title: "View an image through native Codex",
      description: afterSafeStart(
        contract,
        "Invoke the outer Codex view_image tool and return its multimodal result to this same ChatGPT response.",
      ),
      inputSchema: {
        ...turnReferenceInput(contract),
        path: z.string().min(1).max(16_384),
        detail: z.enum(["high", "original"]).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) =>
      coordinator.withClaimedTurn("codex_view_image", turnReference(contract, input), extra, async (claimed) => {
        const { path, detail } = input;
        const bound = claimed.environment;
        const tool = exactTool(bound, "view_image");
        const payload = { arguments: { path, ...(detail ? { detail } : {}) } };
        return tool
          ? coordinator.invoke(claimed.bindingId, bound, tool, payload, extra.signal)
          : coordinator.invokeNestedNative(claimed.bindingId, bound, "view_image", false, payload, extra.signal);
      }),
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
        path: z
          .string()
          .min(1)
          .max(16_384)
          .describe("Path to the file (relative to working directory or absolute within sandbox roots)."),
        offset: z
          .number()
          .int()
          .min(1)
          .default(1)
          .optional()
          .describe("1-indexed line number to start reading from (default: 1)."),
        limit_lines: z
          .number()
          .int()
          .min(1)
          .max(2_000)
          .default(500)
          .optional()
          .describe("Maximum number of lines to read (default: 500, max: 2000)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) =>
      coordinator.withClaimedTurn("codex_read_file", turnReference(contract, input), extra, (claimed) => {
        const { path, offset, limit_lines } = input;
        const bound = claimed.environment;
        const res = handleReadFile({
          path,
          offset,
          limit_lines,
          cwd: bound.cwd,
          roots: bound.roots,
          cache: workspaceFileCache,
        });
        return asMcpResult(res, { toolName: "codex_read_file", offload: false });
      }),
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
        path: z
          .string()
          .min(1)
          .max(16_384)
          .describe("Path to the file (relative to working directory or absolute within sandbox roots)."),
        content: z.string().min(1).max(5_000_000).describe("Complete text content to write to the file."),
        overwrite: z.boolean().default(false).optional().describe("Allow replacing an existing file (default: false)."),
        create_parents: z
          .boolean()
          .default(false)
          .optional()
          .describe("Create missing parent directories (default: false)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input, extra) =>
      coordinator.withClaimedTurn("codex_write_file", turnReference(contract, input), extra, (claimed) => {
        const { path, content, overwrite, create_parents } = input;
        const bound = claimed.environment;
        const res = handleWriteFile({
          path,
          content,
          overwrite,
          create_parents,
          cwd: bound.cwd,
          roots: bound.roots,
          writableRoots: bound.writableRoots ?? bound.roots,
          cache: workspaceFileCache,
        });
        return asMcpResult(res, { toolName: "codex_write_file", offload: false });
      }),
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
        path: z
          .string()
          .min(1)
          .max(16_384)
          .describe("Path to the file (relative to working directory or absolute within sandbox roots)."),
        target_content: z
          .string()
          .min(1)
          .max(1_000_000)
          .describe(
            "Exact text to replace, including whitespace and indentation. Only the first occurrence is replaced.",
          ),
        replacement_content: z
          .string()
          .max(1_000_000)
          .describe("Replacement text; an empty string deletes the matched target."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input, extra) =>
      coordinator.withClaimedTurn("codex_patch_file", turnReference(contract, input), extra, (claimed) => {
        const { path, target_content, replacement_content } = input;
        const bound = claimed.environment;
        const res = handlePatchFile({
          path,
          target_content,
          replacement_content,
          cwd: bound.cwd,
          roots: bound.roots,
          writableRoots: bound.writableRoots ?? bound.roots,
          cache: workspaceFileCache,
        });
        return asMcpResult(res, { toolName: "codex_patch_file", offload: false });
      }),
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
        path: z
          .string()
          .max(16_384)
          .default(".")
          .optional()
          .describe("Directory path to list (default: current working directory)."),
        depth: z
          .number()
          .int()
          .min(1)
          .max(4)
          .default(1)
          .optional()
          .describe("Maximum directory depth to traverse (default: 1 = immediate children)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(100)
          .optional()
          .describe("Maximum number of entries to return (default: 100, max: 500)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) =>
      coordinator.withClaimedTurn("codex_list_dir", turnReference(contract, input), extra, (claimed) => {
        const { path, depth, limit } = input;
        const bound = claimed.environment;
        const res = handleListDir({ path, depth, limit, cwd: bound.cwd, roots: bound.roots });
        return asMcpResult(res, { toolName: "codex_list_dir", offload: false });
      }),
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
        path: z
          .string()
          .max(16_384)
          .default(".")
          .optional()
          .describe("Directory or file to search in (default: current working directory)."),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .optional()
          .describe("Maximum matching lines to return (default: 50, max: 200)."),
        case_sensitive: z
          .boolean()
          .default(false)
          .optional()
          .describe("Whether search is case-sensitive (default: false)."),
        file_pattern: z
          .string()
          .max(256)
          .optional()
          .describe("Optional glob pattern to filter files (e.g. '*.ts', 'src/**')."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) =>
      coordinator.withClaimedTurn("codex_grep", turnReference(contract, input), extra, (claimed) => {
        const { query, path, max_results, case_sensitive, file_pattern } = input;
        const bound = claimed.environment;
        const res = handleGrep({
          query,
          path,
          max_results,
          case_sensitive,
          file_pattern,
          cwd: bound.cwd,
          roots: bound.roots,
        });
        return asMcpResult(res, { toolName: "codex_grep", offload: false });
      }),
  );
}
