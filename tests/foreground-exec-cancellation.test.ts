import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleExecCommand, type HandleExecCommandOptions } from "../src/adapters/chatgpt-web/fast-path/exec";

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
