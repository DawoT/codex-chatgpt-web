import { describe, expect, test } from "bun:test";
import {
  COMPACT_PROMPT,
  COMPACTION_STATE_TAG_END,
  COMPACTION_STATE_TAG_START,
  type CompactionStateBlock,
  compactionItemToText,
  compactionStateFields,
  countCompactionRequirementItems,
  decodeCompactionSummary,
  encodeCompactionSummary,
  extractStructuredCompactionHandoff,
  formatCompactionStateBlock,
  inspectCompactionStateFormat,
  isReadableCompactionSummaryText,
  parseCompactionState,
  SUMMARY_PREFIX,
} from "../src/responses/compaction";

describe("Sprint Q: Structured Compaction Handoff Envelope", () => {
  test("COMPACT_PROMPT requests a faithful handoff without exposing the internal schema", () => {
    expect(COMPACT_PROMPT).toContain("faithful handoff");
    expect(COMPACT_PROMPT).not.toContain(COMPACTION_STATE_TAG_START);
    expect(COMPACT_PROMPT).not.toContain("requirements:");
  });

  test("parses structured compaction state from summary text", () => {
    const rawSummary = `
The previous turn completed refactoring the authentication session guard and cache layer.

<compaction_state>
modified_files:
- src/adapters/chatgpt-web/fast-path-cache.ts
- src/adapters/chatgpt-web/session-guard.ts
active_hypothesis: The fast-path cache reduces disk I/O while preserving mtime validation.
blockers_or_test_failures:
- None
next_actions:
- Run bun test ./tests to verify zero regressions
- Verify /healthz output
</compaction_state>

All 871 tests were passing before compaction.
`;

    const parsed = parseCompactionState(rawSummary);
    expect(parsed).not.toBeNull();
    expect(parsed?.modifiedFiles).toEqual([
      "src/adapters/chatgpt-web/fast-path-cache.ts",
      "src/adapters/chatgpt-web/session-guard.ts",
    ]);
    expect(parsed?.activeHypothesis).toBe("The fast-path cache reduces disk I/O while preserving mtime validation.");
    expect(parsed?.blockersOrTestFailures).toEqual([]);
    expect(parsed?.nextActions).toEqual(["Run bun test ./tests to verify zero regressions", "Verify /healthz output"]);
  });

  test("returns null when <compaction_state> block is absent", () => {
    const legacySummary = "A plain text summary without structured blocks. Everything worked.";
    expect(parseCompactionState(legacySummary)).toBeNull();
  });

  test("reads a legacy checkpoint tag after narrative on the same line", () => {
    const checkpoint =
      "Summary text <compaction_state>\nversion: 2\nmodified_files:\n- src/legacy.ts\n</compaction_state>";
    expect(parseCompactionState(checkpoint)?.modifiedFiles).toEqual(["src/legacy.ts"]);
    expect(extractStructuredCompactionHandoff(checkpoint).narrative).toBe("Summary text");
  });

  test("reads a legacy inline state block without treating backticked examples as state", () => {
    const checkpoint = "<compaction_state>modified_files:\n- src/inline.ts\n</compaction_state>";
    expect(parseCompactionState(checkpoint)?.modifiedFiles).toEqual(["src/inline.ts"]);
    expect(parseCompactionState("`<compaction_state>modified_files: - example.ts</compaction_state>`")).toBeNull();
  });

  test("extracts the parsed block rather than a fenced example with identical tags", () => {
    const checkpoint = [
      "Example:",
      "```xml",
      "<compaction_state>",
      "modified_files:",
      "- example.ts",
      "</compaction_state>",
      "```",
      "Actual checkpoint:",
      "<compaction_state>",
      "modified_files:",
      "- src/real.ts",
      "</compaction_state>",
    ].join("\n");
    const extracted = extractStructuredCompactionHandoff(checkpoint);
    expect(extracted.state?.modifiedFiles).toEqual(["src/real.ts"]);
    expect(extracted.narrative).toContain("- example.ts");
    expect(extracted.narrative).not.toContain("src/real.ts");
  });

  test("reports checkpoint tag shape without exposing checkpoint content", () => {
    const fenced = "```xml\n<compaction_state>\nsecret: do not log\n</compaction_state>\n```";
    expect(inspectCompactionStateFormat(fenced)).toEqual({
      openingTags: 1,
      closingTags: 1,
      usableUnfencedBlock: false,
      fencedTag: true,
    });
    expect(JSON.stringify(inspectCompactionStateFormat(fenced))).not.toContain("secret");
    expect(inspectCompactionStateFormat("No checkpoint block")).toEqual({
      openingTags: 0,
      closingTags: 0,
      usableUnfencedBlock: false,
      fencedTag: false,
    });
  });

  test("formats compaction state block canonically and round-trips", () => {
    const block: CompactionStateBlock = {
      modifiedFiles: ["src/index.ts", "package.json"],
      activeHypothesis: "Refactoring bundle pipeline to optimize startup time.",
      verifiedAchievements: ["Timeout regression test passes — evidence: bun test timeout.test.ts"],
      decisionsAndInvariants: ["Never emit a tool call before browser observation"],
      blockersOrTestFailures: ["TypeError in browser worker"],
      pendingObligations: ["Run the integration suite"],
      nextActions: ["Patch browser worker", "Re-run suite"],
    };

    const formatted = formatCompactionStateBlock(block);
    expect(formatted).toContain(COMPACTION_STATE_TAG_START);
    expect(formatted).toContain("modified_files:\n- src/index.ts\n- package.json");
    expect(formatted).toContain("active_hypothesis: Refactoring bundle pipeline to optimize startup time.");
    expect(formatted).toContain(
      "verified_achievements:\n- Timeout regression test passes — evidence: bun test timeout.test.ts",
    );
    expect(formatted).toContain("decisions_and_invariants:\n- Never emit a tool call before browser observation");
    expect(formatted).toContain("blockers_or_test_failures:\n- TypeError in browser worker");
    expect(formatted).toContain("pending_obligations:\n- Run the integration suite");
    expect(formatted).toContain("next_actions:\n- Patch browser worker\n- Re-run suite");
    expect(formatted).toContain(COMPACTION_STATE_TAG_END);

    const roundTrip = parseCompactionState(formatted);
    expect(roundTrip).toEqual(block);
  });

  test("round-trips a versioned mission checklist with stable requirement IDs", () => {
    const block: CompactionStateBlock = {
      version: 2,
      originalRequestRef: "user message at turn 1",
      modifiedFiles: ["src/bridge.ts"],
      activeHypothesis: "Finish bridge delivery",
      requirements: [
        { id: "REQ-1", status: "pending", source: "user message at turn 1: deliver bridge" },
        {
          id: "REQ-2",
          status: "verified",
          source: "user message at turn 1: test bridge",
          evidence: "bun test bridge.test.ts: 2 pass",
        },
      ],
      closureCriteria: ["All tests pass"],
      blockersOrTestFailures: [],
      nextActions: ["Run integration test"],
    };

    expect(parseCompactionState(formatCompactionStateBlock(block))).toEqual(block);
  });

  test("extracts narrative prose and structured state cleanly", () => {
    const mixed = `First paragraph of narrative summary.

<compaction_state>
modified_files:
- file1.ts
next_actions:
- step 1
</compaction_state>

Second paragraph of narrative summary.`;

    const { narrative, state } = extractStructuredCompactionHandoff(mixed);
    expect(narrative).toBe("First paragraph of narrative summary.\n\nSecond paragraph of narrative summary.");
    expect(state).not.toBeNull();
    expect(state?.modifiedFiles).toEqual(["file1.ts"]);
    expect(state?.nextActions).toEqual(["step 1"]);
  });

  test("encodes and decodes structured summary with ocx1: envelope", () => {
    const originalSummary = `Summary text\n<compaction_state>\nmodified_files:\n- a.ts\n</compaction_state>`;
    const encoded = encodeCompactionSummary(originalSummary);
    expect(encoded.startsWith("ocx1:")).toBe(true);

    const decoded = decodeCompactionSummary(encoded);
    expect(decoded).toBe(originalSummary);

    const replayed = compactionItemToText(encoded);
    expect(isReadableCompactionSummaryText(replayed)).toBe(true);
    expect(replayed).toBe(`${SUMMARY_PREFIX}\n\n${originalSummary}`);
  });

  test.each(["ocx1:", "ocx1:!!!", "ocx1:a", "ocx1:////", "ocx1:SGVsbG8=garbage"])(
    "rejects malformed bridge checkpoint envelope %s instead of replaying corrupt history",
    (envelope) => {
      expect(decodeCompactionSummary(envelope)).toBeNull();
      expect(isReadableCompactionSummaryText(compactionItemToText(envelope))).toBeFalse();
    },
  );

  test("parses compaction state when wrapped in a markdown xml code fence", () => {
    const fenced = [
      "Here is the compaction state for the session:",
      "```xml",
      "<compaction_state>",
      "version: 2",
      "original_request_ref: request-1",
      "modified_files:",
      "- src/responses/compaction.ts",
      "active_hypothesis: Support fenced checkpoints",
      "requirements:",
      '- {"id":"REQ-1","status":"verified","source":"user","evidence":"bun test passes"}',
      "closure_criteria:",
      "- All tests pass",
      "blockers_or_test_failures:",
      "- None",
      "next_actions:",
      "- Verify build bundle",
      "</compaction_state>",
      "```",
      "Please proceed with the next task.",
    ].join("\n");

    const parsed = parseCompactionState(fenced);
    expect(parsed).not.toBeNull();
    expect(parsed?.version).toBe(2);
    expect(parsed?.modifiedFiles).toEqual(["src/responses/compaction.ts"]);
    expect(parsed?.nextActions).toEqual(["Verify build bundle"]);

    const handoff = extractStructuredCompactionHandoff(fenced);
    expect(handoff.narrative).toBe(
      "Here is the compaction state for the session:\n\nPlease proceed with the next task.",
    );
    expect(handoff.state?.version).toBe(2);
  });

  test("parses compaction state with escaped underscores, entities, and hyphens", () => {
    const escaped = [
      "<compaction\\_state>",
      "version: 2",
      "original\\_request\\_ref: request-2",
      "modified\\_files:",
      "- src/file.ts",
      "requirements:",
      '- {"id":"REQ-2","status":"pending","source":"task"}',
      "next\\_actions:",
      "- Continue",
      "</compaction\\_state>",
    ].join("\n");

    const parsed = parseCompactionState(escaped);
    expect(parsed).not.toBeNull();
    expect(parsed?.version).toBe(2);
    expect(parsed?.originalRequestRef).toBe("request-2");
    expect(parsed?.modifiedFiles).toEqual(["src/file.ts"]);
    expect(parsed?.nextActions).toEqual(["Continue"]);

    const entitySummary = [
      "&lt;compaction_state&gt;",
      "version: 2",
      "modified_files:",
      "- src/entity.ts",
      "requirements:",
      '- {"id":"REQ-3","status":"pending","source":"task"}',
      "next_actions:",
      "- Continue",
      "&lt;/compaction_state&gt;",
    ].join("\n");

    expect(parseCompactionState(entitySummary)?.modifiedFiles).toEqual(["src/entity.ts"]);

    const hyphenSummary = [
      "<compaction-state>",
      "version: 2",
      "modified_files:",
      "- src/hyphen.ts",
      "requirements:",
      '- {"id":"REQ-4","status":"pending","source":"task"}',
      "next_actions:",
      "- Continue",
      "</compaction-state>",
    ].join("\n");

    expect(parseCompactionState(hyphenSummary)?.modifiedFiles).toEqual(["src/hyphen.ts"]);
  });

  test("parses tagless structured compaction state and extracts narrative", () => {
    const tagless = [
      "Before checkpoint narrative.",
      "",
      "version: 2",
      "original_request_ref: request-5",
      "modified_files:",
      "- src/tagless.ts",
      "active_hypothesis: Fallback parser works",
      "requirements:",
      '- {"id":"REQ-5","status":"pending","source":"task"}',
      "closure_criteria:",
      "- Tests pass",
      "blockers_or_test_failures:",
      "- None",
      "next_actions:",
      "- Run tests",
      "",
      "After checkpoint narrative.",
    ].join("\n");

    const parsed = parseCompactionState(tagless);
    expect(parsed).not.toBeNull();
    expect(parsed?.version).toBe(2);
    expect(parsed?.modifiedFiles).toEqual(["src/tagless.ts"]);
    expect(parsed?.nextActions).toEqual(["Run tests"]);

    const handoff = extractStructuredCompactionHandoff(tagless);
    expect(handoff.narrative).toBe("Before checkpoint narrative.\n\nAfter checkpoint narrative.");
    expect(handoff.state?.version).toBe(2);
  });

  test("does not invent a version for a tagless legacy checkpoint", () => {
    const summary = [
      "modified_files:",
      "- src/bridge.ts",
      "requirements:",
      '- {"id":"REQ-1","status":"pending","source":"user request"}',
      "closure_criteria:",
      "- Bridge works",
      "next_actions:",
      "- Continue",
    ].join("\n");
    expect(parseCompactionState(summary)?.version).toBeUndefined();
  });

  test("reads decorated field names without changing their values", () => {
    const summary = [
      "<compaction_state>",
      "**version**: 2",
      "**original\\_request\\_ref**: request-1",
      "**modified\\_files**:",
      "- src/a_b.ts",
      "**active\\_hypothesis**: Preserve `a_b` exactly",
      "**requirements**:",
      '- {"id":"REQ-1","status":"pending","source":"keep a_b"}',
      "**next\\_actions**:",
      "- Check a_b",
      "</compaction_state>",
    ].join("\n");
    const parsed = parseCompactionState(summary);
    expect(parsed?.version).toBe(2);
    expect(parsed?.originalRequestRef).toBe("request-1");
    expect(parsed?.modifiedFiles).toEqual(["src/a_b.ts"]);
    expect(parsed?.activeHypothesis).toBe("Preserve `a_b` exactly");
    expect(parsed?.nextActions).toEqual(["Check a_b"]);
  });

  test("reads tagless underscore emphasis as one checkpoint", () => {
    const summary = [
      "Before state.",
      "__version__: 2",
      "__modified_files__:",
      "- src/bridge.ts",
      "__requirements__:",
      '- {"id":"REQ-1","status":"pending","source":"bridge"}',
      "__closure_criteria__:",
      "- Bridge works",
      "__next_actions__:",
      "- Continue",
      "After state.",
    ].join("\n");
    expect(parseCompactionState(summary)?.version).toBe(2);
    expect(parseCompactionState(summary)?.modifiedFiles).toEqual(["src/bridge.ts"]);
    expect(extractStructuredCompactionHandoff(summary).narrative).toBe("Before state.\n\nAfter state.");
  });

  test("parses a collapsed single-line compaction block with escaped underscores and inline lists", () => {
    const singleLine = `<compaction_state> version: 2 original\\_request\\_ref: "sha256:d88a1e86d8dd121300c4172b5a2590d42ac3637d57f748e54fabdfe680adb555" modified\\_files: - src/a.ts - src/b.ts active\\_hypothesis: "Single line test hypothesis" requirements: - {"id":"REQ-1","status":"pending","source":"original user request: req 1"} - {"id":"REQ-2","status":"verified","source":"original user request: req 2","evidence":"tests pass"} closure\\_criteria: - "All tests pass" verified\\_achievements: - "Tests pass — evidence: tests pass" decisions\\_and\\_invariants: - "Keep invariants intact" blockers\\_or\\_test\\_failures: - "None" pending\\_obligations: - "Complete validation" next\\_actions: - "Run suite" </compaction_state>`;

    const parsed = parseCompactionState(singleLine);
    expect(parsed).not.toBeNull();
    expect(parsed?.version).toBe(2);
    expect(parsed?.originalRequestRef).toBe(
      '"sha256:d88a1e86d8dd121300c4172b5a2590d42ac3637d57f748e54fabdfe680adb555"',
    );
    expect(parsed?.modifiedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(parsed?.activeHypothesis).toBe('"Single line test hypothesis"');
    expect(parsed?.requirements).toHaveLength(2);
    expect(parsed?.requirements?.[0]?.id).toBe("REQ-1");
    expect(parsed?.requirements?.[1]?.id).toBe("REQ-2");
    expect(parsed?.closureCriteria).toEqual(['"All tests pass"']);
    expect(parsed?.verifiedAchievements).toEqual(['"Tests pass — evidence: tests pass"']);
    expect(parsed?.decisionsAndInvariants).toEqual(['"Keep invariants intact"']);
    expect(parsed?.blockersOrTestFailures).toEqual(['"None"']);
    expect(parsed?.pendingObligations).toEqual(['"Complete validation"']);
    expect(parsed?.nextActions).toEqual(['"Run suite"']);

    const fields = compactionStateFields(singleLine);
    expect(fields.has("version")).toBe(true);
    expect(fields.has("original_request_ref")).toBe(true);
    expect(fields.has("modified_files")).toBe(true);
    expect(fields.has("active_hypothesis")).toBe(true);
    expect(fields.has("requirements")).toBe(true);
    expect(fields.has("closure_criteria")).toBe(true);
    expect(fields.has("verified_achievements")).toBe(true);
    expect(fields.has("decisions_and_invariants")).toBe(true);
    expect(fields.has("blockers_or_test_failures")).toBe(true);
    expect(fields.has("pending_obligations")).toBe(true);
    expect(fields.has("next_actions")).toBe(true);

    const handoff = extractStructuredCompactionHandoff(`Before narrative.\n\n${singleLine}\n\nAfter narrative.`);
    expect(handoff.narrative).toBe("Before narrative.\n\nAfter narrative.");
    expect(handoff.state?.version).toBe(2);
    expect(handoff.state?.modifiedFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("preserves quoted field names and bullet-like text inside collapsed checkpoint values", () => {
    const summary = `<compaction_state> version: 2 original\\_request\\_ref: "Keep requirements: and - examples" modified\\_files: - src/a.ts active\\_hypothesis: "Preserve A - B and next_actions: literally" requirements: - {"id":"REQ-1","status":"pending","source":"Keep - text and modified_files: literal"} next\\_actions: - "Check - text" </compaction_state>`;

    const state = parseCompactionState(summary);
    expect(state?.originalRequestRef).toBe('"Keep requirements: and - examples"');
    expect(state?.activeHypothesis).toBe('"Preserve A - B and next_actions: literally"');
    expect(state?.requirements?.[0]?.source).toBe("Keep - text and modified_files: literal");
    expect(state?.nextActions).toEqual(['"Check - text"']);
    expect(countCompactionRequirementItems(summary)).toBe(1);
  });

  test("preserves unquoted hyphenated scalar checkpoint values", () => {
    const summary =
      '<compaction_state> version: 2 original_request_ref: Keep A - B modified_files: - src/a.ts active_hypothesis: Check A - B requirements: - {"id":"REQ-1","status":"pending","source":"Check A - B"} next_actions: - Continue </compaction_state>';

    const state = parseCompactionState(summary);
    expect(state?.originalRequestRef).toBe("Keep A - B");
    expect(state?.activeHypothesis).toBe("Check A - B");
    expect(state?.requirements?.[0]?.source).toBe("Check A - B");
  });
});
