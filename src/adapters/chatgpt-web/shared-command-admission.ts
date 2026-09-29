import { Database } from "bun:sqlite";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../../config";

type Row = { id: number };
type CountRow = { count: number };
type ActiveRow = { id: number; ownerPid: number; ownerIdentity: string | null };

export interface CommandAdmissionStatus {
  capacity: number;
  active: Array<{
    id: number;
    ownerPid: number;
    ownerState: "alive" | "dead" | "reused" | "unknown";
  }>;
  waiting: number;
}

const POLL_MS = 50;
const WAIT_MS = 5000;

function linuxProcessStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const endOfName = stat.lastIndexOf(")");
    const fields = stat
      .slice(endOfName + 2)
      .trim()
      .split(/\s+/);
    if (endOfName < 0 || !/^\d+$/.test(fields[19] ?? "")) {
      throw new Error("Cannot read Linux process start identity");
    }
    return fields[19];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function linuxBootAndNamespace(): string {
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const namespace = readlinkSync("/proc/self/ns/pid");
  if (!boot || !namespace) throw new Error("Cannot read Linux process namespace identity");
  return `linux|${boot}|${namespace}`;
}

/**
 * Coordinates Chat-First shell slots across MCP processes using the same config home.
 * Active rows are only removed after command close. An abruptly killed owner leaves
 * its slot occupied: another process cannot prove its descendants have stopped.
 */
export class SharedCommandAdmission {
  private readonly database: Database;
  private readonly ownerIdentity: string;

  constructor(
    private readonly capacity: number,
    private readonly maxQueued = capacity,
    private readonly waitMs = WAIT_MS,
    configHome = getConfigDir(),
  ) {
    if (
      !Number.isSafeInteger(capacity) ||
      capacity < 1 ||
      !Number.isSafeInteger(maxQueued) ||
      maxQueued < 0 ||
      !Number.isSafeInteger(waitMs) ||
      waitMs < 1
    ) {
      throw new RangeError("Invalid shared command admission limits");
    }
    this.ownerIdentity =
      process.platform === "linux"
        ? `${linuxBootAndNamespace()}|${linuxProcessStart(process.pid) ?? "unavailable"}`
        : `pid|${process.pid}`;
    if (this.ownerIdentity.endsWith("|unavailable")) {
      throw new Error("Cannot establish owner process identity for command admission");
    }
    const home = realpathSync(configHome);
    const runtime = join(home, "runtime");
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(runtime);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (process.platform !== "win32" && (metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0))
    ) {
      throw new Error("Shared command admission requires a private runtime directory");
    }
    const path = join(runtime, "chat-first-admission.sqlite");
    let existing: ReturnType<typeof lstatSync> | undefined;
    try {
      existing = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing) {
      if (
        !existing.isFile() ||
        existing.isSymbolicLink() ||
        (process.platform !== "win32" && existing.uid !== process.getuid?.())
      ) {
        throw new Error("Shared command admission requires an owned regular database file");
      }
    }
    this.database = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    this.database.run("PRAGMA busy_timeout = 5000");
    this.database.run(`
      CREATE TABLE IF NOT EXISTS command_admission (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        state TEXT NOT NULL CHECK (state IN ('waiting', 'active')),
        owner_pid INTEGER NOT NULL,
        owner_identity TEXT NOT NULL,
        expires_at INTEGER
      )
    `);
    this.transaction(() => {
      const columns = this.database.query<{ name: string }, []>("PRAGMA table_info(command_admission)").all();
      if (!columns.some((column) => column.name === "owner_identity")) {
        this.database.run("ALTER TABLE command_admission ADD COLUMN owner_identity TEXT");
      }
    });
    this.database.run(`
      CREATE INDEX IF NOT EXISTS command_admission_state_id
      ON command_admission (state, id)
    `);
    this.database.run(`
      CREATE TABLE IF NOT EXISTS command_admission_limit (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        capacity INTEGER NOT NULL
      )
    `);
  }

  async acquire(signal?: AbortSignal, wait = true): Promise<() => void> {
    signal?.throwIfAborted();
    let ticket: number | undefined;
    const expiresAt = Date.now() + this.waitMs;
    try {
      while (true) {
        signal?.throwIfAborted();
        const outcome = this.transaction(() => {
          this.database.run("DELETE FROM command_admission WHERE state = 'waiting' AND expires_at <= ?", [Date.now()]);
          this.assertCapacity();
          const active = this.count("active");
          const oldest = this.database
            .query<Row, []>("SELECT id FROM command_admission WHERE state = 'waiting' ORDER BY id LIMIT 1")
            .get();
          if (ticket !== undefined) {
            const ownsTurn = oldest?.id === ticket;
            if (ownsTurn && active < this.capacity) {
              this.database.run("UPDATE command_admission SET state = 'active', expires_at = NULL WHERE id = ?", [
                ticket,
              ]);
              return { active: ticket };
            }
            const exists = this.database
              .query<Row, [number]>("SELECT id FROM command_admission WHERE id = ? AND state = 'waiting'")
              .get(ticket);
            if (!exists) throw new Error("Command admission timed out; no command was started.");
            return {};
          }
          if (active < this.capacity && !oldest) {
            this.database.run(
              "INSERT INTO command_admission (state, owner_pid, owner_identity) VALUES ('active', ?, ?)",
              [process.pid, this.ownerIdentity],
            );
            const id = this.database.query<Row, []>("SELECT last_insert_rowid() AS id").get()!.id;
            return { active: id };
          }
          if (!wait || this.count("waiting") >= this.maxQueued) {
            throw new Error(
              `Command capacity exhausted (maxConcurrent=${this.capacity}, maxQueued=${this.maxQueued}); no command was started.`,
            );
          }
          this.database.run(
            "INSERT INTO command_admission (state, owner_pid, owner_identity, expires_at) VALUES ('waiting', ?, ?, ?)",
            [process.pid, this.ownerIdentity, expiresAt],
          );
          return { ticket: this.database.query<Row, []>("SELECT last_insert_rowid() AS id").get()!.id };
        });
        if (outcome.active !== undefined) return this.lease(outcome.active);
        if (outcome.ticket !== undefined) ticket = outcome.ticket;
        if (Date.now() >= expiresAt) {
          throw new Error("Command admission timed out; no command was started.");
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
          }, POLL_MS);
          const abort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            reject(signal?.reason ?? new Error("Command admission cancelled"));
          };
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
    } catch (error) {
      if (ticket !== undefined) {
        this.database.run("DELETE FROM command_admission WHERE id = ? AND state = 'waiting'", [ticket]);
      }
      throw error;
    }
  }

  status(): CommandAdmissionStatus {
    const active = this.database
      .query<ActiveRow, []>(
        "SELECT id, owner_pid AS ownerPid, owner_identity AS ownerIdentity FROM command_admission WHERE state = 'active' ORDER BY id",
      )
      .all()
      .map((row) => {
        const ownerState = this.ownerState(row);
        return {
          id: row.id,
          ownerPid: row.ownerPid,
          ownerState,
        };
      });
    const capacity =
      this.database
        .query<{ capacity: number }, []>("SELECT capacity FROM command_admission_limit WHERE singleton = 1")
        .get()?.capacity ?? this.capacity;
    return { capacity, active, waiting: this.count("waiting") };
  }

  /** Operator recovery requires independent confirmation that descendants have settled. */
  recoverStale(id: number, descendantsSettled: boolean, ownerOffline = false): void {
    if (!Number.isSafeInteger(id) || id < 1 || !descendantsSettled) {
      throw new Error("Recovery requires an exact lease ID and --ack-descendants-settled");
    }
    this.transaction(() => {
      const row = this.database
        .query<ActiveRow, [number]>(
          "SELECT id, owner_pid AS ownerPid, owner_identity AS ownerIdentity FROM command_admission WHERE id = ? AND state = 'active'",
        )
        .get(id);
      if (!row) throw new Error(`Active command lease ${id} was not found`);
      const state = this.ownerState(row);
      if (state === "alive" || (state === "unknown" && !ownerOffline)) {
        throw new Error(
          `Cannot recover command lease ${id}: owner process ${row.ownerPid} is ${state === "alive" ? "still alive" : "unverified"}`,
        );
      }
      this.database.run("DELETE FROM command_admission WHERE id = ? AND state = 'active'", [id]);
    });
  }

  private ownerState(row: ActiveRow): "alive" | "dead" | "reused" | "unknown" {
    if (process.platform === "linux") {
      const parts = row.ownerIdentity?.split("|");
      if (parts?.length !== 4 || parts[0] !== "linux") return "unknown";
      try {
        if (parts.slice(0, 3).join("|") !== linuxBootAndNamespace()) return "unknown";
        const currentStart = linuxProcessStart(row.ownerPid);
        if (currentStart === undefined) return "dead";
        return currentStart === parts[3] ? "alive" : "reused";
      } catch {
        return "unknown";
      }
    }
    if (row.ownerIdentity !== `pid|${row.ownerPid}`) return "unknown";
    try {
      process.kill(row.ownerPid, 0);
      return "alive";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return "dead";
      return "unknown";
    }
  }

  private assertCapacity(): void {
    const current = this.database
      .query<{ capacity: number }, []>("SELECT capacity FROM command_admission_limit WHERE singleton = 1")
      .get();
    if (!current || this.count("active") + this.count("waiting") === 0) {
      this.database.run("INSERT OR REPLACE INTO command_admission_limit (singleton, capacity) VALUES (1, ?)", [
        this.capacity,
      ]);
    } else if (current.capacity !== this.capacity) {
      throw new Error(
        `Command admission config mismatch (active capacity=${current.capacity}, requested=${this.capacity}); no command was started.`,
      );
    }
  }

  private count(state: "active" | "waiting"): number {
    return this.database
      .query<CountRow, [string]>("SELECT COUNT(*) AS count FROM command_admission WHERE state = ?")
      .get(state)!.count;
  }

  private transaction<T>(operation: () => T): T {
    this.database.run("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.database.run("COMMIT");
      return value;
    } catch (error) {
      this.database.run("ROLLBACK");
      throw error;
    }
  }

  private lease(id: number): () => void {
    let released = false;
    return () => {
      if (released) return;
      this.database.run("DELETE FROM command_admission WHERE id = ? AND state = 'active'", [id]);
      released = true;
    };
  }
}
