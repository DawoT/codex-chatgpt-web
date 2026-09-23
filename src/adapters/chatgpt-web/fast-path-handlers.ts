import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { workspaceFileCache, type FastPathWorkspaceCache } from "./fast-path-cache";

/**
 * Pure handlers behind the ChatGPT Web fast-path MCP tools (codex_read_file, codex_write_file,
 * codex_patch_file, codex_list_dir, codex_grep). They are synchronous and side-effect scoped to
 * the workspace sandbox so the MCP server in mcp-server.ts stays a thin registration layer and
 * tests can exercise the real behavior against temporary directories.
 */

// A type alias (not an interface) keeps the shape assignable to the MCP SDK's index-signature
// CallToolResult without extra casts at every registerTool call site.
export type FastPathToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

export function result(value: Record<string, unknown>, isError = false): FastPathToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

interface RealpathDeps {
  /** Injectable for tests; production uses node:fs.realpathSync. */
  realpath?: (path: string) => string;
}

export function resolveSafeWorkspacePath(requestedPath: string, cwd: string, roots: string[], deps: RealpathDeps = {}): string {
  const realpath = deps.realpath ?? realpathSync;
  const resolved = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(cwd, requestedPath);
  const isAllowed = roots.some(root => {
    const rel = relative(resolve(root), resolved);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (!isAllowed) {
    throw new Error(`Path is outside allowed sandbox roots: ${requestedPath}`);
  }
  if (existsSync(resolved)) {
    try {
      const real = realpath(resolved);
      const realAllowed = roots.some(root => {
        const realRoot = existsSync(root) ? realpath(resolve(root)) : resolve(root);
        const rel = relative(realRoot, real);
        return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
      });
      if (!realAllowed) {
        throw new Error(`Resolved symlink targets outside allowed sandbox roots: ${requestedPath}`);
      }
    } catch (realErr) {
      if (realErr instanceof Error && realErr.message.includes("Resolved symlink")) throw realErr;
      // Fail closed: an unverifiable path (EACCES, ELOOP, EPERM, ...) must never be accepted as
      // symlink-safe, otherwise a hostile link could escape the sandbox unnoticed.
      const code = realErr !== null && typeof realErr === "object" && "code" in realErr
        && typeof (realErr as { code: unknown }).code === "string"
        ? (realErr as { code: string }).code
        : "UNKNOWN";
      throw new Error(`Cannot verify symlink safety for ${requestedPath}: ${code}`);
    }
  }
  return resolved;
}

export const CHATGPT_WEB_MAX_TOOL_OUTPUT_CHARS = 16_000;

export interface TruncateHeadTailOptions {
  headRatio?: number;
  tailRatio?: number;
  headChars?: number;
  tailChars?: number;
}

export function truncateToolOutputText(
  text: string,
  maxChars = CHATGPT_WEB_MAX_TOOL_OUTPUT_CHARS,
  options?: TruncateHeadTailOptions,
): string {
  if (text.length <= maxChars) return text;

  let headLimit: number;
  let tailLimit: number;

  if (options?.headChars !== undefined && options?.tailChars !== undefined) {
    headLimit = options.headChars;
    tailLimit = options.tailChars;
  } else {
    const effectiveBudget = Math.max(100, maxChars - 200);
    headLimit = Math.floor(effectiveBudget * (options?.headRatio ?? 0.35));
    tailLimit = Math.floor(effectiveBudget * (options?.tailRatio ?? 0.60));
  }

  const omitted = Math.max(0, text.length - headLimit - tailLimit);
  const head = text.slice(0, headLimit);
  const tail = text.slice(-tailLimit);
  const headCut = head.lastIndexOf("\n");
  const tailCut = tail.indexOf("\n");
  const cleanHead = headCut > 0 ? head.slice(0, headCut) : head;
  const cleanTail = tailCut >= 0 ? tail.slice(tailCut + 1) : tail;
  return [
    cleanHead,
    `\n\n[... output truncated: ${omitted.toLocaleString("en-US")} characters omitted to prevent context overflow. To inspect more, use grep, head/tail, or redirect output to a file ...]\n`,
    cleanTail,
  ].join("\n");
}

export function preserveHeadTailOutput(
  text: string,
  maxChars = CHATGPT_WEB_MAX_TOOL_OUTPUT_CHARS,
  headChars?: number,
  tailChars?: number,
): string {
  return truncateToolOutputText(text, maxChars, { headChars, tailChars });
}

/** Hard ceiling for one codex_read_file call; larger files must be read in slices or via codex_exec. */
export const CHATGPT_WEB_MAX_READ_FILE_BYTES = 16 * 1024 * 1024;

export function handleReadFile(options: {
  path: string;
  offset?: number;
  limit_lines?: number;
  cwd: string;
  roots: string[];
  cache?: FastPathWorkspaceCache;
}): FastPathToolResult {
  const { path, offset = 1, limit_lines = 500 } = options;
  const cache = options.cache ?? workspaceFileCache;
  const resolved = resolveSafeWorkspacePath(path, options.cwd, options.roots);
  if (!existsSync(resolved)) {
    return result({ error: `File does not exist: ${path}` }, true);
  }
  const st = statSync(resolved);
  if (st.isDirectory()) {
    return result({ error: `Path is a directory, not a file. Use codex_list_dir to view contents: ${path}` }, true);
  }
  if (st.size > CHATGPT_WEB_MAX_READ_FILE_BYTES) {
    return result({
      path: relative(options.cwd, resolved) || path,
      size_bytes: st.size,
      error: `File is too large to read (${st.size.toLocaleString("en-US")} bytes; limit ${CHATGPT_WEB_MAX_READ_FILE_BYTES.toLocaleString("en-US")}).`,
      suggestion: "read with offset/limit_lines or use codex_exec",
    }, true);
  }
  const cached = cache.get(resolved, st);
  let lines: string[];
  let totalLines: number;
  if (cached) {
    if (cached.isBinary) {
      return result({
        path: relative(options.cwd, resolved) || path,
        binary: true,
        size_bytes: st.size,
        error: "Binary file cannot be displayed as text. Use codex_view_image or inspect via codex_exec.",
      }, true);
    }
    lines = cached.lines;
    totalLines = cached.totalLines;
  } else {
    const buffer = readFileSync(resolved);
    const checkBytes = Math.min(buffer.length, 8192);
    for (let i = 0; i < checkBytes; i++) {
      if (buffer[i] === 0) {
        cache.set(resolved, st, { text: "", lines: [], isBinary: true });
        return result({
          path: relative(options.cwd, resolved) || path,
          binary: true,
          size_bytes: buffer.length,
          error: "Binary file cannot be displayed as text. Use codex_view_image or inspect via codex_exec.",
        }, true);
      }
    }
    const text = buffer.toString("utf8");
    lines = text.split(/\r?\n/);
    totalLines = lines.length;
    cache.set(resolved, st, { text, lines, isBinary: false });
    try {
      cache.prewarmLocalImports(resolved, text, options.roots);
    } catch {
      // Best effort prewarming
    }
  }
  const startIndex = Math.max(0, offset - 1);
  const selected = lines.slice(startIndex, startIndex + limit_lines);
  const joinedContent = truncateToolOutputText(selected.join("\n"));
  const endLine = Math.min(startIndex + selected.length, totalLines);
  return result({
    path: relative(options.cwd, resolved) || path,
    start_line: startIndex + 1,
    end_line: endLine,
    total_lines: totalLines,
    content: joinedContent,
    has_more: endLine < totalLines,
  });
}

export function handleWriteFile(options: {
  path: string;
  content: string;
  overwrite?: boolean;
  create_parents?: boolean;
  cwd: string;
  roots: string[];
  cache?: FastPathWorkspaceCache;
}): FastPathToolResult {
  const { path, content, overwrite = false, create_parents = false } = options;
  const cache = options.cache ?? workspaceFileCache;
  const resolved = resolveSafeWorkspacePath(path, options.cwd, options.roots);
  const existed = existsSync(resolved);
  if (existed) {
    const st = statSync(resolved);
    if (st.isDirectory()) {
      return result({ path, error: `Path is a directory, not a file: ${path}` }, true);
    }
    if (!overwrite) {
      return result({
        path: relative(options.cwd, resolved) || path,
        error: "File already exists and overwrite is false; refusing to clobber it. Re-run with overwrite=true to replace the content.",
        size_bytes: st.size,
        modified_epoch_ms: st.mtimeMs,
      }, true);
    }
  }
  const parent = dirname(resolved);
  if (!existsSync(parent)) {
    if (!create_parents) {
      return result({
        path,
        error: `Parent directory does not exist: ${relative(options.cwd, parent) || parent}. Re-run with create_parents=true to create it.`,
      }, true);
    }
    mkdirSync(parent, { recursive: true });
  }
  writeFileSync(resolved, content, "utf8");
  cache.invalidate(resolved);
  return result({
    path: relative(options.cwd, resolved) || path,
    bytes_written: Buffer.byteLength(content, "utf8"),
    overwrote: existed,
  });
}

export function handlePatchFile(options: {
  path: string;
  target_content: string;
  replacement_content: string;
  cwd: string;
  roots: string[];
  cache?: FastPathWorkspaceCache;
}): FastPathToolResult {
  const { path, target_content, replacement_content } = options;
  const cache = options.cache ?? workspaceFileCache;
  const resolved = resolveSafeWorkspacePath(path, options.cwd, options.roots);
  if (!existsSync(resolved)) {
    return result({ error: `File does not exist: ${path}` }, true);
  }
  const st = statSync(resolved);
  if (st.isDirectory()) {
    return result({ error: `Path is a directory, not a file. Use codex_list_dir to view contents: ${path}` }, true);
  }
  const cached = cache.get(resolved, st);
  const content = cached ? cached.text : readFileSync(resolved).toString("utf8");
  // Mutation safety: unlike read_file (which only probes the first bytes), never write into a
  // file that contains a null byte anywhere; treating it as text would corrupt the binary.
  if (content.includes("\0")) {
    return result({
      path: relative(options.cwd, resolved) || path,
      binary: true,
      size_bytes: st.size,
      error: "Binary file cannot be patched as text. Rewrite it with codex_write_file or inspect via codex_exec.",
    }, true);
  }
  const firstIndex = content.indexOf(target_content);
  if (firstIndex < 0) {
    return result({
      path: relative(options.cwd, resolved) || path,
      error: "target_content was not found in the file; nothing was written. The match must be exact, including whitespace, indentation, and line endings.",
      target_chars: target_content.length,
    }, true);
  }
  const updated = content.slice(0, firstIndex) + replacement_content + content.slice(firstIndex + target_content.length);
  writeFileSync(resolved, updated, "utf8");
  cache.invalidate(resolved);
  return result({
    path: relative(options.cwd, resolved) || path,
    replacements: 1,
    bytes_written: Buffer.byteLength(updated, "utf8"),
  });
}

export function handleListDir(options: {
  path?: string;
  depth?: number;
  limit?: number;
  cwd: string;
  roots: string[];
}): FastPathToolResult {
  const { path = ".", depth = 1, limit = 100 } = options;
  const resolved = resolveSafeWorkspacePath(path, options.cwd, options.roots);
  if (!existsSync(resolved)) {
    return result({ error: `Directory does not exist: ${path}` }, true);
  }
  const st = statSync(resolved);
  if (!st.isDirectory()) {
    return result({ error: `Path is a file, not a directory. Use codex_read_file: ${path}` }, true);
  }

  const entries: Array<{ name: string; path: string; type: "file" | "directory" | "other"; size_bytes?: number }> = [];
  const ignoredDirs = new Set([".git", "node_modules", "dist", ".cache", ".gemini", ".next", ".turbo"]);

  const walk = (currentDir: string, currentDepth: number) => {
    if (entries.length >= limit) return;
    let dirents;
    try {
      dirents = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
    for (const d of dirents) {
      if (entries.length >= limit) break;
      // Ignored directories are skipped entirely so they neither appear in the listing nor
      // consume the caller's entry budget at the top level.
      if (ignoredDirs.has(d.name)) continue;
      const fullPath = join(currentDir, d.name);
      const relPath = relative(resolved, fullPath);
      const isDir = d.isDirectory();
      const isFile = d.isFile();
      let size: number | undefined;
      if (isFile) {
        try {
          size = statSync(fullPath).size;
        } catch {}
      }
      entries.push({
        name: d.name,
        path: relPath,
        type: isDir ? "directory" : isFile ? "file" : "other",
        ...(size !== undefined ? { size_bytes: size } : {}),
      });
      if (isDir && currentDepth < depth) {
        walk(fullPath, currentDepth + 1);
      }
    }
  };

  walk(resolved, 1);
  return result({
    path: relative(options.cwd, resolved) || path,
    entries,
    total: entries.length,
    truncated: entries.length >= limit,
  });
}

export interface RgExecution {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type RgExecutor = (rgPath: string, args: string[], options: { cwd: string }) => RgExecution;

const RG_FALLBACK_PATHS = ["/usr/bin/rg", "/usr/local/bin/rg", "/opt/homebrew/bin/rg"];
const RG_TIMEOUT_MS = 15_000;
const RG_MAX_BUFFER_BYTES = 5 * 1024 * 1024;

let cachedRgPath: string | null | undefined;

/**
 * Resolve the ripgrep binary once per process. Bun.which covers PATH lookups; the fallback list
 * covers GUI-launched daemons whose PATH omits the usual install locations.
 */
export function resolveRgPath(): string | null {
  if (cachedRgPath !== undefined) return cachedRgPath;
  const fromPath = typeof Bun !== "undefined" ? Bun.which("rg") : null;
  cachedRgPath = fromPath ?? RG_FALLBACK_PATHS.find(candidate => existsSync(candidate)) ?? null;
  return cachedRgPath;
}

function defaultRgExecutor(rgPath: string, args: string[], options: { cwd: string }): RgExecution {
  const spawned = spawnSync(rgPath, args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: RG_TIMEOUT_MS,
    maxBuffer: RG_MAX_BUFFER_BYTES,
  });
  return {
    status: spawned.status,
    stdout: spawned.stdout ?? "",
    stderr: spawned.stderr ?? "",
    ...(spawned.error ? { error: spawned.error } : {}),
  };
}

export function handleGrep(options: {
  query: string;
  path?: string;
  max_results?: number;
  case_sensitive?: boolean;
  file_pattern?: string;
  cwd: string;
  roots: string[];
  runRg?: RgExecutor;
  resolveRgPath?: () => string | null;
}): FastPathToolResult {
  const { query, path = ".", max_results = 50, case_sensitive = false, file_pattern } = options;
  const locateRg = options.resolveRgPath ?? resolveRgPath;
  const rgPath = locateRg();
  if (!rgPath) {
    return result({
      error: "ripgrep (rg) is not installed or not on PATH. Install it (e.g. 'apt install ripgrep' or 'brew install ripgrep') to use codex_grep.",
    }, true);
  }
  const resolved = resolveSafeWorkspacePath(path, options.cwd, options.roots);
  if (!existsSync(resolved)) {
    return result({ error: `Search target does not exist: ${path}` }, true);
  }

  const args: string[] = [
    "--line-number",
    "--color=never",
    "--max-count", String(max_results),
    "--hidden",
    "--glob", "!**/.git/**",
    "--glob", "!**/node_modules/**",
    "--glob", "!**/dist/**",
  ];
  if (!case_sensitive) args.push("-i");
  if (file_pattern) {
    args.push("--glob", file_pattern);
  }
  args.push("-e", query, resolved);

  const runRg = options.runRg ?? defaultRgExecutor;
  const rg = runRg(rgPath, args, { cwd: options.cwd });

  if (rg.error) {
    return result({ error: `rg execution failed: ${rg.error.message}` }, true);
  }

  // Exit 1 only means "no matches". Any other nonzero status (invalid pattern, unreadable target,
  // timeout) is a real failure and must surface its stderr instead of masquerading as 0 matches.
  if (rg.status !== 0 && rg.status !== 1) {
    return result({ error: `rg search failed (exit ${rg.status}): ${(rg.stderr || "unknown error").trim().slice(0, 500)}` }, true);
  }

  const lines = rg.status === 0 ? rg.stdout.trim().split("\n").filter(Boolean) : [];
  const matches: Array<{ file: string; line: number; text: string }> = [];
  for (const line of lines.slice(0, max_results)) {
    const firstColon = line.indexOf(":");
    if (firstColon < 0) continue;
    const secondColon = line.indexOf(":", firstColon + 1);
    if (secondColon < 0) continue;
    const filePath = line.slice(0, firstColon);
    const lineNum = parseInt(line.slice(firstColon + 1, secondColon), 10);
    const matchedText = line.slice(secondColon + 1);
    matches.push({
      file: relative(options.cwd, filePath) || filePath,
      line: isNaN(lineNum) ? 0 : lineNum,
      text: matchedText.length > 200 ? `${matchedText.slice(0, 200)}...` : matchedText,
    });
  }

  return result({
    query,
    path: relative(options.cwd, resolved) || path,
    matches,
    total: matches.length,
    truncated: lines.length >= max_results,
  });
}

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
    toolName === "write_file" ||
    toolName === "patch_file"
  );
}

export type FastPathToolCall = {
  tool: string;
  arguments: Record<string, unknown>;
  id?: string;
};

export type FastPathBatchResult = {
  id?: string;
  tool: string;
  result: FastPathToolResult;
};

export function dispatchFastPathTool(
  tool: string,
  args: Record<string, unknown>,
  context: {
    cwd: string;
    roots: string[];
    cache?: FastPathWorkspaceCache;
  },
): FastPathToolResult {
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
        cache: context.cache,
      });
    case "codex_patch_file":
      return handlePatchFile({
        path: String(args.path ?? ""),
        target_content: String(args.target_content ?? ""),
        replacement_content: String(args.replacement_content ?? ""),
        cwd: context.cwd,
        roots: context.roots,
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
    default:
      return result({ error: `Unsupported fast-path tool: ${tool}` }, true);
  }
}

export async function executeFastPathBatch(
  calls: FastPathToolCall[],
  context: {
    cwd: string;
    roots: string[];
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
          const res = dispatchFastPathTool(call.tool, call.arguments, context);
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
        const res = dispatchFastPathTool(call.tool, call.arguments, context);
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

