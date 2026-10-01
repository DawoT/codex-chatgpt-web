import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getConfigDir } from "../../config";
import { runtimeIdentity } from "../../runtime-identity";
import { TelemetryTraceSink } from "./telemetry-trace";

const TOOL_LIFECYCLE_EVENTS = new Set([
  "broker_claimed",
  "browser_observed",
  "codex_emitted",
  "host_started",
  "result_received",
]);

/** One transport-owned, bounded queue. Logging never changes tool outcomes. */
export class McpTelemetry {
  private readonly instanceId = randomUUID();
  private readonly sink: TelemetryTraceSink;
  private dropped = 0;
  private failed = 0;

  constructor(directory = join(getConfigDir(), "logs", "mcp")) {
    this.sink = new TelemetryTraceSink(directory);
  }

  health(): ReturnType<TelemetryTraceSink["health"]> {
    return this.sink.health();
  }

  flush(deadlineMs = 1000): Promise<boolean> {
    return this.sink.flush(deadlineMs);
  }

  readonly write = (event: Record<string, unknown>): void => {
    const call = Number.isSafeInteger(event.call) ? Number(event.call) : 0;
    const eventName =
      typeof event.event === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(event.event) ? event.event : "unknown";
    const failed =
      eventName === "reply_send_failed" ||
      eventName === "transport_error" ||
      event.outcome === "protocol_error" ||
      event.is_error === true;
    const metadata = {
      protocol_version: runtimeIdentity.protocolVersion,
      build_commit: runtimeIdentity.buildCommit,
      artifact_sha256: runtimeIdentity.artifactSha256,
      process_generation: runtimeIdentity.generation,
      process_pid: runtimeIdentity.pid,
      scope:
        eventName.startsWith("broker_") || TOOL_LIFECYCLE_EVENTS.has(eventName)
          ? "broker_tool_lifecycle"
          : "mcp_transport_only",
      event: eventName,
      tool: typeof event.tool === "string" ? event.tool : "unknown",
      call,
      ...(typeof event.turn_trace_id === "string" && /^[a-zA-Z0-9:_-]{1,128}$/.test(event.turn_trace_id)
        ? { turn_trace_id: event.turn_trace_id }
        : {}),
      dropped_events: this.dropped,
      failed_writes: this.failed,
      execution_observed: eventName === "result_received",
      delivery_observed: eventName === "reply_sent",
      ...(typeof event.terminal_cause === "string" &&
      ["user_cancelled", "handoff_accepted", "deadline", "transport", "internal_failure"].includes(event.terminal_cause)
        ? { terminal_cause: event.terminal_cause }
        : {}),
      ...(typeof event.elapsed_ms === "number" ? { elapsed_ms: event.elapsed_ms } : {}),
      ...(typeof event.tracked_calls === "number" ? { tracked_calls: event.tracked_calls } : {}),
      ...(typeof event.evidence === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(event.evidence)
        ? { evidence: event.evidence }
        : {}),
    };
    void this.sink
      .record({
        traceId:
          typeof event.trace_id === "string" && /^[a-f0-9-]{36}$/.test(event.trace_id)
            ? event.trace_id
            : `${this.instanceId}:${call}`,
        sessionId: this.instanceId,
        ...(typeof event.broker_call_id === "string" && /^call_[a-zA-Z0-9_-]{1,128}$/.test(event.broker_call_id)
          ? { brokerCallId: event.broker_call_id }
          : {}),
        kind: "tool_call",
        terminalState: [
          "call_received",
          "transport_ready",
          "uncorrelated_call",
          "broker_queued",
          "broker_delivered",
          "broker_claimed",
          "browser_observed",
          "codex_emitted",
          "host_started",
        ].includes(eventName)
          ? "pending"
          : ["broker_compaction_cancelled", "call_cancelled"].includes(eventName)
            ? "cancelled"
            : ["transport_closed", "reply_send_failed", "broker_abandoned"].includes(eventName)
              ? "transport_dropped"
              : failed
                ? "failed"
                : "completed",
        metadata,
      })
      .catch((error) => {
        if (error instanceof RangeError) this.dropped += 1;
        else this.failed += 1;
      });
  };
}
