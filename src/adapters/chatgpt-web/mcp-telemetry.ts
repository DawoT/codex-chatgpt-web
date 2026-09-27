import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getConfigDir } from "../../config";
import { TelemetryTraceSink } from "./telemetry-trace";

/** One transport-owned, bounded queue. Logging never changes tool outcomes. */
export class McpTelemetry {
  private readonly instanceId = randomUUID();
  private readonly sink: TelemetryTraceSink;
  private pending = 0;
  private dropped = 0;
  private failed = 0;

  constructor(directory = join(getConfigDir(), "logs", "mcp")) {
    this.sink = new TelemetryTraceSink(directory);
  }

  readonly write = (event: Record<string, unknown>): void => {
    if (this.pending >= 256) {
      this.dropped += 1;
      return;
    }
    this.pending += 1;
    const call = Number.isSafeInteger(event.call) ? Number(event.call) : 0;
    const eventName = String(event.event);
    const failed = eventName === "reply_send_failed" || event.outcome === "protocol_error" || event.is_error === true;
    const metadata = {
      scope: eventName.startsWith("broker_") ? "broker_tool_lifecycle" : "mcp_transport_only",
      event: eventName,
      tool: typeof event.tool === "string" ? event.tool : "unknown",
      call,
      dropped_events: this.dropped,
      failed_writes: this.failed,
      ...(typeof event.elapsed_ms === "number" ? { elapsed_ms: event.elapsed_ms } : {}),
      ...(typeof event.tracked_calls === "number" ? { tracked_calls: event.tracked_calls } : {}),
    };
    void this.sink.record({
      traceId: typeof event.trace_id === "string" && /^[a-f0-9-]{36}$/.test(event.trace_id)
        ? event.trace_id : `${this.instanceId}:${call}`,
      sessionId: this.instanceId,
      ...(typeof event.broker_call_id === "string" && /^call_[a-zA-Z0-9_-]{1,128}$/.test(event.broker_call_id)
        ? { brokerCallId: event.broker_call_id } : {}),
      kind: "tool_call",
      terminalState: ["call_received", "uncorrelated_call", "broker_queued", "broker_delivered"].includes(eventName) ? "pending"
        : eventName === "broker_compaction_cancelled" ? "cancelled"
        : ["transport_closed", "reply_send_failed", "broker_abandoned"].includes(eventName) ? "transport_dropped"
          : failed ? "failed" : "completed",
      metadata,
    }).catch(() => {
      this.failed += 1;
      if (this.failed === 1) console.error("[chatgpt-web-mcp] telemetry_write_failed; transport behavior unchanged");
    }).finally(() => {
      this.pending -= 1;
    });
  };
}
