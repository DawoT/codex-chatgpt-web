import { expect, test } from "bun:test";
import type { CodexMessage } from "../src/types";
import {
  buildCompactionEvidenceIndex,
  selectCompactionRepairEvidence,
} from "../src/adapters/chatgpt-web/compaction-evidence";
import { validateCompactionQuality } from "../src/adapters/chatgpt-web/autonomous-compaction";
import { structuredCompactionHandoffInstruction } from "../src/adapters/chatgpt-web/native-compaction-control";
import { parseCompactionState } from "../src/responses/compaction";

const messages: CodexMessage[] = [
  { role: "user", content: "Run bridge tests", timestamp: 1 },
  { role: "assistant", content: [{ type: "toolCall", id: "call_test", name: "exec_command", arguments: { cmd: "bun test bridge.test.ts" } }], timestamp: 2 },
  { role: "toolResult", toolCallId: "call_test", toolName: "exec_command", content: '{"exit_code":0,"output":"2 pass"}', isError: false, timestamp: 3 },
];

function checkpoint(ref: string): string {
  return `<compaction_state>
version: 2
original_request_ref: user turn 1
modified_files:
active_hypothesis: Verify bridge tests.
requirements:
- ${JSON.stringify({ id: "REQ-1", status: "verified", source: "user turn 1: run bridge tests", evidence: "2 pass", evidenceRefs: [ref] })}
closure_criteria:
- Tests pass
verified_achievements:
decisions_and_invariants:
blockers_or_test_failures:
- None
pending_obligations:
next_actions:
- Report result
</compaction_state>`;
}

test("evidence references bind a completed result to its session", () => {
  const ref = buildCompactionEvidenceIndex(messages, "session-a")[0]?.ref;
  expect(ref).toBeDefined();
  expect(validateCompactionQuality(messages, checkpoint(ref!), {
    requireStructured: true,
    evidenceSessionId: "session-a",
  }).valid).toBe(true);
  const foreign = validateCompactionQuality(messages, checkpoint(ref!), {
    requireStructured: true,
    evidenceSessionId: "session-b",
  });
  expect(foreign.valid).toBe(false);
  expect(foreign.missingInvariants.some(issue => issue.includes("REQ-1") && issue.includes("reference"))).toBe(true);
});

test("Bun test output with zero failures proves completion, but a nonzero failure does not", () => {
  const withResult = (failures: number): CodexMessage[] => messages.map(message => message.role === "toolResult"
    ? { ...message, content: JSON.stringify({ exit_code: 0, output: `2 pass\n${failures} fail` }) }
    : message);
  const passed = withResult(0);
  const passedRef = buildCompactionEvidenceIndex(passed, "session-a")[0]!.ref;
  expect(buildCompactionEvidenceIndex(passed, "session-a")[0]!.status).toBe("succeeded");
  expect(validateCompactionQuality(passed, checkpoint(passedRef), {
    requireStructured: true,
    evidenceSessionId: "session-a",
  }).valid).toBe(true);

  const failed = withResult(1);
  const failedRef = buildCompactionEvidenceIndex(failed, "session-a")[0]!.ref;
  expect(buildCompactionEvidenceIndex(failed, "session-a")[0]!.status).toBe("failed");
  expect(validateCompactionQuality(failed, checkpoint(failedRef), {
    requireStructured: true,
    evidenceSessionId: "session-a",
  }).valid).toBe(false);
});

test("a started command or a different result cannot support the referenced claim", () => {
  const running: CodexMessage[] = [messages[0]!, messages[1]!, {
    role: "toolResult",
    toolCallId: "call_test",
    toolName: "exec_command",
    content: '{"session_id":123,"output":"2 pass"}',
    isError: false,
    timestamp: 3,
  }];
  expect(buildCompactionEvidenceIndex(running, "session-a")).toEqual([]);
  const ref = buildCompactionEvidenceIndex(messages, "session-a")[0]!.ref;
  const changed = messages.map(message => message.role === "toolResult"
    ? { ...message, content: '{"exit_code":0,"output":"0 pass"}' } : message);
  expect(validateCompactionQuality(changed, checkpoint(ref), {
    requireStructured: true,
    evidenceSessionId: "session-a",
  }).valid).toBe(false);
});

test("a started session remains unfinished even when its output embeds exit_code zero", () => {
  const running = messages.map(message => message.role === "toolResult"
    ? { ...message, content: '{"session_id":42,"exit_code":0,"output":"2 pass"}' } : message);
  expect(buildCompactionEvidenceIndex(running, "session-a")).toEqual([]);
});

test("completed polling inherits its original test command and failed polling cannot verify it", () => {
  const polled = (exitCode: number): CodexMessage[] => [
    messages[0]!,
    messages[1]!,
    {
      role: "toolResult",
      toolCallId: "call_test",
      toolName: "exec_command",
      content: JSON.stringify({ session_id: 42, output: "Tests are still running" }),
      isError: false,
      timestamp: 3,
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_poll", name: "write_stdin", arguments: { session_id: 42, chars: "" } }],
      timestamp: 4,
    },
    {
      role: "toolResult",
      toolCallId: "call_poll",
      toolName: "write_stdin",
      content: JSON.stringify({ exit_code: exitCode, output: exitCode === 0 ? "2 pass\n0 fail" : "1 fail" }),
      isError: exitCode !== 0,
      timestamp: 5,
    },
  ];
  const completed = polled(0);
  const observations = buildCompactionEvidenceIndex(completed, "session-a");
  expect(observations).toHaveLength(1);
  expect(observations[0]?.toolName).toBe("write_stdin");
  expect(observations[0]?.ref).toBe("obs_f16f1f795aaadf5b9a45d589");
  expect(validateCompactionQuality(completed, checkpoint(observations[0]!.ref), {
    requireStructured: true,
    evidenceSessionId: "session-a",
  }).valid).toBeTrue();

  const failed = polled(1);
  const failedObservation = buildCompactionEvidenceIndex(failed, "session-a")[0]!;
  expect(failedObservation.status).toBe("failed");
  expect(validateCompactionQuality(failed, checkpoint(failedObservation.ref), {
    requireStructured: true,
    evidenceSessionId: "session-a",
  }).valid).toBeFalse();

  const contradictory = completed.map(message => message.role === "toolResult" && message.toolName === "write_stdin"
    ? { ...message, content: JSON.stringify({ exit_code: 0, output: "1 fail" }) }
    : message);
  expect(buildCompactionEvidenceIndex(contradictory, "session-a")[0]?.status).toBe("failed");

  const wrongSession = completed.map(message => message.role === "assistant"
    && message.content.some(part => part.type === "toolCall" && part.name === "write_stdin")
    ? { ...message, content: [{ type: "toolCall" as const, id: "call_poll", name: "write_stdin", arguments: { session_id: 43, chars: "" } }] }
    : message);
  const wrongObservation = buildCompactionEvidenceIndex(wrongSession, "session-a")[0]!;
  expect(wrongObservation.command).toBeUndefined();
  expect(validateCompactionQuality(wrongSession, checkpoint(wrongObservation.ref), {
    requireStructured: true,
    evidenceSessionId: "session-a",
  }).valid).toBeFalse();
});

test("conflicting execution envelopes cannot certify a completed test", () => {
  const conflicting = messages.map(message => message.role === "toolResult"
    ? { ...message, content: '{"exit_code":0,"output":"2 pass"}\n{"exit_code":-1,"timed_out":true}' }
    : message);
  expect(buildCompactionEvidenceIndex(conflicting, "session-a")).toEqual([]);
  const legacy = checkpoint("missing-ref").replace(',"evidenceRefs":["missing-ref"]', "");
  const verdict = validateCompactionQuality(conflicting, legacy, {
    requireStructured: true,
    evidenceSessionId: "session-a",
  });
  expect(verdict.valid).toBe(false);
});

test("codex_apply_patch can prove a file edit with a bound successful result", () => {
  const patch: CodexMessage[] = [
    { role: "user", content: "Edit src/a.ts", timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "call_patch", name: "codex_apply_patch", arguments: { patch: "*** Update File: src/a.ts" } }], timestamp: 2 },
    { role: "toolResult", toolCallId: "call_patch", toolName: "codex_apply_patch", content: "Success. Updated the following files:\nM src/a.ts", isError: false, timestamp: 3 },
  ];
  const ref = buildCompactionEvidenceIndex(patch, "session-a")[0]!.ref;
  const summary = checkpoint(ref)
    .replace("modified_files:\n", "modified_files:\n- src/a.ts\n")
    .replace("Verify bridge tests.", "Edit src/a.ts.")
    .replace("user turn 1: run bridge tests", "user turn 1: edit src/a.ts")
    .replace('"evidence":"2 pass"', '"evidence":"M src/a.ts"');
  expect(validateCompactionQuality(patch, summary, {
    requireStructured: true,
    evidenceSessionId: "session-a",
  }).valid).toBe(true);
});

test("a reference cannot borrow evidence from another result with the same call ID", () => {
  const duplicated: CodexMessage[] = [
    messages[0]!,
    messages[1]!,
    { role: "toolResult", toolCallId: "call_test", toolName: "exec_command", content: '{"exit_code":0,"output":"unrelated success"}', isError: false, timestamp: 3 },
    messages[2]!,
  ];
  const firstRef = buildCompactionEvidenceIndex(duplicated, "session-a")[0]!.ref;
  const verdict = validateCompactionQuality(duplicated, checkpoint(firstRef), {
    requireStructured: true,
    evidenceSessionId: "session-a",
  });
  expect(verdict.valid).toBe(false);
});

test("a referenced result uses its own command when call IDs are reused", () => {
  const reused: CodexMessage[] = [
    messages[0]!,
    messages[1]!,
    { role: "assistant", content: [{ type: "toolCall", id: "call_test", name: "exec_command", arguments: { cmd: "cat test-log.txt" } }], timestamp: 3 },
    { role: "toolResult", toolCallId: "call_test", toolName: "exec_command", content: '{"exit_code":0,"output":"2 pass"}', isError: false, timestamp: 4 },
  ];
  const ref = buildCompactionEvidenceIndex(reused, "session-a")[0]!.ref;
  expect(validateCompactionQuality(reused, checkpoint(ref), {
    requireStructured: true,
    evidenceSessionId: "session-a",
  }).valid).toBe(false);
});

test("identical output from reused IDs keeps distinct command references", () => {
  const reused: CodexMessage[] = [
    messages[0]!,
    messages[1]!,
    messages[2]!,
    { role: "assistant", content: [{ type: "toolCall", id: "call_test", name: "exec_command", arguments: { cmd: "cat test-log.txt" } }], timestamp: 4 },
    { ...messages[2]!, timestamp: 5 },
  ];
  const observations = buildCompactionEvidenceIndex(reused, "session-a");
  expect(observations).toHaveLength(2);
  expect(observations[0]!.ref).not.toBe(observations[1]!.ref);
});

test("repair selection recovers an old result relevant to a failed requirement", () => {
  const observations = [
    { ref: "obs_old", toolCallId: "old", toolName: "exec_command", status: "succeeded" as const, command: "bun test bridge.test.ts", excerpt: "2 pass" },
    ...Array.from({ length: 8 }, (_, index) => ({
      ref: `obs_recent_${index}`,
      toolCallId: `recent_${index}`,
      toolName: "exec_command",
      status: "succeeded" as const,
      command: `bun test unrelated-${index}.test.ts`,
      excerpt: "1 pass",
    })),
  ];
  const selected = selectCompactionRepairEvidence(observations, "REQ-1 bridge.test.ts has no completed observation", 4);
  expect(selected.map(item => item.ref)).toContain("obs_old");
});

test("handoff instruction supplies bridge-issued references to the model", () => {
  const observations = buildCompactionEvidenceIndex(messages, "session-a");
  const prompt = structuredCompactionHandoffInstruction(
    { token: "control_test", handoffId: "handoff_test" },
    observations,
  );
  expect(prompt).toContain(observations[0]!.ref);
  expect(prompt).toContain("2 pass");
});

test("structured achievements retain and validate their evidence references", () => {
  const ref = buildCompactionEvidenceIndex(messages, "session-a")[0]!.ref;
  const summary = checkpoint(ref).replace(
    "verified_achievements:\n",
    `verified_achievements:\n- ${JSON.stringify({ result: "Bridge tests passed", evidence: "2 pass", evidenceRefs: [ref] })}\n`,
  );
  expect(parseCompactionState(summary)?.verifiedAchievements).toEqual([
    { result: "Bridge tests passed", evidence: "2 pass", evidenceRefs: [ref] },
  ]);
  expect(validateCompactionQuality(messages, summary, {
    requireStructured: true,
    evidenceSessionId: "session-a",
  }).valid).toBe(true);
  expect(validateCompactionQuality(messages, summary, {
    requireStructured: true,
    evidenceSessionId: "session-b",
  }).valid).toBe(false);
});

test("an inherited checkpoint preserves its old claim without verifying a new claim", () => {
  const prior = `<compaction_state>
version: 2
original_request_ref: user turn 1
modified_files:
active_hypothesis: Continue bridge.
requirements:
- {"id":"REQ-OLD","status":"verified","source":"user turn 1: run old tests","evidence":"2 pass"}
closure_criteria:
- Tests pass
verified_achievements:
decisions_and_invariants:
blockers_or_test_failures:
- None
pending_obligations:
next_actions:
- Continue bridge
</compaction_state>`;
  const next = prior.replace(
    "closure_criteria:",
    '- {"id":"REQ-NEW","status":"verified","source":"user turn 2: run new tests","evidence":"2 pass"}\nclosure_criteria:',
  );
  const source: CodexMessage[] = [
    { role: "user", origin: "compaction_summary", content: prior, timestamp: 1 },
    { role: "user", content: "Run new tests", timestamp: 2 },
  ];
  expect(validateCompactionQuality(source, prior, { requireStructured: true }).valid).toBe(true);
  const verdict = validateCompactionQuality(source, next, { requireStructured: true });
  expect(verdict.valid).toBe(false);
  expect(verdict.missingInvariants).toContain("Verified requirement REQ-NEW has no completed observation");
});

test("an unchanged legacy achievement survives inheritance without proving a new one", () => {
  const prior = `<compaction_state>
version: 2
original_request_ref: user turn 1
modified_files:
active_hypothesis: Continue bridge.
requirements:
- {"id":"REQ-1","status":"pending","source":"user turn 1: bridge"}
closure_criteria:
- Bridge works
verified_achievements:
- Bridge tests passed — evidence: 2 tests passed
decisions_and_invariants:
blockers_or_test_failures:
- None
pending_obligations:
- Continue bridge
next_actions:
- Continue bridge
</compaction_state>`;
  const source: CodexMessage[] = [{ role: "user", origin: "compaction_summary", content: prior, timestamp: 1 }];
  expect(validateCompactionQuality(source, prior, { requireStructured: true }).valid).toBe(true);
  const invented = prior.replace("Bridge tests passed", "New tests passed");
  expect(validateCompactionQuality(source, invented, { requireStructured: true }).valid).toBe(false);
});
