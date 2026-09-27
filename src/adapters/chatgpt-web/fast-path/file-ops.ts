import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { workspaceFileCache, type FastPathWorkspaceCache } from "../fast-path-cache";
import { GLOBAL_SKILL_READ_ROOTS, type FastPathToolResult, result } from "./types";
import { truncateToolOutputText } from "./output";
import { assertWritableRootContainment, resolveSafeWorkspacePath } from "./sandbox";

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
  const allowedRoots = [
    ...options.roots,
    ...GLOBAL_SKILL_READ_ROOTS.filter(dir => existsSync(dir)),
  ];
  const resolved = resolveSafeWorkspacePath(path, options.cwd, allowedRoots);
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
  const allowedRoots = [
    ...options.roots,
    ...GLOBAL_SKILL_READ_ROOTS.filter(dir => existsSync(dir)),
  ];
  const resolved = resolveSafeWorkspacePath(path, options.cwd, allowedRoots);
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
