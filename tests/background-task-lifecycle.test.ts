import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundTaskManager } from "../src/adapters/chatgpt-web/background-task-manager";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "task-lifecycle-"));
  const manager = new BackgroundTaskManager();
  const start = (cmd: string, extra = {}) => manager.startTask({
    cmd,
    cwd: root,
    roots: [root],
    writableRoots: [root],
    ...extra,
  });
  return { root, manager, start };
}

test("task owners cannot list, read, wait for or kill another owner's task", async () => {
  const { root, manager, start } = fixture();
  const task = start("echo owner-a", { ownerId: "a" });
  try {
    expect(manager.getTask(task.id, "b")).toBeUndefined();
    expect(manager.listTasks("b")).toEqual([]);
    expect(manager.getTaskLog(task.id, 10, "b")).toBeNull();
    expect(await manager.pollTask(task.id, 100, 10, { ownerId: "b" })).toBeNull();
    expect(manager.killTask(task.id, "b")).toBe(false);
    const own = await manager.pollTask(task.id, 2000, 10, { ownerId: "a" });
    expect(own?.tail).toContain("owner-a");
    expect(manager.listTasks("a")).toHaveLength(1);
  } finally {
    manager.killTask(task.id, "a");
    rmSync(root, { recursive: true, force: true });
  }
});

test("background workdir is honored and escapes are rejected before creating a task", async () => {
  const { root, manager, start } = fixture();
  const sub = join(root, "sub");
  mkdirSync(sub);
  try {
    const task = start(process.platform === "win32" ? "cd" : "pwd", { workdir: "sub" });
    expect(task.cwd).toBe(sub);
    const completed = await manager.pollTask(task.id, 2000);
    expect(completed?.tail).toContain(sub);
    expect(() => start("echo forbidden", { workdir: ".." })).toThrow();
    expect(manager.listTasks()).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a completion listener may unsubscribe itself without skipping the next listener", async () => {
  const { root, manager, start } = fixture();
  const observed: string[] = [];
  const unsubscribe = manager.onCompletion(() => {
    observed.push("first");
    unsubscribe();
  });
  manager.onCompletion(() => {
    observed.push("second");
  });
  try {
    const task = start("echo done");
    await manager.pollTask(task.id, 2000);
    expect(observed).toEqual(["first", "second"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelled task polling releases its wait immediately without killing the task", async () => {
  const { root, manager, start } = fixture();
  const task = start(process.platform === "win32" ? "ping -n 6 127.0.0.1 > NUL" : "sleep 5");
  try {
    const controller = new AbortController();
    const pending = manager.pollTask(task.id, 30_000, 10, { signal: controller.signal });
    controller.abort(new Error("test cancellation"));
    const outcome = await Promise.race([
      pending.then(() => "resolved", error => error.message),
      Bun.sleep(250).then(() => "late"),
    ]);
    expect(outcome).toBe("test cancellation");
    expect(manager.getTask(task.id)?.status).toBe("running");
  } finally {
    manager.killTask(task.id);
    await manager.pollTask(task.id, 2000);
    rmSync(root, { recursive: true, force: true });
  }
});

test("task logs reject a redirected directory and never read a replaced log", async () => {
  const { root, manager, start } = fixture();
  const { symlinkSync, unlinkSync, writeFileSync } = await import("node:fs");
  const outside = mkdtempSync(join(tmpdir(), "task-log-outside-"));
  try {
    symlinkSync(outside, join(root, ".codex-tmp"), process.platform === "win32" ? "junction" : "dir");
    expect(() => start("echo escaped")).toThrow();
    unlinkSync(join(root, ".codex-tmp"));
    const task = start("echo original");
    await manager.pollTask(task.id, 2000);
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "foreign-private-log");
    unlinkSync(task.fullLogPath);
    symlinkSync(secret, task.fullLogPath);
    expect(manager.getTaskLog(task.id)?.logTail).not.toContain("foreign-private-log");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("evicting old completed tasks removes their owned logs instead of orphaning them", async () => {
  const { root, manager, start } = fixture();
  const { existsSync } = await import("node:fs");
  try {
    const first = start("echo first");
    await manager.pollTask(first.id, 2000);
    for (let index = 0; index < 51; index++) {
      const next = start("echo next");
      await manager.pollTask(next.id, 2000);
    }
    expect(manager.getTask(first.id)).toBeUndefined();
    expect(existsSync(first.fullLogPath)).toBe(false);
    expect(manager.listTasks()).toHaveLength(50);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("killing a task stops descendants that ignore graceful termination", async () => {
  const { root, manager, start } = fixture();
  const { existsSync } = await import("node:fs");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const code = [
    'const fs = require("node:fs");',
    'process.on("SIGTERM", () => {});',
    'fs.writeFileSync("ready", "yes");',
    'setTimeout(() => { fs.writeFileSync("survived", "yes"); process.exit(0); }, 2000);',
  ].join("\n");
  const task = start(`${quote(process.execPath)} -e ${quote(code)} & wait`);
  try {
    const deadline = Date.now() + 2000;
    while (!existsSync(join(root, "ready")) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(join(root, "ready"))).toBe(true);
    expect(manager.killTask(task.id)).toBe(true);
    await manager.pollTask(task.id, 3000);
    await Bun.sleep(2100);
    expect(existsSync(join(root, "survived"))).toBe(false);
    expect(manager.getTask(task.id)?.status).toBe("killed");
  } finally {
    manager.killTask(task.id);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a single log line larger than the tail budget still returns its last fragment", async () => {
  const { root, manager, start } = fixture();
  const { writeFileSync } = await import("node:fs");
  try {
    const task = start("echo initial");
    await manager.pollTask(task.id, 2000);
    writeFileSync(task.fullLogPath, "x".repeat(200_000) + "final-fragment");
    const tail = manager.getTaskLog(task.id, 10)?.logTail;
    expect(tail).toEndWith("final-fragment");
    expect(Buffer.byteLength(tail!)).toBeLessThanOrEqual(128 * 1024);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
