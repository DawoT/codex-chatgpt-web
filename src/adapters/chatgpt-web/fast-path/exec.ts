import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { workspaceFileCache, type FastPathWorkspaceCache } from "../fast-path-cache";
import { type FastPathToolResult, result } from "./types";
import { assertWritableRootContainment, resolveSafeWorkspacePath } from "./sandbox";

export interface HandleExecCommandOptions {
  cmd: string;
  workdir?: string;
  timeout_ms?: number;
  cwd: string;
  roots: string[];
  writableRoots?: string[];
  cache?: FastPathWorkspaceCache;
  signal?: AbortSignal;
}

export const DEFAULT_EXEC_TIMEOUT_MS = 600_000; // 10 minutes
export const MAX_EXEC_TIMEOUT_MS = 1_800_000;   // 30 minutes
export const MIN_EXEC_TIMEOUT_MS = 1_000;       // 1 second

export async function handleExecCommand(options: HandleExecCommandOptions): Promise<FastPathToolResult> {
  const { cmd, workdir, timeout_ms, cwd, roots, writableRoots, cache, signal: abortSignal } = options;
  if (!cmd || typeof cmd !== "string" || !cmd.trim()) {
    return result({ error: "cmd must be a non-empty string" }, true);
  }

  if (!writableRoots || writableRoots.length === 0) {
    return result({ error: "Command execution is disabled in readOnly mode" }, true);
  }

  if (abortSignal?.aborted) {
    return result({ cmd, exit_code: -1, cancelled: true, timed_out: false }, true);
  }

  let effectiveCwd: string;
  try {
    effectiveCwd = resolveSafeWorkspacePath(workdir?.trim() || cwd, cwd, roots);
    assertWritableRootContainment(effectiveCwd, effectiveCwd, writableRoots);
    if (!existsSync(effectiveCwd) || !statSync(effectiveCwd).isDirectory()) {
      return result({ error: `workdir is not an existing directory: ${effectiveCwd}` }, true);
    }
  } catch (err) {
    return result({ error: err instanceof Error ? err.message : String(err) }, true);
  }

  const timeout = Math.min(Math.max(timeout_ms ?? DEFAULT_EXEC_TIMEOUT_MS, MIN_EXEC_TIMEOUT_MS), MAX_EXEC_TIMEOUT_MS);
  const shell = process.platform === "win32" ? "cmd.exe" : "/bin/bash";
  const shellArgs = process.platform === "win32" ? ["/c", cmd] : ["-c", cmd];

  return new Promise<FastPathToolResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let cancelled = false;

    let child: ReturnType<typeof spawn>;
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
      abortSignal?.removeEventListener("abort", onAbort);
      if (cache) {
        cache.clear();
      } else {
        workspaceFileCache.clear();
      }
    };

    const terminate = () => {
      // Kill the current POSIX process group before close; no delayed signal can
      // accidentally target a recycled PID. Windows currently terminates the root only.
      try {
        if (process.platform !== "win32" && child.pid) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        child.kill("SIGKILL");
      }
    };
    const onAbort = () => {
      cancelled = true;
      terminate();
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (abortSignal?.aborted) onAbort();
    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeout);

    let stdoutTruncated = false;
    let stderrTruncated = false;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < 10 * 1024 * 1024) {
        stdout += chunk;
      } else if (!stdoutTruncated) {
        stdoutTruncated = true;
        stdout += "\n[codex_exec: stdout truncated at 10MB limit]";
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 10 * 1024 * 1024) {
        stderr += chunk;
      } else if (!stderrTruncated) {
        stderrTruncated = true;
        stderr += "\n[codex_exec: stderr truncated at 10MB limit]";
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
      if (cancelled) {
        resolve(result({
          cmd,
          cwd: effectiveCwd,
          exit_code: -1,
          cancelled: true,
          timed_out: timedOut,
          stdout,
          stderr,
        }, true));
        return;
      }
      if (timedOut) {
        const timeoutSec = Math.round(timeout / 1000);
        const timeoutMin = (timeout / 60000).toFixed(1);
        const partialNotice = `\n[codex_exec] Command timed out after ${timeout}ms (${timeoutSec}s / ~${timeoutMin}m).` +
          `\nPartial output was preserved above.` +
          `\nUse supported background execution or smaller work units for long-running jobs; the active transport may cap timeout_ms.`;
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
