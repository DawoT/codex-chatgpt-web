import { describe, expect, test } from "bun:test";
import { condenseVerboseProseWithSyntaxAwareness } from "../src/adapters/chatgpt-web/syntax-condenser";
import { applyMicroCompactionBoundary } from "../src/adapters/chatgpt-web/prompt";
import type { CodexMessage } from "../src/types";

describe("Sprint L: Syntax & Diff-Aware Micro-Compaction", () => {
  test("preserves short text under 400 chars untouched", () => {
    const text = "Short assistant message discussing the architecture.";
    expect(condenseVerboseProseWithSyntaxAwareness(text)).toBe(text);
  });

  test("condenses TypeScript code block while preserving function signature and balanced fences", () => {
    const verboseTs = [
      "Here is the implementation of the auth provider:",
      "```typescript",
      "export class AuthenticationManager {",
      "  private readonly tokenStore: Map<string, string> = new Map();",
      "  constructor(private readonly salt: string) {",
      "    console.log('Initializing auth manager with secret salt');",
      "  }",
      "  public async validateToken(token: string): Promise<boolean> {",
      "    const hash = await crypto.subtle.digest('SHA-256', Buffer.from(token + this.salt));",
      "    return hash.byteLength === 32;",
      "  }",
      "}",
      "```",
      "This class handles validation securely across all worker processes.",
    ].join("\n");

    expect(verboseTs.length).toBeGreaterThan(400);

    const condensed = condenseVerboseProseWithSyntaxAwareness(verboseTs, 400);

    // Code fences must be balanced
    const fenceMatches = condensed.match(/```/g) || [];
    expect(fenceMatches.length % 2).toBe(0);

    // Language tag and class signature must be preserved
    expect(condensed).toContain("```typescript");
    expect(condensed).toContain("export class AuthenticationManager {");
    expect(condensed).toContain("// [... implementation details omitted for context budget ...]");
    expect(condensed).toContain("}");

    // Overall length is reduced
    expect(condensed.length).toBeLessThan(verboseTs.length);
  });

  test("condenses Unified Diff patch while preserving headers", () => {
    const verboseDiff = [
      "I have updated the router implementation with this patch:",
      "```diff",
      "diff --git a/src/router.ts b/src/router.ts",
      "index a1b2c3d..e4f5g6h 100644",
      "--- a/src/router.ts",
      "+++ b/src/router.ts",
      "@@ -15,7 +15,7 @@ export class Router {",
      "-  private route: string = '/old';",
      "+  private route: string = '/new';",
      "   public handle(req: Request): Response {",
      "-    return new Response('deprecated');",
      "+    return new Response('active');",
      "   }",
      " }",
      "```",
      "This patch updates both the route definition and the response message cleanly.",
    ].join("\n");

    const longDiff = verboseDiff + "\n" + "Extra analysis text to ensure we cross the character threshold. ".repeat(6);
    expect(longDiff.length).toBeGreaterThan(400);

    const condensed = condenseVerboseProseWithSyntaxAwareness(longDiff, 400);

    // Verify diff headers preserved
    expect(condensed).toContain("```diff");
    expect(condensed).toContain("diff --git a/src/router.ts b/src/router.ts");
    expect(condensed).toContain("--- a/src/router.ts");
    expect(condensed).toContain("+++ b/src/router.ts");
    expect(condensed).toContain("[... diff hunks omitted for context budget ...]");

    // Verify fence balance
    const fenceMatches = condensed.match(/```/g) || [];
    expect(fenceMatches.length % 2).toBe(0);
  });

  test("condenses JSON payload while preserving object structure", () => {
    const largeObj: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) {
      largeObj[`key_${i}`] = `value_long_string_entry_${i}_payload_data`;
    }
    const verboseJson = `Configuration output:\n\`\`\`json\n${JSON.stringify(largeObj, null, 2)}\n\`\`\`\nPlease review the configuration.`;
    expect(verboseJson.length).toBeGreaterThan(400);

    const condensed = condenseVerboseProseWithSyntaxAwareness(verboseJson, 400);

    expect(condensed).toContain("```json");
    expect(condensed).toContain("{\n  \"_context\": \"[... json properties omitted for context budget ...]\"\n}");
    const fenceMatches = condensed.match(/```/g) || [];
    expect(fenceMatches.length % 2).toBe(0);
  });

  test("condenses plain prose at natural word/newline boundaries", () => {
    const sentences = [
      "The subsystem architecture relies on a supervisor that tracks health every 15 seconds.",
      "If three consecutive probes fail, exponential backoff initiates recovery.",
      "During this time, client requests are buffered or returned with 503 retryable status.",
      "Once the connection is re-established, the supervisor clears error counters.",
      "This design prevents persistent zombie connections from blocking Codex turns.",
    ];
    const longProse = sentences.join(" ").repeat(3);
    expect(longProse.length).toBeGreaterThan(400);

    const condensed = condenseVerboseProseWithSyntaxAwareness(longProse, 400);
    expect(condensed).toContain("[... intermediate discussion omitted for context budget ...]");
    // Does not slice in the middle of a token or leave unclosed fences
    expect(condensed).not.toContain("```");
    expect(condensed.length).toBeLessThan(longProse.length);
  });

  test("integration with applyMicroCompactionBoundary preserves code fences in history messages", () => {
    const codeSnippet = [
      "```typescript",
      "export function computeTotal(items: number[]): number {",
      "  return items.reduce((acc, curr) => acc + curr, 0);",
      "}",
      "```",
    ].join("\n");

    const verboseAssistant = `Analysis of items:\n${codeSnippet}\n` + "Detailed breakdown of each item calculation. ".repeat(15);

    const messages: CodexMessage[] = [
      { role: "user", content: "Initial task instruction", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: verboseAssistant }], timestamp: 2 },
      { role: "toolResult", toolCallId: "call_1", toolName: "exec", content: "OK", isError: false, timestamp: 3 },
      { role: "user", content: "Next active instruction", timestamp: 4 },
    ];

    // Stage 1 micro-compaction: ceiling set to 120 tokens, satisfies Stage 1
    const compacted = applyMicroCompactionBoundary(messages, 120);
    const assistantMsg = compacted[1]!;
    const textPart = assistantMsg.content[0] as { type: "text"; text: string };

    // Fences must be balanced and typescript code fence preserved
    const fenceCount = (textPart.text.match(/```/g) || []).length;
    expect(fenceCount % 2).toBe(0);
    expect(textPart.text).toContain("```typescript");
    expect(textPart.text).toContain("computeTotal");

    // Stage 2 micro-compaction: ceiling set to very low 20 tokens, triggers Stage 2
    const compactedStage2 = applyMicroCompactionBoundary(messages, 20);
    const textPartStage2 = compactedStage2[1]!.content[0] as { type: "text"; text: string };
    expect(textPartStage2.text).toBe("[Earlier assistant reply condensed for context budget]");
  });
});
