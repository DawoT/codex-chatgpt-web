import { open, mkdir, stat, rename, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

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
  terminalState: "completed" | "cancelled" | "failed" | "transport_dropped";
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
}

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MiB
const DEFAULT_MAX_FILES = 5;
const SENSITIVE_KEY_PATTERN = /(token|secret|password|auth|bearer|credential|prompt|body|cookie|header)/i;

function sanitizeMetadata(metadata?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
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

  constructor(directory: string, options?: TelemetryTraceSinkOptions) {
    this.directory = directory;
    this.maxFileBytes = options?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;
  }

  private async rotateIfNeeded(activePath: string): Promise<void> {
    const currentStat = await stat(activePath).catch(() => null);
    if (!currentStat || currentStat.size < this.maxFileBytes) return;

    // Shift existing rotated files: telemetry.jsonl.N -> telemetry.jsonl.(N+1)
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const src = i === 1 ? activePath : join(this.directory, `telemetry.jsonl.${i - 1}`);
      const dst = join(this.directory, `telemetry.jsonl.${i}`);
      const srcStat = await stat(src).catch(() => null);
      if (srcStat) {
        if (i === this.maxFiles - 1) {
          await rm(dst, { force: true }).catch(() => {});
        }
        await rename(src, dst).catch(() => {});
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
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.metadata ? { metadata: sanitizeMetadata(entry.metadata) } : {}),
    };

    const line = `${JSON.stringify(record)}\n`;
    const activePath = join(this.directory, "telemetry.jsonl");

    // Serialize file writes and rotations with mutex
    this.writeMutex = this.writeMutex.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await this.rotateIfNeeded(activePath);
      const handle = await open(activePath, "a", 0o600);
      try {
        await handle.writeFile(line, "utf8");
      } finally {
        await handle.close();
      }
    });

    await this.writeMutex;
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
    const records: TelemetryTraceRecord[] = [];

    // Find all telemetry files in order
    const files = await readdir(this.directory).catch(() => []);
    const traceFiles = files
      .filter(f => f.startsWith("telemetry.jsonl"))
      .sort((a, b) => {
        if (a === "telemetry.jsonl") return -1;
        if (b === "telemetry.jsonl") return 1;
        const numA = parseInt(a.replace("telemetry.jsonl.", ""), 10) || 0;
        const numB = parseInt(b.replace("telemetry.jsonl.", ""), 10) || 0;
        return numA - numB;
      });

    for (const f of traceFiles) {
      if (records.length >= limit) break;
      const content = await readFile(join(this.directory, f), "utf8").catch(() => "");
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
