import { expect, test } from "bun:test";
import { estimateChatGptWebUsage, resolveBiggerContextMultipartParts } from "../src/adapters/chatgpt-web/usage";
import type { CodexParsedRequest } from "../src/types";

const capabilities = {
  localToolsEnabled: true,
  solAvailable: true,
  extraHighAvailable: true,
  proAvailable: true,
};

test("usage measures accumulated tool history even when a fresh transport cannot carry it", () => {
  const request: CodexParsedRequest = {
    modelId: "gpt-5.6-sol",
    stream: true,
    options: { reasoning: "high" },
    context: {
      messages: [
        { role: "user", content: "Inspect the evidence", timestamp: 1 },
        {
          role: "toolResult",
          toolCallId: "call_evidence",
          toolName: "exec_command",
          content: "evidence line\n".repeat(25_000),
          isError: false,
          timestamp: 2,
        },
      ],
    },
  };

  // This history belongs to an already running browser conversation. A new Send
  // must still fail closed, but measuring completed work must not cancel it.
  expect(() => resolveBiggerContextMultipartParts(request, capabilities)).toThrow("45,000");
  const before = estimateChatGptWebUsage(
    { ...request, context: { messages: request.context.messages.slice(0, 1) } },
    { answer: "done" },
    capabilities,
    true,
  );
  const usage = estimateChatGptWebUsage(request, { answer: "done" }, capabilities, true);
  expect(usage.estimated).toBe(true);
  expect(usage.inputTokens).toBeGreaterThan(before.inputTokens + 50_000);
  expect(usage.inputTokens).toBeLessThan(240_300);
  expect(usage.outputTokens).toBeGreaterThan(0);
  expect(usage.totalTokens).toBe(usage.inputTokens + usage.outputTokens);
  expect(usage).toEqual(estimateChatGptWebUsage(request, { answer: "done" }, capabilities, false));
});
