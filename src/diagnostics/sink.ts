import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, opendir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { runtimeIdentity } from "../runtime-identity";

export type DiagnosticSinkFailureCode =
  | "EACCES"
  | "EPERM"
  | "ENOSPC"
  | "EDQUOT"
  | "EROFS"
  | "EIO"
  | "EMFILE"
  | "ENFILE"
  | "EEXIST"
  | "ENOENT"
  | "ENOTDIR"
  | "EISDIR"
  | "ELOOP"
  | "ENXIO"
  | "EINVAL"
  | "UNKNOWN_IO"
  | "INVALID_RECORD"
  | "RECORD_BUDGET_EXCEEDED"
  | "QUEUE_BUDGET_EXCEEDED"
  | "ARCHIVE_BUDGET_EXCEEDED"
  | "UNSAFE_FILE"
  | "CIRCUIT_OPEN";

export type DiagnosticSinkOperation =
  | "serialize"
  | "enqueue"
  | "mkdir"
  | "open"
  | "stat"
  | "write"
  | "rotate"
  | "read"
  | "query"
  | "close";

export interface DiagnosticSinkFailure {
  code: DiagnosticSinkFailureCode;
  operation: DiagnosticSinkOperation;
}

export interface DiagnosticSinkOptions<T extends object = object> {
  maxFileBytes?: number;
  maxFiles?: number;
  maxPendingRecords?: number;
  maxPendingBytes?: number;
  /** Accepted for legacy callers; exclusive segments never acquire shared locks. */
  lockDeadlineMs?: number;
  circuitCooldownMs?: number;
  /** Entries must already be sanitized by their producer, just as for disk persistence. */
  fallback?: (entry: T, failure: DiagnosticSinkFailure) => void;
}

export interface DiagnosticSinkHealth {
  status: "healthy" | "degraded";
  pendingRecords: number;
  pendingBytes: number;
  /** Lifetime counters retained at the top level for telemetry V1 callers. */
  failedWrites: number;
  droppedRecords: number;
  current: {
    status: "healthy" | "degraded";
    circuitOpen: boolean;
    code?: DiagnosticSinkFailureCode;
    operation?: DiagnosticSinkOperation;
  };
  lifetime: {
    failedWrites: number;
    droppedRecords: number;
    circuitRejections: number;
    lastFailure?: DiagnosticSinkFailure;
  };
}

const IO_CODES = new Set([
  "EACCES",
  "EPERM",
  "ENOSPC",
  "EDQUOT",
  "EROFS",
  "EIO",
  "EMFILE",
  "ENFILE",
  "EEXIST",
  "ENOENT",
  "ENOTDIR",
  "EISDIR",
  "ELOOP",
  "ENXIO",
  "EINVAL",
]);
const SEGMENT_PATTERN = /^telemetry\.[1-9][0-9]*\.[a-f0-9-]{36}\.[a-f0-9-]{36}\.jsonl(?:\.[1-9][0-9]*)?$/;
const LEGACY_PATTERN = /^telemetry\.jsonl(?:\.[1-9][0-9]*)?$/;
const MAX_QUERY_FILES = 1024;
const MAX_DIRECTORY_ENTRIES = 4096;
const MAX_QUERY_BYTES = 64 * 1024 * 1024;
const MAX_QUERY_RECORDS = 10_000;

function writerActive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Only dead-writer diagnostic segments are eligible. Journals and ambiguous legacy locks are never touched. */
export async function pruneDiagnosticArchives(
  directory: string,
  options: { now?: number; maxAgeMs?: number; maxBytes?: number; isWriterActive?: (pid: number) => boolean } = {},
): Promise<{ removedFiles: number }> {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
  const maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
  if (![now, maxAgeMs, maxBytes].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new RangeError("Invalid diagnostic retention budget");
  }
  const entries = await opendir(directory);
  const eligible: Array<{ path: string; size: number; modifiedAt: number }> = [];
  let seen = 0;
  for await (const entry of entries) {
    if (++seen > MAX_DIRECTORY_ENTRIES) break;
    if (!SEGMENT_PATTERN.test(entry.name) || !entry.isFile()) continue;
    const pid = Number(entry.name.split(".")[1]);
    if ((options.isWriterActive ?? writerActive)(pid)) continue;
    const path = join(directory, entry.name);
    try {
      const info = await lstat(path);
      if (info.isFile()) eligible.push({ path, size: info.size, modifiedAt: info.mtimeMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  eligible.sort((left, right) => left.modifiedAt - right.modifiedAt);
  let bytes = eligible.reduce((sum, file) => sum + file.size, 0);
  let removedFiles = 0;
  for (const file of eligible) {
    if (now - file.modifiedAt <= maxAgeMs && bytes <= maxBytes) continue;
    await rm(file.path, { force: true });
    bytes -= file.size;
    removedFiles += 1;
  }
  return { removedFiles };
}

function failureError(failure: DiagnosticSinkFailure): Error & DiagnosticSinkFailure {
  const budget = failure.code === "RECORD_BUDGET_EXCEEDED" || failure.code === "QUEUE_BUDGET_EXCEEDED";
  const label =
    failure.code === "RECORD_BUDGET_EXCEEDED"
      ? "Diagnostic file budget exceeded"
      : failure.code === "QUEUE_BUDGET_EXCEEDED"
        ? "Diagnostic queue budget exceeded"
        : `Diagnostic ${failure.operation} failed (${failure.code})`;
  return Object.assign(budget ? new RangeError(label) : new Error(label), failure);
}

async function io<T>(operation: DiagnosticSinkOperation, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    throw failureError({
      code: typeof code === "string" && IO_CODES.has(code) ? (code as DiagnosticSinkFailureCode) : "UNKNOWN_IO",
      operation,
    });
  }
}

/**
 * One process/generation/instance owns one append queue and its private rotations.
 * No writer waits for another process. Readers never follow archive symlinks or
 * block on special files, and have aggregate byte/file/record allocation bounds.
 */
export class DiagnosticSink<T extends object> {
  private readonly segment: string;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly maxPendingRecords: number;
  private readonly maxPendingBytes: number;
  private readonly circuitCooldownMs: number;
  private readonly fallback?: DiagnosticSinkOptions<T>["fallback"];
  private tail: Promise<void> = Promise.resolve();
  private initialized = false;
  private pendingRecords = 0;
  private pendingBytes = 0;
  private failedWrites = 0;
  private droppedRecords = 0;
  private circuitRejections = 0;
  private circuitUntil = 0;
  private currentFailure?: DiagnosticSinkFailure;
  private lastFailure?: DiagnosticSinkFailure;
  private retentionChecked = false;

  constructor(
    private readonly directory: string,
    options: DiagnosticSinkOptions<T> = {},
  ) {
    this.maxFileBytes = options.maxFileBytes ?? 10 * 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 5;
    this.maxPendingRecords = options.maxPendingRecords ?? 256;
    this.maxPendingBytes = options.maxPendingBytes ?? 1024 * 1024;
    this.circuitCooldownMs = options.circuitCooldownMs ?? 1000;
    this.fallback = options.fallback;
    if (
      ![this.maxPendingRecords, this.maxPendingBytes, this.circuitCooldownMs, options.lockDeadlineMs ?? 1000].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    ) {
      throw new RangeError("Diagnostic queue and cooldown budgets must be positive safe integers");
    }
    if (
      !Number.isSafeInteger(this.maxFileBytes) ||
      this.maxFileBytes < 128 ||
      !Number.isSafeInteger(this.maxFiles) ||
      this.maxFiles < 1 ||
      this.maxFiles > 100
    ) {
      throw new RangeError("Diagnostics require maxFileBytes >= 128 and maxFiles between 1 and 100");
    }
    const generation = /^[a-f0-9-]{36}$/.test(runtimeIdentity.generation) ? runtimeIdentity.generation : randomUUID();
    this.segment = join(directory, `telemetry.${process.pid}.${generation}.${randomUUID()}.jsonl`);
  }

  health(): DiagnosticSinkHealth {
    const status = this.currentFailure ? "degraded" : "healthy";
    return {
      status,
      pendingRecords: this.pendingRecords,
      pendingBytes: this.pendingBytes,
      failedWrites: this.failedWrites,
      droppedRecords: this.droppedRecords,
      current: {
        status,
        circuitOpen: performance.now() < this.circuitUntil,
        ...this.currentFailure,
      },
      lifetime: {
        failedWrites: this.failedWrites,
        droppedRecords: this.droppedRecords,
        circuitRejections: this.circuitRejections,
        ...(this.lastFailure ? { lastFailure: { ...this.lastFailure } } : {}),
      },
    };
  }

  async flush(deadlineMs = 1000): Promise<boolean> {
    if (!Number.isFinite(deadlineMs) || deadlineMs < 0) {
      throw new RangeError("Invalid diagnostic flush deadline");
    }
    if (this.pendingRecords === 0) {
      return true;
    }
    if (deadlineMs === 0) {
      return false;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.tail.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), deadlineMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private report(entry: T, failure: DiagnosticSinkFailure): void {
    this.lastFailure = { ...failure };
    try {
      if (this.fallback) {
        this.fallback(entry, { ...failure });
      } else {
        // The generic sink cannot establish that an arbitrary T is safe for stderr.
        console.error(JSON.stringify({ event: "diagnostic_sink_fallback", ...failure }));
      }
    } catch {
      // Logging failure must not escape into execution or protocol delivery.
    }
  }

  private rejectEntry(entry: T, failure: DiagnosticSinkFailure): never {
    this.droppedRecords += 1;
    if (failure.code === "CIRCUIT_OPEN") {
      this.circuitRejections += 1;
    } else {
      this.currentFailure = { ...failure };
    }
    this.report(entry, failure);
    throw failureError(failure);
  }

  private async rotate(incomingBytes: number): Promise<void> {
    if (!this.initialized) {
      return;
    }
    const info = await io("stat", () => lstat(this.segment));
    if (!info.isFile()) {
      throw failureError({ code: "UNSAFE_FILE", operation: "stat" });
    }
    if (info.size + incomingBytes <= this.maxFileBytes) {
      return;
    }
    await io("rotate", async () => {
      if (this.maxFiles === 1) {
        await rm(this.segment);
      } else {
        await rm(`${this.segment}.${this.maxFiles - 1}`, { force: true });
        for (let index = this.maxFiles - 2; index >= 1; index -= 1) {
          try {
            await rename(`${this.segment}.${index}`, `${this.segment}.${index + 1}`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw error;
            }
          }
        }
        await rename(this.segment, `${this.segment}.1`);
      }
    });
    this.initialized = false;
  }

  async record(entry: T): Promise<T> {
    if (performance.now() < this.circuitUntil) {
      return this.rejectEntry(entry, { code: "CIRCUIT_OPEN", operation: "enqueue" });
    }
    let snapshot: T;
    let incomingBytes: number;
    try {
      snapshot = JSON.parse(JSON.stringify(entry)) as T;
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
        throw new Error("Invalid record");
      }
      // Reserve the exact UTC stamp size before accepting the queued allocation.
      const reserved =
        (snapshot as { version?: unknown }).version === 2
          ? { ...snapshot, writtenAt: "2000-01-01T00:00:00.000Z" }
          : snapshot;
      incomingBytes = Buffer.byteLength(`${JSON.stringify(reserved)}\n`, "utf8");
    } catch {
      return this.rejectEntry(entry, { code: "INVALID_RECORD", operation: "serialize" });
    }
    if (incomingBytes > this.maxFileBytes) {
      return this.rejectEntry(snapshot, { code: "RECORD_BUDGET_EXCEEDED", operation: "serialize" });
    }
    if (this.pendingRecords >= this.maxPendingRecords || this.pendingBytes + incomingBytes > this.maxPendingBytes) {
      return this.rejectEntry(snapshot, { code: "QUEUE_BUDGET_EXCEEDED", operation: "enqueue" });
    }
    this.pendingRecords += 1;
    this.pendingBytes += incomingBytes;
    const pending = this.tail.then(async () => {
      if (performance.now() < this.circuitUntil) {
        return this.rejectEntry(snapshot, { code: "CIRCUIT_OPEN", operation: "enqueue" });
      }
      try {
        await io("mkdir", () => mkdir(this.directory, { recursive: true, mode: 0o700 }));
        if (!this.retentionChecked) {
          await io("rotate", () => pruneDiagnosticArchives(this.directory));
          this.retentionChecked = true;
        }
        await this.rotate(incomingBytes);
        const flags =
          constants.O_WRONLY |
          constants.O_APPEND |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          (this.initialized ? 0 : constants.O_CREAT | constants.O_EXCL);
        const handle = await io("open", () => open(this.segment, flags, 0o600));
        let written: T;
        try {
          const info = await io("stat", () => handle.stat());
          if (!info.isFile()) {
            throw failureError({ code: "UNSAFE_FILE", operation: "stat" });
          }
          if (info.size + incomingBytes > this.maxFileBytes) {
            throw failureError({ code: "ARCHIVE_BUDGET_EXCEEDED", operation: "write" });
          }
          this.initialized = true;
          written =
            (snapshot as { version?: unknown }).version === 2
              ? { ...snapshot, writtenAt: new Date().toISOString() }
              : snapshot;
          await io("write", () => handle.writeFile(`${JSON.stringify(written)}\n`, "utf8"));
        } finally {
          await io("close", () => handle.close());
        }
        this.currentFailure = undefined;
        this.circuitUntil = 0;
        return written;
      } catch (error) {
        const failure = error as DiagnosticSinkFailure;
        this.failedWrites += 1;
        if (failure.code === "ENOENT") this.initialized = false;
        this.currentFailure = { code: failure.code, operation: failure.operation };
        this.circuitUntil = performance.now() + this.circuitCooldownMs;
        this.report(snapshot, this.currentFailure);
        throw failureError(this.currentFailure);
      }
    });
    const tracked = pending.finally(() => {
      this.pendingRecords -= 1;
      this.pendingBytes -= incomingBytes;
    });
    this.tail = tracked.then(
      () => undefined,
      () => undefined,
    );
    return tracked;
  }

  /** At most 1024 archives, 64 MiB of source bytes, and 10,000 newest records. */
  async query(): Promise<T[]> {
    await this.tail;
    const names: string[] = [];
    try {
      const directory = await opendir(this.directory);
      let visited = 0;
      for await (const entry of directory) {
        visited += 1;
        if (visited > MAX_DIRECTORY_ENTRIES) {
          throw failureError({ code: "ARCHIVE_BUDGET_EXCEEDED", operation: "query" });
        }
        if (LEGACY_PATTERN.test(entry.name) || SEGMENT_PATTERN.test(entry.name)) {
          names.push(entry.name);
          if (names.length > MAX_QUERY_FILES) {
            throw failureError({ code: "ARCHIVE_BUDGET_EXCEEDED", operation: "query" });
          }
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return [];
      }
      if (code === "ARCHIVE_BUDGET_EXCEEDED") {
        throw error;
      }
      throw failureError({
        code: IO_CODES.has(code ?? "") ? (code as DiagnosticSinkFailureCode) : "UNKNOWN_IO",
        operation: "query",
      });
    }
    const archives: Array<{ name: string; modified: number }> = [];
    for (const name of names) {
      try {
        const info = await io("stat", () => lstat(join(this.directory, name)));
        archives.push({ name, modified: info.mtimeMs });
      } catch (error) {
        if ((error as DiagnosticSinkFailure).code !== "ENOENT") {
          throw error;
        }
      }
    }
    archives.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name, undefined, { numeric: true }));
    const records: T[] = [];
    let totalBytes = 0;
    for (const { name } of archives) {
      let handle: FileHandle;
      try {
        handle = await io("open", () =>
          open(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
        );
      } catch (error) {
        if ((error as DiagnosticSinkFailure).code === "ENOENT") {
          continue;
        }
        throw error;
      }
      let content: string;
      try {
        const info = await io("stat", () => handle.stat());
        if (!info.isFile()) {
          throw failureError({ code: "UNSAFE_FILE", operation: "read" });
        }
        if (info.size > this.maxFileBytes || totalBytes + info.size > MAX_QUERY_BYTES) {
          throw failureError({ code: "ARCHIVE_BUDGET_EXCEEDED", operation: "read" });
        }
        // A fixed snapshot allocation avoids unbounded readFile growth under a live writer.
        const buffer = Buffer.alloc(info.size + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const read = await io("read", () => handle.read(buffer, offset, buffer.length - offset, offset));
          if (read.bytesRead === 0) {
            break;
          }
          offset += read.bytesRead;
        }
        totalBytes += offset;
        if (offset > this.maxFileBytes || totalBytes > MAX_QUERY_BYTES) {
          throw failureError({ code: "ARCHIVE_BUDGET_EXCEEDED", operation: "read" });
        }
        content = buffer.toString("utf8", 0, offset);
      } finally {
        await io("close", () => handle.close());
      }
      const lines = content.split("\n");
      // The final incomplete append is never treated as a complete record.
      lines.pop();
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          const entry: unknown = JSON.parse(lines[index]);
          if (entry && typeof entry === "object" && !Array.isArray(entry) && records.length < MAX_QUERY_RECORDS) {
            records.push(entry as T);
          }
        } catch {
          // Corrupted individual lines cannot hide other valid records.
        }
      }
    }
    return records;
  }
}
