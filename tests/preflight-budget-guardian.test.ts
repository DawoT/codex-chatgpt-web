import { describe, expect, test } from "bun:test";
import {
  enforcePreflightDeliveryBudget,
  evaluatePreflightBudget,
  PREFLIGHT_SAFE_INLINE_CHAR_LIMIT,
  PREFLIGHT_MAX_STAGE_CHAR_LIMIT,
  type PreflightBudgetVerdict,
} from "../src/adapters/chatgpt-web/preflight-budget";
import type { CodexMessage, CodexParsedRequest } from "../src/types";

describe("Lossless preflight transport planning", () => {
  const baseCapabilities = {
    localToolsEnabled: true,
    solAvailable: true,
    extraHighAvailable: true,
    proAvailable: true,
    experimentalBiggerContext: true,
  };

  function createMockRequest(messages: CodexMessage[]): CodexParsedRequest {
    return {
      modelId: "gpt-5.6-sol",
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



  test("a large inline-only payload is left to measured model limits", () => {
    // Single massive user instruction without tool results to prune
    const unprunableMassivePrompt = "u".repeat(120_000);
    const messages: CodexMessage[] = [
      { role: "user", content: unprunableMassivePrompt, timestamp: 1 },
    ];
    const request = createMockRequest(messages);

    const verdict = evaluatePreflightBudget(request, baseCapabilities, { experimentalBiggerContext: false });
    expect(verdict.safe).toBe(false);
    expect(verdict.prunableToolResultsCount).toBe(0);
    expect(verdict.actionRequired).toBe("none");
  });



  test("resolveBiggerContextMultipartParts enforces safe boundary when forceMultipart is true", () => {
    const { resolveBiggerContextMultipartParts } = require("../src/adapters/chatgpt-web/usage");
    // Message > 65k chars
    const largeMessage = "x".repeat(80_000);
    const messages: CodexMessage[] = [
      { role: "user", content: largeMessage, timestamp: 1 },
    ];
    const request = createMockRequest(messages);

    // With forceMultipart = true, it must return a multipart count (2 or 6), NEVER undefined
    const parts = resolveBiggerContextMultipartParts(request, baseCapabilities, false, true);
    expect(parts).toBeDefined();
    expect(parts === 2 || parts === 6).toBe(true);
  });

  test("promotes a fitting 160k character payload instead of requiring compaction", () => {
    const request = createMockRequest([
      { role: "user", content: "x".repeat(160_001), timestamp: 1 },
    ]);

    const verdict = evaluatePreflightBudget(request, baseCapabilities, {
      experimentalBiggerContext: true,
    });

    expect(verdict.estimatedChars).toBe(160_001);
    expect(verdict.actionRequired).toBe("promote_multipart");
    expect(verdict.prunableToolResultsCount).toBe(0);
    expect(verdict.reason).toContain("multipart");
  });

  test("does not block a 227k character payload before compiled limits are measured", () => {
    const request = createMockRequest([
      { role: "user", content: "x".repeat(227_000), timestamp: 1 },
    ]);
    const verdict = evaluatePreflightBudget(request, baseCapabilities, {
      experimentalBiggerContext: true,
    });

    expect(verdict.actionRequired).toBe("promote_multipart");
    expect(() => enforcePreflightDeliveryBudget(request, verdict)).not.toThrow();

    const compactRequest = { ...request, _compactionRequest: true };
    expect(() => enforcePreflightDeliveryBudget(compactRequest, verdict)).not.toThrow();
  });
});
