import { expect, test } from "bun:test";
import {
  FALLBACK_COMPACTION_TRUNCATION_LIMIT,
  truncateOversizedMessagesForFallbackCompaction,
  truncateOversizedContextForFallbackCompaction,
} from "../src/adapters/chatgpt-web/adapter/compaction-flow";
import type { CodexMessage, CodexParsedRequest } from "../src/types";

test("single oversized text message is truncated with notice", () => {
  const longText = "A".repeat(250_000);
  const messages: CodexMessage[] = [
    { role: "user", content: longText, timestamp: 1000 },
  ];
  const result = truncateOversizedMessagesForFallbackCompaction(messages);
  expect(result[0]!.content).toBeTypeOf("string");
  const text = result[0]!.content as string;
  expect(text.length).toBeLessThan(longText.length);
  expect(text).toContain("characters truncated for compaction");
  expect(text.startsWith("A".repeat(FALLBACK_COMPACTION_TRUNCATION_LIMIT))).toBe(true);
});

test("multiple text parts summing to over the limit are truncated so total fits", () => {
  // Two parts of 120,000 chars each = 240,000 chars (> 210,756), but neither is > 210,756 individually
  const part1 = "A".repeat(120_000);
  const part2 = "B".repeat(120_000);
  const messages: CodexMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: part1 },
        { type: "text", text: part2 },
      ],
      timestamp: 1000,
    },
  ];
  const result = truncateOversizedMessagesForFallbackCompaction(messages);
  const parts = result[0]!.content as Array<{ type: string; text: string }>;
  const totalChars = parts.reduce((sum, p) => sum + p.text.length, 0);
  expect(totalChars).toBeLessThanOrEqual(FALLBACK_COMPACTION_TRUNCATION_LIMIT + 500);
  expect(parts.some(p => p.text.includes("characters truncated for compaction"))).toBe(true);
});

test("assistant thinking part exceeding the limit is truncated", () => {
  const longThinking = "T".repeat(250_000);
  const messages: CodexMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: longThinking },
        { type: "text", text: "Final answer" },
      ],
      timestamp: 1000,
    },
  ];
  const result = truncateOversizedMessagesForFallbackCompaction(messages);
  const parts = result[0]!.content as unknown as Array<Record<string, unknown>>;
  const thinkingPart = parts.find(p => p.type === "thinking") as { type: string; thinking: string } | undefined;
  expect(thinkingPart).toBeDefined();
  expect(thinkingPart!.thinking.length).toBeLessThan(longThinking.length);
  expect(thinkingPart!.thinking).toContain("characters truncated for compaction");
});

test("truncateOversizedContextForFallbackCompaction truncates systemPrompt as well as messages", () => {
  const longSystem = "S".repeat(250_000);
  const parsed: CodexParsedRequest = {
    modelId: "chatgpt-web/gpt-5.4",
    context: {
      systemPrompt: [longSystem, "normal prompt"],
      messages: [
        { role: "user", content: "hello", timestamp: 1000 },
      ],
    },
    stream: false,
    options: {
      reasoning: "medium",
    },
  };
  const result = truncateOversizedContextForFallbackCompaction(parsed);
  expect(result.context.systemPrompt![0]!.length).toBeLessThan(longSystem.length);
  expect(result.context.systemPrompt![0]!).toContain("characters truncated for compaction");
  expect(result.context.systemPrompt![1]!).toBe("normal prompt");
});
