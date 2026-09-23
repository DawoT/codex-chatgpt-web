import { describe, expect, test } from "bun:test";
import {
  preserveHeadTailOutput,
  truncateToolOutputText,
} from "../src/adapters/chatgpt-web/fast-path-handlers";

describe("Sprint V: Diagnostic-Aware Head/Tail Output Preservation", () => {
  test("preserves output intact when within maxChars limit", () => {
    const text = "npm run test: passing 5 tests, 0 failures.";
    expect(truncateToolOutputText(text, 1000)).toBe(text);
    expect(preserveHeadTailOutput(text, 1000)).toBe(text);
  });

  test("preserves initial command and final failure stack trace across large output", () => {
    const lines: string[] = [
      "$ bun test ./tests",
      "Running 895 tests across 75 files...",
    ];
    for (let i = 1; i <= 1000; i++) {
      lines.push(`PASS tests/feature-${i}.test.ts [1.2ms]`);
    }
    lines.push("FAIL tests/critical.test.ts");
    lines.push("AssertionError: expected true but received false");
    lines.push("    at Object.<anonymous> (/workspace/tests/critical.test.ts:42:15)");
    lines.push("1 tests failed, 894 passed");

    const hugeText = lines.join("\n");
    const truncated = truncateToolOutputText(hugeText, 4000);

    expect(truncated.length).toBeLessThanOrEqual(4500);
    // Head preservation: contains initial command
    expect(truncated).toContain("$ bun test ./tests");
    expect(truncated).toContain("Running 895 tests");

    // Middle omitted indicator
    expect(truncated).toContain("characters omitted to prevent context overflow");

    // Tail preservation: contains the critical failure and stack trace
    expect(truncated).toContain("FAIL tests/critical.test.ts");
    expect(truncated).toContain("AssertionError: expected true but received false");
    expect(truncated).toContain("/workspace/tests/critical.test.ts:42:15");
    expect(truncated).toContain("1 tests failed, 894 passed");
  });

  test("respects explicit headChars and tailChars when provided", () => {
    const text = "START_BLOCK\n" + "x\n".repeat(5000) + "END_BLOCK";
    const custom = truncateToolOutputText(text, 1000, {
      headChars: 150,
      tailChars: 250,
    });

    expect(custom).toContain("START_BLOCK");
    expect(custom).toContain("END_BLOCK");
    expect(custom).toContain("characters omitted");
  });

  test("safely handles small custom maxChars without negative omitted calculation", () => {
    const text = "A".repeat(500) + "\n" + "B".repeat(500);
    const small = truncateToolOutputText(text, 400);

    expect(small).toContain("characters omitted");
    expect(small.length).toBeLessThan(text.length);
  });
});
