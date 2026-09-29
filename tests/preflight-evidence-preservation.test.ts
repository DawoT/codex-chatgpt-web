import { expect, test } from "bun:test";
import { preparePreflightInput } from "../src/adapters/chatgpt-web/preflight-budget";
import type { CodexParsedRequest } from "../src/types";

for (const multipart of [false, true]) {
  test(`preflight preserves historical failures and obligations with multipart=${multipart}`, () => {
    const request = {
      modelId: "gpt-5.6-sol",
      options: { reasoning: "high" },
      context: {
        systemPrompt: ["Do not repeat mutations with unknown outcomes."],
        messages: [
          { role: "user", content: "Audit without deployment", timestamp: 1 },
          {
            role: "toolResult",
            toolCallId: "old",
            toolName: "exec",
            isError: true,
            content: `${"diagnostic\n".repeat(8000)}Unresolved: migration failed; do not retry; inspect src/db.ts:40.`,
            timestamp: 2,
          },
          {
            role: "toolResult",
            toolCallId: "newer",
            toolName: "read",
            isError: false,
            content: "newer evidence",
            timestamp: 3,
          },
          {
            role: "toolResult",
            toolCallId: "latest",
            toolName: "read",
            isError: false,
            content: "latest evidence",
            timestamp: 4,
          },
          { role: "user", content: "Explain the original failure", timestamp: 5 },
        ],
      },
    } as CodexParsedRequest;
    const original = structuredClone(request);
    const result = preparePreflightInput(
      request,
      {
        localToolsEnabled: true,
        solAvailable: true,
        extraHighAvailable: true,
        proAvailable: true,
      },
      { experimentalBiggerContext: multipart },
    );
    expect(result.input).toEqual(original);
    expect(request).toEqual(original);
    expect(result.verdict.actionRequired).toBe(multipart ? "promote_multipart" : "none");
  });
}
