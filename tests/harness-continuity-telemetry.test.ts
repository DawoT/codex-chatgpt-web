import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelemetryTraceSink } from "../src/adapters/chatgpt-web/telemetry-trace";

test("telemetry bounds queued count/bytes, flush deadline and retains ambiguous locks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "continuity-telemetry-"));
  try {
    await mkdir(join(directory, ".telemetry.lock"));
    const sink = new TelemetryTraceSink(directory, { maxPendingRecords: 1, maxPendingBytes: 512, lockDeadlineMs: 80 });
    const pending = sink.record({ traceId: "one", kind: "turn", terminalState: "pending" }).catch(() => {});
    await expect(sink.record({ traceId: "two", kind: "turn", terminalState: "pending" })).rejects.toThrow("queue");
    expect(sink.health().pendingRecords).toBe(1);
    expect(await sink.flush(5)).toBe(false);
    await pending;
    expect(sink.health().pendingRecords).toBe(0);
    expect(sink.health().pendingBytes).toBe(0);
    expect(sink.health().failedWrites).toBe(1);
    expect(sink.health().droppedRecords).toBe(1);
    expect(await sink.recoverWriterLock(async () => true)).toBe(false);
    expect(await sink.flush(50)).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("new locks identify their owner and generation and live owners cannot be recovered", async () => {
  const directory = await mkdtemp(join(tmpdir(), "continuity-lock-"));
  try {
    // Hold the append by writing enough concurrent records to observe its owned lock.
    const sink = new TelemetryTraceSink(directory, { maxPendingRecords: 256 });
    const writes = Array.from({ length: 100 }, (_, index) =>
      sink.record({ traceId: `${index}`, kind: "turn", terminalState: "completed" }),
    );
    let owner: { pid: number; generation: string } | undefined;
    for (let attempt = 0; attempt < 100 && !owner; attempt += 1) {
      owner = await readFile(join(directory, ".telemetry.lock", "owner.json"), "utf8")
        .then(JSON.parse)
        .catch(() => undefined);
      if (!owner) await Bun.sleep(1);
    }
    expect(owner?.pid).toBe(process.pid);
    expect(owner?.generation).toBeTypeOf("string");
    expect(await sink.recoverWriterLock(async () => true)).toBe(false);
    await Promise.all(writes);
    expect(sink.health().status).toBe("healthy");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
