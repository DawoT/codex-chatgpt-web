import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, stat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TelemetryTraceSink, type TelemetryTraceRecord } from "../src/adapters/chatgpt-web/telemetry-trace";

describe("TelemetryTraceSink", () => {
  let logDir: string;

  beforeEach(async () => {
    logDir = await mkdtemp(join(tmpdir(), "telemetry-trace-"));
  });

  afterEach(async () => {
    await rm(logDir, { recursive: true, force: true });
  });

  it("records structured trace events with version and timestamp", async () => {
    const sink = new TelemetryTraceSink(logDir);
    await sink.record({
      traceId: "trace-abc-123",
      turnId: "turn-001",
      sessionId: "session-xyz",
      kind: "turn",
      model: "chatgpt-web/gpt-5.6-sol",
      tokens: { inputEstimated: 12000, outputReported: 850, cached: 4000 },
      times: { startMs: 1727450000000, endMs: 1727450002500, durationMs: 2500 },
      terminalState: "completed",
      bytesTransferred: { sent: 45000, received: 3200 },
    });

    const traces = await sink.query({ traceId: "trace-abc-123" });
    expect(traces).toHaveLength(1);
    const trace = traces[0];
    expect(trace.version).toBe(1);
    expect(typeof trace.timestamp).toBe("number");
    expect(trace.traceId).toBe("trace-abc-123");
    expect(trace.model).toBe("chatgpt-web/gpt-5.6-sol");
    expect(trace.tokens?.inputEstimated).toBe(12000);
    expect(trace.tokens?.cached).toBe(4000);
    expect(trace.terminalState).toBe("completed");
    expect(trace.bytesTransferred?.sent).toBe(45000);
  });

  it("filters out sensitive credentials and prompt bodies by default", async () => {
    const sink = new TelemetryTraceSink(logDir);
    await sink.record({
      traceId: "trace-sec-01",
      kind: "command",
      terminalState: "completed",
      metadata: {
        safeFlag: true,
        bearerToken: "sk-secret-12345",
        password: "supersecretpassword",
        fullPrompt: "This is private user text that must not appear in logs",
      },
    });

    const activeLog = join(logDir, "telemetry.jsonl");
    const rawContent = await readFile(activeLog, "utf8");
    expect(rawContent).not.toContain("sk-secret-12345");
    expect(rawContent).not.toContain("supersecretpassword");
    expect(rawContent).not.toContain("private user text");
    expect(rawContent).toContain("safeFlag");
  });

  it("rotates log files when size exceeds budget and limits retention to max files", async () => {
    // Configure small file limit for test: 500 bytes per file, max 3 files
    const sink = new TelemetryTraceSink(logDir, {
      maxFileBytes: 500,
      maxFiles: 3,
    });

    // Write enough records to trigger multiple rotations
    for (let i = 0; i < 20; i++) {
      await sink.record({
        traceId: `trace-bulk-${i.toString().padStart(3, "0")}`,
        kind: "tool_call",
        terminalState: "completed",
        metadata: { itemIndex: i, padding: "X".repeat(100) },
      });
    }

    const files = await readdir(logDir);
    const traceFiles = files.filter(f => f.startsWith("telemetry.jsonl"));
    // Must not exceed maxFiles
    expect(traceFiles.length).toBeLessThanOrEqual(3);
    expect(traceFiles).toContain("telemetry.jsonl");

    // All active trace files must stay bounded
    for (const f of traceFiles) {
      const s = await stat(join(logDir, f));
      // Each file should be reasonably sized around maxFileBytes
      expect(s.size).toBeLessThan(2000);
    }

    // Querying traces retrieves recent events
    const results = await sink.query({ limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(5);
  });
});
