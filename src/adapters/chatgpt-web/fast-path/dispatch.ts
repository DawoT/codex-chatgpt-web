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
  const norm = tool.startsWith("codex_") ? tool : `codex_${tool}`;
  switch (norm) {
    case "codex_read_file":
      return handleReadFile({
        path: String(args.path ?? ""),
        offset: typeof args.offset === "number" ? args.offset : undefined,
        limit_lines: typeof args.limit_lines === "number" ? args.limit_lines : undefined,
        cwd: context.cwd,
        roots: context.roots,
        cache: context.cache,
      });
    case "codex_write_file":
      return handleWriteFile({
        path: String(args.path ?? ""),
        content: String(args.content ?? ""),
        overwrite: Boolean(args.overwrite),
        create_parents: Boolean(args.create_parents),
        cwd: context.cwd,
        roots: context.roots,
        writableRoots: context.writableRoots,
        cache: context.cache,
      });
    case "codex_patch_file":
      return handlePatchFile({
        path: String(args.path ?? ""),
        target_content: String(args.target_content ?? ""),
        replacement_content: String(args.replacement_content ?? ""),
        cwd: context.cwd,
        roots: context.roots,
        writableRoots: context.writableRoots,
        cache: context.cache,
      });
    case "codex_list_dir":
      return handleListDir({
        path: typeof args.path === "string" ? args.path : undefined,
        depth: typeof args.depth === "number" ? args.depth : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
        cwd: context.cwd,
        roots: context.roots,
      });
    case "codex_grep":
      return handleGrep({
        query: String(args.query ?? ""),
        path: typeof args.path === "string" ? args.path : undefined,
        max_results: typeof args.max_results === "number" ? args.max_results : undefined,
        case_sensitive: typeof args.case_sensitive === "boolean" ? args.case_sensitive : undefined,
        file_pattern: typeof args.file_pattern === "string" ? args.file_pattern : undefined,
        cwd: context.cwd,
        roots: context.roots,
      });
    case "codex_exec":
      return handleExecCommand({
        cmd: String(args.cmd ?? ""),
        workdir: typeof args.workdir === "string" ? args.workdir : undefined,
        timeout_ms: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
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
