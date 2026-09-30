import { describe, expect, test } from "bun:test";
import { validateCompactionQuality } from "../src/adapters/chatgpt-web/autonomous-compaction";
import { autoHealCompactionHandoff } from "../src/adapters/chatgpt-web/compaction-handoff";
import {
  autoHealCompactionBlock,
  locateCompactionStateBounds,
  normalizeCompactionStateBlock,
  parseCompactionState,
} from "../src/responses/compaction";
import type { CodexMessage, CodexParsedRequest } from "../src/types";

function createMockParsedRequest(messages: CodexMessage[] = []): CodexParsedRequest {
  const userContent = "Original user task: fix the compaction loop";
  return {
    modelId: "chatgpt-web-native",
    _compactionRequest: true,
    _rawBody: {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: userContent }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn_source_norm" },
        },
      ],
    },
    context: {
      messages: [
        {
          role: "user",
          content: userContent,
          timestamp: 1000,
        },
        ...messages,
      ],
      systemPrompt: [],
      tools: [],
    },
    options: {},
  };
}

describe("Sprint 1: Tolerant Normalization & Checkpoint Resilience", () => {
  test("unfences markdown code block enclosing <compaction_state>", () => {
    const rawFenced = `
Here is the handoff summary for the next agent:

\`\`\`xml
<compaction_state>
version: 2
original_request_ref: sha256:d8b2d2f70b4f8d
modified_files:
- src/responses/compaction.ts
active_hypothesis: Normalizing fenced blocks prevents rejection.
requirements:
- id: REQ-001
  status: pending
  source: User request
closure_criteria:
- Tests pass
verified_achievements:
- Created test suite
decisions_and_invariants:
- Unfence only when no outer unfenced block exists
blockers_or_test_failures:
- None
pending_obligations:
- None
next_actions:
- Verify normalization pass
</compaction_state>
\`\`\`

End of summary.
`;

    const normalized = normalizeCompactionStateBlock(rawFenced);
    const bounds = locateCompactionStateBounds(normalized, { unfencedOnly: true });
    expect(bounds).not.toBeNull();
    expect(bounds?.fenced).toBe(false);

    const parsed = parseCompactionState(normalized);
    expect(parsed).not.toBeNull();
    expect(parsed?.version).toBe(2);
    expect(parsed?.modifiedFiles).toEqual(["src/responses/compaction.ts"]);
    expect(parsed?.nextActions).toEqual(["Verify normalization pass"]);
  });

  test("auto-completes missing empty sections (pending_obligations and blockers)", () => {
    const rawWithoutOptionalSections = `
<compaction_state>
version: 2
original_request_ref: sha256:abc12345
modified_files:
- src/test.ts
active_hypothesis: Complete missing empty sections with none.
requirements:
- id: REQ-1
  status: pending
  source: User instruction
closure_criteria:
- All green
verified_achievements:
- Implemented normalizer
decisions_and_invariants:
- Safe defaults
next_actions:
- Run integration tests
</compaction_state>
`;

    const healed = autoHealCompactionBlock(rawWithoutOptionalSections);
    const parsed = parseCompactionState(healed);
    expect(parsed).not.toBeNull();
    expect(parsed?.blockersOrTestFailures).toEqual([]);
    expect(parsed?.pendingObligations).toEqual([]);

    // Check that normalized text contains the section headers so validateCompactionQuality passes
    expect(healed).toContain("blockers_or_test_failures:");
    expect(healed).toContain("pending_obligations:");
  });

  test("auto-defaults version: 2 if omitted but v2 fields are present", () => {
    const rawWithoutVersion = `
<compaction_state>
original_request_ref: sha256:def456
modified_files:
- src/index.ts
active_hypothesis: Auto-inject version 2 for structured handoffs.
requirements:
- id: REQ-2
  status: pending
  source: Task spec
closure_criteria:
- Verification clean
verified_achievements:
- Added auto-default
decisions_and_invariants:
- Default v2
blockers_or_test_failures:
- None
pending_obligations:
- None
next_actions:
- Run test suite
</compaction_state>
`;

    const healed = autoHealCompactionBlock(rawWithoutVersion);
    const parsed = parseCompactionState(healed);
    expect(parsed).not.toBeNull();
    expect(parsed?.version).toBe(2);
  });

  test("coalesces multiple next_actions into a single actionable entry", () => {
    const rawMultipleActions = `
<compaction_state>
version: 2
original_request_ref: sha256:789abc
modified_files:
- src/app.ts
active_hypothesis: Single next action requirement.
requirements:
- id: REQ-3
  status: pending
  source: Initial prompt
closure_criteria:
- Complete
verified_achievements:
- Action coalescing
decisions_and_invariants:
- Format cleanly
blockers_or_test_failures:
- None
pending_obligations:
- None
next_actions:
- Run the full test suite
- Verify linting and build
</compaction_state>
`;

    const healed = autoHealCompactionBlock(rawMultipleActions);
    const parsed = parseCompactionState(healed);
    expect(parsed).not.toBeNull();
    expect(parsed?.nextActions.length).toBe(1);
    expect(parsed?.nextActions[0]).toContain("Run the full test suite");
  });

  test("canonicalizeCompactionHandoff normalizes and reconciles without requiring prior perfection", () => {
    const parsedRequest = createMockParsedRequest();
    const imperfectSummary = `
Summary of past progress.

\`\`\`markdown
<compaction_state>
original_request_ref: sha256:111222
modified_files:
- src/service.ts
active_hypothesis: Resilient canonicalization.
requirements:
- id: REQ-4
  status: pending
  source: User request
closure_criteria:
- Success
verified_achievements:
- Tested flow
decisions_and_invariants:
- Strict typing
next_actions:
- Execute final audit
- Deploy update
</compaction_state>
\`\`\`
`;

    const canonical = autoHealCompactionHandoff(parsedRequest, imperfectSummary);
    expect(canonical).toContain("CODEX_LATEST_USER_PROMPT_JSON");
    expect(canonical).toContain("CODEX_ORIGINAL_USER_REQUEST_JSON");

    const quality = validateCompactionQuality(parsedRequest.context.messages, canonical, {
      requireStructured: true,
    });
    expect(quality.valid).toBe(true);
    expect(quality.missingInvariants).toEqual([]);
  });
});
