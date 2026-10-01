import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
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

test("an oversized telemetry record degrades health without allocating queued resources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "continuity-record-budget-"));
  try {
    const sink = new TelemetryTraceSink(directory, { maxFileBytes: 128 });
    await expect(
      sink.record({
        traceId: "oversized-record",
        kind: "turn",
        terminalState: "pending",
        metadata: { diagnostic: "x".repeat(400) },
      }),
    ).rejects.toThrow("file budget");
    expect(sink.health()).toMatchObject({
      status: "degraded",
      droppedRecords: 1,
      pendingRecords: 0,
      pendingBytes: 0,
    });
    expect(await sink.flush()).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("writer lock recovery preserves diagnostics and requires a dead owner and an inactive runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "continuity-dead-owner-"));
  try {
    const child = Bun.spawnSync([process.execPath, "--eval", "console.log(process.pid)"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
    const pid = Number(child.stdout.toString().trim());
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
    const owner = JSON.stringify({
      version: 1,
      pid,
      host: hostname(),
      generation: "isolated-runtime-generation",
      ownerId: "isolated-writer-owner",
    });
    const lock = join(directory, ".telemetry.lock");
    await mkdir(lock);
    await writeFile(join(lock, "owner.json"), owner);
    const sink = new TelemetryTraceSink(directory);
    expect(await sink.recoverWriterLock(async () => false)).toBe(false);
    expect(await readFile(join(lock, "owner.json"), "utf8")).toBe(owner);
    expect(await sink.recoverWriterLock(async () => true)).toBe(true);
    const diagnostics = (await readdir(directory)).filter((name) => name.startsWith(".telemetry.lock.abandoned."));
    expect(diagnostics.length).toBe(1);
    expect(await readFile(join(directory, diagnostics[0]!, "owner.json"), "utf8")).toBe(owner);
    await sink.record({ traceId: "recovered", kind: "turn", terminalState: "completed" });
    expect(sink.health().status).toBe("healthy");
    expect(await sink.flush()).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
