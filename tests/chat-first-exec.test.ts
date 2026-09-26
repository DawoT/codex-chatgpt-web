import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  MAX_EXEC_TIMEOUT_MS,
  MIN_EXEC_TIMEOUT_MS,
  handleExecCommand,
  executeFastPathBatch,
  type FastPathToolResult,
} from "../src/adapters/chatgpt-web/fast-path-handlers";
import { FastPathWorkspaceCache } from "../src/adapters/chatgpt-web/fast-path-cache";

function payload(res: FastPathToolResult): Record<string, any> {
  return res.structuredContent as Record<string, any>;
}

describe("Chat-First Shell Execution (codex_exec)", () => {
  test("exports generous timeout constants for heavy testing and compilation", () => {
    expect(DEFAULT_EXEC_TIMEOUT_MS).toBe(600_000); // 10 minutes default
    expect(MAX_EXEC_TIMEOUT_MS).toBe(1_800_000);   // 30 minutes ceiling
    expect(MIN_EXEC_TIMEOUT_MS).toBe(1_000);       // 1 second floor
  });

  test("executes basic shell command and returns stdout and exit_code 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-first-exec-test-"));
    try {
      const res = await handleExecCommand({
        cmd: "echo 'hello from chat-first'",
        cwd: root,
        roots: [root],
        writableRoots: [root],
      });
      expect(res.isError).toBeUndefined();
      const out = payload(res);
      expect(out.cmd).toBe("echo 'hello from chat-first'");
      expect(out.exit_code).toBe(0);
      expect(out.timed_out).toBe(false);
      expect(out.stdout.trim()).toBe("hello from chat-first");
      expect(out.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("honors custom relative and absolute workdir within allowed roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-first-workdir-"));
    try {
      const sub = join(root, "subdir");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(sub);

      // Relative workdir
      const resRel = await handleExecCommand({
        cmd: "pwd",
        workdir: "subdir",
        cwd: root,
        roots: [root],
        writableRoots: [root],
      });
      expect(resRel.isError).toBeUndefined();
      expect(payload(resRel).stdout.trim()).toBe(sub);

      // Absolute workdir
      const resAbs = await handleExecCommand({
        cmd: "pwd",
        workdir: sub,
        cwd: root,
        roots: [root],
        writableRoots: [root],
      });
      expect(resAbs.isError).toBeUndefined();
      expect(payload(resAbs).stdout.trim()).toBe(sub);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects command execution when writableRoots is empty (readOnly mode)", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-first-readonly-"));
    try {
      const res = await handleExecCommand({
        cmd: "echo 'should be rejected'",
        cwd: root,
        roots: [root],
        writableRoots: [],
      });
      expect(res.isError).toBe(true);
      expect(payload(res).error).toContain("disabled in readOnly mode");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("captures stderr and non-zero exit_code on failed commands", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-first-failed-"));
    try {
      const res = await handleExecCommand({
        cmd: "echo 'failure diagnostic' >&2; exit 42",
        cwd: root,
        roots: [root],
        writableRoots: [root],
      });
      expect(res.isError).toBe(true);
      const out = payload(res);
      expect(out.exit_code).toBe(42);
      expect(out.stderr.trim()).toContain("failure diagnostic");
      expect(out.timed_out).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("terminates on timeout, captures partial output, and provides actionable guidance", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-first-timeout-"));
    try {
      // Produce some output, then sleep longer than the short timeout
      const cmd = "echo 'partial test output before cutoff'; sleep 3; echo 'should never reach'";
      const res = await handleExecCommand({
        cmd,
        timeout_ms: 100, // 100ms timeout
        cwd: root,
        roots: [root],
        writableRoots: [root],
      });
      expect(res.isError).toBe(true);
      const out = payload(res);
      expect(out.timed_out).toBe(true);
      expect(out.exit_code).toBe(-1);
      expect(out.stdout).toContain("partial test output before cutoff");
      expect(out.stdout).not.toContain("should never reach");
      expect(out.stderr).toContain("Command timed out after 1000ms"); // clamped to MIN_EXEC_TIMEOUT_MS = 1000ms
      expect(out.stderr).toContain("Partial output was preserved above");
      expect(out.stderr).toContain("pass a larger timeout_ms");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not hang on commands expecting stdin (receives EOF)", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-first-stdin-"));
    try {
      const start = Date.now();
      const res = await handleExecCommand({
        cmd: "cat", // without args or closed stdin, cat would hang waiting for user input
        cwd: root,
        roots: [root],
        writableRoots: [root],
        timeout_ms: 5_000,
      });
      const elapsed = Date.now() - start;
      expect(res.isError).toBeUndefined();
      expect(payload(res).exit_code).toBe(0);
      expect(elapsed).toBeLessThan(3_000); // Exited immediately on EOF
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("invalidates FastPathWorkspaceCache on command execution", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-first-cache-"));
    try {
      const cache = new FastPathWorkspaceCache();
      const filePath = join(root, "test.txt");
      writeFileSync(filePath, "initial content", "utf8");

      // Prime cache
      const { handleReadFile } = await import("../src/adapters/chatgpt-web/fast-path-handlers");
      const read1 = handleReadFile({ path: "test.txt", cwd: root, roots: [root], cache });
      expect(payload(read1).content).toBe("initial content");

      // Execute command that mutates the file
      await handleExecCommand({
        cmd: "echo 'mutated by script' > test.txt",
        cwd: root,
        roots: [root],
        writableRoots: [root],
        cache,
      });

      // Cache should be cleared and fresh content returned
      const read2 = handleReadFile({ path: "test.txt", cwd: root, roots: [root], cache });
      expect(payload(read2).content.trim()).toBe("mutated by script");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("executeFastPathBatch handles codex_exec alongside read operations", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-first-batch-"));
    try {
      writeFileSync(join(root, "sample.txt"), "before mutation\n", "utf8");
      const results = await executeFastPathBatch(
        [
          { id: "call_1", tool: "codex_read_file", arguments: { path: "sample.txt" } },
          { id: "call_2", tool: "codex_exec", arguments: { cmd: "echo 'executed in batch'" } },
        ],
        { cwd: root, roots: [root], writableRoots: [root] },
      );

      expect(results).toHaveLength(2);
      expect(results[0].id).toBe("call_1");
      expect(payload(results[0].result).content.trim()).toBe("before mutation");
      expect(results[1].id).toBe("call_2");
      expect(payload(results[1].result).stdout.trim()).toBe("executed in batch");
      expect(payload(results[1].result).exit_code).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
