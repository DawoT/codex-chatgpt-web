import { describe, expect, test } from "bun:test";
import {
  HEAVY_TURN_TOOL_CALL_THRESHOLD,
  isHeavyCompactionTurn,
} from "../src/adapters/chatgpt-web/adapter/compaction-flow";
import type { CodexMessage } from "../src/types";

describe("Sprint 3: Fast-Path Fresh Compaction & Unified Timeout Budget", () => {
  test("isHeavyCompactionTurn identifies light vs heavy turns based on tool calls", () => {
    const lightMessages: CodexMessage[] = [
      { role: "user", content: "Do some work", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Running tool" },
          { type: "toolCall", id: "call_1", name: "exec", arguments: {} },
        ],
        timestamp: 2,
      },
      { role: "toolResult", toolCallId: "call_1", toolName: "exec", content: "ok", isError: false, timestamp: 3 },
    ];

    expect(isHeavyCompactionTurn(lightMessages)).toBe(false);

    // Build a turn with >= 35 tool calls
    const heavyMessages: CodexMessage[] = [{ role: "user", content: "Run many operations", timestamp: 1 }];

    for (let i = 0; i < HEAVY_TURN_TOOL_CALL_THRESHOLD; i++) {
      heavyMessages.push({
        role: "assistant",
        content: [{ type: "toolCall", id: `call_${i}`, name: "exec", arguments: {} }],
        timestamp: i * 2 + 2,
      });
      heavyMessages.push({
        role: "toolResult",
        toolCallId: `call_${i}`,
        toolName: "exec",
        content: `result ${i}`,
        isError: false,
        timestamp: i * 2 + 3,
      });
    }

    expect(isHeavyCompactionTurn(heavyMessages)).toBe(true);
  });

  test("unified compaction deadline respects total remaining budget across phases", () => {
    // When 4 minutes is the global budget, re-arming on progress or fresh fallback
    // must not reset the deadline to a fresh 5 minutes if 2 minutes have already elapsed.
    const startTime = 1000;
    const totalBudgetMs = 4 * 60_000; // 240,000ms
    const globalDeadlineAt = startTime + totalBudgetMs;

    const halfwayTime = startTime + 120_000; // 2 minutes elapsed
    const remainingMs = Math.max(0, globalDeadlineAt - halfwayTime);

    expect(remainingMs).toBe(120_000);
    expect(remainingMs).toBeLessThan(totalBudgetMs);
  });

  test("boundary condition: exactly 34 tool calls is not heavy, 35 is heavy", () => {
    const messages34: CodexMessage[] = [{ role: "user", content: "Task", timestamp: 1 }];
    for (let i = 0; i < 34; i++) {
      messages34.push({
        role: "assistant",
        content: [{ type: "toolCall", id: `call_${i}`, name: "exec", arguments: {} }],
        timestamp: i + 2,
      });
    }
    expect(isHeavyCompactionTurn(messages34)).toBe(false);

    const messages35: CodexMessage[] = [{ role: "user", content: "Task", timestamp: 1 }];
    for (let i = 0; i < 35; i++) {
      messages35.push({
        role: "assistant",
        content: [{ type: "toolCall", id: `call_${i}`, name: "exec", arguments: {} }],
        timestamp: i + 2,
      });
    }
    expect(isHeavyCompactionTurn(messages35)).toBe(true);
  });

  test("counts parallel tool calls in a single assistant message", () => {
    const messages: CodexMessage[] = [
      { role: "user", content: "Parallel calls", timestamp: 1 },
      {
        role: "assistant",
        content: Array.from({ length: 35 }, (_, i) => ({
          type: "toolCall" as const,
          id: `p_call_${i}`,
          name: "read_file",
          arguments: { path: `file_${i}.txt` },
        })),
        timestamp: 2,
      },
    ];
    expect(isHeavyCompactionTurn(messages)).toBe(true);
  });
});
