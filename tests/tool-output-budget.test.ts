import { expect, test } from "bun:test";
import {
  CHATGPT_WEB_MAX_TOOL_OUTPUT_CHARS,
  sanitizeToolOutputContent,
  truncateToolOutputText,
} from "../src/adapters/chatgpt-web/mcp-server";

test("preserves tool output below the context safety budget", () => {
  const shortText = "Line 1: Build succeeded.\nLine 2: 12 tests passed.";
  expect(truncateToolOutputText(shortText)).toBe(shortText);

  const content = [{ type: "text", text: shortText }];
  expect(sanitizeToolOutputContent(content)).toEqual(content);
});

test("truncates oversized tool output cleanly to protect the 80k token budget", () => {
  const lines: string[] = [];
  for (let i = 1; i <= 2000; i++) {
    lines.push(`Line ${i}: log output entry with detailed information and stack traces.`);
  }
  const hugeText = lines.join("\n");
  expect(hugeText.length).toBeGreaterThan(CHATGPT_WEB_MAX_TOOL_OUTPUT_CHARS);

  const truncated = truncateToolOutputText(hugeText);
  expect(truncated.length).toBeLessThan(hugeText.length);
  expect(truncated).toContain("Line 1:");
  expect(truncated).toContain("Line 2000:");
  expect(truncated).toContain("characters omitted to prevent context overflow");
  expect(truncated).toContain("To inspect more, use grep, head/tail, or redirect output to a file");
});

test("sanitizes content arrays containing text and non-text parts", () => {
  const normalText = "Short status";
  const oversizedText = "x\n".repeat(20_000);
  const imagePart = { type: "image", data: "base64data" };

  const content = [
    { type: "text", text: normalText },
    { type: "text", text: oversizedText },
    imagePart,
  ];

  const sanitized = sanitizeToolOutputContent(content) as Array<{ type: string; text?: string }>;
  expect(sanitized).toHaveLength(3);
  expect(sanitized[0]!.text).toBe(normalText);
  expect(sanitized[1]!.text!.length).toBeLessThan(oversizedText.length);
  expect(sanitized[1]!.text).toContain("output truncated");
  expect(sanitized[2]).toEqual(imagePart);
});
