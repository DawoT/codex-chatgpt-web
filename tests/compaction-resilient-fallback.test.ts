import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCompactionFlow } from "../src/adapters/chatgpt-web/adapter/compaction-flow";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import {
  ChatGptTextFeed,
  ChatGptTraceFeed,
  ChatGptTurnSession,
  chatGptTurnSessions,
} from "../src/adapters/chatgpt-web/turn-execution";
import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";

test("retained handoff failures fall back to fresh compaction instead of failing immediately", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-resilient-compaction-"));
  const parsed: CodexParsedRequest = {
    modelId: "gpt-5.6-sol",
    context: {
      messages: [
        { role: "user", content: "Original goal", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Goal in progress" }], timestamp: 2 },
      ],
    },
    options: { reasoning: "medium" },
    _compactionRequest: true,
    _rawBody: {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Original goal" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn_source" },
        },
      ],
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread_resilient_test",
          turn_id: "turn_resilient_test",
        }),
      },
    },
  };

  const convKey = chatGptConversationKey(parsed, root)!;
  let freshCompactionStarted = false;

  // Register an active retained session head
  chatGptTurnSessions.getOrCreate(convKey, () => ({
    mode: "tools",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: parsed,
    conversationKey: convKey,
    cancel() {},
  }));

  const events: AdapterEvent[] = [];

  try {
    const success = await executeCompactionFlow({
      worker: {
        run: async () => {
          // Simulate ChatGPT finishing without sending handoff
          throw new ChatGptWebAdapterError("ChatGPT finished without sending summary", {
            status: 409,
            errorType: "invalid_request_error",
            code: "compaction_handoff_missing",
            retryable: false,
          });
        },
      } as any,
      parsed,
      incoming: { headers: new Headers() },
      emit: (e: AdapterEvent) => events.push(e),
      configuredCapabilities: { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
      turnCapabilities: { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
      manualRequest: false,
      retainedLauncherDescriptor: "launcher-descriptor",
      structuredBroker: {
        beginCompactionTransaction: async () => ({ token: "control_1", handoffId: "handoff_1" }),
        waitForCompactionHandoff: async () => {
          throw new ChatGptWebAdapterError("ChatGPT finished without sending summary", {
            status: 409,
            errorType: "invalid_request_error",
            code: "compaction_handoff_missing",
            retryable: false,
          });
        },
        abortCompactionTransaction() {},
      } as any,
      broker: {} as any,
      executionNamespace: root,
      timeoutMs: 10_000,
      freshConversationPerTurn: false,
      retryKey: "retry-key",
      environment: undefined,
      startRuntime: () => {
        freshCompactionStarted = true;
        const validSummary = [
          "Summary narrative describing the work done in earlier turns.",
          "<compaction_state>",
          "version: 2",
          "original_request_ref: sha256:1111111111111111111111111111111111111111111111111111111111111111",
          "modified_files:",
          "- None",
          "active_hypothesis: Testing resilient fallback",
          "requirements:",
          '- {"id":"REQ-1","status":"pending","source":"user"}',
          "closure_criteria:",
          "- All green",
          "verified_achievements:",
          "- None",
          "decisions_and_invariants:",
          "- Rule kept",
          "pending_obligations:",
          "- Verify fallback",
          "blockers_or_test_failures:",
          "- None",
          "next_actions:",
          "- Ship fix",
          "</compaction_state>",
        ].join("\n");
        return {
          browser: Promise.resolve(validSummary),
          physicalSettlement: Promise.resolve(),
          cancel() {},
        } as any;
      },
    });

    expect(freshCompactionStarted).toBe(true);
    expect(success).toBe(true);
    expect(events.some(e => e.type === "error")).toBe(false);
  } finally {
    chatGptTurnSessions.clear();
    rmSync(root, { recursive: true, force: true });
  }
});
