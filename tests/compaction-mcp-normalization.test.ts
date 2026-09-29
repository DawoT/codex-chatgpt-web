import { expect, test } from "bun:test";
import { canonicalizeCompactionHandoff } from "../src/adapters/chatgpt-web/compaction-handoff";
import { validateCompactionQuality } from "../src/adapters/chatgpt-web/autonomous-compaction";
import { structuredCompactionHandoffInstruction } from "../src/adapters/chatgpt-web/native-compaction-control";
import { extractStructuredCompactionHandoff } from "../src/responses/compaction";
import { boundedCompactionRepairObservations } from "../src/adapters/chatgpt-web/compaction-evidence";
import { buildCompactionFallbackRepairPrompt, checkpointRepairPromptFits } from "../src/adapters/chatgpt-web/compaction-repair";
import type { CodexParsedRequest } from "../src/types";

test("a freeform MCP handoff becomes a conservative versioned checkpoint", () => {
  const request: CodexParsedRequest = {
    modelId: "gpt-5.6-sol",
    stream: false,
    options: {},
    _compactionRequest: true,
    context: {
      messages: [
        { role: "user", content: "Fix the payment retry bug.", timestamp: 1 },
        { role: "user", content: "Also preserve the failed charge diagnostic.", timestamp: 2 },
      ],
    },
    _rawBody: {
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Also preserve the failed charge diagnostic." }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_source" },
      }],
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread_mcp_compaction",
          turn_id: "turn_compact",
        }),
      },
    },
  };
  const summary = "The payment retry bug remains open. The failed charge diagnostic must be preserved. No successful test run was observed. Next, inspect the retry path and reproduce the failure.";

  const canonical = canonicalizeCompactionHandoff(request, summary);
  const state = extractStructuredCompactionHandoff(canonical).state;

  expect(state?.version).toBe(2);
  expect(state?.requirements?.map(item => item.status)).toEqual(["pending", "pending"]);
  expect(state?.requirements?.map(item => item.source)).toEqual([
    "Fix the payment retry bug.",
    "Also preserve the failed charge diagnostic.",
  ]);
  expect(canonical).toContain(summary);
  expect(validateCompactionQuality(request.context.messages, canonical, { requireStructured: true }).valid).toBe(true);
});

test("ordinary prose headings do not block freeform checkpoint normalization", () => {
  const request: CodexParsedRequest = {
    modelId: "gpt-5.6-sol",
    stream: false,
    options: {},
    _compactionRequest: true,
    context: { messages: [{ role: "user", content: "Fix retry logic", timestamp: 1 }] },
    _rawBody: {
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Fix retry logic" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_source" },
      }],
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_freeform", turn_id: "turn_compact" }),
      },
    },
  };

  const canonical = canonicalizeCompactionHandoff(
    request,
    "Requirements: fix retry logic and preserve the failure log. Next: inspect the failing test before editing.",
  );

  expect(validateCompactionQuality(request.context.messages, canonical, { requireStructured: true }).valid).toBe(true);
});

test("fallback repair bounds the rejected draft and the complete physical prompt", () => {
  const prompt = buildCompactionFallbackRepairPrompt({
    issues: ["The handoff omitted the pending task."],
    originalRequest: "Fix the payment retry bug.",
    latestRequest: "Keep the failed charge diagnostic.",
    otherUserRequests: [],
    priorState: null,
    observations: [],
    rejectedDraft: "Z".repeat(560_000),
  });

  expect(prompt).toBeDefined();
  expect(prompt!.length).toBeLessThanOrEqual(45_000);
  expect(prompt).toContain("Keep the failed charge diagnostic.");
  expect(prompt).toContain("[draft excerpt truncated]");
  expect(buildCompactionFallbackRepairPrompt({
    issues: [],
    originalRequest: "A".repeat(46_000),
    latestRequest: "Latest instruction",
    otherUserRequests: [],
    priorState: null,
    observations: [],
    rejectedDraft: "short draft",
  })).toBeUndefined();
});

test("retained repair rejects a prompt above the physical handoff boundary", () => {
  expect(checkpointRepairPromptFits(
    "x".repeat(45_001),
    "gpt-5.6-sol",
    "low",
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  )).toBe(false);
});

test("repair observations count serialized commands as well as excerpts", () => {
  const selected = boundedCompactionRepairObservations([
    { ref: "obs_a", toolCallId: "a", toolName: "exec_command", status: "succeeded", command: "x".repeat(12_000), excerpt: "ok" },
    { ref: "obs_b", toolCallId: "b", toolName: "exec_command", status: "succeeded", command: "bun test", excerpt: "1 pass" },
  ]);

  expect(selected.map(item => item.ref)).toEqual(["obs_b"]);
  const unicode = boundedCompactionRepairObservations([
    { ref: "obs_unicode", toolCallId: "c", toolName: "exec_command", status: "succeeded", excerpt: "😀".repeat(3_000) },
  ]);
  expect(unicode).toEqual([]);
});

test("the retained MCP request does not repeat the checkpoint schema", () => {
  const instruction = structuredCompactionHandoffInstruction({
    token: `control_${"a".repeat(32)}`,
    handoffId: `handoff_${"b".repeat(32)}`,
  });

  expect(instruction).toContain("codex.control.compaction_handoff");
  expect(instruction).not.toContain("<compaction_state>");
  expect(instruction).not.toContain("requirements:");
});
