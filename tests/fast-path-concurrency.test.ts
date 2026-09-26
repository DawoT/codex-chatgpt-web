import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isReadOnlyFastPathTool,
  isMutatingFastPathTool,
  dispatchFastPathTool,
  executeFastPathBatch,
  type FastPathToolCall,
} from "../src/adapters/chatgpt-web/fast-path-handlers";
import { FastPathWorkspaceCache } from "../src/adapters/chatgpt-web/fast-path-cache";

describe("Sprint X: Concurrent Fast-Path Batch Execution", () => {
  let tmpDir: string;
  let cache: FastPathWorkspaceCache;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cgw-fastpath-concurrency-"));
    cache = new FastPathWorkspaceCache();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("tool classifiers correctly distinguish read-only vs mutating operations", () => {
    expect(isReadOnlyFastPathTool("codex_read_file")).toBe(true);
    expect(isReadOnlyFastPathTool("read_file")).toBe(true);
    expect(isReadOnlyFastPathTool("codex_list_dir")).toBe(true);
    expect(isReadOnlyFastPathTool("list_dir")).toBe(true);
    expect(isReadOnlyFastPathTool("codex_grep")).toBe(true);
    expect(isReadOnlyFastPathTool("grep")).toBe(true);

    expect(isReadOnlyFastPathTool("codex_write_file")).toBe(false);
    expect(isReadOnlyFastPathTool("codex_patch_file")).toBe(false);
    expect(isReadOnlyFastPathTool("codex_exec")).toBe(false);
    expect(isReadOnlyFastPathTool("unknown_tool")).toBe(false);

    expect(isMutatingFastPathTool("codex_write_file")).toBe(true);
    expect(isMutatingFastPathTool("write_file")).toBe(true);
    expect(isMutatingFastPathTool("codex_patch_file")).toBe(true);
    expect(isMutatingFastPathTool("patch_file")).toBe(true);

    expect(isMutatingFastPathTool("codex_read_file")).toBe(false);
    expect(isMutatingFastPathTool("codex_list_dir")).toBe(false);
  });

  test("dispatchFastPathTool returns error for unknown tool without throwing", async () => {
    const res = await dispatchFastPathTool(
      "non_existent_tool",
      {},
      { cwd: tmpDir, roots: [tmpDir], cache },
    );
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error).toContain("Unsupported fast-path tool");
  });

  test("concurrently executes read-only operations and preserves call IDs and order", async () => {
    writeFileSync(join(tmpDir, "file1.txt"), "hello from file 1\n");
    writeFileSync(join(tmpDir, "file2.txt"), "hello from file 2\n");
    writeFileSync(join(tmpDir, "file3.txt"), "hello from file 3\n");

    const batch: FastPathToolCall[] = [
      { id: "call_1", tool: "codex_read_file", arguments: { path: "file1.txt" } },
      { id: "call_2", tool: "codex_read_file", arguments: { path: "file2.txt" } },
      { id: "call_3", tool: "codex_read_file", arguments: { path: "file3.txt" } },
      { id: "call_4", tool: "codex_list_dir", arguments: { path: "." } },
    ];

    const results = await executeFastPathBatch(batch, {
      cwd: tmpDir,
      roots: [tmpDir],
      cache,
    });

    expect(results).toHaveLength(4);
    expect(results[0].id).toBe("call_1");
    expect(results[0].result.structuredContent.content).toContain("hello from file 1");

    expect(results[1].id).toBe("call_2");
    expect(results[1].result.structuredContent.content).toContain("hello from file 2");

    expect(results[2].id).toBe("call_3");
    expect(results[2].result.structuredContent.content).toContain("hello from file 3");

    expect(results[3].id).toBe("call_4");
    expect(results[3].result.structuredContent.entries).toBeDefined();
  });

  test("enforces barrier ordering: reads before write observe old state, reads after write observe new state", async () => {
    writeFileSync(join(tmpDir, "target.txt"), "version 1\n");

    const batch: FastPathToolCall[] = [
      { id: "r1", tool: "codex_read_file", arguments: { path: "target.txt" } },
      {
        id: "w1",
        tool: "codex_write_file",
        arguments: { path: "target.txt", content: "version 2\n", overwrite: true },
      },
      { id: "r2", tool: "codex_read_file", arguments: { path: "target.txt" } },
      {
        id: "p1",
        tool: "codex_patch_file",
        arguments: { path: "target.txt", target_content: "version 2", replacement_content: "version 3" },
      },
      { id: "r3", tool: "codex_read_file", arguments: { path: "target.txt" } },
    ];

    const results = await executeFastPathBatch(batch, {
      cwd: tmpDir,
      roots: [tmpDir],
      cache,
    });

    expect(results).toHaveLength(5);
    // r1 reads initial version 1
    expect(results[0].result.structuredContent.content).toBe("version 1\n");
    // w1 writes version 2
    expect(results[1].result.structuredContent.overwrote).toBe(true);
    // r2 reads updated version 2
    expect(results[2].result.structuredContent.content).toBe("version 2\n");
    // p1 patches to version 3
    expect(results[3].result.structuredContent.replacements).toBe(1);
    // r3 reads updated version 3
    expect(results[4].result.structuredContent.content).toBe("version 3\n");
  });

  test("error on one tool call does not abort or corrupt remaining operations in batch", async () => {
    writeFileSync(join(tmpDir, "existing.txt"), "I exist\n");

    const batch: FastPathToolCall[] = [
      { id: "fail_1", tool: "codex_read_file", arguments: { path: "does_not_exist.txt" } },
      { id: "ok_1", tool: "codex_read_file", arguments: { path: "existing.txt" } },
      {
        id: "fail_2",
        tool: "codex_write_file",
        arguments: { path: "/outside/sandbox/file.txt", content: "bad" },
      },
      { id: "ok_2", tool: "codex_list_dir", arguments: { path: "." } },
    ];

    const results = await executeFastPathBatch(batch, {
      cwd: tmpDir,
      roots: [tmpDir],
      cache,
    });

    expect(results).toHaveLength(4);
    expect(results[0].result.isError).toBe(true);
    expect(results[0].result.structuredContent.error).toContain("does not exist");

    expect(results[1].result.isError).toBeUndefined();
    expect(results[1].result.structuredContent.content).toBe("I exist\n");

    expect(results[2].result.isError).toBe(true);
    expect(results[2].result.structuredContent.error).toContain("sandbox roots");

    expect(results[3].result.isError).toBeUndefined();
    expect(results[3].result.structuredContent.entries).toBeDefined();
  });
});
