import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { runtimeIdentity } from "../../runtime-identity";

export interface TelemetryTraceRecord {
  version: 1;
  timestamp: number;
  traceId: string;
  turnId?: string;
  brokerCallId?: string;
  sessionId?: string;
  kind: "turn" | "tool_call" | "command" | "compaction";
  model?: string;
  tokens?: {
    inputEstimated?: number;
    outputReported?: number;
    cached?: number;
  };
  times?: {
    startMs: number;
    endMs?: number;
    durationMs?: number;
  };
  terminalState: "pending" | "completed" | "cancelled" | "failed" | "transport_dropped";
  bytesTransferred?: {
    sent?: number;
    received?: number;
  };
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface TelemetryTraceSinkOptions {
  maxFileBytes?: number;
  maxFiles?: number;
  maxPendingRecords?: number;
  maxPendingBytes?: number;
  lockDeadlineMs?: number;
}

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MiB
const DEFAULT_MAX_FILES = 5;
const SENSITIVE_KEY_PATTERN = /(token|secret|password|auth|bearer|credential|prompt|body|cookie|header)/i;

function sanitizeMetadata(metadata?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    // Structured request fragments are not telemetry. Do not recursively retain them.
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) continue;
    if (typeof value === "string" && (value.startsWith("sk-") || value.length > 512)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

export class TelemetryTraceSink {
  private readonly directory: string;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private writeMutex: Promise<void> = Promise.resolve();
  private readonly ownerId = randomUUID();
  private readonly maxPendingRecords: number;
  private readonly maxPendingBytes: number;
  private readonly lockDeadlineMs: number;
  private pendingRecords = 0;
  private pendingBytes = 0;
  private failedWrites = 0;
  private droppedRecords = 0;

  health(): {
    status: "healthy" | "degraded";
    pendingRecords: number;
    pendingBytes: number;
    failedWrites: number;
    droppedRecords: number;
  } {
    return {
      status: this.failedWrites || this.droppedRecords ? "degraded" : "healthy",
      pendingRecords: this.pendingRecords,
      pendingBytes: this.pendingBytes,
      failedWrites: this.failedWrites,
      droppedRecords: this.droppedRecords,
    };
  }

  async flush(deadlineMs = 1000): Promise<boolean> {
    if (!Number.isFinite(deadlineMs) || deadlineMs < 0) throw new RangeError("Invalid telemetry flush deadline");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.writeMutex.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), deadlineMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private fallback(record: TelemetryTraceRecord, reason: string): void {
    try {
      console.error(JSON.stringify({ event: "telemetry_fallback", reason, record }));
    } catch {
      // Observability must not affect execution or delivery.
    }
  }

  /** Ambiguous legacy locks remain untouched; recovery requires affirmative runtime quiescence. */
  async recoverWriterLock(runtimeInactive: () => Promise<boolean>): Promise<boolean> {
    if (!(await runtimeInactive())) return false;
    const path = join(this.directory, ".telemetry.lock");
    try {
      const info = await stat(path);
      const original = await readFile(join(path, "owner.json"), "utf8");
      const owner = JSON.parse(original) as { pid?: unknown; generation?: unknown; ownerId?: unknown; host?: unknown };
      if (
        !Number.isSafeInteger(owner.pid) ||
        Number(owner.pid) <= 0 ||
        typeof owner.generation !== "string" ||
        typeof owner.ownerId !== "string" ||
        owner.host !== hostname()
      )
        return false;
      try {
        process.kill(Number(owner.pid), 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
      }
      if (!(await runtimeInactive())) return false;
      const current = await stat(path);
      if (
        current.ino !== info.ino ||
        current.dev !== info.dev ||
        (await readFile(join(path, "owner.json"), "utf8")) !== original
      )
        return false;
      await rename(path, join(this.directory, `.telemetry.lock.abandoned.${randomUUID()}`));
      return true;
    } catch {
      return false;
    }
  }

  constructor(directory: string, options?: TelemetryTraceSinkOptions) {
    this.directory = directory;
    this.maxFileBytes = options?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxPendingRecords = options?.maxPendingRecords ?? 256;
    this.maxPendingBytes = options?.maxPendingBytes ?? 1024 * 1024;
    this.lockDeadlineMs = options?.lockDeadlineMs ?? 1000;
    if (
      ![this.maxPendingRecords, this.maxPendingBytes, this.lockDeadlineMs].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    ) {
      throw new RangeError("Telemetry queue and lock budgets must be positive safe integers");
    }
    if (
      !Number.isSafeInteger(this.maxFileBytes) ||
      this.maxFileBytes < 128 ||
      !Number.isSafeInteger(this.maxFiles) ||
      this.maxFiles < 1 ||
      this.maxFiles > 100
    ) {
      throw new RangeError("Telemetry requires maxFileBytes >= 128 and maxFiles between 1 and 100");
    }
  }

  private async withWriterLock<T>(operation: () => Promise<T>): Promise<T> {
    const path = join(this.directory, ".telemetry.lock");
    const deadline = performance.now() + this.lockDeadlineMs;
    while (true) {
      try {
        await mkdir(path, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (performance.now() >= deadline)
          throw new Error("Telemetry writer lock unavailable; verify crashed writer before manual recovery");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    try {
      await writeFile(
        join(path, "owner.json"),
        JSON.stringify({
          version: 1,
          pid: process.pid,
          generation: runtimeIdentity.generation,
          ownerId: this.ownerId,
          host: hostname(),
        }),
        { mode: 0o600, flag: "wx" },
      );
      return await operation();
    } finally {
      await rm(path, { recursive: true });
    }
  }

  private async rotateIfNeeded(activePath: string, incomingBytes: number): Promise<void> {
    const currentStat = await stat(activePath).catch(() => null);
    if (!currentStat || currentStat.size + incomingBytes <= this.maxFileBytes) return;
    if (!currentStat.isFile()) throw new Error("Telemetry destination must be a regular file");
    if (this.maxFiles === 1) {
      await rm(activePath);
      return;
    }

    // Shift existing rotated files: telemetry.jsonl.N -> telemetry.jsonl.(N+1)
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const src = i === 1 ? activePath : join(this.directory, `telemetry.jsonl.${i - 1}`);
      const dst = join(this.directory, `telemetry.jsonl.${i}`);
      const srcStat = await stat(src).catch(() => null);
      if (srcStat) {
        if (i === this.maxFiles - 1) {
          await rm(dst, { force: true });
        }
        await rename(src, dst);
      }
    }
  }

  async record(entry: Omit<TelemetryTraceRecord, "version" | "timestamp">): Promise<TelemetryTraceRecord> {
    const record: TelemetryTraceRecord = {
      version: 1,
      timestamp: Date.now(),
      traceId: entry.traceId,
      ...(entry.turnId ? { turnId: entry.turnId } : {}),
      ...(entry.brokerCallId ? { brokerCallId: entry.brokerCallId } : {}),
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      kind: entry.kind,
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.tokens ? { tokens: entry.tokens } : {}),
      ...(entry.times ? { times: entry.times } : {}),
      terminalState: entry.terminalState,
      ...(entry.bytesTransferred ? { bytesTransferred: entry.bytesTransferred } : {}),
      ...(entry.error ? { error: "operation_failed" } : {}),
      ...(entry.metadata ? { metadata: sanitizeMetadata(entry.metadata) } : {}),
    };

    const line = `${JSON.stringify(record)}\n`;
    const incomingBytes = Buffer.byteLength(line, "utf8");
    if (incomingBytes > this.maxFileBytes) {
      this.droppedRecords += 1;
      this.fallback(record, "record_budget_exceeded");
      throw new RangeError("Telemetry record exceeds the file budget");
    }
    if (this.pendingRecords >= this.maxPendingRecords || this.pendingBytes + incomingBytes > this.maxPendingBytes) {
      this.droppedRecords += 1;
      this.fallback(record, "queue_budget_exceeded");
      throw new RangeError("Telemetry queue budget exceeded");
    }
    this.pendingRecords += 1;
    this.pendingBytes += incomingBytes;
    const activePath = join(this.directory, "telemetry.jsonl");

    // Serialize file writes and rotations with mutex
    const pending = this.writeMutex.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await this.withWriterLock(async () => {
        await this.rotateIfNeeded(activePath, incomingBytes);
        const handle = await open(
          activePath,
          constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          0o600,
        );
        try {
          if (!(await handle.stat()).isFile()) throw new Error("Telemetry destination must be a regular file");
          await handle.writeFile(line, "utf8");
        } finally {
          await handle.close();
        }
      });
    });

    const tracked = pending
      .catch((error) => {
        this.failedWrites += 1;
        this.fallback(record, "write_failed");
        throw error;
      })
      .finally(() => {
        this.pendingRecords -= 1;
        this.pendingBytes -= incomingBytes;
      });
    this.writeMutex = tracked.catch(() => {});
    await tracked;
    return record;
  }

  async query(options?: {
    traceId?: string;
    sessionId?: string;
    kind?: TelemetryTraceRecord["kind"];
    limit?: number;
  }): Promise<TelemetryTraceRecord[]> {
    await this.writeMutex;
    const limit = options?.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new RangeError("Telemetry query limit must be between 1 and 1000");
    const records: TelemetryTraceRecord[] = [];

    // Find all telemetry files in order
    const files = await readdir(this.directory).catch(() => []);
    const traceFiles = files
      .filter(
        (f) =>
          f === "telemetry.jsonl" ||
          (/^telemetry\.jsonl\.[1-9][0-9]*$/.test(f) && Number(f.split(".").at(-1)) < this.maxFiles),
      )
      .sort((a, b) => {
        if (a === "telemetry.jsonl") return -1;
        if (b === "telemetry.jsonl") return 1;
        const numA = parseInt(a.replace("telemetry.jsonl.", ""), 10) || 0;
        const numB = parseInt(b.replace("telemetry.jsonl.", ""), 10) || 0;
        return numA - numB;
      });

    for (const f of traceFiles) {
      if (records.length >= limit) break;
      const handle = await open(
        join(this.directory, f),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      ).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      if (!handle) continue;
      let content: string;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > this.maxFileBytes)
          throw new Error("Telemetry archive exceeds its budget or is not a regular file");
        content = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
      const lines = content.trim().split("\n").filter(Boolean).reverse();
      for (const line of lines) {
        if (records.length >= limit) break;
        try {
          const rec: TelemetryTraceRecord = JSON.parse(line);
          if (rec.version !== 1) continue;
          if (options?.traceId && rec.traceId !== options.traceId) continue;
          if (options?.sessionId && rec.sessionId !== options.sessionId) continue;
          if (options?.kind && rec.kind !== options.kind) continue;
          records.push(rec);
        } catch {
          // ignore torn or corrupted lines
        }
      }
    }

    return records;
  }
}
