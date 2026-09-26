import type { BackgroundTask } from "./background-task-manager";

const SUMMARY_MAX_LENGTH = 300;
const ERROR_LINE_MAX_LENGTH = 120;
const COUNTS_SCAN_WINDOW_LINES = 200;
const FALLBACK_TAIL_LINES = 2;

const ERROR_LINE_PATTERN = /error|Error|ERROR|FAILED|failures?:/;

interface ParsedCounts {
  label: string;
  text: string;
}

/**
 * Builds a single-line summary (max 300 chars) of a background task from its record plus a log
 * tail. Deterministic and side-effect free: no clock, no I/O, never throws. Segments are joined
 * with " | ": status (with exit code / duration when available), parsed test counts, the first
 * error line (when present), and the full log path. When nothing parses from the log, the last
 * two log lines are used as a fallback.
 */
export function summarizeTask(task: BackgroundTask, logTail: string): string {
  try {
    return buildSummary(task, typeof logTail === "string" ? logTail : "");
  } catch {
    return `${task?.status ?? "unknown"} | log=${task?.fullLogPath ?? "unknown"}`;
  }
}

function buildSummary(task: BackgroundTask, logTail: string): string {
  const lines = lastLines(logTail, COUNTS_SCAN_WINDOW_LINES);
  const segments: string[] = [statusSegment(task)];

  const counts = parseCounts(lines);
  if (counts) {
    segments.push(`${counts.label}: ${counts.text}`);
  }

  const errorLine = firstErrorLine(lines);
  if (errorLine) {
    segments.push(`error: ${errorLine}`);
  }

  if (!counts && !errorLine) {
    const fallback = fallbackTail(lines);
    if (fallback) {
      segments.push(fallback);
    }
  }

  segments.push(`log=${task.fullLogPath}`);
  return clampLength(segments.join(" | "), SUMMARY_MAX_LENGTH);
}

function statusSegment(task: BackgroundTask): string {
  const detail: string[] = [];
  if (task.status !== "running" && task.exitCode !== null && task.exitCode !== undefined) {
    detail.push(`exit ${task.exitCode}`);
  }
  if (task.durationMs !== undefined && Number.isFinite(task.durationMs)) {
    detail.push(formatDuration(task.durationMs));
  }
  return detail.length > 0 ? `${task.status} (${detail.join(", ")})` : task.status;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))}ms`;
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

/**
 * Attempts each runner's summary pattern against the log-tail window. Order matters: highly
 * specific patterns first (cargo's "test result:", jest's "Tests:" prefix), then the generic
 * "N passed"/"N pass" counters, then go's per-package ok/FAIL line counts.
 */
function parseCounts(lines: string[]): ParsedCounts | undefined {
  const tail = lines.join("\n");

  // cargo: "test result: ok. 10 passed; 0 failed; 0 ignored; ..."
  const cargo = tail.match(/test result:\s*\w+\.\s*(\d+) passed;\s*(\d+) failed/);
  if (cargo) return { label: "cargo", text: `${cargo[1]} passed, ${cargo[2]} failed` };

  // jest/vitest: "Tests:  5 passed, 2 failed, 7 total" (failed part optional)
  const jest = tail.match(/Tests:\s+(\d+) passed(?:,\s+(\d+) failed)?/);
  if (jest) {
    return {
      label: "jest",
      text: jest[2] !== undefined ? `${jest[1]} passed, ${jest[2]} failed` : `${jest[1]} passed`,
    };
  }

  // pytest summary line when failures lead: "===== 2 failed, 3 passed in 0.42s ====="
  const pytestReversed = tail.match(/(\d+) failed(?:,\s+(\d+) passed)/);
  if (pytestReversed) {
    return { label: "pytest", text: `${pytestReversed[2]} passed, ${pytestReversed[1]} failed` };
  }

  // pytest: "5 passed, 2 failed in 0.12s" (failed part optional)
  const pytest = tail.match(/(\d+) passed(?:,\s+(\d+) failed)?/);
  if (pytest) {
    return {
      label: "pytest",
      text: pytest[2] !== undefined ? `${pytest[1]} passed, ${pytest[2]} failed` : `${pytest[1]} passed`,
    };
  }

  // Loose failed-only counter (e.g. failed-only jest runs: "Tests:  2 failed")
  const looseFailed = tail.match(/(\d+) failed/);
  if (looseFailed) return { label: "tests", text: `${looseFailed[1]} failed` };

  // bun: "Ran 4 tests across 2 files. 3 pass; 1 fail; 0 skip"
  const bunPass = tail.match(/(\d+) pass/);
  const bunFail = tail.match(/(\d+) fail/);
  if (bunPass || bunFail) {
    return { label: "bun", text: `${bunPass?.[1] ?? 0} pass, ${bunFail?.[1] ?? 0} fail` };
  }

  return countGoPackages(lines);
}

// go: one "ok <pkg>" or "FAIL <pkg>" line per package; count them.
function countGoPackages(lines: string[]): ParsedCounts | undefined {
  let ok = 0;
  let failed = 0;
  for (const line of lines) {
    if (/^ok\s/.test(line)) ok++;
    else if (/^FAIL\b/.test(line)) failed++;
  }
  if (ok === 0 && failed === 0) return undefined;
  return { label: "go", text: `${ok} ok, ${failed} failed` };
}

function firstErrorLine(lines: string[]): string | undefined {
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (ERROR_LINE_PATTERN.test(line)) {
      return clampLength(line, ERROR_LINE_MAX_LENGTH);
    }
  }
  return undefined;
}

function fallbackTail(lines: string[]): string {
  const meaningful = lines.slice(-FALLBACK_TAIL_LINES).map(line => line.trim()).filter(line => line.length > 0);
  return meaningful.join(" / ");
}

function lastLines(logTail: string, maxLines: number): string[] {
  return logTail.split("\n").slice(-maxLines);
}

function clampLength(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
