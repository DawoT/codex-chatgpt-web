import { type FastPathWorkspaceCache } from "../fast-path-cache";
import { type FastPathBatchResult, type FastPathToolCall, type FastPathToolResult, result } from "./types";
import { handleReadFile, handleWriteFile, handlePatchFile, handleListDir } from "./file-ops";
import { handleGrep } from "./grep";
import { handleExecCommand } from "./exec";

export function isReadOnlyFastPathTool(toolName: string): boolean {
  return (
    toolName === "codex_read_file" ||
    toolName === "codex_list_dir" ||
    toolName === "codex_grep" ||
    toolName === "read_file" ||
    toolName === "list_dir" ||
    toolName === "grep"
  );
}

export function isMutatingFastPathTool(toolName: string): boolean {
  return (
    toolName === "codex_write_file" ||
    toolName === "codex_patch_file" ||
    toolName === "codex_exec" ||
    toolName === "write_file" ||
    toolName === "patch_file" ||
    toolName === "exec"
  );
}

export function dispatchFastPathTool(
  tool: string,
  args: Record<string, unknown>,
  context: {
    cwd: string;
    roots: string[];
    writableRoots?: string[];
    cache?: FastPathWorkspaceCache;
  },
): FastPathToolResult | Promise<FastPathToolResult> {
  const safeArgs = (args && typeof args === "object" && !Array.isArray(args)) ? args : {};
  const norm = tool.startsWith("codex_") ? tool : `codex_${tool}`;
  switch (norm) {
    case "codex_read_file":
      return handleReadFile({
        path: String(safeArgs.path ?? ""),
        offset: typeof safeArgs.offset === "number" ? safeArgs.offset : undefined,
        limit_lines: typeof safeArgs.limit_lines === "number" ? safeArgs.limit_lines : undefined,
        offset_bytes: typeof safeArgs.offset_bytes === "number" ? safeArgs.offset_bytes : undefined,
        max_bytes: typeof safeArgs.max_bytes === "number" ? safeArgs.max_bytes : undefined,
        cwd: context.cwd,
        roots: context.roots,
        cache: context.cache,
      });
    case "codex_write_file":
      return handleWriteFile({
        path: String(safeArgs.path ?? ""),
        content: String(safeArgs.content ?? ""),
        overwrite: Boolean(safeArgs.overwrite),
        create_parents: Boolean(safeArgs.create_parents),
        cwd: context.cwd,
        roots: context.roots,
        writableRoots: context.writableRoots,
        cache: context.cache,
      });
    case "codex_patch_file":
      return handlePatchFile({
        path: String(safeArgs.path ?? ""),
        target_content: String(safeArgs.target_content ?? ""),
        replacement_content: String(safeArgs.replacement_content ?? ""),
        cwd: context.cwd,
        roots: context.roots,
        writableRoots: context.writableRoots,
        cache: context.cache,
      });
    case "codex_list_dir":
      return handleListDir({
        path: typeof safeArgs.path === "string" ? safeArgs.path : undefined,
        depth: typeof safeArgs.depth === "number" ? safeArgs.depth : undefined,
        limit: typeof safeArgs.limit === "number" ? safeArgs.limit : undefined,
        cwd: context.cwd,
        roots: context.roots,
      });
    case "codex_grep":
      return handleGrep({
        query: String(safeArgs.query ?? ""),
        path: typeof safeArgs.path === "string" ? safeArgs.path : undefined,
        max_results: typeof safeArgs.max_results === "number" ? safeArgs.max_results : undefined,
        case_sensitive: typeof safeArgs.case_sensitive === "boolean" ? safeArgs.case_sensitive : undefined,
        file_pattern: typeof safeArgs.file_pattern === "string" ? safeArgs.file_pattern : undefined,
        cwd: context.cwd,
        roots: context.roots,
      });
    case "codex_exec":
      return handleExecCommand({
        cmd: String(safeArgs.cmd ?? ""),
        workdir: typeof safeArgs.workdir === "string" ? safeArgs.workdir : undefined,
        timeout_ms: typeof safeArgs.timeout_ms === "number" ? safeArgs.timeout_ms : undefined,
        cwd: context.cwd,
        roots: context.roots,
        writableRoots: context.writableRoots,
        cache: context.cache,
      });
    default:
      return result({ error: `Unsupported fast-path tool: ${tool}` }, true);
  }
}

export async function executeFastPathBatch(
  calls: FastPathToolCall[],
  context: {
    cwd: string;
    roots: string[];
    writableRoots?: string[];
    cache?: FastPathWorkspaceCache;
  },
): Promise<FastPathBatchResult[]> {
  const results: FastPathBatchResult[] = new Array(calls.length);
  let readSegment: Array<{ index: number; call: FastPathToolCall }> = [];

  const flushReadSegment = async () => {
    if (readSegment.length === 0) return;
    const current = readSegment;
    readSegment = [];
    await Promise.all(
      current.map(async ({ index, call }) => {
        try {
          const res = await dispatchFastPathTool(call.tool, call.arguments, context);
          results[index] = { id: call.id, tool: call.tool, result: res };
        } catch (err) {
          results[index] = {
            id: call.id,
            tool: call.tool,
            result: result({ error: err instanceof Error ? err.message : String(err) }, true),
          };
        }
      }),
    );
  };

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    if (isReadOnlyFastPathTool(call.tool)) {
      readSegment.push({ index: i, call });
    } else {
      // Barrier: flush all preceding read operations concurrently before mutating
      await flushReadSegment();
      try {
        const res = await dispatchFastPathTool(call.tool, call.arguments, context);
        results[i] = { id: call.id, tool: call.tool, result: res };
      } catch (err) {
        results[i] = {
          id: call.id,
          tool: call.tool,
          result: result({ error: err instanceof Error ? err.message : String(err) }, true),
        };
      }
    }
  }

  // Flush any trailing read operations
  await flushReadSegment();

  return results;
}
