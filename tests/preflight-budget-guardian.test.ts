import { describe, expect, test } from "bun:test";
import {
  applyPreflightPredictivePruning,
  evaluatePreflightBudget,
  PREFLIGHT_SAFE_INLINE_CHAR_LIMIT,
  PREFLIGHT_MAX_STAGE_CHAR_LIMIT,
  type PreflightBudgetVerdict,
} from "../src/adapters/chatgpt-web/preflight-budget";
import type { CodexMessage, CodexParsedRequest } from "../src/types";

describe("Sprint X: Adaptive Pre-flight Token Budgeting & Predictive Pruning", () => {
  const baseCapabilities = {
    localToolsEnabled: true,
    solAvailable: true,
    extraHighAvailable: true,
    proAvailable: true,
    experimentalBiggerContext: true,
  };

  function createMockRequest(messages: CodexMessage[]): CodexParsedRequest {
    return {
      modelId: "chatgpt-web",
      options: { reasoning: "high" },
      context: {
        messages,
      },
    } as unknown as CodexParsedRequest;
  }

  test("evaluatePreflightBudget reports safe=true and inline for small prompts", () => {
    const messages: CodexMessage[] = [
      { role: "user", content: "Short query", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "Short reply" }], timestamp: 2 },
      { role: "user", content: "Next prompt", timestamp: 3 },
    ];
    const request = createMockRequest(messages);

    const verdict = evaluatePreflightBudget(request, baseCapabilities);
    expect(verdict.safe).toBe(true);
    expect(verdict.recommendedTransport).toBe("inline");
    expect(verdict.actionRequired).toBe("none");
    expect(verdict.estimatedChars).toBeLessThan(PREFLIGHT_SAFE_INLINE_CHAR_LIMIT);
  });

  test("evaluatePreflightBudget flags danger and recommends multipart when inline chars exceed safe limit", () => {
    const largeText = "x".repeat(PREFLIGHT_SAFE_INLINE_CHAR_LIMIT + 5_000);
    const messages: CodexMessage[] = [
      { role: "user", content: "Read big file", timestamp: 1 },
      { role: "toolResult", toolCallId: "t1", toolName: "read_file", isError: false, content: largeText, timestamp: 2 },
      { role: "user", content: "What is in the file?", timestamp: 3 },
    ];
    const request = createMockRequest(messages);

    const verdict = evaluatePreflightBudget(request, baseCapabilities);
    expect(verdict.safe).toBe(false);
    expect(verdict.recommendedTransport).toBe("multipart-6");
    expect(verdict.actionRequired).toBe("promote_multipart");
    expect(verdict.estimatedChars).toBeGreaterThanOrEqual(PREFLIGHT_SAFE_INLINE_CHAR_LIMIT);
  });

  test("evaluatePreflightBudget recommends apply_pruning when older tool results can be pruned", () => {
    const toolOutputA = "a".repeat(30_000);
    const toolOutputB = "b".repeat(30_000);
    const toolOutputC = "c".repeat(30_000);

    const messages: CodexMessage[] = [
      { role: "user", content: "Step 1", timestamp: 1 },
      { role: "toolResult", toolCallId: "t1", toolName: "exec", isError: false, content: toolOutputA, timestamp: 2 },
      { role: "assistant", content: [{ type: "text", text: "Done 1" }], timestamp: 3 },
      { role: "user", content: "Step 2", timestamp: 4 },
      { role: "toolResult", toolCallId: "t2", toolName: "exec", isError: false, content: toolOutputB, timestamp: 5 },
      { role: "assistant", content: [{ type: "text", text: "Done 2" }], timestamp: 6 },
      { role: "user", content: "Step 3", timestamp: 7 },
      { role: "toolResult", toolCallId: "t3", toolName: "exec", isError: false, content: toolOutputC, timestamp: 8 },
      { role: "assistant", content: [{ type: "text", text: "Done 3" }], timestamp: 9 },
      { role: "user", content: "Final prompt", timestamp: 10 },
    ];
    const request = createMockRequest(messages);

    const verdict = evaluatePreflightBudget(request, baseCapabilities, { experimentalBiggerContext: false });
    expect(verdict.safe).toBe(false);
    expect(verdict.prunableToolResultsCount).toBeGreaterThan(0);
    expect(verdict.actionRequired).toBe("apply_pruning");
  });

  test("applyPreflightPredictivePruning prunes older tool results and preserves recent ones", () => {
    const oldHeavyOutput = "heavy-old-data\n".repeat(1000); // ~15,000 chars
    const recentOutput = "recent-important-result";

    const messages: CodexMessage[] = [
      { role: "user", content: "Action 1", timestamp: 1 },
      { role: "toolResult", toolCallId: "call_1", toolName: "build", isError: false, content: oldHeavyOutput, timestamp: 2 },
      { role: "assistant", content: [{ type: "text", text: "Build finished" }], timestamp: 3 },
      { role: "user", content: "Action 2", timestamp: 4 },
      { role: "toolResult", toolCallId: "call_2", toolName: "test", isError: false, content: oldHeavyOutput, timestamp: 5 },
      { role: "assistant", content: [{ type: "text", text: "Test finished" }], timestamp: 6 },
      { role: "user", content: "Action 3", timestamp: 7 },
      { role: "toolResult", toolCallId: "call_3", toolName: "lint", isError: false, content: recentOutput, timestamp: 8 },
      { role: "user", content: "Final query", timestamp: 9 },
    ];

    const pruned = applyPreflightPredictivePruning(messages, { retainRecentToolCount: 1 });

    expect(pruned.length).toBe(messages.length);

    // Call 1 & 2 should be pruned
    const toolResult1 = pruned[1] as any;
    expect(toolResult1.content).toContain("[Historical tool output pruned by Preflight Guardian");
    expect(toolResult1.content).not.toContain("heavy-old-data");

    // Call 3 should be intact
    const toolResult3 = pruned[7] as any;
    expect(toolResult3.content).toBe(recentOutput);
  });

  test("evaluatePreflightBudget triggers compaction when payload cannot be pruned and exceeds capacity", () => {
    // Single massive user instruction without tool results to prune
    const unprunableMassivePrompt = "u".repeat(120_000);
    const messages: CodexMessage[] = [
      { role: "user", content: unprunableMassivePrompt, timestamp: 1 },
    ];
    const request = createMockRequest(messages);

    const verdict = evaluatePreflightBudget(request, baseCapabilities, { experimentalBiggerContext: false });
    expect(verdict.safe).toBe(false);
    expect(verdict.prunableToolResultsCount).toBe(0);
    expect(verdict.actionRequired).toBe("trigger_compaction");
  });

  test("preparePreflightInput transparently prunes messages when actionRequired is apply_pruning", () => {
    const { preparePreflightInput } = require("../src/adapters/chatgpt-web/preflight-budget");
    const oldOutput = "log-line\n".repeat(4000);
    const messages: CodexMessage[] = [
      { role: "user", content: "Run A", timestamp: 1 },
      { role: "toolResult", toolCallId: "c1", toolName: "run", isError: false, content: oldOutput, timestamp: 2 },
      { role: "user", content: "Run B", timestamp: 3 },
      { role: "toolResult", toolCallId: "c2", toolName: "run", isError: false, content: oldOutput, timestamp: 4 },
      { role: "user", content: "Run C", timestamp: 5 },
      { role: "toolResult", toolCallId: "c3", toolName: "run", isError: false, content: "recent", timestamp: 6 },
      { role: "user", content: "Summary", timestamp: 7 },
    ];
    const request = createMockRequest(messages);

    const { input, verdict } = preparePreflightInput(request, baseCapabilities, { experimentalBiggerContext: false });
    expect(verdict.actionRequired).toBe("apply_pruning");
    expect(input.context.messages[1].content).toContain("[Historical tool output pruned by Preflight Guardian");
    expect(input.context.messages[5].content).toBe("recent");
  });
});

