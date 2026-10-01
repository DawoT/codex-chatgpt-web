import { expect, test } from "bun:test";
import { runtimeIdentity } from "../src/runtime-identity";

const api = (await import("../src/diagnostics/events").catch(() => ({}))) as any;
function producer() {
  expect(api.createDiagnosticProducer).toBeTypeOf("function");
  return api.createDiagnosticProducer;
}

test("each producer owns ordered occurrence clocks and validated runtime/correlation fields", () => {
  const create = producer();
  const emit = create("browser", runtimeIdentity);
  const other = create("browser", runtimeIdentity);
  const first = emit({
    event: "stage_started",
    phase: "started",
    correlation: { turnId: "turn-1", traceId: "trace-1", prompt: "private" },
    fields: { durationMs: 10, status: 502, prompt: "private", message: "private", reason: "transport_reset" },
    error: Object.assign(new Error("private"), { code: "ECONNRESET" }),
  });
  const second = emit({ event: "stage_failed", phase: "failed" });
  expect(first).toMatchObject({
    version: 2,
    producer: "browser",
    sequence: 1,
    runtime: runtimeIdentity,
    correlation: { turnId: "turn-1", traceId: "trace-1" },
    fields: { durationMs: 10, status: 502, reason: "transport_reset" },
  });
  expect(first.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  expect(first.writtenAt).toBeUndefined();
  expect(second.sequence).toBe(2);
  expect(second.monotonicMs).toBeGreaterThanOrEqual(first.monotonicMs);
  expect(other({ event: "stage_started", phase: "started" }).sequence).toBe(1);
  expect(first.error.nodes[0].code).toBe("transport_reset");
  expect(JSON.stringify(first)).not.toContain("private");
  expect(first.producerId).not.toBe(other({ event: "stage_started", phase: "started" }).producerId);
});

test("ring snapshots expose capture loss and never mix turns or retain mutable caller data", () => {
  const emit = producer()("main");
  const ring = new api.DiagnosticEventRing();
  const first = emit({ event: "stage_started", phase: "started", correlation: { turnId: "one" } });
  ring.record(first);
  first.correlation.turnId = "foreign";
  for (let index = 0; index < 300; index += 1) {
    ring.record(emit({ event: "stage_started", phase: "started", correlation: { turnId: index % 2 ? "one" : "two" } }));
  }
  const snapshot = ring.snapshot("one");
  expect(snapshot.events.length).toBeLessThanOrEqual(256);
  expect(snapshot.events.every((event: any) => event.correlation.turnId === "one")).toBe(true);
  expect(snapshot.evidence).toMatchObject({ captured: 151, dropped: 0, evicted: 23, missing: true });
  snapshot.events[0].correlation.turnId = "foreign";
  expect(ring.snapshot("one").events.every((event: any) => event.correlation.turnId === "one")).toBe(true);
  expect(ring.health().bytes).toBeLessThanOrEqual(1024 * 1024);
});

test("byte overflow and invalid events are counted as missing evidence", () => {
  const emit = producer()("helper");
  const ring = new api.DiagnosticEventRing({ maxEvents: 256, maxBytes: 700 });
  for (let index = 0; index < 3; index += 1) {
    ring.record(emit({ event: "stage_started", phase: "started", correlation: { turnId: "small" } }));
  }
  expect(ring.snapshot("small").evidence.missing).toBe(true);
  expect(ring.health().bytes).toBeLessThanOrEqual(700);
  const tiny = new api.DiagnosticEventRing({ maxBytes: 1 });
  tiny.record(emit({ event: "stage_started", phase: "started", correlation: { turnId: "drop" } }));
  expect(tiny.snapshot("drop").evidence).toMatchObject({ captured: 0, dropped: 1, missing: true });
  expect(() => emit({ event: "private prompt", phase: "private" })).not.toThrow();
  expect(
    JSON.stringify(
      emit({
        event: "private prompt",
        phase: "private",
        fields: { reason: "sk-secret", stage: "private prompt", tool: "private prompt" },
      }),
    ),
  ).not.toMatch(/private prompt|sk-secret/);
});

test("diagnostic observers cannot throw or reject into application execution", async () => {
  producer();
  const { emitDiagnosticEvent } = await import("../src/diagnostics/index");
  expect(() =>
    emitDiagnosticEvent(
      { producer: "main", event: "stage_started", phase: "started" },
      {
        write() {
          throw new Error("private");
        },
      },
    ),
  ).not.toThrow();
  expect(() =>
    emitDiagnosticEvent(
      { producer: "main", event: "stage_started", phase: "started" },
      {
        write: async () => {
          throw new Error("private");
        },
      },
    ),
  ).not.toThrow();
  await Bun.sleep(1);
});

test("worker stages and exact selection evidence survive with startup/request/document correlation", () => {
  const emit = producer()("browser");
  for (const stage of [
    "browser_page",
    "browser_page_rebind",
    "temporary_chat_preparation",
    "effort_selection",
    "final_part_effort_selection",
    "prompt_attachment",
    "connector_catalog_refresh",
    "file_attachment",
    "send",
    "multipart_stage_1_attachment",
    "multipart_stage_6_acknowledgement",
  ]) {
    const event = emit({
      event: "stage_failed",
      phase: "failed",
      correlation: { startupId: "startup-1", requestId: "request-1", documentGeneration: 2 },
      fields: { stage, expectedValue: 3, observedValue: 1 },
    });
    expect(event.fields).toMatchObject({ stage, expectedValue: 3, observedValue: 1 });
    expect(event.correlation).toMatchObject({ startupId: "startup-1", requestId: "request-1", documentGeneration: 2 });
  }
  expect(
    emit({ event: "stage_failed", phase: "failed", fields: { stage: "multipart_stage_999_attachment" } }).fields.stage,
  ).toBeUndefined();
});

test("failed default emitter produces safe output even without a supplied sink", async () => {
  producer();
  const { spyOn } = await import("bun:test");
  const { emitDiagnosticEvent } = await import("../src/diagnostics/index");
  const lines: string[] = [];
  const logger = spyOn(console, "error").mockImplementation((line) => {
    lines.push(String(line));
  });
  try {
    const event = emitDiagnosticEvent({
      producer: "main",
      event: "stage_failed",
      phase: "failed",
      error: new Error("private cookie prompt"),
    });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ version: 2, eventId: event.eventId });
    expect(lines.join("\n")).not.toContain("private cookie prompt");
  } finally {
    logger.mockRestore();
  }
});

test.each([{ pid: 0 }, { generation: "invalid" }, { protocolVersion: 0 }])(
  "remote identity is rejected instead of attributed to the receiving process (%j)",
  (invalid) => {
    const event = producer()("helper")({ event: "transport_ready", phase: "observed" });
    event.runtime = { ...event.runtime, ...invalid };
    expect(() => api.parseDiagnosticEvent(event)).toThrow("Invalid diagnostic runtime identity");
  },
);
