import { diagnosticCode, emitDiagnosticEvent } from "../../diagnostics";

type McpTransportEvent = "transport_ready" | "transport_error" | "transport_closed";

export function emitMcpTransportDiagnostic(
  event: McpTransportEvent,
  record: (entry: Record<string, unknown>) => void,
  error?: unknown,
): void {
  const sourceReason = diagnosticCode(error);
  const reason =
    event === "transport_closed"
      ? "transport_closed"
      : sourceReason === "operation_failed"
        ? "transport_error"
        : sourceReason;
  const diagnostic = emitDiagnosticEvent(
    {
      producer: "mcp",
      event,
      phase: event === "transport_ready" ? "started" : event === "transport_closed" ? "dropped" : "failed",
      fields: event === "transport_ready" ? {} : { reason },
      ...(error === undefined ? {} : { error }),
    },
    { write: () => {} },
  );
  try {
    console.error(`[chatgpt-web-mcp] transport_event ${JSON.stringify(diagnostic)}`);
  } catch {
    // Logging cannot prevent callback delivery.
  }
  try {
    record({ event, tool: "mcp_transport", call: 0, ...(event === "transport_ready" ? {} : { reason }), diagnostic });
  } catch {
    // A caller-provided observer is diagnostic only.
  }
}

/** Attach before server.connect(), so the MCP SDK preserves these callbacks. */
export function attachMcpTransportDiagnostics(
  transport: { onclose?: () => void; onerror?: (error: Error) => void },
  record: (event: Record<string, unknown>) => void,
): void {
  const previousClose = transport.onclose;
  const previousError = transport.onerror;
  transport.onclose = () => {
    emitMcpTransportDiagnostic("transport_closed", record);
    previousClose?.();
  };
  transport.onerror = (error) => {
    emitMcpTransportDiagnostic("transport_error", record, error);
    previousError?.(error);
  };
}
