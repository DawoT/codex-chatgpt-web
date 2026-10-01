import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { inspectCompactionCheckpoint } from "../src/adapters/chatgpt-web/compaction-policy";
import { buildCompactionFallbackRepairPrompt } from "../src/adapters/chatgpt-web/compaction-repair";
import { compactionOriginalRequestRef } from "../src/adapters/chatgpt-web/compaction-source";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import {
  structuredCompactionHandoffInstruction,
  structuredCompactionRepairInstruction,
  zeroRiskActiveCompactionToolResultInstruction,
} from "../src/adapters/chatgpt-web/native-compaction-control";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { COMPACT_PROMPT, formatCompactionStateBlock, ORIGINAL_USER_REQUEST_MARKER } from "../src/responses/compaction";
import type { CodexParsedRequest } from "../src/types";

const sections = [
  "version: 2",
  "original_request_ref:",
  "modified_files:",
  "active_hypothesis:",
  "requirements:",
  "closure_criteria:",
  "verified_achievements:",
  "decisions_and_invariants:",
  "blockers_or_test_failures:",
  "pending_obligations:",
  "next_actions:",
];

const transaction = { token: "control_fixture", handoffId: "handoff_fixture" };

function request(): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    context: { messages: [{ role: "user", content: "Fix the parser", timestamp: 1 }] },
    options: { reasoning: "medium" },
    _compactionRequest: true,
    _rawBody: {
      input: [
        {
          type: "message",
          role: "user",
          content: "Fix the parser",
          internal_chat_message_metadata_passthrough: { turn_id: "source" },
        },
      ],
    },
  };
}

test("all model-facing checkpoint requests explicitly describe the strict v2 wire format", () => {
  const instructions = [
    COMPACT_PROMPT,
    structuredCompactionHandoffInstruction(transaction),
    structuredCompactionRepairInstruction(transaction, ["Missing structured compaction state"]),
    zeroRiskActiveCompactionToolResultInstruction(true),
    zeroRiskActiveCompactionToolResultInstruction(false),
  ];
  for (const instruction of instructions) {
    expect(instruction).toContain("<compaction_state>");
    expect(instruction).toContain("</compaction_state>");
    for (const section of sections) expect(instruction).toContain(section);
    expect(instruction).toContain("exactly one next action");
    expect(instruction).toContain("Never invent");
  }
});

test("compiled fresh compact supplies the host-computed original reference outside task history", () => {
  const parsed = request();
  const compiled = compileChatGptWebPrompt(parsed, {
    localToolsEnabled: false,
    solAvailable: true,
    extraHighAvailable: false,
    proAvailable: false,
  });
  expect(compiled.text).toContain(`original_request_ref: ${compactionOriginalRequestRef(parsed)}`);
  expect(compiled.text).toContain("exactly one next action");
});

test("trusted continuation preserves the original digest and refuses corrupt provenance", () => {
  const parsed = request();
  const original = String.raw`Keep a\_b.ts and the original task`;
  const digest = createHash("sha256").update(original).digest("hex");
  parsed.context.messages.unshift({
    role: "user",
    origin: "compaction_summary",
    content: `Prior checkpoint\n${ORIGINAL_USER_REQUEST_MARKER}\n${JSON.stringify({ sha256: digest, text: original })}`,
    timestamp: 0,
  });
  expect(compactionOriginalRequestRef(parsed)).toBe(`sha256:${digest}`);
  const first = parsed.context.messages[0]!;
  if (first.role !== "user") throw new Error("fixture must contain a user checkpoint");
  first.content = `Prior checkpoint\n${ORIGINAL_USER_REQUEST_MARKER}\n${JSON.stringify({ sha256: "0".repeat(64), text: original })}`;
  expect(() => compactionOriginalRequestRef(parsed)).toThrow("invalid original-request marker");
});

test("a native environment preamble cannot replace the original task reference", () => {
  const parsed = request();
  parsed.context.messages.unshift({
    role: "user",
    content: "<environment_context><cwd>/tmp/project</cwd></environment_context>",
    timestamp: 0,
  });
  expect(compactionOriginalRequestRef(parsed)).toBe(
    `sha256:${createHash("sha256").update("Fix the parser").digest("hex")}`,
  );
});

test("a complete checkpoint with a forged original digest is rejected rather than accepted", () => {
  const parsed = request();
  const draft = formatCompactionStateBlock({
    version: 2,
    originalRequestRef: `sha256:${"0".repeat(64)}`,
    modifiedFiles: [],
    activeHypothesis: "Fix the parser",
    requirements: [{ id: "REQ-parser", status: "pending", source: "Fix the parser" }],
    closureCriteria: ["Fix the parser"],
    verifiedAchievements: [],
    decisionsAndInvariants: [],
    blockersOrTestFailures: [],
    pendingObligations: ["Fix the parser"],
    nextActions: ["Inspect the parser"],
  });
  const inspected = inspectCompactionCheckpoint(parsed, draft);
  expect(inspected.valid).toBe(false);
  expect(inspected.issues).toContain("Original request reference does not match the authoritative source");
  expect(inspected.state?.originalRequestRef).toBe(`sha256:${"0".repeat(64)}`);
});

test("fallback repair supplies the authoritative original request digest and preserves literals", () => {
  const originalRequest = String.raw`Fix src/a\_b.ts; preserve turn_0123456789 and $HOME literally.`;
  const digest = createHash("sha256").update(originalRequest).digest("hex");
  const instruction = buildCompactionFallbackRepairPrompt({
    issues: ["Missing structured compaction state"],
    originalRequest,
    latestRequest: "Run the final checks",
    otherUserRequests: [],
    priorState: undefined,
    observations: [],
    rejectedDraft: "I tried to fix it; no final check has run.",
  });
  expect(instruction).toBeDefined();
  expect(instruction).toContain(`original_request_ref: sha256:${digest}`);
  expect(instruction).toContain(JSON.stringify(originalRequest));
  expect(instruction).toContain("<compaction_state>");
  for (const section of sections) expect(instruction).toContain(section);
  expect(instruction).not.toContain("bridge will normalize its internal format");
});

test("a cached static contract never borrows another task's original digest", () => {
  const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false };
  const first = request();
  const second = request();
  second.context.messages[0] = { role: "user", content: "Repair a different task", timestamp: 1 };
  compileChatGptWebPrompt(first, capabilities);
  const selected = compileChatGptWebPrompt(second, capabilities);
  expect(selected.text).toContain(`original_request_ref: ${compactionOriginalRequestRef(second)}`);
  expect(selected.text).not.toContain(`original_request_ref: ${compactionOriginalRequestRef(first)}`);
});
