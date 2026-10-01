import { randomUUID } from "node:crypto";
import { readFile, rename, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { DiagnosticSink, type DiagnosticSinkOptions } from "../../diagnostics/sink";

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

export type TelemetryTraceSinkOptions = DiagnosticSinkOptions<TelemetryTraceRecord>;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9:_-][A-Za-z0-9:_.-]{0,127}$/;
const KINDS = new Set(["turn", "tool_call", "command", "compaction"]);
const TERMINAL_STATES = new Set(["pending", "completed", "cancelled", "failed", "transport_dropped"]);
const METADATA_ENUMS: Record<string, ReadonlySet<string>> = {
  event: new Set([
    "unknown",
    "call_received",
    "call_cancelled",
    "uncorrelated_call",
    "reply_sent",
    "reply_send_failed",
    "transport_ready",
    "transport_error",
    "transport_closed",
    "broker_claimed",
    "broker_queued",
    "broker_delivered",
    "broker_result_received",
    "broker_compaction_cancelled",
    "broker_abandoned",
    "browser_observed",
    "codex_emitted",
    "host_started",
    "result_received",
  ]),
  scope: new Set(["broker_tool_lifecycle", "mcp_transport_only"]),
  terminal_cause: new Set(["user_cancelled", "handoff_accepted", "deadline", "transport", "internal_failure"]),
  evidence: new Set([
    "broker_claim_succeeded",
    "proven_by_result_arrival",
    "tool_result",
    "host_tool_result",
    "handed_to_adapter_only",
    "adapter_replayed_tool_call",
    "browser_acknowledged_tool_boundary",
    "adapter_emitted_tool_call",
  ]),
  tool: new Set([
    "unknown",
    "mcp_transport",
    "codex_turn_start",
    "codex_exec",
    "codex_exec_command",
    "codex_write_stdin",
    "codex_apply_patch",
    "codex_view_image",
    "codex_image_generate",
    "image_gen",
    "codex_read_file",
    "codex_write_file",
    "codex_patch_file",
    "codex_list_dir",
    "codex_grep",
    "codex_tool_inventory",
    "codex_tool_call",
    "codex_poll_task",
    "codex_wait_tasks",
    "codex_turn_complete",
  ]),
};
const METADATA_NUMBERS = new Set([
  "protocol_version",
  "process_pid",
  "call",
  "dropped_events",
  "failed_writes",
  "tracked_calls",
  "itemIndex",
]);
const METADATA_BOOLEANS = new Set(["safeFlag", "execution_observed", "delivery_observed"]);

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value) && !value.startsWith("sk-") ? value : undefined;
}

function finiteMeasurement(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function numericFields(value: unknown, keys: readonly string[]): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const fields = Object.fromEntries(
    keys.flatMap((key) => (finiteMeasurement(source[key]) ? [[key, source[key]]] : [])),
  );
  return Object.keys(fields).length > 0 ? fields : undefined;
}

function sanitizeMetadata(metadata: unknown): Record<string, unknown> | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const source = metadata as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const [key, allowed] of Object.entries(METADATA_ENUMS)) {
    if (typeof source[key] === "string" && allowed.has(source[key])) {
      sanitized[key] = source[key];
    }
  }
  for (const key of METADATA_NUMBERS) {
    if (finiteMeasurement(source[key]) && Number.isSafeInteger(source[key])) {
      sanitized[key] = source[key];
    }
  }
  if (finiteMeasurement(source.elapsed_ms)) {
    sanitized.elapsed_ms = source.elapsed_ms;
  }
  for (const key of METADATA_BOOLEANS) {
    if (typeof source[key] === "boolean") {
      sanitized[key] = source[key];
    }
  }
  for (const [key, pattern] of [
    ["build_commit", /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/],
    ["artifact_sha256", /^[a-f0-9]{64}$/],
    ["process_generation", /^[a-f0-9-]{36}$/],
  ] as const) {
    if (source[key] === null || (typeof source[key] === "string" && pattern.test(source[key]))) {
      sanitized[key] = source[key];
    }
  }
  const turnTraceId = identifier(source.turn_trace_id);
  if (turnTraceId) {
    sanitized.turn_trace_id = turnTraceId;
  }
  return sanitized;
}

function sanitizedRecord(
  entry: Omit<TelemetryTraceRecord, "version" | "timestamp">,
  timestamp: number,
): TelemetryTraceRecord {
  const tokens = numericFields(entry.tokens, ["inputEstimated", "outputReported", "cached"]);
  const times = numericFields(entry.times, ["startMs", "endMs", "durationMs"]);
  const bytesTransferred = numericFields(entry.bytesTransferred, ["sent", "received"]);
  const metadata = sanitizeMetadata(entry.metadata);
  const turnId = identifier(entry.turnId);
  const brokerCallId = identifier(entry.brokerCallId);
  const sessionId = identifier(entry.sessionId);
  const model =
    typeof entry.model === "string" && /^(?:chatgpt-web\/|gpt-)[A-Za-z0-9_.-]{1,100}$/.test(entry.model)
      ? entry.model
      : undefined;
  return {
    version: 1,
    timestamp,
    traceId: identifier(entry.traceId) ?? "invalid",
    ...(turnId ? { turnId } : {}),
    ...(brokerCallId ? { brokerCallId } : {}),
    ...(sessionId ? { sessionId } : {}),
    kind: KINDS.has(entry.kind) ? entry.kind : "turn",
    ...(model ? { model } : {}),
    ...(tokens ? { tokens } : {}),
    ...(times && finiteMeasurement(times.startMs) ? { times: times as TelemetryTraceRecord["times"] } : {}),
    terminalState: TERMINAL_STATES.has(entry.terminalState) ? entry.terminalState : "failed",
    ...(bytesTransferred ? { bytesTransferred } : {}),
    ...(entry.error ? { error: "operation_failed" } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

/** V1 telemetry compatibility boundary; producers cannot persist arbitrary metadata or errors. */
export class TelemetryTraceSink {
  private readonly sink: DiagnosticSink<TelemetryTraceRecord>;

  constructor(
    private readonly directory: string,
    options: TelemetryTraceSinkOptions = {},
  ) {
    this.sink = new DiagnosticSink(directory, {
      ...options,
      fallback:
        options.fallback ??
        ((record, failure) => {
          console.error(JSON.stringify({ event: "telemetry_fallback", ...failure, record }));
        }),
    });
  }

  health(): ReturnType<DiagnosticSink<TelemetryTraceRecord>["health"]> {
    return this.sink.health();
  }

  flush(deadlineMs = 1000): Promise<boolean> {
    return this.sink.flush(deadlineMs);
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

  record(entry: Omit<TelemetryTraceRecord, "version" | "timestamp">): Promise<TelemetryTraceRecord> {
    return this.sink.record(sanitizedRecord(entry, Date.now()));
  }

  async query(options?: {
    traceId?: string;
    sessionId?: string;
    kind?: TelemetryTraceRecord["kind"];
    limit?: number;
  }): Promise<TelemetryTraceRecord[]> {
    const limit = options?.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new RangeError("Telemetry query limit must be between 1 and 1000");
    }
    const records = await this.sink.query();
    return records
      .filter(
        (entry) =>
          entry.version === 1 &&
          finiteMeasurement(entry.timestamp) &&
          Boolean(identifier(entry.traceId)) &&
          KINDS.has(entry.kind) &&
          TERMINAL_STATES.has(entry.terminalState),
      )
      .map((entry) => sanitizedRecord(entry, entry.timestamp))
      .filter(
        (entry) =>
          (!options?.traceId || entry.traceId === options.traceId) &&
          (!options?.sessionId || entry.sessionId === options.sessionId) &&
          (!options?.kind || entry.kind === options.kind),
      )
      .sort((left, right) => right.timestamp - left.timestamp)
      .slice(0, limit);
  }
}
