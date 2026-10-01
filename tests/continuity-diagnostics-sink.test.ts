import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "diagnostics-sink-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function loadSink() {
  const module = await import("../src/diagnostics/sink").catch(() => null);
  expect(module, "the generic diagnostic sink must exist").not.toBeNull();
  return module!.DiagnosticSink;
}

test("independent instances rotate only their own private segments and ignore legacy locks", async () => {
  const DiagnosticSink = await loadSink();
  await mkdir(join(directory, ".telemetry.lock"));
  await writeFile(join(directory, ".telemetry.lock", "owner.json"), "legacy owner");
  await writeFile(join(directory, "telemetry.jsonl"), '{"source":"legacy"}\n');
  const first = new DiagnosticSink<{ source: string; index?: number }>(directory, {
    maxFileBytes: 128,
    maxFiles: 2,
  });
  const second = new DiagnosticSink<{ source: string }>(directory, { maxFileBytes: 128, maxFiles: 1 });
  await second.record({ source: "other" });
  for (let index = 0; index < 20; index += 1) {
    await first.record({ source: "first", index });
  }
  const files = await readdir(directory);
  const segments = files.filter((name) => /^telemetry\.\d+\.[a-f0-9-]{36}\.[a-f0-9-]{36}\.jsonl(?:\.1)?$/.test(name));
  expect(segments).toHaveLength(3);
  for (const name of segments) {
    expect((await stat(join(directory, name))).size).toBeLessThanOrEqual(128);
    if (process.platform !== "win32") {
      expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
    }
  }
  const records = await first.query();
  expect(records).toContainEqual({ source: "legacy" });
  expect(records).toContainEqual({ source: "other" });
  expect(records).toContainEqual({ source: "first", index: 19 });
  expect(await readFile(join(directory, ".telemetry.lock", "owner.json"), "utf8")).toBe("legacy owner");
});

test("real concurrent processes retain all records across separate rotations", async () => {
  const DiagnosticSink = await loadSink();
  const sinkPath = resolve(import.meta.dir, "../src/diagnostics/sink.ts");
  const script = `
    const { DiagnosticSink } = await import(process.argv[1]);
    const sink = new DiagnosticSink(process.argv[2], { maxFileBytes: 128, maxFiles: 30 });
    for (let index = 0; index < 40; index += 1) {
      await sink.record({ writer: Number(process.argv[3]), index });
    }
    if (!(await sink.flush())) {
      process.exit(1);
    }
  `;
  const children = Array.from({ length: 4 }, (_, writer) =>
    Bun.spawn([process.execPath, "--eval", script, sinkPath, directory, String(writer)], {
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const outcomes = await Promise.all(
    children.map(async (child) => ({
      code: await child.exited,
      stderr: await new Response(child.stderr).text(),
    })),
  );
  expect(outcomes).toEqual(Array.from({ length: 4 }, () => ({ code: 0, stderr: "" })));
  const records = await new DiagnosticSink<{ writer: number; index: number }>(directory).query();
  expect(records).toHaveLength(160);
  expect(new Set(records.map((entry) => `${entry.writer}:${entry.index}`)).size).toBe(160);
  expect((await readdir(directory)).some((name) => name === ".telemetry.lock")).toBe(false);
});

test("queue count and byte limits reject before allocating more queued resources", async () => {
  const DiagnosticSink = await loadSink();
  const failures: unknown[] = [];
  const countSink = new DiagnosticSink<{ value: string }>(directory, {
    maxPendingRecords: 1,
    fallback: (_entry, failure) => failures.push(failure),
  });
  const pending = countSink.record({ value: "one" });
  const rejected = countSink.record({ value: "two" });
  expect(countSink.health().pendingRecords).toBe(1);
  expect(countSink.health().pendingBytes).toBe(16);
  await expect(rejected).rejects.toMatchObject({ code: "QUEUE_BUDGET_EXCEEDED" });
  await pending;
  const byteSink = new DiagnosticSink<{ value: string }>(directory, { maxPendingBytes: 20 });
  const first = byteSink.record({ value: "one" });
  await expect(byteSink.record({ value: "two" })).rejects.toMatchObject({ code: "QUEUE_BUDGET_EXCEEDED" });
  await first;
  expect(failures).toEqual([{ code: "QUEUE_BUDGET_EXCEEDED", operation: "enqueue" }]);
  expect(countSink.health()).toMatchObject({
    status: "healthy",
    pendingRecords: 0,
    pendingBytes: 0,
    droppedRecords: 1,
    lifetime: { failedWrites: 0, droppedRecords: 1 },
  });
});

test("oversized and unserializable entries fail safely without queuing or invoking unsafe fallback", async () => {
  const DiagnosticSink = await loadSink();
  const failures: unknown[] = [];
  const sink = new DiagnosticSink<object>(directory, {
    maxFileBytes: 128,
    fallback: (_entry, failure) => {
      failures.push(failure);
      throw new Error("fallback secret");
    },
  });
  await expect(sink.record({ payload: "x".repeat(200) })).rejects.toMatchObject({ code: "RECORD_BUDGET_EXCEEDED" });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  await expect(sink.record(cycle)).rejects.toMatchObject({ code: "INVALID_RECORD" });
  expect(sink.health()).toMatchObject({ pendingRecords: 0, pendingBytes: 0, droppedRecords: 2 });
  expect(failures).toEqual([
    { code: "RECORD_BUDGET_EXCEEDED", operation: "serialize" },
    { code: "INVALID_RECORD", operation: "serialize" },
  ]);
});

test("a sustained I/O failure opens a fast circuit and recovery resets current health only", async () => {
  const DiagnosticSink = await loadSink();
  const blocked = join(directory, "private-credential-path");
  await writeFile(blocked, "obstruction");
  const failures: unknown[] = [];
  const sink = new DiagnosticSink<{ index: number }>(blocked, {
    circuitCooldownMs: 100,
    fallback: (_entry, failure) => failures.push(failure),
  });
  const error = await sink.record({ index: 0 }).catch((failure) => failure);
  expect(error).toMatchObject({ code: "EEXIST", operation: "mkdir" });
  expect(String(error)).not.toContain("private-credential-path");
  const started = performance.now();
  const failuresBefore = sink.health().failedWrites;
  await Promise.all(
    Array.from({ length: 200 }, (_, index) =>
      sink.record({ index }).catch((failure) => {
        expect(failure.code).toBe("CIRCUIT_OPEN");
      }),
    ),
  );
  expect(performance.now() - started).toBeLessThan(100);
  expect(sink.health().failedWrites).toBe(failuresBefore);
  expect(sink.health()).toMatchObject({
    status: "degraded",
    current: { code: "EEXIST", operation: "mkdir", circuitOpen: true },
    lifetime: { failedWrites: 1, circuitRejections: 200 },
  });
  expect(JSON.stringify(failures)).not.toContain("private-credential-path");
  await rm(blocked);
  await Bun.sleep(110);
  await sink.record({ index: 201 });
  expect(sink.health()).toMatchObject({
    status: "healthy",
    current: { status: "healthy", circuitOpen: false },
    lifetime: { failedWrites: 1, circuitRejections: 200 },
  });
  expect(sink.health().current.code).toBeUndefined();
  expect(await sink.query()).toEqual([{ index: 201 }]);
});

test("flush respects an outstanding append deadline and drains after completion", async () => {
  const DiagnosticSink = await loadSink();
  const sink = new DiagnosticSink<{ index: number }>(directory);
  const writes = Array.from({ length: 200 }, (_, index) => sink.record({ index }));
  expect(await sink.flush(0)).toBe(false);
  await Promise.all(writes);
  expect(await sink.flush()).toBe(true);
  await expect(sink.flush(-1)).rejects.toBeInstanceOf(RangeError);
});

test("V2 writtenAt is stamped after preceding appends rather than when queued", async () => {
  const DiagnosticSink = await loadSink();
  type Event = {
    version: number;
    occurredAt: string;
    monotonicMs: number;
    sequence: number;
    writtenAt?: string;
    toJSON?: () => object;
  };
  const sink = new DiagnosticSink<Event>(directory);
  const original: Event = {
    version: 2,
    occurredAt: "2000-01-01T00:00:00.000Z",
    monotonicMs: 12,
    sequence: 1,
    writtenAt: "2000-01-01T00:00:00.000Z",
  };
  let precedingSettledAt = 0;
  const first = sink.record({ ...original, sequence: 0 }).then(() => {
    precedingSettledAt = Date.now();
  });
  const second = sink.record(original);
  // Blocking here separates enqueue time from actual asynchronous disk operations.
  const until = performance.now() + 10;
  while (performance.now() < until) {
    Math.sqrt(12345);
  }
  const beforeDiskWork = Date.now();
  await first;
  const result = await second;
  expect(Date.parse(result.writtenAt!)).toBeGreaterThanOrEqual(beforeDiskWork);
  expect(Date.parse(result.writtenAt!)).toBeGreaterThanOrEqual(precedingSettledAt);
  expect(result.occurredAt).toBe("2000-01-01T00:00:00.000Z");
  expect(result.sequence).toBe(1);
  expect(original.writtenAt).toBe("2000-01-01T00:00:00.000Z");
  expect(await sink.query()).toContainEqual(result);
});

test("query reads legacy archives and all segment rotations while ignoring torn and non-object lines", async () => {
  const DiagnosticSink = await loadSink();
  await writeFile(join(directory, "telemetry.jsonl.8"), '{"source":"legacy"}\nnull\n42\n[]\n{"torn":');
  await writeFile(join(directory, "not-telemetry.jsonl"), '{"source":"ignored"}\n');
  const sink = new DiagnosticSink<{ source: string }>(directory, { maxFiles: 1 });
  await sink.record({ source: "segment" });
  expect(await sink.query()).toContainEqual({ source: "legacy" });
  expect(await sink.query()).toHaveLength(2);
});

test("query refuses symlinks without disclosing the target or reading external data", async () => {
  const DiagnosticSink = await loadSink();
  const privatePath = join(directory, "private-target");
  await writeFile(privatePath, '{"secret":"outside"}\n');
  await symlink(privatePath, join(directory, "telemetry.jsonl.1"));
  const failure = await new DiagnosticSink<object>(directory).query().catch((error) => error);
  expect(failure).toMatchObject({ code: "ELOOP", operation: "open" });
  expect(String(failure)).not.toContain("private-target");
});

test("query refuses FIFO archives promptly without waiting for a writer", async () => {
  const DiagnosticSink = await loadSink();
  const fifo = join(directory, "telemetry.jsonl");
  const created = Bun.spawnSync(["mkfifo", fifo]);
  expect(created.exitCode).toBe(0);
  const started = performance.now();
  await expect(new DiagnosticSink<object>(directory).query()).rejects.toMatchObject({ code: "UNSAFE_FILE" });
  expect(performance.now() - started).toBeLessThan(250);
});

test("query bounds a file before reading and rejects oversized archives", async () => {
  const DiagnosticSink = await loadSink();
  await writeFile(join(directory, "telemetry.jsonl"), "x".repeat(129));
  await expect(new DiagnosticSink<object>(directory, { maxFileBytes: 128 }).query()).rejects.toMatchObject({
    code: "ARCHIVE_BUDGET_EXCEEDED",
    operation: "read",
  });
});

test("replaced active segment symlinks and FIFOs cannot receive writes", async () => {
  const DiagnosticSink = await loadSink();
  for (const replacement of ["symlink", "fifo"]) {
    const ownDirectory = join(directory, replacement);
    const sink = new DiagnosticSink<{ index: number }>(ownDirectory);
    await sink.record({ index: 0 });
    const [name] = await readdir(ownDirectory);
    const path = join(ownDirectory, name!);
    await rm(path);
    const target = join(directory, "untouched");
    await writeFile(target, "private-data");
    if (replacement === "symlink") {
      await symlink(target, path);
    } else {
      expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
    }
    const started = performance.now();
    await expect(sink.record({ index: 1 })).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(250);
    expect(await readFile(target, "utf8")).toBe("private-data");
  }
});

test("query handles a missing directory as empty without hiding other I/O failures", async () => {
  const DiagnosticSink = await loadSink();
  expect(await new DiagnosticSink<object>(join(directory, "missing")).query()).toEqual([]);
  const obstruction = join(directory, "file");
  await writeFile(obstruction, "not a directory");
  await expect(new DiagnosticSink<object>(obstruction).query()).rejects.toMatchObject({
    code: "ENOTDIR",
    operation: "query",
  });
});

test("a deleted private segment can recover on the next write after cooldown", async () => {
  const DiagnosticSink = await loadSink();
  const sink = new DiagnosticSink<{ index: number }>(directory, { circuitCooldownMs: 1 });
  await sink.record({ index: 1 });
  const segment = (await readdir(directory)).find((name) => name.endsWith(".jsonl"))!;
  await rm(join(directory, segment));
  await expect(sink.record({ index: 2 })).rejects.toMatchObject({ code: "ENOENT" });
  await Bun.sleep(5);
  await sink.record({ index: 3 });
  expect(sink.health().current.status).toBe("healthy");
  expect(sink.health().lifetime.failedWrites).toBe(1);
  expect(await sink.query()).toEqual([{ index: 3 }]);
});
