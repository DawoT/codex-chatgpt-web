import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpTelemetry } from "../src/adapters/chatgpt-web/mcp-telemetry";
import { TelemetryTraceSink } from "../src/adapters/chatgpt-web/telemetry-trace";
import type { DiagnosticEventV2 } from "../src/diagnostics/events";
import { DiagnosticSink } from "../src/diagnostics/sink";

test("MCP persists internal ordered diagnostic phases beside unchanged V1 telemetry without content", async () => {
  const root = await mkdtemp(join(tmpdir(), "diagnostics-mcp-"));
  try {
    const telemetry = new McpTelemetry(root);
    telemetry.write({
      event: "browser_observed",
      call: 1,
      tool: "codex_exec",
      turn_trace_id: "turn-mcp",
      prompt: "private prompt",
    });
    telemetry.write({ event: "result_received", call: 1, tool: "codex_exec", turn_trace_id: "turn-mcp" });
    telemetry.write({ event: "reply_sent", call: 1, tool: "codex_exec", turn_trace_id: "turn-mcp" });
    expect(await telemetry.flush()).toBe(true);
    const all = await new DiagnosticSink<DiagnosticEventV2>(root).query();
    const diagnostics = all.filter((record) => record.version === 2).sort((a, b) => a.monotonicMs - b.monotonicMs);
    expect(diagnostics.map((record) => record.phase)).toEqual(["observed", "result_received", "delivered"]);
    expect(diagnostics.map((record) => record.correlation.turnId)).toEqual(["turn-mcp", "turn-mcp", "turn-mcp"]);
    expect(diagnostics.every((record) => Boolean(record.writtenAt))).toBe(true);
    const publicRecords = await new TelemetryTraceSink(root).query();
    expect(publicRecords).toHaveLength(3);
    expect(publicRecords.every((record) => record.version === 1)).toBe(true);
    expect(JSON.stringify(all)).not.toContain("private prompt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
