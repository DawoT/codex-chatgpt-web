import { expect, spyOn, test } from "bun:test";
import {
  attachMcpTransportDiagnostics,
  emitMcpTransportDiagnostic,
} from "../src/adapters/chatgpt-web/mcp-transport-observability";

test("transport diagnostics record ready, error and close without raw error text", () => {
  const events: Array<Record<string, unknown>> = [];
  const lines: string[] = [];
  const logger = spyOn(console, "error").mockImplementation((line) => {
    lines.push(String(line));
  });
  let previousClose = 0;
  let previousError = 0;
  const transport = {
    async start() {},
    onclose: () => {
      previousClose += 1;
    },
    onerror: (_error: Error) => {
      previousError += 1;
    },
  };
  try {
    attachMcpTransportDiagnostics(transport, (event) => events.push(event));
    emitMcpTransportDiagnostic("transport_ready", (event) => events.push(event));
    transport.onerror(new Error("secret request body"));
    transport.onclose();
  } finally {
    logger.mockRestore();
  }
  expect(events.map((event) => event.event)).toEqual(["transport_ready", "transport_error", "transport_closed"]);
  expect(previousError).toBe(1);
  expect(previousClose).toBe(1);
  expect(JSON.stringify(events)).not.toContain("secret request body");
  expect(lines.every((line) => line.startsWith("[chatgpt-web-mcp] transport_event "))).toBe(true);
  expect(lines[0]).toContain('"generation":');
  expect(lines.join("\n")).not.toContain("secret request body");
});
