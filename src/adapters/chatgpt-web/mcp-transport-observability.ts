import { runtimeIdentity } from "../../runtime-identity";

type McpTransportEvent = "transport_ready" | "transport_error" | "transport_closed";

export function emitMcpTransportDiagnostic(
  event: McpTransportEvent,
  record: (entry: Record<string, unknown>) => void,
): void {
  console.error(
    `[chatgpt-web-mcp] transport_event ${JSON.stringify({
      schemaVersion: 1,
      event,
      runtime: runtimeIdentity,
    })}`,
  );
  record({ event, tool: "mcp_transport", call: 0 });
}

/** Attach before server.connect(), so the MCP SDK preserves these callbacks. */
export function attachMcpTransportDiagnostics(
  transport: {
    onclose?: () => void;
    onerror?: (error: Error) => void;
  },
  record: (event: Record<string, unknown>) => void,
): void {
  const previousClose = transport.onclose;
  const previousError = transport.onerror;
  transport.onclose = () => {
    emitMcpTransportDiagnostic("transport_closed", record);
    previousClose?.();
  };
  transport.onerror = (error) => {
    emitMcpTransportDiagnostic("transport_error", record);
    previousError?.(error);
  };
}
