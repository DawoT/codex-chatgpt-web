import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { relative } from "node:path";
import { GLOBAL_SKILL_READ_ROOTS, type FastPathToolResult, type RgExecution, type RgExecutor, type RgResolverDeps, RG_FAILURE_CACHE_TTL_MS, result } from "./types";
import { resolveSafeWorkspacePath } from "./sandbox";

const RG_FALLBACK_PATHS = ["/usr/bin/rg", "/usr/local/bin/rg", "/opt/homebrew/bin/rg"];
const RG_TIMEOUT_MS = 15_000;
const RG_MAX_BUFFER_BYTES = 5 * 1024 * 1024;

let cachedRgPath: string | null | undefined;
let cachedRgFailedAtMs = 0;

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
  const allowedRoots = [
    ...options.roots,
    ...GLOBAL_SKILL_READ_ROOTS.filter(dir => existsSync(dir)),
  ];
  const resolved = resolveSafeWorkspacePath(path, options.cwd, allowedRoots);
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
    const colonOffset = /^[a-zA-Z]:[\\/]/.test(line) ? 2 : 0;
    const firstColon = line.indexOf(":", colonOffset);
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
