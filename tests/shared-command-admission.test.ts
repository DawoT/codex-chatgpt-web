import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedCommandAdmission } from "../src/adapters/chatgpt-web/shared-command-admission";

const homes: string[] = [];

function home(): string {
  const path = mkdtempSync(join(tmpdir(), "cgw-admission-"));
  homes.push(path);
  return path;
}

afterEach(() => {
  for (const path of homes.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

test("separate database connections grant waiting sessions in FIFO order", async () => {
  const configHome = home();
  const first = new SharedCommandAdmission(1, 2, 2000, configHome);
  const second = new SharedCommandAdmission(1, 2, 2000, configHome);
  const third = new SharedCommandAdmission(1, 2, 2000, configHome);
  const releaseFirst = await first.acquire();
  const order: string[] = [];
  const next = second.acquire().then((release) => {
    order.push("second");
    release();
  });
  await Bun.sleep(40);
  const last = third.acquire().then((release) => {
    order.push("third");
    release();
  });
  await Bun.sleep(40);
  expect(order).toEqual([]);
  releaseFirst();
  await Promise.all([next, last]);
  expect(order).toEqual(["second", "third"]);
});

test("aborted waiting session loses its ticket and cannot consume the next slot", async () => {
  const configHome = home();
  const first = new SharedCommandAdmission(1, 1, 1000, configHome);
  const second = new SharedCommandAdmission(1, 1, 1000, configHome);
  const release = await first.acquire();
  const controller = new AbortController();
  const waiting = second.acquire(controller.signal).catch((error) => error);
  await Bun.sleep(40);
  controller.abort(new Error("cancelled"));
  expect((await waiting).message).toBe("cancelled");
  release();
  const nextRelease = await second.acquire(undefined, false);
  nextRelease();
});

test("a foreground timeout clears its queue entry without releasing another command", async () => {
  const configHome = home();
  const first = new SharedCommandAdmission(1, 1, 80, configHome);
  const second = new SharedCommandAdmission(1, 1, 80, configHome);
  const release = await first.acquire();
  await expect(second.acquire()).rejects.toThrow("timed out");
  await expect(second.acquire(undefined, false)).rejects.toThrow("capacity exhausted");
  release();
  const nextRelease = await second.acquire(undefined, false);
  nextRelease();
});

test("config changes cannot weaken capacity while a lease is active", async () => {
  const configHome = home();
  const first = new SharedCommandAdmission(1, 1, 1000, configHome);
  const changed = new SharedCommandAdmission(2, 2, 1000, configHome);
  const release = await first.acquire();
  await expect(changed.acquire(undefined, false)).rejects.toThrow("config mismatch");
  release();
  const nextRelease = await changed.acquire(undefined, false);
  nextRelease();
});

test("operator recovery refuses a live lease and an unacknowledged request", async () => {
  const admission = new SharedCommandAdmission(1, 1, 1000, home());
  const release = await admission.acquire();
  const lease = admission.status().active[0];
  expect(lease?.ownerPid).toBe(process.pid);
  expect(lease?.ownerState).toBe("alive");
  expect(() => admission.recoverStale(lease!.id, false)).toThrow("ack-descendants-settled");
  expect(() => admission.recoverStale(lease!.id, true)).toThrow("still alive");
  expect(() => admission.recoverStale(lease!.id, true, true)).toThrow("still alive");
  expect(admission.status().active).toHaveLength(1);
  release();
  expect(admission.status().active).toHaveLength(0);
});

test("recovery refuses an owner from an unverified PID namespace", async () => {
  if (process.platform !== "linux") return;
  const configHome = home();
  const admission = new SharedCommandAdmission(1, 1, 1000, configHome);
  const release = await admission.acquire();
  const id = admission.status().active[0]!.id;
  const database = new Database(join(configHome, "runtime", "chat-first-admission.sqlite"));
  try {
    database.run("UPDATE command_admission SET owner_identity = ? WHERE id = ?", ["linux|foreign-boot|pid:[1]|1", id]);
    expect(admission.status().active[0]?.ownerState).toBe("unknown");
    expect(() => admission.recoverStale(id, true)).toThrow("unverified");
  } finally {
    database.close();
    release();
  }
});

test("admission refuses a symlinked runtime directory", () => {
  const configHome = home();
  const target = join(configHome, "target");
  mkdirSync(target);
  symlinkSync(target, join(configHome, "runtime"));
  expect(() => new SharedCommandAdmission(1, 1, 1000, configHome)).toThrow("private runtime directory");
});

test("unknown older owner identity requires separate offline acknowledgement", () => {
  if (process.platform !== "linux") return;
  const configHome = home();
  const admission = new SharedCommandAdmission(1, 1, 1000, configHome);
  const database = new Database(join(configHome, "runtime", "chat-first-admission.sqlite"));
  try {
    database.run("INSERT INTO command_admission (state, owner_pid, owner_identity) VALUES ('active', ?, ?)", [
      999_999_999,
      "linux|previous-boot|pid:[1]|1",
    ]);
    const lease = admission.status().active[0]!;
    expect(lease.ownerState).toBe("unknown");
    expect(() => admission.recoverStale(lease.id, true)).toThrow("unverified");
    admission.recoverStale(lease.id, true, true);
    expect(admission.status().active).toHaveLength(0);
  } finally {
    database.close();
  }
});
