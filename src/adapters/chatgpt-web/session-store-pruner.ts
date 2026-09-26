import { existsSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runtimeMetrics } from "./runtime-metrics";

/**
 * Sprint AC: Session Store Compaction & Pruning Utility
 * 
 * Safely prunes, compacts, and garbage-collects historical rollout session files
 * located in ~/.codex/sessions/ (or custom path). Protects active sessions,
 * recent files within a grace period, and allows filtering by session source (e.g. subagents).
 */

export interface CodexRolloutFileInfo {
  path: string;
  filename: string;
  sessionId?: string;
  source?: string;
  timestamp?: string;
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
}

export interface CodexSessionPruningOptions {
  sessionsDir?: string;
  maxFiles?: number;
  maxTotalBytes?: number;
  maxAgeMs?: number;
  protectRecentMs?: number;
  targetSources?: string[];
  minFileSizeBytes?: number;
  dryRun?: boolean;
  removeEmptyDirs?: boolean;
  syncSqliteState?: boolean;
  stateDbPath?: string;
}

export interface PrunedRolloutFile {
  path: string;
  filename: string;
  sessionId?: string;
  source?: string;
  size: number;
  reason: string;
}

export interface CodexSessionPruneResult {
  scannedFiles: number;
  totalInitialBytes: number;
  prunedFiles: PrunedRolloutFile[];
  reclaimedBytes: number;
  remainingFiles: number;
  remainingBytes: number;
  dryRun: boolean;
  staleDbRowsRemoved?: number;
}

export function defaultCodexSessionsDir(): string {
  return join(homedir(), ".codex", "sessions");
}

export function defaultCodexStateDbPath(): string {
  return join(homedir(), ".codex", "state_5.sqlite");
}

export function syncCodexStateDatabase(
  stateDbPath: string = defaultCodexStateDbPath(),
  options: { dryRun?: boolean } = {},
): { totalRows: number; staleRowsRemoved: number } {
  if (!existsSync(stateDbPath)) return { totalRows: 0, staleRowsRemoved: 0 };
  try {
    const { Database } = require("bun:sqlite");
    const db = new Database(stateDbPath);
    try {
      const rows = db.query("SELECT id, rollout_path FROM threads").all() as Array<{ id: string; rollout_path: string }>;
      const staleIds: string[] = [];
      for (const row of rows) {
        if (!row.rollout_path || !existsSync(row.rollout_path)) {
          staleIds.push(row.id);
        }
      }
      if (!options.dryRun && staleIds.length > 0) {
        const placeholders = staleIds.map(() => "?").join(",");
        db.query(`DELETE FROM threads WHERE id IN (${placeholders})`).run(...staleIds);
      }
      return { totalRows: rows.length, staleRowsRemoved: staleIds.length };
    } finally {
      db.close();
    }
  } catch {
    return { totalRows: 0, staleRowsRemoved: 0 };
  }
}

function parseRolloutMeta(filePath: string): { sessionId?: string; source?: string; timestamp?: string } {
  try {
    const buffer = Buffer.alloc(4096);
    const fd = require("node:fs").openSync(filePath, "r");
    const bytesRead = require("node:fs").readSync(fd, buffer, 0, 4096, 0);
    require("node:fs").closeSync(fd);
    if (bytesRead <= 0) return {};

    const text = buffer.toString("utf8", 0, bytesRead);
    const newlineIndex = text.indexOf("\n");
    const firstLine = newlineIndex >= 0 ? text.slice(0, newlineIndex) : text;
    const parsed = JSON.parse(firstLine);

    const payload = parsed?.payload;
    const sessionId = typeof payload?.session_id === "string" ? payload.session_id : undefined;
    const source = typeof payload?.source === "string" ? payload.source : undefined;
    const timestamp = typeof parsed?.timestamp === "string" ? parsed.timestamp : undefined;

    return { sessionId, source, timestamp };
  } catch {
    return {};
  }
}

/**
 * Recursively scans directory for rollout-*.jsonl files and extracts metadata.
 */
export function collectCodexRolloutFiles(sessionsDir: string): CodexRolloutFileInfo[] {
  const results: CodexRolloutFileInfo[] = [];
  if (!existsSync(sessionsDir)) return results;

  function walk(currentDir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(currentDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      let st;
      try {
        st = statSync(fullPath);
      } catch {
        continue;
      }

      if (st.isDirectory()) {
        walk(fullPath);
      } else if (st.isFile() && (entry.startsWith("rollout-") || entry.endsWith(".jsonl"))) {
        const meta = parseRolloutMeta(fullPath);
        results.push({
          path: fullPath,
          filename: entry,
          sessionId: meta.sessionId,
          source: meta.source,
          timestamp: meta.timestamp,
          size: st.size,
          mtimeMs: st.mtimeMs,
          birthtimeMs: st.birthtimeMs,
        });
      }
    }
  }

  walk(sessionsDir);
  return results;
}

/**
 * Removes empty directories from target upwards until baseDir.
 */
function cleanEmptyDirs(targetDir: string, baseDir: string): void {
  let current = targetDir;
  const normalizedBase = resolve(baseDir);

  while (resolve(current) !== normalizedBase && resolve(current).startsWith(normalizedBase)) {
    try {
      const entries = readdirSync(current);
      if (entries.length === 0) {
        rmdirSync(current);
        current = dirname(current);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

/**
 * Prunes rollout files in ~/.codex/sessions according to retention policy.
 */
export function pruneCodexSessions(options: CodexSessionPruningOptions = {}): CodexSessionPruneResult {
  const sessionsDir = options.sessionsDir ?? defaultCodexSessionsDir();
  const protectRecentMs = options.protectRecentMs ?? 3_600_000; // default 1 hour grace period
  const dryRun = options.dryRun ?? false;
  const removeEmptyDirs = options.removeEmptyDirs ?? true;
  const targetSources = options.targetSources && options.targetSources.length > 0 ? new Set(options.targetSources) : undefined;
  const maxFiles = options.maxFiles;
  const maxTotalBytes = options.maxTotalBytes;
  const maxAgeMs = options.maxAgeMs;
  const minFileSizeBytes = options.minFileSizeBytes;

  const allFiles = collectCodexRolloutFiles(sessionsDir);
  const totalInitialBytes = allFiles.reduce((acc, f) => acc + f.size, 0);

  const now = Date.now();
  const prunedFiles: PrunedRolloutFile[] = [];
  const prunedPaths = new Set<string>();

  // Filter candidates: recent files are strictly protected from deletion
  const eligibleFiles = allFiles.filter(f => {
    const ageMs = now - f.mtimeMs;
    if (ageMs < protectRecentMs) return false;
    if (targetSources && f.source && !targetSources.has(f.source)) return false;
    return true;
  });

  // 1. Max Age (TTL) pass
  if (typeof maxAgeMs === "number" && maxAgeMs > 0) {
    for (const f of eligibleFiles) {
      if (prunedPaths.has(f.path)) continue;
      const ageMs = now - f.mtimeMs;
      if (ageMs > maxAgeMs) {
        prunedPaths.add(f.path);
        prunedFiles.push({
          path: f.path,
          filename: f.filename,
          sessionId: f.sessionId,
          source: f.source,
          size: f.size,
          reason: `exceeded_max_age (${Math.round(ageMs / 86_400_000)}d > ${Math.round(maxAgeMs / 86_400_000)}d)`,
        });
      }
    }
  }

  // 2. Min File Size (Mega-session) pass if configured
  if (typeof minFileSizeBytes === "number" && minFileSizeBytes > 0) {
    for (const f of eligibleFiles) {
      if (prunedPaths.has(f.path)) continue;
      if (f.size >= minFileSizeBytes) {
        prunedPaths.add(f.path);
        prunedFiles.push({
          path: f.path,
          filename: f.filename,
          sessionId: f.sessionId,
          source: f.source,
          size: f.size,
          reason: `mega_file (${(f.size / (1024 * 1024)).toFixed(1)}MB >= ${(minFileSizeBytes / (1024 * 1024)).toFixed(1)}MB)`,
        });
      }
    }
  }

  // Sort remaining eligible files from oldest to newest (FIFO)
  const remainingEligible = eligibleFiles
    .filter(f => !prunedPaths.has(f.path))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  // Helper to calculate current active files and active bytes
  let currentFileCount = allFiles.length - prunedPaths.size;
  let currentTotalBytes = allFiles
    .filter(f => !prunedPaths.has(f.path))
    .reduce((acc, f) => acc + f.size, 0);

  // 3. Max Files (Quota) pass - prune oldest first
  if (typeof maxFiles === "number" && maxFiles >= 0) {
    for (const f of remainingEligible) {
      if (currentFileCount <= maxFiles) break;
      if (prunedPaths.has(f.path)) continue;

      prunedPaths.add(f.path);
      prunedFiles.push({
        path: f.path,
        filename: f.filename,
        sessionId: f.sessionId,
        source: f.source,
        size: f.size,
        reason: `exceeded_max_files (limit: ${maxFiles})`,
      });
      currentFileCount -= 1;
      currentTotalBytes -= f.size;
    }
  }

  // 4. Max Total Bytes pass - prune oldest first until under budget
  if (typeof maxTotalBytes === "number" && maxTotalBytes > 0) {
    for (const f of remainingEligible) {
      if (currentTotalBytes <= maxTotalBytes) break;
      if (prunedPaths.has(f.path)) continue;

      prunedPaths.add(f.path);
      prunedFiles.push({
        path: f.path,
        filename: f.filename,
        sessionId: f.sessionId,
        source: f.source,
        size: f.size,
        reason: `exceeded_max_total_bytes (current: ${(currentTotalBytes / (1024 * 1024)).toFixed(1)}MB, limit: ${(maxTotalBytes / (1024 * 1024)).toFixed(1)}MB)`,
      });
      currentFileCount -= 1;
      currentTotalBytes -= f.size;
    }
  }

  // Physical deletion if not dryRun
  let reclaimedBytes = 0;
  if (!dryRun) {
    for (const pruned of prunedFiles) {
      try {
        unlinkSync(pruned.path);
        reclaimedBytes += pruned.size;
        if (removeEmptyDirs) {
          cleanEmptyDirs(dirname(pruned.path), sessionsDir);
        }
      } catch {
        // Silently continue if file was already removed or locked
      }
    }
  } else {
    reclaimedBytes = prunedFiles.reduce((acc, f) => acc + f.size, 0);
  }

  let staleDbRowsRemoved = 0;
  if (options.syncSqliteState) {
    const syncRes = syncCodexStateDatabase(options.stateDbPath, { dryRun });
    staleDbRowsRemoved = syncRes.staleRowsRemoved;
  }

  const remainingFiles = allFiles.length - prunedFiles.length;
  const remainingBytes = Math.max(0, totalInitialBytes - reclaimedBytes);

  return {
    scannedFiles: allFiles.length,
    totalInitialBytes,
    prunedFiles,
    reclaimedBytes,
    remainingFiles,
    remainingBytes,
    dryRun,
    staleDbRowsRemoved,
  };
}

export interface SessionJanitorOptions {
  enabled?: boolean;
  intervalMs?: number;
  initialDelayMs?: number;
  sessionsDir?: string;
  maxFiles?: number;
  maxTotalBytes?: number;
  maxAgeMs?: number;
  protectRecentMs?: number;
  targetSources?: string[];
  minFileSizeBytes?: number;
  dryRun?: boolean;
  runOnStart?: boolean;
  logger?: (message: string) => void;
}

export interface SessionJanitorStats {
  enabled: boolean;
  running: boolean;
  runs_count: number;
  last_run_at: string | null;
  last_pruned_count: number;
  last_reclaimed_bytes: number;
  last_error: string | null;
  policy: {
    max_files?: number;
    max_total_bytes?: number;
    max_age_days?: number;
    protect_recent_hours?: number;
    target_sources?: string[];
  };
}

export class SessionStoreJanitor {
  private readonly options: SessionJanitorOptions;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private initialTimeout: NodeJS.Timeout | null = null;
  private runsCount = 0;
  private lastRunAt: string | null = null;
  private lastPrunedCount = 0;
  private lastReclaimedBytes = 0;
  private lastError: string | null = null;

  constructor(options: SessionJanitorOptions = {}) {
    this.options = {
      enabled: options.enabled ?? true,
      intervalMs: options.intervalMs ?? 6 * 3600 * 1000, // 6 hours
      initialDelayMs: options.initialDelayMs ?? 10_000, // 10 seconds
      sessionsDir: options.sessionsDir ?? defaultCodexSessionsDir(),
      maxAgeMs: options.maxAgeMs ?? 7 * 86_400_000, // 7 days
      protectRecentMs: options.protectRecentMs ?? 3_600_000, // 1 hour
      targetSources: options.targetSources ?? ["subagent:thread_spawn", "subagent:other"],
      dryRun: options.dryRun ?? false,
      runOnStart: options.runOnStart ?? true,
      ...options,
    };
  }

  public start(): void {
    if (this.running || this.options.enabled === false) return;
    this.running = true;

    if (this.options.runOnStart) {
      const delay = this.options.initialDelayMs ?? 10_000;
      this.initialTimeout = setTimeout(() => {
        if (!this.running) return;
        this.runNow();
      }, delay);
    }

    const interval = this.options.intervalMs ?? 6 * 3600 * 1000;
    this.timer = setInterval(() => {
      if (!this.running) return;
      this.runNow();
    }, interval);
  }

  public stop(): void {
    this.running = false;
    if (this.initialTimeout) {
      clearTimeout(this.initialTimeout);
      this.initialTimeout = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public runNow(): CodexSessionPruneResult {
    try {
      const result = pruneCodexSessions({
        sessionsDir: this.options.sessionsDir,
        maxFiles: this.options.maxFiles,
        maxTotalBytes: this.options.maxTotalBytes,
        maxAgeMs: this.options.maxAgeMs,
        protectRecentMs: this.options.protectRecentMs,
        targetSources: this.options.targetSources,
        minFileSizeBytes: this.options.minFileSizeBytes,
        dryRun: this.options.dryRun,
        removeEmptyDirs: true,
      });

      this.runsCount += 1;
      this.lastRunAt = new Date().toISOString();
      this.lastPrunedCount = result.prunedFiles.length;
      this.lastReclaimedBytes = result.reclaimedBytes;
      this.lastError = null;
      // Record metrics — non-blocking, never throws
      try {
        runtimeMetrics.recordJanitorRun({
          filesPruned: result.prunedFiles.length,
          bytesReclaimed: result.reclaimedBytes,
          error: false,
        });
      } catch { /* ignore */ }

      if (this.options.logger) {
        this.options.logger(
          `[session-janitor] Scanned ${result.scannedFiles} sessions, pruned ${result.prunedFiles.length} files, reclaimed ${result.reclaimedBytes} bytes`,
        );
      }
      return result;
    } catch (error) {
      this.runsCount += 1;
      this.lastRunAt = new Date().toISOString();
      this.lastError = error instanceof Error ? error.message : String(error);
      // Record error metrics — non-blocking, never throws
      try {
        runtimeMetrics.recordJanitorRun({ filesPruned: 0, bytesReclaimed: 0, error: true });
      } catch { /* ignore */ }
      if (this.options.logger) {
        this.options.logger(`[session-janitor] Error during prune: ${this.lastError}`);
      }
      return {
        scannedFiles: 0,
        totalInitialBytes: 0,
        prunedFiles: [],
        reclaimedBytes: 0,
        remainingFiles: 0,
        remainingBytes: 0,
        dryRun: this.options.dryRun ?? false,
      };
    }
  }

  public getStats(): SessionJanitorStats {
    return {
      enabled: this.options.enabled !== false,
      running: this.running,
      runs_count: this.runsCount,
      last_run_at: this.lastRunAt,
      last_pruned_count: this.lastPrunedCount,
      last_reclaimed_bytes: this.lastReclaimedBytes,
      last_error: this.lastError,
      policy: {
        max_files: this.options.maxFiles,
        max_total_bytes: this.options.maxTotalBytes,
        max_age_days: this.options.maxAgeMs ? this.options.maxAgeMs / 86_400_000 : undefined,
        protect_recent_hours: this.options.protectRecentMs ? this.options.protectRecentMs / 3_600_000 : undefined,
        target_sources: this.options.targetSources,
      },
    };
  }
}

