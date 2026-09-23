import { describe, expect, test } from "bun:test";
import {
  trimDeepSubagentHistory,
  SUBAGENT_RESULT_TAG_OPEN,
  SUBAGENT_RESULT_TAG_CLOSE,
} from "../src/adapters/chatgpt-web/subagent-protocol";
import { withAdaptiveHistoryPruning } from "../src/adapters/chatgpt-web/prompt";
import type { CodexMessage } from "../src/types";

describe("Sprint S: Multi-Agent Message Isolation & Deep Subagent Trimming", () => {
  const makeSubagentResultMsg = (taskName: string, files: string[]): CodexMessage => ({
    role: "assistant",
    timestamp: 1000,
    content: [
      {
        type: "text",
        text: `Here is the comprehensive report for ${taskName}. I completed everything and ran all checks.\n\n${SUBAGENT_RESULT_TAG_OPEN}\n{\n  "status": "completed",\n  "summary": "${taskName} finished successfully.",\n  "modified_files": ${JSON.stringify(files)}\n}\n${SUBAGENT_RESULT_TAG_CLOSE}`,
      },
    ],
  });

  const makeAgentBriefMsg = (taskName: string, recipient: string, length: number): CodexMessage => ({
    role: "agentMessage",
    author: "orchestrator",
    recipient,
    timestamp: 1000,
    content: `Brief for ${taskName}: ${"x".repeat(length)}`,
  });

  test("leaves subagent messages untouched when total subagent results <= retainRecentCount", () => {
    const messages: CodexMessage[] = [
      { role: "user", timestamp: 1000, content: "Start multi-agent task" },
      makeAgentBriefMsg("Task 1", "worker-1", 300),
      makeSubagentResultMsg("Task 1", ["src/task1.ts"]),
      makeAgentBriefMsg("Task 2", "worker-2", 300),
      makeSubagentResultMsg("Task 2", ["src/task2.ts"]),
    ];

    const trimmed = trimDeepSubagentHistory(messages, { retainRecentCount: 2 });
    expect(trimmed).toEqual(messages);
  });

  test("condenses older completed subagent dialogues while preserving recent subagent turns intact", () => {
    const messages: CodexMessage[] = [
      { role: "user", timestamp: 1000, content: "Start orchestrator" },
      // Subagent Turn 1 (Oldest -> should be trimmed)
      makeAgentBriefMsg("Task 1", "worker-1", 300),
      makeSubagentResultMsg("Task 1", ["src/task1.ts"]),

      // Subagent Turn 2 (Oldest -> should be trimmed)
      makeAgentBriefMsg("Task 2", "worker-2", 250),
      makeSubagentResultMsg("Task 2", ["src/task2.ts"]),

      // Subagent Turn 3 (Recent 2 -> preserved intact)
      makeAgentBriefMsg("Task 3", "worker-3", 300),
      makeSubagentResultMsg("Task 3", ["src/task3.ts"]),

      // Subagent Turn 4 (Recent 1 -> preserved intact)
      makeAgentBriefMsg("Task 4", "worker-4", 300),
      makeSubagentResultMsg("Task 4", ["src/task4.ts"]),

      { role: "user", timestamp: 1000, content: "What is the overall progress?" },
    ];

    const trimmed = trimDeepSubagentHistory(messages, { retainRecentCount: 2 });

    // Check Turn 1:
    const brief1 = trimmed[1]!;
    expect(brief1.role).toBe("agentMessage");
    expect(brief1.content).toContain("[Historical subagent task dialogue to worker-1: completed in earlier turn");

    const result1 = trimmed[2]!;
    expect(result1.role).toBe("assistant");
    const result1Text = (result1.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(result1Text).toContain("[Subagent Result: COMPLETED]");
    expect(result1Text).toContain("Summary: Task 1 finished successfully.");
    expect(result1Text).not.toContain("Here is the comprehensive report");

    // Check Turn 3 (retained recent):
    const brief3 = trimmed[5]!;
    expect(brief3).toEqual(messages[5]);

    const result3 = trimmed[6]!;
    expect(result3).toEqual(messages[6]);

    // Check Turn 4 (retained recent):
    const brief4 = trimmed[7]!;
    expect(brief4).toEqual(messages[7]);

    const result4 = trimmed[8]!;
    expect(result4).toEqual(messages[8]);
  });

  test("integrates with withAdaptiveHistoryPruning seamlessly", () => {
    const messages: CodexMessage[] = [
      { role: "user", timestamp: 1000, content: "<environment_context>cwd: /test</environment_context> Run tasks" },
      makeAgentBriefMsg("Task A", "sub-A", 400),
      makeSubagentResultMsg("Task A", ["src/a.ts"]),
      makeAgentBriefMsg("Task B", "sub-B", 400),
      makeSubagentResultMsg("Task B", ["src/b.ts"]),
      makeAgentBriefMsg("Task C", "sub-C", 400),
      makeSubagentResultMsg("Task C", ["src/c.ts"]),
      { role: "user", timestamp: 1000, content: "<environment_context>cwd: /test</environment_context> Finalize" },
    ];

    const pruned = withAdaptiveHistoryPruning(messages);
    expect(pruned.length).toBe(messages.length);

    // Oldest subagent task A was trimmed
    const prunedBriefA = pruned[1]!;
    expect(prunedBriefA.content).toContain("[Historical subagent task dialogue");
    const prunedResultA = pruned[2]!;
    const textA = (prunedResultA.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(textA).toContain("[Subagent Result: COMPLETED]");

    // Recent subagent tasks B and C remain intact
    expect(pruned[5]).toEqual(messages[5]);
    expect(pruned[6]).toEqual(messages[6]);
  });
});
