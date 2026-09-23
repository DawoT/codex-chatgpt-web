import { describe, expect, test } from "bun:test";
import {
  trimDeepSubagentHistory,
  SUBAGENT_RESULT_TAG_OPEN,
  SUBAGENT_RESULT_TAG_CLOSE,
} from "../src/adapters/chatgpt-web/subagent-protocol";
import { withAdaptiveHistoryPruning, compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
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

  test("subagent turn applies differentiated pruning with tighter thresholds", () => {
    // 3 historical completed tool results
    const messages: CodexMessage[] = [
      { role: "user", timestamp: 1000, content: "Initial command" },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "codex_read_file",
        content: "A".repeat(180), // > 150 chars, but < 250 chars
        isError: false,
        timestamp: 1001,
      },
      {
        role: "toolResult",
        toolCallId: "call_2",
        toolName: "codex_list_dir",
        content: "B".repeat(180), // > 150 chars
        isError: false,
        timestamp: 1002,
      },
      {
        role: "toolResult",
        toolCallId: "call_3",
        toolName: "codex_grep",
        content: "C".repeat(180), // most recent completed tool result
        isError: false,
        timestamp: 1003,
      },
      { role: "user", timestamp: 1004, content: "Perform next step" },
    ];

    // For root (default): retainRecentToolResults = 2, maxHistoricalCharThreshold = 250
    // The 2 most recent (tools 2 and 3) are retained intact. Tool 1 (180 chars) is <= 250 chars, so none are tombstoned.
    const rootPruned = withAdaptiveHistoryPruning(messages);
    expect(rootPruned[1]!.content).toBe("A".repeat(180));
    expect(rootPruned[2]!.content).toBe("B".repeat(180));
    expect(rootPruned[3]!.content).toBe("C".repeat(180));

    // For subagent: retainRecentToolResults = 1, maxHistoricalCharThreshold = 150
    // Retains only tool 3. Tools 1 and 2 exceed 150 chars, so they are tombstoned!
    const subagentPruned = withAdaptiveHistoryPruning(messages, {
      retainRecentToolResults: 1,
      maxHistoricalCharThreshold: 150,
      retainRecentSubagents: 1,
      maxPromptTokens: 16_000,
    });
    expect(subagentPruned[1]!.content).toContain("[Historical tool output omitted: codex_read_file completed in earlier turn");
    expect(subagentPruned[2]!.content).toContain("[Historical tool output omitted: codex_list_dir completed in earlier turn");
    expect(subagentPruned[3]!.content).toBe("C".repeat(180)); // most recent is retained
  });

  test("compileChatGptWebPrompt automatically applies subagent pruning thresholds for subagent turns", () => {
    const historicalMessages: CodexMessage[] = [
      { role: "user", timestamp: 1000, content: "Start" },
      {
        role: "toolResult",
        toolCallId: "call_sub_1",
        toolName: "codex_read_file",
        content: "Long historical tool output exceeding 150 chars ".repeat(5),
        isError: false,
        timestamp: 1001,
      },
      {
        role: "toolResult",
        toolCallId: "call_sub_2",
        toolName: "codex_list_dir",
        content: "Recent tool result ".repeat(10),
        isError: false,
        timestamp: 1002,
      },
      { role: "user", timestamp: 1003, content: "Do subagent brief" },
    ];

    const subagentReq = {
      modelId: CHATGPT_WEB_MODEL_ID,
      stream: true,
      options: { reasoning: "high" as const },
      context: {
        systemPrompt: ["system"],
        messages: historicalMessages,
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

    const compiledSubagent = compileChatGptWebPrompt(
      subagentReq,
      { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: false },
      "turn_subagent_00000000000000000000000",
    );

    // The subagent prompt should contain tombstone for older tool result exceeding 150 chars
    expect(compiledSubagent.text).toContain("[Historical tool output omitted: codex_read_file completed in earlier turn");

    const rootReq = {
      modelId: CHATGPT_WEB_MODEL_ID,
      stream: true,
      options: { reasoning: "high" as const },
      context: {
        systemPrompt: ["system"],
        messages: historicalMessages,
      },
    };

    const compiledRoot = compileChatGptWebPrompt(
      rootReq,
      { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: false },
      "turn_root_000000000000000000000000000",
    );

    // The root prompt retains 2 recent tool results, so neither is tombstoned
    expect(compiledRoot.text).not.toContain("[Historical tool output omitted: codex_read_file completed in earlier turn");
  });
});

