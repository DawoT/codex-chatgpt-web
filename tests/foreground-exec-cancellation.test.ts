import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommandCgroup } from "../src/adapters/chatgpt-web/command-cgroup";
import { type HandleExecCommandOptions, handleExecCommand } from "../src/adapters/chatgpt-web/fast-path/exec";

const delegatedCgroup = createCommandCgroup();
delegatedCgroup?.release();

function options(cwd: string, signal?: AbortSignal): HandleExecCommandOptions & { signal?: AbortSignal } {
  return { cwd, roots: [cwd], writableRoots: [cwd], cmd: "printf ran > marker", signal };
}

test("already cancelled execution never starts a shell", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "exec-aborted-"));
  try {
    const res = await handleExecCommand(options(cwd, AbortSignal.abort()));
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.cancelled).toBe(true);
    expect(existsSync(join(cwd, "marker"))).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cancelling a running foreground command prevents its later effects", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "exec-cancel-"));
  const controller = new AbortController();
  try {
    const pending = handleExecCommand({
      ...options(cwd, controller.signal),
      cmd: "printf ready > ready; sleep 2; printf late > marker",
    });
    const deadline = Date.now() + 1000;
    while (!existsSync(join(cwd, "ready")) && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(existsSync(join(cwd, "ready"))).toBe(true);
    controller.abort();
    const res = await pending;
    expect(res.structuredContent?.cancelled).toBe(true);
    expect(res.isError).toBe(true);
    expect(existsSync(join(cwd, "marker"))).toBe(false);
  } finally {
    controller.abort();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test.skipIf(!delegatedCgroup)("cancellation stops a descendant that starts a new session", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "exec-detached-cancel-"));
  const controller = new AbortController();
  try {
    const pending = handleExecCommand({
      ...options(cwd, controller.signal),
      cmd: "setsid bash -c 'sleep 1; printf escaped > marker' </dev/null >/dev/null 2>&1 & printf ready > ready; sleep 10",
    });
    const deadline = Date.now() + 2000;
    while (!existsSync(join(cwd, "ready")) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(join(cwd, "ready"))).toBe(true);
    controller.abort();
    const res = await pending;
    expect(res.structuredContent?.cancelled).toBe(true);
    await Bun.sleep(1200);
    expect(existsSync(join(cwd, "marker"))).toBe(false);
  } finally {
    controller.abort();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test.skipIf(!delegatedCgroup)("a completed command does not leave a detached descendant running", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "exec-detached-complete-"));
  try {
    const res = await handleExecCommand({
      ...options(cwd),
      cmd: "setsid bash -c 'sleep 1; printf escaped > marker' </dev/null >/dev/null 2>&1 & printf done",
    });
    expect(res.structuredContent?.exit_code).toBe(0);
    await Bun.sleep(1200);
    expect(existsSync(join(cwd, "marker"))).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("immediate cancellation blocks commands before their cgroup join", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "exec-immediate-cancel-"));
  try {
    for (let index = 0; index < 20; index += 1) {
      const controller = new AbortController();
      const pending = handleExecCommand({
        ...options(cwd, controller.signal),
        cmd: `sleep 0.05; printf late > marker-${index}`,
      });
      controller.abort();
      expect((await pending).structuredContent?.cancelled).toBe(true);
    }
    await Bun.sleep(150);
    for (let index = 0; index < 20; index += 1) {
      expect(existsSync(join(cwd, `marker-${index}`))).toBe(false);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test.skipIf(!delegatedCgroup)("root exit retires detached descendants that inherit output pipes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "exec-inherited-pipes-"));
  try {
    const res = await handleExecCommand({
      ...options(cwd),
      cmd: "setsid bash -c 'sleep 0.3; printf escaped > marker' & printf done",
      timeout_ms: 2000,
    });
    expect(res.structuredContent?.exit_code).toBe(0);
    expect(existsSync(join(cwd, "marker"))).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("default and explicit working directories require writable containment", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "exec-writable-"));
  const writable = join(cwd, "writable");
  mkdirSync(writable);
  try {
    for (const workdir of [undefined, cwd]) {
      const res = await handleExecCommand({ ...options(cwd), writableRoots: [writable], workdir });
      expect(res.isError).toBe(true);
      expect(existsSync(join(cwd, "marker"))).toBe(false);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
