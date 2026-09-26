import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TOOL_OFFLOAD_THRESHOLD_CHARS,
  DEFAULT_HEAD_LINES,
  DEFAULT_TAIL_LINES,
  spoolToolOutput,
  sanitizeToolOutputWithSpooler,
  resolveProjectScratchDirectory,
  type ToolSpoolerOptions,
} from "../src/adapters/chatgpt-web/tool-spooler";

describe("Sprint T: MCP Tool Output Offloading & Spooling (.agents/scratch/)", () => {
  let tempWorkspace: string;

  beforeEach(() => {
    tempWorkspace = mkdtempSync(join(tmpdir(), "spooler-test-workspace-"));
  });

  afterEach(() => {
    try {
      rmSync(tempWorkspace, { recursive: true, force: true });
    } catch {}
  });

  describe("resolveProjectScratchDirectory", () => {
    test("creates .agents/scratch/outputs inside provided workspace root", () => {
      const scratchDir = resolveProjectScratchDirectory(tempWorkspace);
      expect(existsSync(scratchDir)).toBe(true);
      expect(scratchDir).toBe(join(tempWorkspace, ".agents", "scratch", "outputs"));
    });

    test("falls back cleanly if workspace is not writable or undefined", () => {
      const fallbackDir = resolveProjectScratchDirectory("/non/existent/unwritable/path/that/cannot/exist");
      expect(existsSync(fallbackDir)).toBe(true);
      expect(fallbackDir).toContain(".codex-chatgpt-web");
    });
  });

  describe("spoolToolOutput", () => {
    test("preserves short outputs below the threshold without touching disk", () => {
      const shortText = "Build succeeded: 42 tests passed in 1.2s.";
      const result = spoolToolOutput(shortText, {
        workspaceRoot: tempWorkspace,
        maxChars: 500,
      });

      expect(result.text).toBe(shortText);
      expect(result.spooled).toBe(false);
      expect(result.filePath).toBeUndefined();

      // Ensure no files were created in .agents
      const agentsDir = join(tempWorkspace, ".agents");
      expect(existsSync(agentsDir)).toBe(false);
    });

    test("offloads oversized output to disk and returns structured head/tail summary", () => {
      const lines: string[] = [];
      for (let i = 1; i <= 200; i++) {
        lines.push(`Line ${i}: log entry with relevant stack trace details and context.`);
      }
      const largeText = lines.join("\n");
      expect(largeText.length).toBeGreaterThan(DEFAULT_TOOL_OFFLOAD_THRESHOLD_CHARS);

      const result = spoolToolOutput(largeText, {
        workspaceRoot: tempWorkspace,
        toolName: "bash",
        callId: "call_abc123",
      });

      expect(result.spooled).toBe(true);
      expect(result.filePath).toBeDefined();
      expect(existsSync(result.filePath!)).toBe(true);

      // Verify the entire original content was preserved on disk
      const savedContent = readFileSync(result.filePath!, "utf-8");
      expect(savedContent).toBe(largeText);

      // Verify the summary returned to ChatGPT
      expect(result.text.length).toBeLessThan(largeText.length);
      expect(result.text).toContain("Output truncated and offloaded to disk");
      expect(result.text).toContain(result.filePath!);
      expect(result.text).toContain("Line 1:");
      expect(result.text).toContain(`Line ${DEFAULT_HEAD_LINES}:`);
      expect(result.text).toContain("Line 200:");
      expect(result.text).toContain("To inspect specific sections, use read_file with offset/limit_lines or grep");
    });

    test("respects custom headLines and tailLines parameters", () => {
      const lines: string[] = [];
      for (let i = 1; i <= 100; i++) {
        lines.push(`Row ${i}`);
      }
      const largeText = lines.join("\n");

      const result = spoolToolOutput(largeText, {
        workspaceRoot: tempWorkspace,
        maxChars: 100,
        headLines: 5,
        tailLines: 5,
        toolName: "git_diff",
        callId: "call_diff99",
      });

      expect(result.spooled).toBe(true);
      expect(result.text).toContain("Row 1");
      expect(result.text).toContain("Row 5");
      expect(result.text).not.toContain("Row 6\n");
      expect(result.text).not.toContain("Row 90\n");
      expect(result.text).toContain("Row 96");
      expect(result.text).toContain("Row 100");
    });

    test("handles non-newline text by falling back to character-based slicing", () => {
      const solidBlock = "X".repeat(5000);
      const result = spoolToolOutput(solidBlock, {
        workspaceRoot: tempWorkspace,
        maxChars: 500,
      });

      expect(result.spooled).toBe(true);
      expect(result.text.length).toBeLessThan(solidBlock.length);
      expect(result.text).toContain("Output truncated and offloaded to disk");
      expect(readFileSync(result.filePath!, "utf-8")).toBe(solidBlock);
    });

    test("fails closed gracefully to memory truncation if writing to disk throws", () => {
      const largeText = "Y\n".repeat(3000);

      const result = spoolToolOutput(largeText, {
        workspaceRoot: tempWorkspace,
        maxChars: 500,
        deps: {
          writeFileSync: () => {
            throw new Error("Disk full or permission denied simulation");
          },
        },
      });

      // Should not throw, but fallback to memory truncation
      expect(result.text.length).toBeLessThan(largeText.length);
      expect(result.spooled).toBe(false);
      expect(result.text).toContain("characters omitted to prevent context overflow");
    });
  });

  describe("sanitizeToolOutputWithSpooler", () => {
    test("sanitizes arrays containing multiple parts (text, image, json)", () => {
      const normalText = "Short status";
      const oversizedText = "Data line\n".repeat(500);
      const imagePart = { type: "image", data: "base64encodedimage" };

      const content = [
        { type: "text", text: normalText },
        { type: "text", text: oversizedText },
        imagePart,
      ];

      const sanitized = sanitizeToolOutputWithSpooler(content, {
        workspaceRoot: tempWorkspace,
        toolName: "test_tool",
        callId: "call_multi_1",
      }) as Array<{ type: string; text?: string; data?: string }>;

      expect(sanitized).toHaveLength(3);
      expect(sanitized[0]!.text).toBe(normalText);
      expect(sanitized[1]!.text!.length).toBeLessThan(oversizedText.length);
      expect(sanitized[1]!.text).toContain("Output truncated and offloaded to disk");
      expect(sanitized[2]).toEqual(imagePart);
    });

    test("leaves non-array inputs intact", () => {
      expect(sanitizeToolOutputWithSpooler(null as never, {})).toBe(null as never);
      expect(sanitizeToolOutputWithSpooler(undefined as never, {})).toBe(undefined as never);
    });
  });
});
