import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelemetryTraceSink } from "../src/adapters/chatgpt-web/telemetry-trace";

describe("TelemetryTraceSink", () => {
  let logDir: string;

  beforeEach(async () => {
    logDir = await mkdtemp(join(tmpdir(), "telemetry-trace-"));
  });

  afterEach(async () => {
    await rm(logDir, { recursive: true, force: true });
  });

  it("does not leak nested credentials or arbitrary error text", async () => {
    const sink = new TelemetryTraceSink(logDir);
    await sink.record({
      traceId: "private",
      kind: "command",
      terminalState: "failed",
      error: "Authorization: Bearer private-value",
      metadata: { details: { password: "nested-value" } },
    });
    const raw = await readTelemetrySegments(logDir);
    expect(raw).not.toContain("private-value");
    expect(raw).not.toContain("nested-value");
  });

  it("coordinates independent sink instances through rotations", async () => {
    const sinks = Array.from({ length: 20 }, () => new TelemetryTraceSink(logDir, { maxFileBytes: 400, maxFiles: 30 }));
    await Promise.all(
      sinks.map((sink, index) =>
        sink.record({ traceId: `parallel-${index}`, kind: "turn", terminalState: "completed" }),
      ),
    );
    expect(await sinks[0].query({ limit: 30 })).toHaveLength(20);
    for (const name of await readdir(logDir)) {
      expect((await stat(join(logDir, name))).size).toBeLessThanOrEqual(400);
    }
  });

  it("refuses symlink archives rather than reading external records", async () => {
    const fs = await import("node:fs/promises");
    const target = join(logDir, "private.jsonl");
    await fs.writeFile(target, `${JSON.stringify({ version: 1, traceId: "foreign-private-record" })}\n`);
    await fs.symlink(target, join(logDir, "telemetry.jsonl.1"));
    await expect(new TelemetryTraceSink(logDir).query()).rejects.toThrow();
  });

  it("recovers after a failed write and bounds a single retained file", async () => {
    const blocked = join(logDir, "blocked");
    await (await import("node:fs/promises")).writeFile(blocked, "obstruction");
    const sink = new TelemetryTraceSink(blocked, { maxFileBytes: 400, maxFiles: 1, circuitCooldownMs: 1 });
    await expect(sink.record({ traceId: "first", kind: "turn", terminalState: "failed" })).rejects.toThrow();
    await rm(blocked);
    await Bun.sleep(2);
    for (let index = 0; index < 10; index += 1) {
      await sink.record({ traceId: `next-${index}`, kind: "turn", terminalState: "completed" });
    }
    const [name] = await readdir(blocked);
    expect((await stat(join(blocked, name!))).size).toBeLessThanOrEqual(400);
    expect(sink.health()).toMatchObject({ status: "healthy", failedWrites: 1 });
    expect((await sink.query())[0].traceId).toBe("next-9");
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

    const rawContent = await readTelemetrySegments(logDir);
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
    const traceFiles = files.filter((f) => /^telemetry\..+\.jsonl(?:\.\d+)?$/.test(f));
    // Must not exceed maxFiles
    expect(traceFiles.length).toBe(3);
    expect(traceFiles.some((name) => name.endsWith(".jsonl"))).toBe(true);

    // All active trace files must stay bounded
    for (const f of traceFiles) {
      const s = await stat(join(logDir, f));
      // Each file should be reasonably sized around maxFileBytes
      expect(s.size).toBeLessThanOrEqual(500);
    }

    // Querying traces retrieves recent events
    const results = await sink.query({ limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(5);
  });
});

async function readTelemetrySegments(directory: string): Promise<string> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
  return (await Promise.all(names.map((name) => readFile(join(directory, name), "utf8")))).join("\n");
}

it("retains only semantic metadata and finite numeric measurement fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "telemetry-semantic-"));
  try {
    const sink = new TelemetryTraceSink(directory);
    const entry = await sink.record({
      traceId: "bounded-trace",
      turnId: "https://private.example/conversation?token=private",
      sessionId: "x".repeat(200),
      kind: "tool_call",
      terminalState: "failed",
      error: "Bearer credential",
      tokens: { inputEstimated: 12, outputReported: Infinity, cached: -1 },
      times: { startMs: 100, endMs: NaN, durationMs: 1.5 },
      bytesTransferred: { sent: 7, received: Infinity },
      metadata: {
        safeFlag: true,
        itemIndex: 3,
        event: "result_received",
        scope: "broker_tool_lifecycle",
        tool: "codex_exec_command",
        process_pid: 42,
        elapsed_ms: 1.5,
        execution_observed: true,
        delivery_observed: false,
        build_commit: "a".repeat(40),
        artifact_sha256: "b".repeat(64),
        terminal_cause: "deadline",
        evidence: "host_tool_result",
        innocent: "credential",
        eventText: "private prompt",
        diagnostic: "private detail",
        arbitraryNumber: 123,
      },
    });
    expect(entry).toMatchObject({
      version: 1,
      traceId: "bounded-trace",
      error: "operation_failed",
      tokens: { inputEstimated: 12 },
      times: { startMs: 100, durationMs: 1.5 },
      bytesTransferred: { sent: 7 },
    });
    expect(entry.turnId).toBeUndefined();
    expect(entry.sessionId).toBeUndefined();
    expect(entry.tokens).toEqual({ inputEstimated: 12 });
    expect(entry.metadata).toEqual({
      safeFlag: true,
      itemIndex: 3,
      event: "result_received",
      scope: "broker_tool_lifecycle",
      tool: "codex_exec_command",
      process_pid: 42,
      elapsed_ms: 1.5,
      execution_observed: true,
      delivery_observed: false,
      build_commit: "a".repeat(40),
      artifact_sha256: "b".repeat(64),
      terminal_cause: "deadline",
      evidence: "host_tool_result",
    });
    const disk = await readTelemetrySegments(directory);
    expect(disk).not.toContain("credential");
    expect(disk).not.toContain("private");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("sanitizes fallback output as strictly as persisted records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "telemetry-fallback-"));
  const lines: string[] = [];
  const logger = spyOn(console, "error").mockImplementation((line) => lines.push(String(line)));
  try {
    const sink = new TelemetryTraceSink(directory, { maxFileBytes: 128 });
    await expect(
      sink.record({
        traceId: "x".repeat(128),
        kind: "command",
        terminalState: "failed",
        error: "private-credential",
        metadata: { innocent: "private-prompt", event: "Bearer private-credential" },
      }),
    ).rejects.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("private");
    expect(lines.join("\n")).toContain("RECORD_BUDGET_EXCEEDED");
  } finally {
    logger.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

it("preserves V1 query filtering and limit across private and legacy segments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "telemetry-query-"));
  try {
    const sink = new TelemetryTraceSink(directory);
    await sink.record({ traceId: "a", sessionId: "one", kind: "turn", terminalState: "completed" });
    await sink.record({ traceId: "b", sessionId: "two", kind: "command", terminalState: "failed" });
    await sink.record({ traceId: "a", sessionId: "one", kind: "turn", terminalState: "pending" });
    expect(await sink.query({ traceId: "a", sessionId: "one", kind: "turn", limit: 1 })).toMatchObject([
      { traceId: "a", terminalState: "pending" },
    ]);
    await expect(sink.query({ limit: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(sink.query({ limit: 1001 })).rejects.toBeInstanceOf(RangeError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
