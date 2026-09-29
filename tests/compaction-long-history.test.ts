import { expect, test } from "bun:test";
import { validateCompactionQuality } from "../src/adapters/chatgpt-web/autonomous-compaction";
import { extractStructuredCompactionHandoff } from "../src/responses/compaction";
import type { CodexMessage } from "../src/types";

function checkpoint(requirements: string[], files: string[], achievement = "") {
  return `<compaction_state>
version: 2
original_request_ref: user turn t0: finish the bridge
modified_files:
${files.map((file) => `- ${file}`).join("\n")}
active_hypothesis: Preserve a long mission across browser handoff.
requirements:
${requirements.join("\n")}
closure_criteria:
- All pending requirements are completed
verified_achievements:
${achievement}
decisions_and_invariants:
- Keep the same session ownership
blockers_or_test_failures:
- Network permission was denied
pending_obligations:
- Continue the open mission
next_actions:
- Verify the next pending requirement
</compaction_state>`;
}

test("a long repaired checkpoint retains prior IDs, blockers, files and completed test evidence", () => {
  const priorRequirements = Array.from(
    { length: 45 },
    (_, index) =>
      `- ${JSON.stringify({
        id: `REQ-${index + 1}`,
        status: index % 7 === 0 ? "blocked" : "pending",
        source: `user turn t0: complete requirement ${index + 1}`,
      })}`,
  );
  const previous = checkpoint(priorRequirements, ["src/bridge.ts"]);
  const current = checkpoint(
    [
      ...priorRequirements,
      `- ${JSON.stringify({ id: "REQ-46", status: "pending", source: "user turn t1: verify the new runtime" })}`,
    ],
    ["src/bridge.ts", "src/runtime.ts"],
    "- Runtime tests passed — evidence: 2 tests passed",
  );
  const messages: CodexMessage[] = [
    { role: "user", origin: "compaction_summary", content: previous, timestamp: 1 },
    { role: "user", content: "Verify the new runtime", timestamp: 2 },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_patch",
          name: "apply_patch",
          arguments: { patch: "*** Update File: src/runtime.ts" },
        },
      ],
      timestamp: 3,
    },
    {
      role: "toolResult",
      toolCallId: "call_patch",
      toolName: "apply_patch",
      content: "Success. Updated the following files:\nM src/runtime.ts",
      isError: false,
      timestamp: 4,
    },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call_test", name: "exec_command", arguments: { cmd: "bun test runtime.test.ts" } },
      ],
      timestamp: 5,
    },
    {
      role: "toolResult",
      toolCallId: "call_test",
      toolName: "exec_command",
      content: JSON.stringify({ exit_code: 0, output: "2 tests passed\n0 fail" }),
      isError: false,
      timestamp: 6,
    },
  ];
  const parsed = extractStructuredCompactionHandoff(current).state;
  expect(parsed?.requirements).toHaveLength(46);
  expect(parsed?.requirements?.filter((item) => item.status === "blocked")).toHaveLength(7);
  expect(validateCompactionQuality(messages, current, { requireStructured: true }).missingInvariants).toEqual([]);

  const missingRequirement = current.replace(`${priorRequirements[17]!}\n`, "");
  expect(
    validateCompactionQuality(messages, missingRequirement, { requireStructured: true }).missingInvariants,
  ).toContain("Missing prior requirement REQ-18");
  const missingFile = current.replace("- src/runtime.ts\n", "");
  expect(validateCompactionQuality(messages, missingFile, { requireStructured: true }).missingInvariants).toContain(
    "Missing modified file from successful patch: src/runtime.ts",
  );
});
