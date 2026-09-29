import { randomUUID } from "node:crypto";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { mcpTraceContext } from "./mcp-trace-context";

interface PendingObservation {
  call: { call: number; tool: string; started: number; trace_id: string } | null;
  remainingReplies: number;
}

/** Content-free receipt/reply observations. A sent MCP result is not proof of tool execution. */
export function observeMcpToolCalls(
  transport: Transport,
  knownTools: ReadonlySet<string>,
  write: (event: Record<string, unknown>) => void = (event) =>
    console.error(`[chatgpt-web-mcp] transport=${JSON.stringify(event)}`),
): Transport {
  let sequence = 0;
  const pending = new Map<string | number, PendingObservation>();
  const emit = (event: Record<string, unknown>) => {
    // Logging is observational: a broken sink cannot change the invocation or its result.
    try {
      write({ pid: process.pid, ...event });
    } catch {
      /* Preserve transport semantics. */
    }
  };
  const receive = transport.onmessage;
  transport.onmessage = (message, extra) => {
    let traceId: string | undefined;
    if ("method" in message && message.method === "tools/call" && "id" in message) {
      const name = message.params?.name;
      const tool = typeof name === "string" && knownTools.has(name) ? name : "unknown";
      const existing = pending.get(message.id);
      if (existing) {
        // An ambiguous protocol ID cannot safely correlate either reply.
        existing.call = null;
        existing.remainingReplies += 1;
        emit({ event: "uncorrelated_call", reason: "duplicate_id", tool });
      } else if (pending.size >= 1_024) {
        emit({ event: "uncorrelated_call", reason: "tracking_limit", tool });
      } else {
        const call = { call: ++sequence, tool, started: performance.now(), trace_id: randomUUID() };
        traceId = call.trace_id;
        pending.set(message.id, { call, remainingReplies: 1 });
        emit({ event: "call_received", call: call.call, tool, trace_id: call.trace_id });
      }
    }
    if (traceId) mcpTraceContext.run(traceId, () => receive?.(message, extra));
    else receive?.(message, extra);
  };
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    const id = "id" in message ? message.id : undefined;
    const entry = id !== undefined && id !== null && !("method" in message) ? pending.get(id) : undefined;
    try {
      await send(message, options);
      // A duplicate may arrive while send awaits transport completion.
      const call = id !== undefined && pending.get(id) === entry ? entry?.call : undefined;
      if (call) {
        const result = "result" in message ? message.result : undefined;
        emit({
          event: "reply_sent",
          call: call.call,
          tool: call.tool,
          trace_id: call.trace_id,
          elapsed_ms: Math.round(performance.now() - call.started),
          outcome: "error" in message ? "protocol_error" : "result",
          ...("result" in message ? { is_error: result?.isError === true } : {}),
        });
      }
    } catch (error) {
      const call = id !== undefined && pending.get(id) === entry ? entry?.call : undefined;
      if (call) emit({ event: "reply_send_failed", call: call.call, tool: call.tool, trace_id: call.trace_id });
      throw error;
    } finally {
      if (entry && id !== undefined && id !== null && pending.get(id) === entry) {
        entry.remainingReplies -= 1;
        if (entry.remainingReplies === 0) pending.delete(id);
      }
    }
  };
  const close = transport.onclose;
  transport.onclose = () => {
    if (pending.size) emit({ event: "transport_closed", tracked_calls: pending.size });
    pending.clear();
    close?.();
  };
  return transport;
}
