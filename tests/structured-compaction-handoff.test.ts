import { describe, expect, test } from "bun:test";
import {
  COMPACT_PROMPT,
  COMPACTION_STATE_TAG_START,
  COMPACTION_STATE_TAG_END,
  compactionItemToText,
  decodeCompactionSummary,
  encodeCompactionSummary,
  extractStructuredCompactionHandoff,
  formatCompactionStateBlock,
  isReadableCompactionSummaryText,
  parseCompactionState,
  SUMMARY_PREFIX,
  type CompactionStateBlock,
} from "../src/responses/compaction";

describe("Sprint Q: Structured Compaction Handoff Envelope", () => {
  test("COMPACT_PROMPT includes structured state XML instructions", () => {
    expect(COMPACT_PROMPT).toContain(COMPACTION_STATE_TAG_START);
    expect(COMPACT_PROMPT).toContain(COMPACTION_STATE_TAG_END);
    expect(COMPACT_PROMPT).toContain("modified_files:");
    expect(COMPACT_PROMPT).toContain("active_hypothesis:");
    expect(COMPACT_PROMPT).toContain("next_actions:");
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
    expect(parsed?.activeHypothesis).toBe(
      "The fast-path cache reduces disk I/O while preserving mtime validation.",
    );
    expect(parsed?.blockersOrTestFailures).toEqual([]);
    expect(parsed?.nextActions).toEqual([
      "Run bun test ./tests to verify zero regressions",
      "Verify /healthz output",
    ]);
  });

  test("returns null when <compaction_state> block is absent", () => {
    const legacySummary = "A plain text summary without structured blocks. Everything worked.";
    expect(parseCompactionState(legacySummary)).toBeNull();
  });

  test("formats compaction state block canonically and round-trips", () => {
    const block: CompactionStateBlock = {
      modifiedFiles: ["src/index.ts", "package.json"],
      activeHypothesis: "Refactoring bundle pipeline to optimize startup time.",
      blockersOrTestFailures: ["TypeError in browser worker"],
      nextActions: ["Patch browser worker", "Re-run suite"],
    };

    const formatted = formatCompactionStateBlock(block);
    expect(formatted).toContain(COMPACTION_STATE_TAG_START);
    expect(formatted).toContain("modified_files:\n- src/index.ts\n- package.json");
    expect(formatted).toContain("active_hypothesis: Refactoring bundle pipeline to optimize startup time.");
    expect(formatted).toContain("blockers_or_test_failures:\n- TypeError in browser worker");
    expect(formatted).toContain("next_actions:\n- Patch browser worker\n- Re-run suite");
    expect(formatted).toContain(COMPACTION_STATE_TAG_END);

    const roundTrip = parseCompactionState(formatted);
    expect(roundTrip).toEqual(block);
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
});
