import { expect, test } from "bun:test";
import {
  truncateOversizedContextForFallbackCompaction,
  truncateOversizedMessagesForFallbackCompaction,
} from "../src/adapters/chatgpt-web/adapter/compaction-flow";
import type { CodexMessage, CodexParsedRequest } from "../src/types";

test("single oversized text message remains literal for explicit transport preflight", () => {
  const longText = "A".repeat(250_000);
  const messages: CodexMessage[] = [{ role: "user", content: longText, timestamp: 1000 }];
  const result = truncateOversizedMessagesForFallbackCompaction(messages);
  expect(result[0]!.content).toBeTypeOf("string");
  const text = result[0]!.content as string;
  expect(text).toBe(longText);
});

test("multiple oversized text parts retain their complete content", () => {
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
  expect(totalChars).toBe(240_000);
  expect(parts.map((part) => part.text)).toEqual([part1, part2]);
});

test("assistant thinking exceeding the boundary remains available as evidence", () => {
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
  const thinkingPart = parts.find((p) => p.type === "thinking") as { type: string; thinking: string } | undefined;
  expect(thinkingPart).toBeDefined();
  expect(thinkingPart!.thinking).toBe(longThinking);
});

test("fallback preserves system instructions and messages before staging", () => {
  const longSystem = "S".repeat(250_000);
  const parsed: CodexParsedRequest = {
    modelId: "chatgpt-web/gpt-5.4",
    context: {
      systemPrompt: [longSystem, "normal prompt"],
      messages: [{ role: "user", content: "hello", timestamp: 1000 }],
    },
    stream: false,
    options: {
      reasoning: "medium",
    },
  };
  const result = truncateOversizedContextForFallbackCompaction(parsed);
  expect(result.context.systemPrompt![0]!).toBe(longSystem);
  expect(result.context.messages).toEqual(parsed.context.messages);
  expect(result.context.systemPrompt![1]!).toBe("normal prompt");
});
