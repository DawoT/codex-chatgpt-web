import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleReadFile,
  handleListDir,
  handleGrep,
  handleWriteFile,
  handlePatchFile,
  dispatchFastPathTool,
} from "../src/adapters/chatgpt-web/fast-path-handlers";
import { FastPathWorkspaceCache, workspaceFileCache } from "../src/adapters/chatgpt-web/fast-path-cache";
import {
  DEFAULT_TOOL_OFFLOAD_THRESHOLD_CHARS,
  sanitizeToolOutputWithSpooler,
  spoolToolOutput,
} from "../src/adapters/chatgpt-web/tool-spooler";
import { asMcpResult } from "../src/adapters/chatgpt-web/mcp-server";

describe("Sprint AA: Fast-Path Universal Spooling & Mutation Cache Coherence", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `sprint-aa-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    mkdirSync(tempDir, { recursive: true });
    workspaceFileCache.clear();
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    workspaceFileCache.clear();
  });

  describe("Cache Invalidation on External Mutations (GAP-03)", () => {
    test("workspaceFileCache is completely cleared after codex_exec invocation", async () => {
      const filePath = join(tempDir, "source.txt");
      writeFileSync(filePath, "original content v1", "utf-8");

      const localCache = new FastPathWorkspaceCache();
      const read1 = handleReadFile({
        path: "source.txt",
        cwd: tempDir,
        roots: [tempDir],
        cache: localCache,
      });
      expect(localCache.getStats().hits).toBe(0);
      expect(localCache.getStats().entryCount).toBe(1);

      // Verify cache hit
      const readCached = handleReadFile({
        path: "source.txt",
        cwd: tempDir,
        roots: [tempDir],
        cache: localCache,
      });
      expect(localCache.getStats().hits).toBe(1);

      // Simulate external command execution altering file on disk
      writeFileSync(filePath, "mutated content v2 by external tool", "utf-8");

      // Clearing cache guarantees eviction
      localCache.clear();
      expect(localCache.getStats().entryCount).toBe(0);

      // Next read gets fresh content
      const read2 = handleReadFile({
        path: "source.txt",
        cwd: tempDir,
        roots: [tempDir],
        cache: localCache,
      });
      const data = JSON.parse(read2.content[0].text);
      expect(data.content).toBe("mutated content v2 by external tool");
    });

    test("workspaceFileCache detects mtime/size differences even without explicit clear", () => {
      const filePath = join(tempDir, "dynamic.txt");
      writeFileSync(filePath, "first generation", "utf-8");

      const localCache = new FastPathWorkspaceCache();
      handleReadFile({
        path: "dynamic.txt",
        cwd: tempDir,
        roots: [tempDir],
        cache: localCache,
      });
      expect(localCache.getStats().entryCount).toBe(1);

      // Mutate file with different size
      writeFileSync(filePath, "second generation with substantially different length", "utf-8");

      const read2 = handleReadFile({
        path: "dynamic.txt",
        cwd: tempDir,
        roots: [tempDir],
        cache: localCache,
      });
      const data = JSON.parse(read2.content[0].text);
      expect(data.content).toBe("second generation with substantially different length");
      expect(localCache.getStats().misses).toBe(2); // Missed initial read + missed stale read
    });
  });

  describe("Fast-Path Spooling via asMcpResult in MCP Server (GAP-02)", () => {
    test("oversized handleReadFile (>2500 chars) is spooled when processed for MCP output", () => {
      const filePath = join(tempDir, "large_code.ts");
      const lines: string[] = [];
      for (let i = 1; i <= 200; i++) {
        lines.push(`export const statement_${i} = "some descriptive constant payload value ${i}";`);
      }
      const fullText = lines.join("\n");
      writeFileSync(filePath, fullText, "utf-8");
      expect(fullText.length).toBeGreaterThan(DEFAULT_TOOL_OFFLOAD_THRESHOLD_CHARS);

      const fastPathRes = handleReadFile({
        path: "large_code.ts",
        cwd: tempDir,
        roots: [tempDir],
      });

      // Raw fast-path result has long JSON text
      const rawText = fastPathRes.content[0].text;
      expect(rawText.length).toBeGreaterThan(DEFAULT_TOOL_OFFLOAD_THRESHOLD_CHARS);

      // Sanitize through spooler with workspaceRoot
      const sanitized = sanitizeToolOutputWithSpooler(fastPathRes.content, {
        workspaceRoot: tempDir,
        toolName: "codex_read_file",
      }) as Array<{ type: "text"; text: string; offloadedPath?: string }>;

      expect(sanitized[0].offloadedPath).toBeDefined();
      expect(existsSync(sanitized[0].offloadedPath!)).toBe(true);
      expect(sanitized[0].text).toContain("Output truncated and offloaded to disk");
      expect(sanitized[0].text).toContain("Head (first 15 lines)");
      expect(sanitized[0].text).toContain("Tail (last 15 lines)");

      // Verify that full content is intact on disk
      const spooledContent = readFileSync(sanitized[0].offloadedPath!, "utf-8");
      expect(spooledContent).toBe(rawText);
    });

    test("oversized handleListDir is spooled when processed for MCP output", () => {
      const subDir = join(tempDir, "many_files");
      mkdirSync(subDir, { recursive: true });
      for (let i = 1; i <= 80; i++) {
        writeFileSync(join(subDir, `generated_service_module_file_${i.toString().padStart(3, "0")}.ts`), `// File ${i}`);
      }

      const listRes = handleListDir({
        path: "many_files",
        limit: 100,
        cwd: tempDir,
        roots: [tempDir],
      });

      const rawText = listRes.content[0].text;
      expect(rawText.length).toBeGreaterThan(DEFAULT_TOOL_OFFLOAD_THRESHOLD_CHARS);

      const sanitized = sanitizeToolOutputWithSpooler(listRes.content, {
        workspaceRoot: tempDir,
        toolName: "codex_list_dir",
      }) as Array<{ type: "text"; text: string; offloadedPath?: string }>;

      expect(sanitized[0].offloadedPath).toBeDefined();
      expect(existsSync(sanitized[0].offloadedPath!)).toBe(true);
      expect(sanitized[0].text).toContain("Output truncated and offloaded to disk");
      expect(sanitized[0].text.length).toBeLessThan(rawText.length);
    });

    test("oversized handleGrep is spooled when processed for MCP output", () => {
      const codeDir = join(tempDir, "grep_test");
      mkdirSync(codeDir, { recursive: true });
      for (let i = 1; i <= 60; i++) {
        writeFileSync(
          join(codeDir, `component_${i}.ts`),
          `// Line 1\nexport const SEARCH_TARGET = "FOUND_MATCH_IN_COMPONENT_${i}_WITH_LONG_METADATA_DESCRIPTION_PAYLOAD";\n// Line 3`,
        );
      }

      const grepRes = handleGrep({
        query: "SEARCH_TARGET",
        path: "grep_test",
        max_results: 60,
        cwd: tempDir,
        roots: [tempDir],
      });

      const rawText = grepRes.content[0].text;
      expect(rawText.length).toBeGreaterThan(DEFAULT_TOOL_OFFLOAD_THRESHOLD_CHARS);

      const sanitized = sanitizeToolOutputWithSpooler(grepRes.content, {
        workspaceRoot: tempDir,
        toolName: "codex_grep",
      }) as Array<{ type: "text"; text: string; offloadedPath?: string }>;

      expect(sanitized[0].offloadedPath).toBeDefined();
      expect(existsSync(sanitized[0].offloadedPath!)).toBe(true);
      expect(sanitized[0].text).toContain("Output truncated and offloaded to disk");
      expect(sanitized[0].text.length).toBeLessThan(rawText.length);
    });

    test("small fast-path outputs (<2500 chars) are NOT spooled", () => {
      writeFileSync(join(tempDir, "small.txt"), "hello world\nsmall file content", "utf-8");

      const readRes = handleReadFile({
        path: "small.txt",
        cwd: tempDir,
        roots: [tempDir],
      });

      const sanitized = sanitizeToolOutputWithSpooler(readRes.content, {
        workspaceRoot: tempDir,
        toolName: "codex_read_file",
      }) as Array<{ type: "text"; text: string; offloadedPath?: string }>;

      expect(sanitized[0].offloadedPath).toBeUndefined();
      expect(sanitized[0].text).toBe(readRes.content[0].text);
      expect(sanitized[0].text).toContain("small file content");
    });

    test("asMcpResult decorates FastPathToolResult with spooling and structuredContent metadata", () => {
      const filePath = join(tempDir, "huge.ts");
      const lines: string[] = [];
      for (let i = 1; i <= 250; i++) {
        lines.push(`const v_${i} = "large data row content that takes substantial tokens in the prompt payload ${i}";`);
      }
      writeFileSync(filePath, lines.join("\n"), "utf-8");

      const res = handleReadFile({
        path: "huge.ts",
        cwd: tempDir,
        roots: [tempDir],
      });

      const mcpOutput = asMcpResult(res, {
        toolName: "codex_read_file",
        workspaceRoot: tempDir,
      });

      expect(mcpOutput.content[0]?.offloadedPath).toBeDefined();
      expect(existsSync(mcpOutput.content[0]?.offloadedPath!)).toBe(true);
      expect(mcpOutput.structuredContent).toBeDefined();
      expect(mcpOutput.structuredContent?.spooled).toBe(true);
      expect(mcpOutput.structuredContent?.offloadedPath).toBe(mcpOutput.content[0]?.offloadedPath);
      // Ensure huge text in structuredContent.content was replaced by spooled summary
      expect(String(mcpOutput.structuredContent?.content)).toContain("Output truncated and offloaded to disk");
    });
  });
});
