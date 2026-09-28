import { expect, test } from "bun:test";
import { responsesUsage } from "../src/bridge/usage";

test("estimated browser usage never invents a zero provider cache read", () => {
  const usage = responsesUsage({
    inputTokens: 12_000,
    outputTokens: 400,
    totalTokens: 12_400,
    estimated: true,
  });
  expect(usage).toEqual({
    input_tokens: 12_000,
    output_tokens: 400,
    total_tokens: 12_400,
  });
  expect(usage).not.toHaveProperty("input_tokens_details");
});

test("observed cache reads, when explicitly available, remain part of total input tokens", () => {
  const usage = responsesUsage({
    inputTokens: 12_000,
    cachedInputTokens: 4_000,
    outputTokens: 400,
    totalTokens: 12_400,
  });
  expect(usage).toMatchObject({
    input_tokens: 12_000,
    total_tokens: 12_400,
    input_tokens_details: { cached_tokens: 4_000 },
  });
});
