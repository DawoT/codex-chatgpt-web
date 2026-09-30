import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCompactionQuality } from "../src/adapters/chatgpt-web/autonomous-compaction";
import { requestRetainedCompactionHandoff } from "../src/adapters/chatgpt-web/compaction-handoff";
import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultBrokerEndpoint } from "../src/config";
import type { CodexParsedRequest } from "../src/types";

function createMockTurnRequest(compaction = false): CodexParsedRequest {
  const userContent = "Fix the compaction loop and reduce timeouts";
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    _compactionRequest: compaction,
    _rawBody: {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: userContent }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn_source_rescue" },
        },
      ],
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread_retained_rescue_test",
          turn_id: compaction ? "turn_compact" : "turn_source_rescue",
        }),
      },
    },
    context: {
      messages: [
        { role: "user", content: userContent, timestamp: 1000 },
        { role: "assistant", content: [{ type: "text", text: "Starting analysis..." }], timestamp: 1001 },
      ],
      systemPrompt: [],
      tools: [],
    },
    options: { reasoning: "high" },
  };
}

describe("Sprint 2: Retained Compaction Text-Based Checkpoint Rescue", () => {
  test("rescues <compaction_state> from assistant text when tool call is omitted", async () => {
    const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-rescue-"));
    const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
    const req = createMockTurnRequest(true);
    const sourceRequest = createMockTurnRequest(false);
    const source = new ChatGptTurnSession({
      mode: "read-only",
      browser: Promise.resolve("source complete"),
      physicalSettlement: Promise.resolve(),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      usageInput: sourceRequest,
      conversationKey: chatGptConversationKey(sourceRequest, "provider")!,
      cancel() {},
    });

    const mockAssistantText = `
Here is the handoff for the next session.

<compaction_state>
version: 2
original_request_ref: sha256:fedcba987654
modified_files:
- src/adapters/chatgpt-web/compaction-handoff.ts
active_hypothesis: Rescued text avoids compaction_handoff_missing errors.
requirements:
- id: REQ-001
  status: pending
  source: User request
closure_criteria:
- Tests pass
verified_achievements:
- Implemented text rescue
decisions_and_invariants:
- Safe fallback
blockers_or_test_failures:
- None
pending_obligations:
- None
next_actions:
- Verify downstream flow
</compaction_state>
`;

    // Worker simulates ChatGPT outputting the checkpoint in assistant text rather than calling the tool
    const worker = {
      run: async (opts: { onTextDelta?: (delta: string) => void }) => {
        opts.onTextDelta?.(mockAssistantText);
        return mockAssistantText;
      },
    };

    const capabilities = {
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true,
      proAvailable: true,
    };

    try {
      const summary = await requestRetainedCompactionHandoff(
        worker as never,
        req,
        source,
        broker,
        capabilities,
        "trace_rescue_test",
      );

      expect(summary).toBeString();
      expect(summary).toContain("<compaction_state>");
      expect(summary).toContain("CODEX_ORIGINAL_USER_REQUEST_JSON");
      expect(summary).toContain("CODEX_LATEST_USER_PROMPT_JSON");

      const quality = validateCompactionQuality(req.context.messages, summary, {
        requireStructured: true,
      });
      expect(quality.valid).toBe(true);
    } finally {
      await broker.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("still throws compaction_handoff_missing when assistant text has no checkpoint", async () => {
    const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-no-rescue-"));
    const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
    const req = createMockTurnRequest(true);
    const sourceRequest = createMockTurnRequest(false);
    const source = new ChatGptTurnSession({
      mode: "read-only",
      browser: Promise.resolve("source complete"),
      physicalSettlement: Promise.resolve(),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      usageInput: sourceRequest,
      conversationKey: chatGptConversationKey(sourceRequest, "provider")!,
      cancel() {},
    });

    const mockRefusalText = "I cannot complete this compaction request due to policy guidelines.";

    const worker = {
      run: async (opts: { onTextDelta?: (delta: string) => void }) => {
        opts.onTextDelta?.(mockRefusalText);
        return mockRefusalText;
      },
    };

    const capabilities = {
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true,
      proAvailable: true,
    };

    try {
      await expect(
        requestRetainedCompactionHandoff(worker as never, req, source, broker, capabilities, "trace_no_rescue_test"),
      ).rejects.toMatchObject({
        code: "compaction_handoff_missing",
        retryable: false,
      });
    } finally {
      await broker.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
