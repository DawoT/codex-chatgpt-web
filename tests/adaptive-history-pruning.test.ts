import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MICRO_COMPACTION_TOKEN_CEILING,
  DEFAULT_RETAINED_COMPLETED_TOOL_RESULTS,
  HISTORICAL_TOOL_OUTPUT_PRUNE_THRESHOLD_CHARS,
  applyMicroCompactionBoundary,
  deduplicateEnvironmentContexts,
  pruneHistoricalToolOutputs,
  withAdaptiveHistoryPruning,
} from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_INSTANT_AUTO_COMPACT_TOKEN_LIMIT } from "../src/chatgpt-web-models";
import { SUMMARY_PREFIX } from "../src/responses/compaction";
import type { CodexMessage } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userMsg(content: string, ts = 1): CodexMessage {
  return { role: "user", content, timestamp: ts };
}

function devMsg(content: string, ts = 1): CodexMessage {
  return { role: "developer", content, timestamp: ts };
}

function assistantMsg(text: string, ts = 1): CodexMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: ts };
}

function toolResultMsg(toolName: string, content: string, isError = false, ts = 1): CodexMessage {
  return {
    role: "toolResult",
    toolCallId: `call_${toolName}_${ts}`,
    toolName,
    content,
    isError,
    timestamp: ts,
  };
}

function envContextMsg(extra = "", ts = 1): CodexMessage {
  return userMsg(
    `<environment_context>cwd: /workspace sandbox: workspaceWrite${extra}</environment_context>`,
    ts,
  );
}

// ---------------------------------------------------------------------------
// pruneHistoricalToolOutputs
// ---------------------------------------------------------------------------

describe("Sprint E: Adaptive History Pruning", () => {
  describe("pruneHistoricalToolOutputs", () => {
    test("constants have expected values", () => {
      expect(DEFAULT_RETAINED_COMPLETED_TOOL_RESULTS).toBe(2);
      expect(HISTORICAL_TOOL_OUTPUT_PRUNE_THRESHOLD_CHARS).toBe(250);
      expect(DEFAULT_MICRO_COMPACTION_TOKEN_CEILING).toBe(CHATGPT_WEB_INSTANT_AUTO_COMPACT_TOKEN_LIMIT);
    });

    test("preserves messages when there are no completed tool results", () => {
      const messages: CodexMessage[] = [
        userMsg("do something", 1),
        assistantMsg("ok", 2),
        userMsg("do more", 3),
      ];
      const result = pruneHistoricalToolOutputs(messages);
      expect(result).toEqual(messages);
    });

    test("preserves messages when fewer tool results than retainRecentCount", () => {
      const messages: CodexMessage[] = [
        userMsg("task 1", 1),
        toolResultMsg("codex_exec", "output of task 1".repeat(10), false, 2),
        assistantMsg("done task 1", 3),
        userMsg("task 2", 4),
      ];
      const result = pruneHistoricalToolOutputs(messages, { retainRecentCount: 2 });
      // Only 1 historical tool result, <= 2 retain, so nothing pruned
      expect(result[1]).toEqual(messages[1]);
    });

    test("prunes old tool outputs exceeding character threshold, preserves recent ones", () => {
      const bigOutput = "x".repeat(5_000);
      const messages: CodexMessage[] = [
        // Turn 1 (completed) - tool result 1 (oldest, will be pruned)
        userMsg("task 1", 1),
        toolResultMsg("codex_exec", bigOutput, false, 2),
        assistantMsg("done 1", 3),
        // Turn 2 (completed) - tool result 2 (recent, retained)
        userMsg("task 2", 4),
        toolResultMsg("codex_read_file", bigOutput, false, 5),
        assistantMsg("done 2", 6),
        // Turn 3 (completed) - tool result 3 (most recent, retained)
        userMsg("task 3", 7),
        toolResultMsg("codex_list_dir", bigOutput, false, 8),
        assistantMsg("done 3", 9),
        // Active turn (instruction)
        userMsg("now do task 4", 10),
      ];

      const result = pruneHistoricalToolOutputs(messages, {
        retainRecentCount: 2,
        maxHistoricalCharThreshold: 250,
      });

      // First tool result should be pruned (tombstone)
      expect(typeof result[1]!.content).toBe("string");
      const pruned = result[1] as { role: string; content: string };
      expect(pruned.content).toContain("Historical tool output omitted");
      expect(pruned.content).toContain("codex_exec");
      expect(pruned.content).toContain("completed");
      expect(pruned.content).toContain("chars");

      // Second and third tool results retained
      expect((result[4] as { content: string }).content).toBe(bigOutput);
      expect((result[7] as { content: string }).content).toBe(bigOutput);
    });

    test("marks failed tool outputs correctly in tombstone", () => {
      const bigOutput = "error detail ".repeat(200);
      const messages: CodexMessage[] = [
        userMsg("task 1", 1),
        toolResultMsg("codex_exec", bigOutput, true, 2),
        assistantMsg("handling error", 3),
        userMsg("task 2", 4),
        toolResultMsg("codex_grep", bigOutput, false, 5),
        assistantMsg("done", 6),
        userMsg("task 3", 7),
        toolResultMsg("codex_read_file", bigOutput, false, 8),
        assistantMsg("done 2", 9),
        userMsg("current task", 10),
      ];
      const result = pruneHistoricalToolOutputs(messages, { retainRecentCount: 2 });
      const prunedContent = (result[1] as { content: string }).content;
      expect(prunedContent).toContain("failed");
    });

    test("does not prune tool outputs within the active turn", () => {
      const bigOutput = "z".repeat(5_000);
      const messages: CodexMessage[] = [
        userMsg("task 1", 1),
        toolResultMsg("codex_exec", bigOutput, false, 2),
        assistantMsg("done 1", 3),
        userMsg("task 2", 4),
        toolResultMsg("codex_exec", bigOutput, false, 5),
        assistantMsg("done 2", 6),
        userMsg("task 3", 7),
        toolResultMsg("codex_exec", bigOutput, false, 8), // active turn result
        assistantMsg("done 3", 9),
        userMsg("current task", 10),
        toolResultMsg("codex_exec", bigOutput, false, 11), // active turn result - MUST NOT prune
      ];
      const result = pruneHistoricalToolOutputs(messages, { retainRecentCount: 1 });
      // Active turn tool result at index 10 must remain intact
      expect((result[10] as { content: string }).content).toBe(bigOutput);
    });

    test("preserves small tool outputs below threshold", () => {
      const smallOutput = "ok";
      const messages: CodexMessage[] = [
        userMsg("task 1", 1),
        toolResultMsg("codex_exec", smallOutput, false, 2),
        assistantMsg("done 1", 3),
        userMsg("task 2", 4),
        toolResultMsg("codex_exec", smallOutput, false, 5),
        assistantMsg("done 2", 6),
        userMsg("task 3", 7),
        toolResultMsg("codex_exec", smallOutput, false, 8),
        assistantMsg("done 3", 9),
        userMsg("current task", 10),
      ];
      const result = pruneHistoricalToolOutputs(messages, {
        retainRecentCount: 1,
        maxHistoricalCharThreshold: 250,
      });
      // All tool outputs are small, none should be pruned
      for (const [idx, msg] of result.entries()) {
        if (msg.role === "toolResult") {
          expect((msg as { content: string }).content).toBe(smallOutput);
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // deduplicateEnvironmentContexts
  // ---------------------------------------------------------------------------

  describe("deduplicateEnvironmentContexts", () => {
    test("preserves messages with no environment context", () => {
      const messages: CodexMessage[] = [
        userMsg("task 1"),
        assistantMsg("done"),
        userMsg("task 2"),
      ];
      const result = deduplicateEnvironmentContexts(messages);
      expect(result).toEqual(messages);
    });

    test("preserves single environment context message without modification", () => {
      const messages: CodexMessage[] = [
        envContextMsg("", 1),
        userMsg("do something", 2),
        assistantMsg("done", 3),
        userMsg("current task", 4),
      ];
      const result = deduplicateEnvironmentContexts(messages);
      expect(typeof result[0]!.content).toBe("string");
      expect((result[0] as { content: string }).content).toContain("<environment_context>");
    });

    test("deduplicates old environment context, retains newest", () => {
      const env1 = "<environment_context>cwd: /old-workspace</environment_context>";
      const env2 = "<environment_context>cwd: /new-workspace</environment_context>";
      const messages: CodexMessage[] = [
        { role: "user", content: env1, timestamp: 1 },
        assistantMsg("did work in old env", 2),
        { role: "user", content: env2, timestamp: 3 },
        assistantMsg("did work in new env", 4),
        userMsg("current task", 5),
      ];
      const result = deduplicateEnvironmentContexts(messages);
      // Oldest env context should be replaced with tombstone
      const firstMsg = result[0] as { content: string };
      expect(firstMsg.content).toContain("Historical environment context omitted");
      expect(firstMsg.content).not.toContain("cwd: /old-workspace");
      // Newest env context should be intact
      const thirdMsg = result[2] as { content: string };
      expect(thirdMsg.content).toContain("cwd: /new-workspace");
    });

    test("environment context embedded in a larger message has only the tag replaced", () => {
      const env1 = "Before text <environment_context>old cwd</environment_context> after text";
      const env2 = "<environment_context>new cwd</environment_context>";
      const messages: CodexMessage[] = [
        { role: "user", content: env1, timestamp: 1 },
        assistantMsg("response", 2),
        { role: "user", content: env2, timestamp: 3 },
        userMsg("current task", 4),
      ];
      const result = deduplicateEnvironmentContexts(messages);
      const firstMsg = result[0] as { content: string };
      expect(firstMsg.content).toContain("Before text");
      expect(firstMsg.content).toContain("after text");
      expect(firstMsg.content).toContain("[Historical environment context omitted]");
      expect(firstMsg.content).not.toContain("old cwd");
      // Second env context intact
      const thirdMsg = result[2] as { content: string };
      expect(thirdMsg.content).toContain("new cwd");
    });

    test("standalone environment context replaced with superseded marker", () => {
      const env1 = "<environment_context>old cwd</environment_context>";
      const env2 = "<environment_context>new cwd</environment_context>";
      const messages: CodexMessage[] = [
        { role: "user", content: env1, timestamp: 1 },
        { role: "user", content: env2, timestamp: 2 },
        userMsg("current task", 3),
      ];
      const result = deduplicateEnvironmentContexts(messages);
      const firstMsg = result[0] as { content: string };
      expect(firstMsg.content).toContain("superseded by latest turn environment");
    });
  });

  // ---------------------------------------------------------------------------
  // applyMicroCompactionBoundary
  // ---------------------------------------------------------------------------

  describe("applyMicroCompactionBoundary", () => {
    test("returns messages unchanged when under token ceiling", () => {
      const messages: CodexMessage[] = [
        userMsg("short prompt 1", 1),
        assistantMsg("short reply 1", 2),
        userMsg("short prompt 2", 3),
      ];
      const result = applyMicroCompactionBoundary(messages, 10_000);
      expect(result).toEqual(messages);
    });

    test("condenses older assistant messages when ceiling exceeded", () => {
      const bigAssistantText = "The complete analysis is: " + "detail ".repeat(3_000);
      const messages: CodexMessage[] = [
        userMsg("task 1", 1),
        assistantMsg(bigAssistantText, 2),
        userMsg("task 2", 3),
        assistantMsg(bigAssistantText, 4),
        userMsg("task 3", 5),
        assistantMsg("short recent reply", 6),
        userMsg("current task", 7),
      ];
      const result = applyMicroCompactionBoundary(messages, 1_000); // very low ceiling
      // The earliest assistant message should have condensed content
      const firstAssistant = result[1] as { content: Array<{ type: string; text: string }> };
      const firstText = firstAssistant.content[0]?.text ?? "";
      // Should be condensed (much shorter than the original)
      expect(firstText.length).toBeLessThan(bigAssistantText.length);
    });

    test("preserves compaction summaries in Stage 3", () => {
      const compactionSummary = `${SUMMARY_PREFIX}\nObjective: fix bug\nState: done`;
      const messages: CodexMessage[] = [
        userMsg(compactionSummary, 1), // compaction summary - must NOT be condensed
        assistantMsg("resumed from checkpoint", 2),
        userMsg("continue the fix", 3),
        userMsg("more work", 4),
        userMsg("current task", 5),
      ];
      // Use a very low ceiling to force Stage 3
      const result = applyMicroCompactionBoundary(messages, 1);
      // Compaction summary at index 0 must remain intact
      expect((result[0] as { content: string }).content).toContain(SUMMARY_PREFIX);
    });

    test("preserves the current instruction (latest user message) intact", () => {
      const bigText = "very long historic prompt " + "x".repeat(3_000);
      const currentInstruction = "now do the critical current task";
      const messages: CodexMessage[] = [
        userMsg(bigText, 1),
        assistantMsg("done 1", 2),
        userMsg(bigText, 3),
        assistantMsg("done 2", 4),
        userMsg(bigText, 5),
        assistantMsg("done 3", 6),
        userMsg(currentInstruction, 7), // current - must NOT be condensed
      ];
      const result = applyMicroCompactionBoundary(messages, 1);
      const lastMsg = result[result.length - 1] as { content: string };
      expect(lastMsg.content).toBe(currentInstruction);
    });
  });

  // ---------------------------------------------------------------------------
  // withAdaptiveHistoryPruning (pipeline)
  // ---------------------------------------------------------------------------

  describe("withAdaptiveHistoryPruning pipeline", () => {
    test("pipeline produces output with fewer total characters than input for heavy history", () => {
      const bigOutput = "command output ".repeat(500);
      const bigEnv = "<environment_context>cwd: /workspace roots: /workspace sandbox: workspaceWrite</environment_context>";
      const messages: CodexMessage[] = [
        { role: "user", content: bigEnv, timestamp: 1 },
        userMsg("task 1", 2),
        toolResultMsg("codex_exec", bigOutput, false, 3),
        assistantMsg("done 1 " + "details ".repeat(200), 4),
        { role: "user", content: bigEnv, timestamp: 5 },
        userMsg("task 2", 6),
        toolResultMsg("codex_exec", bigOutput, false, 7),
        assistantMsg("done 2 " + "details ".repeat(200), 8),
        { role: "user", content: bigEnv, timestamp: 9 },
        userMsg("task 3", 10),
        toolResultMsg("codex_exec", bigOutput, false, 11),
        assistantMsg("done 3", 12),
        userMsg("current task", 13),
      ];

      const totalInputChars = messages.reduce((sum, msg) => {
        const c = msg.role === "toolResult" || msg.role === "user" || msg.role === "developer"
          ? (typeof msg.content === "string" ? msg.content : "")
          : msg.role === "assistant"
            ? msg.content.map(p => p.type === "text" ? p.text : "").join("")
            : "";
        return sum + c.length;
      }, 0);

      const result = withAdaptiveHistoryPruning(messages, {
        retainRecentToolResults: 1,
        maxHistoricalCharThreshold: 250,
        maxPromptTokens: 500,
      });

      const totalOutputChars = result.reduce((sum, msg) => {
        const c = msg.role === "toolResult" || msg.role === "user" || msg.role === "developer"
          ? (typeof msg.content === "string" ? msg.content : "")
          : msg.role === "assistant"
            ? msg.content.map(p => p.type === "text" ? p.text : "").join("")
            : "";
        return sum + c.length;
      }, 0);

      expect(totalOutputChars).toBeLessThan(totalInputChars);
    });

    test("pipeline preserves the current task instruction", () => {
      const bigOutput = "y".repeat(10_000);
      const messages: CodexMessage[] = [
        userMsg("task 1", 1),
        toolResultMsg("codex_exec", bigOutput, false, 2),
        assistantMsg("done 1", 3),
        userMsg("task 2", 4),
        toolResultMsg("codex_exec", bigOutput, false, 5),
        assistantMsg("done 2", 6),
        userMsg("task 3", 7),
        toolResultMsg("codex_exec", bigOutput, false, 8),
        assistantMsg("done 3", 9),
        userMsg("current critical task - must not be condensed", 10),
      ];

      const result = withAdaptiveHistoryPruning(messages, {
        retainRecentToolResults: 1,
        maxHistoricalCharThreshold: 250,
        maxPromptTokens: 500,
      });

      const lastMsg = result[result.length - 1] as { content: string };
      expect(lastMsg.content).toBe("current critical task - must not be condensed");
    });

    test("pipeline preserves message count (no messages are dropped)", () => {
      const messages: CodexMessage[] = [
        userMsg("task 1", 1),
        toolResultMsg("codex_exec", "big output ".repeat(100), false, 2),
        assistantMsg("done", 3),
        userMsg("task 2", 4),
      ];
      const result = withAdaptiveHistoryPruning(messages);
      expect(result).toHaveLength(messages.length);
    });
  });
});
