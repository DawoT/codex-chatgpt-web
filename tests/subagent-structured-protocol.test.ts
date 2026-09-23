import { describe, expect, test } from "bun:test";
import {
  SUBAGENT_RESULT_TAG_CLOSE,
  SUBAGENT_RESULT_TAG_OPEN,
  SUBAGENT_STRUCTURED_RESULT_SCHEMA_INSTRUCTION,
  formatSubagentResultSummary,
  parseSubagentStructuredResult,
  type SubagentStructuredResult,
} from "../src/adapters/chatgpt-web/subagent-protocol";

describe("Sprint F: Structured Subagent Return Protocol", () => {
  describe("parseSubagentStructuredResult", () => {
    test("returns null for empty or non-string inputs", () => {
      expect(parseSubagentStructuredResult("")).toBeNull();
      // @ts-expect-error test non-string
      expect(parseSubagentStructuredResult(null)).toBeNull();
      // @ts-expect-error test non-string
      expect(parseSubagentStructuredResult(undefined)).toBeNull();
    });

    test("returns null when no XML tags and no JSON object present", () => {
      expect(parseSubagentStructuredResult("Just some normal conversation text with no structure.")).toBeNull();
    });

    test("parses standard <subagent_result> with completed status", () => {
      const text = `
I finished updating the user authentication module.

<subagent_result>
{
  "status": "completed",
  "summary": "Updated auth tokens and verified unit tests.",
  "modified_files": ["src/auth.ts", "tests/auth.test.ts"],
  "created_artifacts": ["logs/auth-test.log"]
}
</subagent_result>
      `.trim();

      const result = parseSubagentStructuredResult(text);
      expect(result).not.toBeNull();
      expect(result?.status).toBe("completed");
      expect(result?.summary).toBe("Updated auth tokens and verified unit tests.");
      expect(result?.modified_files).toEqual(["src/auth.ts", "tests/auth.test.ts"]);
      expect(result?.created_artifacts).toEqual(["logs/auth-test.log"]);
      expect(result?.diagnostics).toBeUndefined();
    });

    test("handles case-insensitive tags and extra whitespace", () => {
      const text = `
<SUBAGENT_RESULT>
  {
    "status": "COMPLETED",
    "summary": "Done with changes"
  }
</SUBAGENT_RESULT>
      `;

      const result = parseSubagentStructuredResult(text);
      expect(result).not.toBeNull();
      expect(result?.status).toBe("completed");
      expect(result?.summary).toBe("Done with changes");
    });

    test("handles markdown json code blocks inside XML tags", () => {
      const text = `
<subagent_result>
\`\`\`json
{
  "status": "failed",
  "summary": "Compilation failed due to syntax error",
  "diagnostics": "src/app.ts:12:3 - TS1005: ';' expected."
}
\`\`\`
</subagent_result>
      `;

      const result = parseSubagentStructuredResult(text);
      expect(result).not.toBeNull();
      expect(result?.status).toBe("failed");
      expect(result?.summary).toBe("Compilation failed due to syntax error");
      expect(result?.diagnostics).toBe("src/app.ts:12:3 - TS1005: ';' expected.");
    });

    test("handles blocked status with reason", () => {
      const text = `
<subagent_result>
{
  "status": "blocked",
  "summary": "Cannot access external API without network credentials",
  "diagnostics": "Network 403 Forbidden"
}
</subagent_result>
      `;

      const result = parseSubagentStructuredResult(text);
      expect(result).not.toBeNull();
      expect(result?.status).toBe("blocked");
      expect(result?.diagnostics).toBe("Network 403 Forbidden");
    });

    test("falls back to failed status when error or diagnostics present but invalid status string", () => {
      const text = `
<subagent_result>
{
  "status": "unexpected_status",
  "summary": "Failed to run command",
  "error": "Command exited with status 127"
}
</subagent_result>
      `;

      const result = parseSubagentStructuredResult(text);
      expect(result).not.toBeNull();
      expect(result?.status).toBe("failed");
      expect(result?.diagnostics).toBe("Command exited with status 127");
    });

    test("lenient fallback parses JSON without XML tags if status and summary exist", () => {
      const text = `
Worker finished task:
{
  "status": "completed",
  "summary": "Generated all SVG assets",
  "modified_files": ["assets/logo.svg"]
}
End of report.
      `;

      const result = parseSubagentStructuredResult(text);
      expect(result).not.toBeNull();
      expect(result?.status).toBe("completed");
      expect(result?.summary).toBe("Generated all SVG assets");
      expect(result?.modified_files).toEqual(["assets/logo.svg"]);
    });

    test("trims and filters invalid array entries in modified_files and created_artifacts", () => {
      const text = `
<subagent_result>
{
  "status": "completed",
  "summary": "Refactored helpers",
  "modified_files": ["  src/helper.ts  ", "", null, 42, "  tests/helper.test.ts  "],
  "created_artifacts": ["", "  artifact.txt  "]
}
</subagent_result>
      `;

      const result = parseSubagentStructuredResult(text);
      expect(result).not.toBeNull();
      expect(result?.modified_files).toEqual(["src/helper.ts", "tests/helper.test.ts"]);
      expect(result?.created_artifacts).toEqual(["artifact.txt"]);
    });

    test("gracefully returns null if JSON inside tags is corrupt", () => {
      const text = `
<subagent_result>
{ "status": "completed", "summary": "unclosed json ...
</subagent_result>
      `;

      expect(parseSubagentStructuredResult(text)).toBeNull();
    });
  });

  describe("formatSubagentResultSummary", () => {
    test("formats a completed result cleanly", () => {
      const result: SubagentStructuredResult = {
        status: "completed",
        summary: "Created database migration 001",
        modified_files: ["prisma/schema.prisma"],
        created_artifacts: ["migrations/001.sql"],
      };

      const formatted = formatSubagentResultSummary(result);
      expect(formatted).toContain("[Subagent Result: COMPLETED]");
      expect(formatted).toContain("Summary: Created database migration 001");
      expect(formatted).toContain("Modified files (1): prisma/schema.prisma");
      expect(formatted).toContain("Artifacts (1): migrations/001.sql");
      expect(formatted).not.toContain("Diagnostics:");
    });

    test("formats a failed result with diagnostics", () => {
      const result: SubagentStructuredResult = {
        status: "failed",
        summary: "Unit tests failed",
        diagnostics: "3 tests failed in auth.test.ts",
      };

      const formatted = formatSubagentResultSummary(result);
      expect(formatted).toContain("[Subagent Result: FAILED]");
      expect(formatted).toContain("Diagnostics: 3 tests failed in auth.test.ts");
    });
  });

  describe("SUBAGENT_STRUCTURED_RESULT_SCHEMA_INSTRUCTION", () => {
    test("contains valid schema guidelines and tags", () => {
      const joined = SUBAGENT_STRUCTURED_RESULT_SCHEMA_INSTRUCTION.join("\n");
      expect(joined).toContain(SUBAGENT_RESULT_TAG_OPEN);
      expect(joined).toContain(SUBAGENT_RESULT_TAG_CLOSE);
      expect(joined).toContain('"status": "completed"');
      expect(joined).toContain('"summary"');
      expect(joined).toContain('"modified_files"');
    });
  });

  describe("Integration with Prompt Compilation and Micro-Compaction", () => {
    test("subagent turn compiles prompt containing structured result schema contract", async () => {
      const { compileChatGptWebPrompt } = await import("../src/adapters/chatgpt-web/prompt");
      const { CHATGPT_WEB_MODEL_ID } = await import("../src/adapters/chatgpt-web/model");

      const subagentReq = {
        modelId: CHATGPT_WEB_MODEL_ID,
        stream: true,
        options: { reasoning: "high" as const },
        context: {
          systemPrompt: ["test"],
          messages: [
            { role: "user" as const, content: "Do atomic subtask", timestamp: 1 },
          ],
        },
        _rawBody: {
          client_metadata: {
            "x-codex-turn-metadata": {
              subagent_kind: "thread_spawn",
              parent_thread_id: "thread_root_123",
            },
          },
        },
      };

      const compiled = compileChatGptWebPrompt(
        subagentReq,
        { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: false },
        "turn_12345678901234567890123456789012",
      );

      expect(compiled.text).toContain(SUBAGENT_RESULT_TAG_OPEN);
      expect(compiled.text).toContain(SUBAGENT_RESULT_TAG_CLOSE);
      expect(compiled.text).toContain("STRUCTURED RESULT CONTRACT");
    });

    test("root turn compiles prompt instructing to parse subagent result blocks", async () => {
      const { compileChatGptWebPrompt } = await import("../src/adapters/chatgpt-web/prompt");
      const { CHATGPT_WEB_MODEL_ID } = await import("../src/adapters/chatgpt-web/model");

      const rootReq = {
        modelId: CHATGPT_WEB_MODEL_ID,
        stream: true,
        options: { reasoning: "high" as const },
        context: {
          systemPrompt: ["test"],
          messages: [
            { role: "user" as const, content: "Coordinate repository task", timestamp: 1 },
          ],
        },
      };

      const compiled = compileChatGptWebPrompt(
        rootReq,
        { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: false },
        "turn_12345678901234567890123456789012",
      );

      expect(compiled.text).toContain("parse their <subagent_result> blocks for task status");
      expect(compiled.text).not.toContain("You are an ephemeral atomic worker operating in a dedicated sub-session.");
    });

    test("applyMicroCompactionBoundary preserves subagent result summary across compaction stages", async () => {
      const { applyMicroCompactionBoundary } = await import("../src/adapters/chatgpt-web/prompt");

      const subagentVerboseProse = "Working through steps... " + "reasoning ".repeat(200);
      const subagentResultJson = `
<subagent_result>
{
  "status": "completed",
  "summary": "Implemented fast-path tools",
  "modified_files": ["src/tools.ts"]
}
</subagent_result>
      `.trim();

      const fullAssistantText = `${subagentVerboseProse}\n${subagentResultJson}`;

      const messages = [
        { role: "user" as const, content: "Task 1", timestamp: 1 },
        {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: fullAssistantText }],
          timestamp: 2,
        },
        { role: "user" as const, content: "Task 2", timestamp: 3 },
        { role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }], timestamp: 4 },
        { role: "user" as const, content: "Active current task", timestamp: 5 },
      ];

      // Force compaction by setting ceiling very low
      const condensed = applyMicroCompactionBoundary(messages, 10);
      const firstAssistant = condensed[1] as { content: Array<{ type: string; text: string }> };
      const assistantText = firstAssistant.content[0]?.text ?? "";

      expect(assistantText).toContain("[Subagent Result: COMPLETED]");
      expect(assistantText).toContain("Implemented fast-path tools");
      expect(assistantText).toContain("src/tools.ts");
      expect(assistantText).not.toContain(subagentVerboseProse);
    });
  });
});

