import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { TelemetryTraceSink } from "../src/adapters/chatgpt-web/telemetry-trace";

test("legacy locks never block private writes and queue saturation recovers current health", async () => {
  const directory = await mkdtemp(join(tmpdir(), "continuity-telemetry-"));
  try {
    const lock = join(directory, ".telemetry.lock");
    await mkdir(lock);
    const sink = new TelemetryTraceSink(directory, { maxPendingRecords: 1, maxPendingBytes: 512, lockDeadlineMs: 1 });
    const pending = sink.record({ traceId: "one", kind: "turn", terminalState: "pending" });
    await expect(sink.record({ traceId: "two", kind: "turn", terminalState: "pending" })).rejects.toThrow("queue");
    await pending;
    expect(sink.health()).toMatchObject({
      status: "healthy",
      pendingRecords: 0,
      pendingBytes: 0,
      failedWrites: 0,
      droppedRecords: 1,
    });
    expect(await sink.recoverWriterLock(async () => true)).toBe(false);
    expect(await readdir(lock)).toEqual([]);
    expect(await sink.flush(50)).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("private segments identify process and generation without creating writer locks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "continuity-segment-"));
  try {
    const { runtimeIdentity } = await import("../src/runtime-identity");
    const sink = new TelemetryTraceSink(directory);
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        sink.record({ traceId: `${index}`, kind: "turn", terminalState: "completed" }),
      ),
    );
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toStartWith(`telemetry.${process.pid}.${runtimeIdentity.generation}.`);
    expect(files[0]).toEndWith(".jsonl");
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
        traceId: `oversized-record-${"x".repeat(100)}`,
        kind: "turn",
        terminalState: "pending",
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
