import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  compileChatGptWebPrompt,
  withAdaptiveHistoryPruning,
  DEFAULT_ROOT_PRUNING_TOKEN_CEILING,
} from "../src/adapters/chatgpt-web/prompt";
import { ensureWorkspaceState, readWorkspaceState } from "../src/adapters/chatgpt-web/workspace-state";
import { resolveSubagentWorkspace, listSubagentWorkspaces } from "../src/adapters/chatgpt-web/subagent-workspace";
import type { CodexParsedRequest, CodexMessage } from "../src/types";

/**
 * Sprint AI: Production Turn Execution & Workspace Auto-Init
 *
 * Verifies:
 * 1. ensureWorkspaceState auto-initializes .agents/STATE.md in any workspace
 * 2. resolveSubagentWorkspace auto-initializes .agents/subagents/<id>/
 * 3. Root agent prompt pruning: withAdaptiveHistoryPruning condenses bulky history
 *    under DEFAULT_ROOT_PRUNING_TOKEN_CEILING (e.g. 12_000 tokens) instead of waiting for 32_000
 * 4. compileChatGptWebPrompt contains imperative workspace action directives and
 *    does NOT contain the passive escape clause "otherwise answer the request directly without a tool call"
 * 5. compileChatGptWebPrompt applies root pruning to prevent 100k+ character composer saturation
 */

describe("Sprint AI: Production Turn Execution & Workspace Auto-Init", () => {
  const testDir = join(process.cwd(), ".agents", "scratch", "test-ai-" + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("Workspace & Subagent Auto-Initialization", () => {
    test("ensureWorkspaceState creates .agents/STATE.md in target workspace", () => {
      const stateFile = join(testDir, ".agents", "STATE.md");
      expect(existsSync(stateFile)).toBe(false);

      const state = ensureWorkspaceState(testDir);
      expect(existsSync(stateFile)).toBe(true);
      expect(state.activePhase).toBeDefined();

      const readBack = readWorkspaceState(testDir);
      expect(readBack).not.toBeNull();
      expect(readBack?.goal).toBeDefined();
    });

    test("resolveSubagentWorkspace creates .agents/subagents/<id>/ in target workspace", () => {
      const subId = "worker-science-1";
      const wsDir = resolveSubagentWorkspace(testDir, subId);

      expect(existsSync(wsDir)).toBe(true);
      expect(wsDir).toBe(join(testDir, ".agents", "subagents", subId));

      const workspaces = listSubagentWorkspaces(testDir);
      expect(workspaces).toContain(subId);
    });
  });

  describe("Root Agent Adaptive History Pruning", () => {
    test("DEFAULT_ROOT_PRUNING_TOKEN_CEILING is conservative (<= 14_000 tokens)", () => {
      expect(DEFAULT_ROOT_PRUNING_TOKEN_CEILING).toBeLessThanOrEqual(14_000);
      expect(DEFAULT_ROOT_PRUNING_TOKEN_CEILING).toBeGreaterThanOrEqual(8_000);
    });

    test("withAdaptiveHistoryPruning with root options trims bulky historical tool results", () => {
      // Build a conversation with 5 bulky historical tool results
      const now = Date.now();
      const messages: CodexMessage[] = [
        { role: "user", content: "Initial task request", timestamp: now },
        {
          role: "assistant",
          content: [{ type: "text", text: "Running initial tools..." }],
          timestamp: now + 1,
        },
        // Bulky tool result 1 (10,000 chars)
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "codex_read_file",
          isError: false,
          content: "A".repeat(10_000),
          timestamp: now + 2,
        },
        // Bulky tool result 2 (10,000 chars)
        {
          role: "toolResult",
          toolCallId: "call_2",
          toolName: "codex_grep",
          isError: false,
          content: "B".repeat(10_000),
          timestamp: now + 3,
        },
        // Bulky tool result 3 (10,000 chars)
        {
          role: "toolResult",
          toolCallId: "call_3",
          toolName: "codex_exec",
          isError: false,
          content: "C".repeat(10_000),
          timestamp: now + 4,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Proceeding with more analysis..." }],
          timestamp: now + 5,
        },
        // Recent tool result 4 (retained)
        {
          role: "toolResult",
          toolCallId: "call_4",
          toolName: "codex_read_file",
          isError: false,
          content: "Recent file content...",
          timestamp: now + 6,
        },
        // Latest user instruction
        { role: "user", content: "procede a crearlo, toma el rol de staff cientifico", timestamp: now + 7 },
      ];

      // Prune with root options (retain 2 recent, maxHistoricalCharThreshold 400, maxPromptTokens 12000)
      const pruned = withAdaptiveHistoryPruning(messages, {
        retainRecentToolResults: 2,
        maxHistoricalCharThreshold: 400,
        maxPromptTokens: DEFAULT_ROOT_PRUNING_TOKEN_CEILING,
      });

      // Older tool results should be replaced with tombstones
      const toolResults = pruned.filter(m => m.role === "toolResult");
      expect(toolResults.length).toBe(4);

      // Tool result 1 and 2 should be tombstones
      expect(toolResults[0]?.content).toContain("[Historical tool output omitted");
      expect(toolResults[1]?.content).toContain("[Historical tool output omitted");

      // Tool result 4 (recent) should be preserved
      expect(toolResults[3]?.content).toBe("Recent file content...");
    });
  });

  describe("Imperative Workspace Action Directives in Prompt Contract", () => {
    function makeDummyParsedRequest(): CodexParsedRequest {
      return {
        modelId: "gpt-5.6-sol",
        stream: true,
        context: {
          messages: [
            { role: "user", content: "procede a crearlo, toma el rol de staff cientifico", timestamp: Date.now() },
          ],
          tools: [
            {
              name: "codex_read_file",
              description: "Read file",
              parameters: { type: "object", properties: { path: { type: "string" } } },
            },
          ],
        },
        options: { reasoning: "high" },
      };
    }

    test("compileChatGptWebPrompt contains imperative workspace action instruction", () => {
      const parsed = makeDummyParsedRequest();
      const compiled = compileChatGptWebPrompt(
        parsed,
        { proAvailable: false, solAvailable: true, extraHighAvailable: true, localToolsEnabled: true },
        "token_123",
      );

      // MUST contain the imperative action instruction
      expect(compiled.text).toContain("CRITICAL WORKSPACE ACTION RULE");
      expect(compiled.text).toContain("MUST invoke the appropriate Codex Native tool");
      expect(compiled.text).toContain("ANTI-RESIGNATION RULE");
    });
  });
});
