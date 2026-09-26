import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  lstatSync,
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

function isInsideRoot(base: string, root: string): boolean {
  const rel = relative(root, base);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Deepest ancestor of `path` (including `path` itself) that currently exists on disk. */
function deepestExistingAncestor(path: string): string {
  let current = resolve(path);
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/**
 * Symlink-containment verification shared by every handler that resolves a workspace path
 * (Sprint C1). Two cases must hold before any filesystem mutation:
 *  - If the leaf exists, its full realpath must land inside the realpath-ed roots (pre-existing
 *    leaf check; realpath transitively covers every ancestor of an existing leaf).
 *  - If the leaf does not exist, the deepest EXISTING ancestor is the only on-disk component that
 *    mkdirSync/writeFileSync would traverse, so its realpath must land inside the realpath-ed
 *    roots. A dangling leaf symlink (lstat succeeds, realpath fails) fails closed exactly like
 *    any other unverifiable path; otherwise writeFileSync would follow it and create the target
 *    outside the sandbox.
 * The purely lexical root check in resolveSafeWorkspacePath stays as defense in depth.
 */
export function assertSymlinkSafePath(
  resolved: string,
  roots: string[],
  requestedPath: string,
  deps: RealpathDeps = {},
): void {
  const realpath = deps.realpath ?? realpathSync;
  const outsideError = () => new Error(`Resolved symlink targets outside allowed sandbox roots: ${requestedPath}`);
  const run = (): void => {
    const realRoots = roots.map(root => (existsSync(root) ? realpath(resolve(root)) : resolve(root)));
    if (existsSync(resolved)) {
      const real = realpath(resolved);
      if (!realRoots.some(realRoot => isInsideRoot(real, realRoot))) throw outsideError();
      return;
    }
    let danglingLeaf = false;
    try {
      lstatSync(resolved);
      danglingLeaf = true;
    } catch {
      // Truly absent leaf: fall through to the ancestor check.
    }
    if (danglingLeaf) {
      // Dangling symlink: realpath must fail and trigger the fail-closed branch below.
      const real = realpath(resolved);
      if (!realRoots.some(realRoot => isInsideRoot(real, realRoot))) throw outsideError();
      return;
    }
    const realAncestor = realpath(deepestExistingAncestor(resolved));
    if (!realRoots.some(realRoot => isInsideRoot(realAncestor, realRoot))) throw outsideError();
  };
  try {
    run();
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

export function resolveSafeWorkspacePath(requestedPath: string, cwd: string, roots: string[], deps: RealpathDeps = {}): string {
  const resolved = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(cwd, requestedPath);
  const isAllowed = roots.some(root => {
    const rel = relative(resolve(root), resolved);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (!isAllowed) {
    throw new Error(`Path is outside allowed sandbox roots: ${requestedPath}`);
  }
  assertSymlinkSafePath(resolved, roots, requestedPath, deps);
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

/**
 * Sprint C2: when the turn environment declares writableRoots, mutations must be contained there
 * instead of the broader read-only roots. Callers must reject an empty writableRoots list before
 * reaching this helper (read-only workspaces reject every mutation outright).
 */
function assertWritableRootContainment(
  resolved: string,
  requestedPath: string,
  writableRoots: string[],
  deps: RealpathDeps = {},
): void {
  const lexicalAllowed = writableRoots.some(root => isInsideRoot(resolved, resolve(root)));
  if (!lexicalAllowed) {
    throw new Error(`Path is outside allowed writable roots: ${requestedPath}`);
  }
  assertSymlinkSafePath(resolved, writableRoots, requestedPath, deps);
}

export function handleWriteFile(options: {
  path: string;
  content: string;
  overwrite?: boolean;
  create_parents?: boolean;
  cwd: string;
  roots: string[];
  writableRoots?: string[];
  cache?: FastPathWorkspaceCache;
}): FastPathToolResult {
  const { path, content, overwrite = false, create_parents = false } = options;
  const cache = options.cache ?? workspaceFileCache;
  // A read-only sandbox policy (writableRoots: []) rejects every mutation before touching the
  // filesystem; without writableRoots the write roots fall back to `roots` (legacy behavior).
  if (options.writableRoots !== undefined && options.writableRoots.length === 0) {
    return result({ error: "Workspace is read-only (writableRoots is empty): codex_write_file cannot modify files." }, true);
  }
  const resolved = resolveSafeWorkspacePath(path, options.cwd, options.roots);
  if (options.writableRoots !== undefined) {
    assertWritableRootContainment(resolved, path, options.writableRoots);
  }
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
  writableRoots?: string[];
  cache?: FastPathWorkspaceCache;
}): FastPathToolResult {
  const { path, target_content, replacement_content } = options;
  const cache = options.cache ?? workspaceFileCache;
  // Same read-only/writable-roots policy as codex_write_file (Sprint C2).
  if (options.writableRoots !== undefined && options.writableRoots.length === 0) {
    return result({ error: "Workspace is read-only (writableRoots is empty): codex_patch_file cannot modify files." }, true);
  }
  const resolved = resolveSafeWorkspacePath(path, options.cwd, options.roots);
  if (options.writableRoots !== undefined) {
    assertWritableRootContainment(resolved, path, options.writableRoots);
  }
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
/** Sprint C3: a failed lookup is retried after this TTL instead of being cached for the process lifetime. */
export const RG_FAILURE_CACHE_TTL_MS = 30_000;

let cachedRgPath: string | null | undefined;
let cachedRgFailedAtMs = 0;

export interface RgResolverDeps {
  /** Injectable for tests; production uses Bun.which. */
  which?: (name: string) => string | null;
  /** Injectable for tests; production uses node:fs.existsSync. */
  exists?: (path: string) => boolean;
  /** Injectable clock for tests; production uses Date.now. */
  now?: () => number;
}

/** Clears the memoized ripgrep lookup (Sprint C3 test hook and retry escape hatch). */
export function resetRgPathCache(): void {
  cachedRgPath = undefined;
  cachedRgFailedAtMs = 0;
}

/**
 * Resolve the ripgrep binary. Bun.which covers PATH lookups; the fallback list covers GUI-launched
 * daemons whose PATH omits the usual install locations. A successful resolution is cached for the
 * process lifetime, but a failure is only cached for RG_FAILURE_CACHE_TTL_MS so that installing rg
 * (or fixing PATH) is picked up without restarting the MCP server.
 */
export function resolveRgPath(deps: RgResolverDeps = {}): string | null {
  if (cachedRgPath) return cachedRgPath;
  const now = deps.now?.() ?? Date.now();
  if (cachedRgPath === null && now - cachedRgFailedAtMs < RG_FAILURE_CACHE_TTL_MS) {
    return null;
  }
  const which = deps.which ?? ((name: string) => (typeof Bun !== "undefined" ? Bun.which(name) : null));
  const exists = deps.exists ?? existsSync;
  const found = which("rg") ?? RG_FALLBACK_PATHS.find(candidate => exists(candidate)) ?? null;
  cachedRgPath = found;
  if (found === null) {
    cachedRgFailedAtMs = now;
  } else {
    cachedRgFailedAtMs = 0;
  }
  return found;
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

export interface HandleExecCommandOptions {
  cmd: string;
  workdir?: string;
  timeout_ms?: number;
  cwd: string;
  roots: string[];
  writableRoots?: string[];
  cache?: FastPathWorkspaceCache;
}

export const DEFAULT_EXEC_TIMEOUT_MS = 600_000; // 10 minutes
export const MAX_EXEC_TIMEOUT_MS = 1_800_000;   // 30 minutes
export const MIN_EXEC_TIMEOUT_MS = 1_000;       // 1 second

export async function handleExecCommand(options: HandleExecCommandOptions): Promise<FastPathToolResult> {
  const { cmd, workdir, timeout_ms, cwd, roots, writableRoots, cache } = options;
  if (!cmd || typeof cmd !== "string" || !cmd.trim()) {
    return result({ error: "cmd must be a non-empty string" }, true);
  }

  if (!writableRoots || writableRoots.length === 0) {
    return result({ error: "Command execution is disabled in readOnly mode" }, true);
  }

  let effectiveCwd = cwd;
  if (workdir && typeof workdir === "string" && workdir.trim()) {
    try {
      effectiveCwd = resolveSafeWorkspacePath(workdir.trim(), cwd, roots);
      if (!existsSync(effectiveCwd) || !statSync(effectiveCwd).isDirectory()) {
        return result({ error: `workdir is not an existing directory: ${workdir}` }, true);
      }
    } catch (err) {
      return result({ error: err instanceof Error ? err.message : String(err) }, true);
    }
  }

  const timeout = Math.min(Math.max(timeout_ms ?? DEFAULT_EXEC_TIMEOUT_MS, MIN_EXEC_TIMEOUT_MS), MAX_EXEC_TIMEOUT_MS);
  const shell = process.platform === "win32" ? "cmd.exe" : "/bin/bash";
  const shellArgs = process.platform === "win32" ? ["/c", cmd] : ["-c", cmd];

  return new Promise<FastPathToolResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    let child: ChildProcess;
    try {
      child = spawn(shell, shellArgs, {
        cwd: effectiveCwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
    } catch (spawnError) {
      resolve(result({
        cmd,
        exit_code: 1,
        error: spawnError instanceof Error ? spawnError.message : String(spawnError),
      }, true));
      return;
    }

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
      if (cache) {
        cache.clear();
      } else {
        workspaceFileCache.clear();
      }
    };

    timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === "win32") {
          child.kill("SIGTERM");
          killTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {}
          }, 3_000);
        } else if (child.pid) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }
          killTimer = setTimeout(() => {
            try {
              if (child.pid) process.kill(-child.pid, "SIGKILL");
            } catch {
              try {
                child.kill("SIGKILL");
              } catch {}
            }
          }, 3_000);
        }
      } catch {}
    }, timeout);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < 10 * 1024 * 1024) {
        stdout += chunk;
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 10 * 1024 * 1024) {
        stderr += chunk;
      }
    });

    child.on("error", (err) => {
      cleanup();
      resolve(result({
        cmd,
        exit_code: 1,
        error: err.message,
        stdout,
        stderr,
      }, true));
    });

    child.on("close", (code, signal) => {
      cleanup();
      if (timedOut) {
        const timeoutSec = Math.round(timeout / 1000);
        const timeoutMin = (timeout / 60000).toFixed(1);
        const partialNotice = `\n[codex_exec] Command timed out after ${timeout}ms (${timeoutSec}s / ~${timeoutMin}m).` +
          `\nPartial output was preserved above.` +
          `\nHint: For long-running test batteries or builds, pass a larger timeout_ms (e.g. 900000 for 15m, max 1800000 = 30m), or execute tests in targeted sub-suites.`;
        resolve(result({
          cmd,
          exit_code: -1,
          timed_out: true,
          stdout,
          stderr: (stderr ? stderr + "\n" : "") + partialNotice,
        }, true));
        return;
      }

      const exitCode = code ?? (signal ? 1 : 0);
      const isError = exitCode !== 0;
      resolve(result({
        cmd,
        cwd: effectiveCwd,
        exit_code: exitCode,
        stdout,
        stderr,
        timed_out: false,
      }, isError));
    });
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
    toolName === "codex_exec" ||
    toolName === "write_file" ||
    toolName === "patch_file" ||
    toolName === "exec"
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

