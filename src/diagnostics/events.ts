import { randomUUID } from "node:crypto";
import { type RuntimeIdentity, runtimeIdentity } from "../runtime-identity";
import { type DiagnosticErrorV1, diagnosticCode, parseDiagnosticError, serializeDiagnosticError } from "./errors";

export type DiagnosticProducer = "main" | "browser" | "helper" | "launcher" | "mcp" | "broker";
export type DiagnosticPhase =
  | "received"
  | "claimed"
  | "observed"
  | "emitted"
  | "started"
  | "result_received"
  | "delivered"
  | "reconciled"
  | "failed"
  | "cancelled"
  | "dropped";
export type DiagnosticEventName =
  | "unknown"
  | "stage_started"
  | "stage_completed"
  | "stage_failed"
  | "diagnostic_capture"
  | "page_error"
  | "page_crashed"
  | "page_closed"
  | "page_request_failed"
  | "page_response"
  | "transport_ready"
  | "transport_error"
  | "transport_closed"
  | "reply_send_failed"
  | "reply_sent"
  | "call_received"
  | "call_cancelled"
  | "uncorrelated_call"
  | "broker_queued"
  | "broker_delivered"
  | "broker_claimed"
  | "browser_observed"
  | "codex_emitted"
  | "host_started"
  | "result_received"
  | "broker_result_received"
  | "broker_compaction_cancelled"
  | "broker_abandoned"
  | "helper_error"
  | "compaction_checkpoint";

export interface DiagnosticCorrelation {
  traceId?: string;
  turnId?: string;
  brokerCallId?: string;
  sessionId?: string;
  operationId?: string;
  startupId?: string;
  requestId?: string;
  documentGeneration?: number;
}

export type DiagnosticRuntimeIdentity = RuntimeIdentity & {
  artifactSetSha256?: string | null;
  artifactVerification?: "paired_manifest_verified" | "entrypoint_only" | "manifest_mismatch" | "unavailable";
};

export interface DiagnosticEventV2 {
  version: 2;
  eventId: string;
  producer: DiagnosticProducer;
  producerId: string;
  sequence: number;
  occurredAt: string;
  writtenAt?: string;
  monotonicMs: number;
  runtime: DiagnosticRuntimeIdentity;
  correlation: DiagnosticCorrelation;
  event: DiagnosticEventName;
  phase: DiagnosticPhase;
  fields: Record<string, number | boolean | string>;
  error?: DiagnosticErrorV1;
}

export interface DiagnosticEventInput {
  event: DiagnosticEventName;
  phase: DiagnosticPhase;
  correlation?: DiagnosticCorrelation;
  fields?: Record<string, unknown>;
  error?: unknown;
}

const PRODUCERS = new Set(["main", "browser", "helper", "launcher", "mcp", "broker"]);
const PHASES = new Set([
  "received",
  "claimed",
  "observed",
  "emitted",
  "started",
  "result_received",
  "delivered",
  "reconciled",
  "failed",
  "cancelled",
  "dropped",
]);
const EVENTS = new Set([
  "unknown",
  "stage_started",
  "stage_completed",
  "stage_failed",
  "diagnostic_capture",
  "page_error",
  "page_crashed",
  "page_closed",
  "page_request_failed",
  "page_response",
  "transport_ready",
  "transport_error",
  "transport_closed",
  "reply_send_failed",
  "reply_sent",
  "call_received",
  "call_cancelled",
  "uncorrelated_call",
  "broker_queued",
  "broker_delivered",
  "broker_claimed",
  "browser_observed",
  "codex_emitted",
  "host_started",
  "result_received",
  "broker_result_received",
  "broker_compaction_cancelled",
  "broker_abandoned",
  "helper_error",
  "compaction_checkpoint",
]);
const NUMERIC_FIELDS = new Set([
  "durationMs",
  "elapsedMs",
  "status",
  "call",
  "trackedCalls",
  "revision",
  "attempt",
  "min",
  "max",
  "value",
  "expectedValue",
  "effortIndex",
  "droppedEvents",
  "failedWrites",
  "documentGeneration",
  "observedValue",
  "issueCount",
  "requirementCount",
]);
const BOOLEAN_FIELDS = new Set([
  "executionObserved",
  "deliveryObserved",
  "stateCaptured",
  "screenshotCaptured",
  "pageClosed",
  "localPersisted",
]);
const STAGES = new Set([
  "page-acquisition",
  "browser-page-acquisition",
  "model-selection",
  "effort-selection",
  "prompt-attachment",
  "file-attachment",
  "send",
  "assistant-observation",
  "surface-preparation",
  "prepare-chat-surface",
  "wait-for-completion",
  "browser_page",
  "browser_page_rebind",
  "temporary_chat_preparation",
  "effort_selection",
  "final_part_effort_selection",
  "prompt_attachment",
  "connector_catalog_refresh",
  "file_attachment",
  "response_completion",
  "assistant_response",
]);
const TOOLS = new Set(["mcp_transport", "exec_command", "write_stdin", "apply_patch", "request_user_input", "unknown"]);
const EVIDENCE = new Set(["observed", "missing", "failed", "not_requested", "disabled", "captured", "uncorrelated"]);

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9:_/-]{1,128}$/.test(value) && !value.startsWith("sk-")
    ? value
    : undefined;
}

function correlation(value?: DiagnosticCorrelation): DiagnosticCorrelation {
  const result: DiagnosticCorrelation = {};
  for (const key of [
    "traceId",
    "turnId",
    "brokerCallId",
    "sessionId",
    "operationId",
    "startupId",
    "requestId",
  ] as const) {
    const id = identifier(value?.[key]);
    if (id) result[key] = id;
  }
  if (Number.isSafeInteger(value?.documentGeneration) && value!.documentGeneration! >= 0)
    result.documentGeneration = value!.documentGeneration;
  return result;
}

function fields(value?: Record<string, unknown>): DiagnosticEventV2["fields"] {
  const result: DiagnosticEventV2["fields"] = {};
  for (const key of NUMERIC_FIELDS) {
    const candidate = value?.[key];
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) result[key] = candidate;
  }
  for (const key of BOOLEAN_FIELDS) {
    if (typeof value?.[key] === "boolean") result[key] = value[key];
  }
  const reason = diagnosticCode({ code: value?.reason });
  if (value?.reason !== undefined) result.reason = reason;
  for (const [key, allowed] of [
    ["stage", STAGES],
    ["tool", TOOLS],
    ["evidence", EVIDENCE],
  ] as const) {
    const candidate = value?.[key];
    if (
      typeof candidate === "string" &&
      (allowed.has(candidate) ||
        (key === "stage" &&
          (/^multipart_stage_(?:[1-9]|[1-9][0-9])_(?:effort_selection|attachment|send|acknowledgement)$/.test(
            candidate,
          ) ||
            /^response_page_rebind_[1-9][0-9]?$/.test(candidate))))
    )
      result[key] = candidate;
  }
  for (const [key, allowed] of [
    [
      "checkpointPhase",
      ["prepared", "received", "validated", "repair_started", "persisted", "accepted", "delivered", "failed"],
    ],
    ["route", ["retained", "fallback", "fresh", "unknown"]],
    ["outcome", ["pending", "succeeded", "skipped", "rejected", "failed"]],
  ] as const) {
    const candidate = value?.[key];
    if (typeof candidate === "string" && (allowed as readonly string[]).includes(candidate)) result[key] = candidate;
  }
  const terminalCause = value?.terminalCause;
  if (
    typeof terminalCause === "string" &&
    ["user_cancelled", "handoff_accepted", "deadline", "transport", "internal_failure"].includes(terminalCause)
  )
    result.terminalCause = terminalCause;
  return result;
}

function runtime(value: DiagnosticRuntimeIdentity): DiagnosticRuntimeIdentity {
  const verification = value.artifactVerification;
  return {
    ...(value.artifactSetSha256 === undefined
      ? {}
      : {
          artifactSetSha256:
            typeof value.artifactSetSha256 === "string" && /^[a-f0-9]{64}$/.test(value.artifactSetSha256)
              ? value.artifactSetSha256
              : null,
        }),
    ...(verification !== undefined &&
    ["paired_manifest_verified", "entrypoint_only", "manifest_mismatch", "unavailable"].includes(verification)
      ? { artifactVerification: verification }
      : {}),
    protocolVersion:
      Number.isSafeInteger(value.protocolVersion) && value.protocolVersion > 0
        ? value.protocolVersion
        : runtimeIdentity.protocolVersion,
    buildCommit:
      typeof value.buildCommit === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.buildCommit)
        ? value.buildCommit
        : null,
    artifactSha256:
      typeof value.artifactSha256 === "string" && /^[a-f0-9]{64}$/.test(value.artifactSha256)
        ? value.artifactSha256
        : null,
    generation:
      typeof value.generation === "string" && /^[a-f0-9-]{36}$/.test(value.generation)
        ? value.generation
        : runtimeIdentity.generation,
    pid: Number.isSafeInteger(value.pid) && value.pid > 0 ? value.pid : runtimeIdentity.pid,
  };
}

export function createDiagnosticProducer(
  producer: DiagnosticProducer,
  identity = runtimeIdentity,
): (input: DiagnosticEventInput) => DiagnosticEventV2 {
  const producerId = randomUUID();
  const safeRuntime = runtime(identity);
  let sequence = 0;
  let monotonicMs = 0;
  return (input) => {
    monotonicMs = Math.max(monotonicMs, performance.now());
    return {
      version: 2,
      eventId: randomUUID(),
      producer: PRODUCERS.has(producer) ? producer : "main",
      producerId,
      sequence: ++sequence,
      occurredAt: new Date().toISOString(),
      monotonicMs,
      runtime: { ...safeRuntime },
      correlation: correlation(input.correlation),
      event: EVENTS.has(input.event) ? input.event : "unknown",
      phase: PHASES.has(input.phase) ? input.phase : "observed",
      fields: fields(input.fields),
      ...(input.error === undefined ? {} : { error: serializeDiagnosticError(input.error) }),
    };
  };
}

export function parseDiagnosticEvent(value: DiagnosticEventV2): DiagnosticEventV2 {
  if (
    !value ||
    value.version !== 2 ||
    !/^[a-f0-9-]{36}$/.test(value.eventId) ||
    !/^[a-f0-9-]{36}$/.test(value.producerId) ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    !Number.isFinite(value.monotonicMs) ||
    value.monotonicMs < 0 ||
    typeof value.occurredAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.occurredAt) ||
    !Number.isFinite(Date.parse(value.occurredAt))
  ) {
    throw new Error("Invalid diagnostic event");
  }
  const identity = value.runtime;
  if (
    !identity ||
    !Number.isSafeInteger(identity.protocolVersion) ||
    identity.protocolVersion <= 0 ||
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 0 ||
    typeof identity.generation !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(identity.generation) ||
    (identity.buildCommit !== null &&
      (typeof identity.buildCommit !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(identity.buildCommit))) ||
    (identity.artifactSha256 !== null &&
      (typeof identity.artifactSha256 !== "string" || !/^[a-f0-9]{64}$/.test(identity.artifactSha256))) ||
    (identity.artifactSetSha256 != null &&
      (typeof identity.artifactSetSha256 !== "string" || !/^[a-f0-9]{64}$/.test(identity.artifactSetSha256))) ||
    (identity.artifactVerification !== undefined &&
      !["paired_manifest_verified", "entrypoint_only", "manifest_mismatch", "unavailable"].includes(
        identity.artifactVerification,
      ))
  ) {
    throw new Error("Invalid diagnostic runtime identity");
  }
  const writtenAt = value.writtenAt;
  if (
    writtenAt !== undefined &&
    (typeof writtenAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(writtenAt) ||
      !Number.isFinite(Date.parse(writtenAt)))
  )
    throw new Error("Invalid diagnostic write time");
  return {
    version: 2,
    eventId: value.eventId,
    producer: PRODUCERS.has(value.producer) ? value.producer : "main",
    producerId: value.producerId,
    sequence: value.sequence,
    occurredAt: value.occurredAt,
    ...(writtenAt === undefined ? {} : { writtenAt }),
    monotonicMs: value.monotonicMs,
    runtime: runtime(value.runtime),
    correlation: correlation(value.correlation),
    event: EVENTS.has(value.event) ? value.event : "unknown",
    phase: PHASES.has(value.phase) ? value.phase : "observed",
    fields: fields(value.fields),
    ...(value.error === undefined ? {} : { error: parseDiagnosticError(value.error) }),
  };
}

interface CaptureEvidence {
  captured: number;
  dropped: number;
  evicted: number;
  missing: boolean;
  scopeForgotten: boolean;
}

export interface DiagnosticSnapshot {
  version: 2;
  events: DiagnosticEventV2[];
  evidence: CaptureEvidence;
}

/** One bounded process ring; turn snapshots filter without ever borrowing another turn's evidence. */
export class DiagnosticEventRing {
  private readonly entries: Array<{ event: DiagnosticEventV2; bytes: number }> = [];
  private readonly evidence = new Map<string, CaptureEvidence>();
  private bytes = 0;
  private dropped = 0;
  private evicted = 0;
  private readonly maxEvents: number;
  private readonly maxBytes: number;

  constructor(options?: { maxEvents?: number; maxBytes?: number }) {
    this.maxEvents = options?.maxEvents ?? 256;
    this.maxBytes = options?.maxBytes ?? 1024 * 1024;
    if (![this.maxEvents, this.maxBytes].every((value) => Number.isSafeInteger(value) && value > 0))
      throw new RangeError("Invalid diagnostic ring budgets");
  }

  private scope(turnId: string): CaptureEvidence {
    let value = this.evidence.get(turnId);
    if (value) return value;
    if (this.evidence.size >= 256) this.evidence.delete(this.evidence.keys().next().value!);
    value = { captured: 0, dropped: 0, evicted: 0, missing: false, scopeForgotten: false };
    this.evidence.set(turnId, value);
    return value;
  }

  record(value: DiagnosticEventV2): boolean {
    const scope = this.scope(identifier(value?.correlation?.turnId) ?? "");
    let event: DiagnosticEventV2;
    try {
      event = parseDiagnosticEvent(value);
    } catch {
      scope.dropped += 1;
      scope.missing = true;
      this.dropped += 1;
      return false;
    }
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > this.maxBytes) {
      scope.dropped += 1;
      scope.missing = true;
      this.dropped += 1;
      return false;
    }
    while (this.entries.length >= this.maxEvents || this.bytes + bytes > this.maxBytes) {
      const previous = this.entries.shift()!;
      this.bytes -= previous.bytes;
      this.evicted += 1;
      const previousScope = this.scope(previous.event.correlation.turnId ?? "");
      previousScope.evicted += 1;
      previousScope.missing = true;
    }
    this.entries.push({ event, bytes });
    this.bytes += bytes;
    scope.captured += 1;
    return true;
  }

  health(): { events: number; bytes: number; dropped: number; evicted: number } {
    return { events: this.entries.length, bytes: this.bytes, dropped: this.dropped, evicted: this.evicted };
  }

  snapshot(turnId: string): DiagnosticSnapshot {
    return {
      version: 2,
      events: this.entries
        .filter((entry) => entry.event.correlation.turnId === turnId)
        .map((entry) => parseDiagnosticEvent(entry.event)),
      evidence: {
        ...(this.evidence.get(turnId) ?? { captured: 0, dropped: 0, evicted: 0, missing: true, scopeForgotten: true }),
      },
    };
  }
}
