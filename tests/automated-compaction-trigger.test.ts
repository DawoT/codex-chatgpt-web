import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CodexMessage } from "../src/types";
import {
  evaluateAutonomousCompactionNeeded,
  saveTurnCheckpoint,
  listTurnCheckpoints,
  validateCompactionQuality,
  mergeCompactionIntoWorkspaceState,
  type TurnCheckpoint,
  type AutonomousCompactionContext,
} from "../src/adapters/chatgpt-web/autonomous-compaction";
import {
  readWorkspaceState,
  writeWorkspaceState,
  defaultWorkspaceState,
} from "../src/adapters/chatgpt-web/workspace-state";

describe("Sprint Y: Autonomous Memory Compaction & Turn Checkpoints", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cgw-sprint-y-test-"));
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("evaluateAutonomousCompactionNeeded", () => {
    it("returns false when context pressure and turn count are within safe bounds", () => {
      const context: AutonomousCompactionContext = {
        turnCount: 5,
        estimatedTokens: 30_000,
        capacityTokens: 100_000,
        consecutiveUncompactedTurns: 5,
      };
      expect(evaluateAutonomousCompactionNeeded(context)).toBe(false);
    });

    it("allows a viable 86% payload without mission growth samples", () => {
      const context: AutonomousCompactionContext = {
        turnCount: 10,
        estimatedTokens: 86_000,
        capacityTokens: 100_000,
        consecutiveUncompactedTurns: 10,
      };
      expect(evaluateAutonomousCompactionNeeded(context)).toBe(false);
    });

    it("does not compact solely because twenty turns elapsed", () => {
      const context: AutonomousCompactionContext = {
        turnCount: 22,
        estimatedTokens: 40_000,
        capacityTokens: 100_000,
        consecutiveUncompactedTurns: 20,
      };
      expect(evaluateAutonomousCompactionNeeded(context)).toBe(false);
    });

    it("reserves measured growth when mission requirements remain pending", () => {
      const context: AutonomousCompactionContext = {
        turnCount: 10,
        estimatedTokens: 80_000,
        capacityTokens: 100_000,
        requirements: [{ id: "REQ-1", status: "pending", source: "user turn 1" }],
        growthSamples: [16_000],
      };
      expect(evaluateAutonomousCompactionNeeded(context)).toBe(true);
    });

    it("triggers compaction when actionRequired is trigger_compaction", () => {
      const context: AutonomousCompactionContext = {
        turnCount: 8,
        estimatedTokens: 50_000,
        capacityTokens: 100_000,
        actionRequired: "trigger_compaction",
      };
      expect(evaluateAutonomousCompactionNeeded(context)).toBe(true);
    });
  });

  describe("saveTurnCheckpoint and listTurnCheckpoints", () => {
    it("atomically saves checkpoint JSON file under .agents/checkpoints/", () => {
      const checkpoint: Omit<TurnCheckpoint, "timestamp"> = {
        epoch: 1,
        turnCount: 15,
        stateSnapshot: defaultWorkspaceState(),
        compactSummary: "Sprint T & U successfully completed with state retention.",
        prunedFileReferences: ["src/adapters/chatgpt-web/tool-spooler.ts"],
      };

      const filePath = saveTurnCheckpoint(testDir, checkpoint);
      expect(existsSync(filePath)).toBe(true);

      const content = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(content.epoch).toBe(1);
      expect(content.turnCount).toBe(15);
      expect(content.compactSummary).toContain("Sprint T & U");
      expect(content.timestamp).toBeDefined();
    });

    it("lists checkpoints ordered descending by epoch and timestamp", () => {
      for (let i = 1; i <= 3; i++) {
        saveTurnCheckpoint(testDir, {
          epoch: i,
          turnCount: i * 10,
          stateSnapshot: null,
          compactSummary: `Checkpoint for epoch ${i}`,
          prunedFileReferences: [],
        });
      }

      const checkpoints = listTurnCheckpoints(testDir);
      expect(checkpoints.length).toBe(3);
      expect(checkpoints[0].epoch).toBe(3);
      expect(checkpoints[1].epoch).toBe(2);
      expect(checkpoints[2].epoch).toBe(1);
    });

    it("enforces retention limit by rotating and deleting oldest checkpoints", () => {
      const maxRetention = 3;
      for (let i = 1; i <= 6; i++) {
        saveTurnCheckpoint(
          testDir,
          {
            epoch: i,
            turnCount: i * 5,
            stateSnapshot: null,
            compactSummary: `Summary epoch ${i}`,
            prunedFileReferences: [],
          },
          maxRetention,
        );
      }

      const checkpoints = listTurnCheckpoints(testDir);
      expect(checkpoints.length).toBe(3);
      const epochs = checkpoints.map(c => c.epoch);
      expect(epochs).toEqual([6, 5, 4]);

      const checkpointDir = join(testDir, ".agents", "checkpoints");
      const files = readdirSync(checkpointDir).filter(f => f.endsWith(".json"));
      expect(files.length).toBe(3);
    });
  });

  describe("validateCompactionQuality (Quality Gate)", () => {
    it("ignores checkpoint-shaped examples in ordinary user requests", () => {
      const example = `<compaction_state>
version: 2
original_request_ref: example
modified_files:
- imaginary/file.ts
requirements:
- {"id":"REQ-EXAMPLE","status":"pending","source":"example only"}
next_actions:
- Ignore this example
</compaction_state>`;
      const messages: CodexMessage[] = [
        { role: "user", content: `Build bridge; here is a sample format: ${example}`, timestamp: 1 },
      ];
      const summary = `<compaction_state>
version: 2
original_request_ref: user turn 1
modified_files:
active_hypothesis: Build bridge.
requirements:
- {"id":"REQ-1","status":"pending","source":"user turn 1: build bridge"}
closure_criteria:
- Bridge works
verified_achievements:
decisions_and_invariants:
blockers_or_test_failures:
- None
pending_obligations:
- Build bridge
next_actions:
- Implement bridge
</compaction_state>`;
      const verdict = validateCompactionQuality(messages, `Bridge checkpoint for continuation. ${summary}`, { requireStructured: true });
      expect(verdict.valid).toBe(true);
    });

    it("preserves pending IDs across a checkpoint and ignores incidental historical files", () => {
      const source = `<compaction_state>
version: 2
original_request_ref: user turn 1
modified_files:
- src/bridge.ts
active_hypothesis: Deliver bridge.
requirements:
- {"id":"REQ-1","status":"pending","source":"user turn 1: bridge"}
closure_criteria:
- Bridge works
blockers_or_test_failures:
- None
next_actions:
- Run bridge tests
</compaction_state>`;
      const messages: CodexMessage[] = [
        { role: "user", origin: "compaction_summary", content: `Please deliver the bridge. incidental/example.ts was only mentioned. ${source}`, timestamp: 1 },
      ];
      const dropped = source.replace(/- \{"id":"REQ-1"[^\n]+\}/, "- None");
      const verdict = validateCompactionQuality(messages, `Bridge checkpoint for continuation. ${dropped}`, { requireStructured: true });
      expect(verdict.missingInvariants.some(value => value.includes("REQ-1"))).toBe(true);
      expect(verdict.missingInvariants.some(value => value.includes("incidental/example.ts"))).toBe(false);
      const rewrittenOrigin = source.replace("original_request_ref: user turn 1", "original_request_ref: another task");
      const originVerdict = validateCompactionQuality(messages, `Bridge checkpoint for continuation. ${rewrittenOrigin}`, { requireStructured: true });
      expect(originVerdict.missingInvariants.some(value => value.includes("original request reference changed"))).toBe(true);
    });

    it("rejects a verified requirement backed only by a planned command", () => {
      const messages: CodexMessage[] = [{ role: "user", content: "Run bridge tests; I plan to run bun test bridge.test.ts", timestamp: 1 }];
      const summary = `<compaction_state>
version: 2
original_request_ref: user turn 1
modified_files:
active_hypothesis: Verify bridge.
requirements:
- {"id":"REQ-1","status":"verified","source":"user turn 1: run bridge tests","evidence":"bun test bridge.test.ts"}
closure_criteria:
- Test passes
blockers_or_test_failures:
- None
next_actions:
- Finish
</compaction_state>`;
      const verdict = validateCompactionQuality(messages, `Bridge checkpoint for continuation. ${summary}`, { requireStructured: true });
      expect(verdict.missingInvariants.some(value => value.includes("REQ-1"))).toBe(true);
    });

    it("rejects malformed checklist field types without throwing", () => {
      const messages: CodexMessage[] = [{ role: "user", content: "Run bridge tests", timestamp: 1 }];
      const summary = `<compaction_state>
version: 2
original_request_ref: user turn 1
modified_files:
active_hypothesis: Verify bridge.
requirements:
- {"id":"REQ-1","status":"pending","source":2}
closure_criteria:
- Bridge tests pass
verified_achievements:
decisions_and_invariants:
blockers_or_test_failures:
- None
pending_obligations:
- Run bridge tests
next_actions:
- Run bridge tests
</compaction_state>`;
      const verdict = validateCompactionQuality(messages, `Bridge checkpoint for continuation. ${summary}`, { requireStructured: true });
      expect(verdict.valid).toBe(false);
      expect(verdict.missingInvariants.some(value => value.includes("source"))).toBe(true);
      const malformedEvidence = summary.replace('"status":"pending","source":2', '"status":"verified","source":"user turn 1: run tests","evidence":2');
      const evidenceVerdict = validateCompactionQuality(messages, `Bridge checkpoint for continuation. ${malformedEvidence}`, { requireStructured: true });
      expect(evidenceVerdict.valid).toBe(false);
      expect(evidenceVerdict.missingInvariants.some(value => value.includes("evidence"))).toBe(true);
    });

    it("does not treat a successful file read containing test output as execution evidence", () => {
      const messages: CodexMessage[] = [
        { role: "user", content: "Run bridge tests", timestamp: 1 },
        { role: "toolResult", toolCallId: "call_read", toolName: "read_file", content: "bun test bridge.test.ts: 2 pass", isError: false, timestamp: 2 },
      ];
      const summary = `<compaction_state>
version: 2
original_request_ref: user turn 1
modified_files:
active_hypothesis: Verify bridge.
requirements:
- {"id":"REQ-1","status":"verified","source":"user turn 1: run bridge tests","evidence":"bun test bridge.test.ts: 2 pass"}
closure_criteria:
- Bridge tests pass
verified_achievements:
decisions_and_invariants:
blockers_or_test_failures:
- None
pending_obligations:
next_actions:
- Report result
</compaction_state>`;
      const verdict = validateCompactionQuality(messages, `Bridge checkpoint for continuation. ${summary}`, { requireStructured: true });
      expect(verdict.valid).toBe(false);
      expect(verdict.missingInvariants.some(value => value.includes("completed observation"))).toBe(true);
      const shellRead: CodexMessage[] = [
        messages[0]!,
        { role: "assistant", content: [{ type: "toolCall", id: "call_read", name: "exec_command", arguments: { cmd: "cat test-output.log" } }], timestamp: 2 },
        { role: "toolResult", toolCallId: "call_read", toolName: "exec_command", content: "bun test bridge.test.ts: 2 pass", isError: false, timestamp: 3 },
      ];
      const shellVerdict = validateCompactionQuality(shellRead, `Bridge checkpoint for continuation. ${summary}`, { requireStructured: true });
      expect(shellVerdict.valid).toBe(false);
      const outputOnly = summary.replaceAll("bun test bridge.test.ts: 2 pass", "2 pass");
      const readOutputOnly: CodexMessage[] = [
        shellRead[0]!,
        shellRead[1]!,
        { role: "toolResult", toolCallId: "call_read", toolName: "exec_command", content: "2 pass", isError: false, timestamp: 3 },
      ];
      expect(validateCompactionQuality(readOutputOnly, `Bridge checkpoint for continuation. ${outputOnly}`, { requireStructured: true }).valid).toBe(false);
      const echoedOutput: CodexMessage[] = [
        readOutputOnly[0]!,
        { role: "assistant", content: [{ type: "toolCall", id: "call_read", name: "exec_command", arguments: { cmd: "echo 'bun test bridge.test.ts: 2 pass'" } }], timestamp: 2 },
        { role: "toolResult", toolCallId: "call_read", toolName: "exec_command", content: '{"exit_code":0,"output":"2 pass"}', isError: false, timestamp: 3 },
      ];
      expect(validateCompactionQuality(echoedOutput, `Bridge checkpoint for continuation. ${outputOnly}`, { requireStructured: true }).valid).toBe(false);
    });

    it("preserves files changed by a successful patch on the first checkpoint", () => {
      const messages: CodexMessage[] = [
        { role: "user", content: "Fix the bridge", timestamp: 1 },
        { role: "toolResult", toolCallId: "call_patch", toolName: "apply_patch", content: "Success. Updated the following files:\nM src/bridge.ts", isError: false, timestamp: 2 },
      ];
      const summary = `<compaction_state>
version: 2
original_request_ref: user turn 1
modified_files:
active_hypothesis: Fix the bridge.
requirements:
- {"id":"REQ-1","status":"pending","source":"user turn 1: fix the bridge"}
closure_criteria:
- Bridge fixed
verified_achievements:
decisions_and_invariants:
blockers_or_test_failures:
- None
pending_obligations:
- Fix the bridge
next_actions:
- Run bridge tests
</compaction_state>`;
      const verdict = validateCompactionQuality(messages, `Bridge checkpoint for continuation. ${summary}`, { requireStructured: true });
      expect(verdict.valid).toBe(false);
      expect(verdict.missingInvariants.some(value => value.includes("src/bridge.ts"))).toBe(true);
      const spacedMessages: CodexMessage[] = [
        messages[0]!,
        { role: "toolResult", toolCallId: "call_patch", toolName: "apply_patch", content: "Success. Updated the following files:\nM src/My Bridge.ts", isError: false, timestamp: 2 },
      ];
      expect(validateCompactionQuality(spacedMessages, `Bridge checkpoint for continuation. ${summary}`, { requireStructured: true })
        .missingInvariants.some(value => value.includes("src/My Bridge.ts"))).toBe(true);
    });

    it("accepts a verified file edit only with a matching successful patch result", () => {
      const patchResult = "Success. Updated the following files:\nM src/bridge.ts";
      const messages: CodexMessage[] = [
        { role: "user", content: "Edit src/bridge.ts", timestamp: 1 },
        { role: "assistant", content: [{ type: "toolCall", id: "call_patch", name: "apply_patch", arguments: { patch: "*** Update File: src/bridge.ts" } }], timestamp: 2 },
        { role: "toolResult", toolCallId: "call_patch", toolName: "apply_patch", content: patchResult, isError: false, timestamp: 3 },
      ];
      const summary = `<compaction_state>
version: 2
original_request_ref: user turn 1
modified_files:
- src/bridge.ts
active_hypothesis: Edit the bridge.
requirements:
- ${JSON.stringify({ id: "REQ-1", status: "verified", source: "user turn 1: edit src/bridge.ts", evidence: "M src/bridge.ts" })}
closure_criteria:
- File edit applied
verified_achievements:
decisions_and_invariants:
blockers_or_test_failures:
- None
pending_obligations:
next_actions:
- Verify the result
</compaction_state>`;
      expect(validateCompactionQuality(messages, summary, { requireStructured: true }).valid).toBe(true);
      const testFileMessages: CodexMessage[] = [
        { role: "user", content: "Edit src/bridge.test.ts", timestamp: 1 },
        { role: "assistant", content: [{ type: "toolCall", id: "call_patch", name: "apply_patch", arguments: { patch: "*** Update File: src/bridge.test.ts" } }], timestamp: 2 },
        { role: "toolResult", toolCallId: "call_patch", toolName: "apply_patch", content: patchResult.replaceAll("src/bridge.ts", "src/bridge.test.ts"), isError: false, timestamp: 3 },
      ];
      expect(validateCompactionQuality(testFileMessages,
        summary.replaceAll("src/bridge.ts", "src/bridge.test.ts"), { requireStructured: true }).valid).toBe(true);
      const unbound = messages.filter(message => message.role !== "assistant");
      expect(validateCompactionQuality(unbound, summary, { requireStructured: true }).valid).toBe(false);
      const failed = messages.map(message => message.role === "toolResult"
        ? { ...message, isError: true } : message);
      expect(validateCompactionQuality(failed, summary, { requireStructured: true }).valid).toBe(false);
    });

    it("does not promote an echoed deployment claim to a verified requirement", () => {
      const checkpoint = `<compaction_state>
version: 2
original_request_ref: user turn 1
modified_files:
active_hypothesis: Deploy the bridge.
requirements:
- {"id":"REQ-1","status":"verified","source":"user turn 1: deploy the bridge","evidence":"deployed to staging"}
closure_criteria:
- Staging deployment completed
verified_achievements:
decisions_and_invariants:
blockers_or_test_failures:
- None
pending_obligations:
next_actions:
- Report deployment
</compaction_state>`;
      const toolResult = {
        role: "toolResult" as const,
        toolCallId: "call_deploy",
        toolName: "exec_command",
        content: '{"exit_code":0,"output":"deployed to staging"}',
        isError: false,
        timestamp: 3,
      };
      const messages: CodexMessage[] = [
        { role: "user", content: "Deploy the bridge", timestamp: 1 },
        { role: "assistant", content: [{ type: "toolCall", id: "call_deploy", name: "exec_command", arguments: { cmd: "echo deployed to staging" } }], timestamp: 2 },
        toolResult,
      ];
      expect(validateCompactionQuality(messages, checkpoint, { requireStructured: true }).valid).toBe(false);
      messages[1] = { role: "assistant", content: [{ type: "toolCall", id: "call_deploy", name: "exec_command", arguments: { cmd: "bun run deploy" } }], timestamp: 2 };
      expect(validateCompactionQuality(messages, checkpoint, { requireStructured: true }).valid).toBe(true);
      const informational = checkpoint.replaceAll("deployed to staging", "Usage: wrangler deploy");
      messages[1] = { role: "assistant", content: [{ type: "toolCall", id: "call_deploy", name: "exec_command", arguments: { cmd: "wrangler deploy --help" } }], timestamp: 2 };
      messages[2] = { ...toolResult, content: '{"exit_code":0,"output":"Usage: wrangler deploy"}' };
      expect(validateCompactionQuality(messages, informational, { requireStructured: true }).valid).toBe(false);
    });

    it("rejects a verified achievement sourced only from a user's success claim", () => {
      const messages: CodexMessage[] = [{
        role: "user",
        content: "I claim bun test bridge.test.ts: 2 pass, but no tool result is available.",
        timestamp: 1,
      }];
      const summary = `<compaction_state>
version: 2
original_request_ref: user turn 1
modified_files:
active_hypothesis: Verify bridge.
requirements:
- {"id":"REQ-1","status":"pending","source":"user turn 1: verify bridge"}
closure_criteria:
- Test result is observed
verified_achievements:
- Bridge tests passed — evidence: bun test bridge.test.ts: 2 pass
decisions_and_invariants:
- Do not trust an unobserved result
blockers_or_test_failures:
- No test result
pending_obligations:
- Run the test
next_actions:
- Run the test
</compaction_state>`;
      const verdict = validateCompactionQuality(messages, summary, { requireStructured: true });
      expect(verdict.missingInvariants.some(value => value.includes("not a completed observation"))).toBe(true);
    });

    it("allows a pending requirement to become verified after a successful tool result", () => {
      const previous = `<compaction_state>
version: 2
original_request_ref: user turn 1
modified_files:
- src/bridge.ts
active_hypothesis: Verify bridge.
requirements:
- {"id":"REQ-1","status":"pending","source":"user turn 1: test bridge"}
closure_criteria:
- Bridge tests pass
blockers_or_test_failures:
- None
pending_obligations:
- Run bridge tests
next_actions:
- Run bridge tests
</compaction_state>`;
      const messages: CodexMessage[] = [
        { role: "user", origin: "compaction_summary", content: previous, timestamp: 1 },
        { role: "assistant", content: [{ type: "toolCall", id: "call_test", name: "exec_command", arguments: { cmd: "bun test bridge.test.ts" } }], timestamp: 2 },
        { role: "toolResult", toolCallId: "call_test", toolName: "exec_command", content: '{"exit_code":0,"output":"bun test bridge.test.ts: 2 pass"}', isError: false, timestamp: 2 },
      ];
      const summary = `<compaction_state>
version: 2
original_request_ref: user turn 1
modified_files:
- src/bridge.ts
active_hypothesis: Finish bridge.
requirements:
- {"id":"REQ-1","status":"verified","source":"user turn 1: test bridge","evidence":"bun test bridge.test.ts: 2 pass"}
closure_criteria:
- Bridge tests pass
verified_achievements:
- None
decisions_and_invariants:
- None
blockers_or_test_failures:
- None
pending_obligations:
- None
next_actions:
- Report completion
</compaction_state>`;
      const verdict = validateCompactionQuality(messages, summary, { requireStructured: true });
      expect(verdict.missingInvariants).toEqual([]);
      for (const command of [
        "cd workspace && bun test bridge.test.ts",
        "env CI=1 bun test bridge.test.ts",
        "timeout 120 bun test bridge.test.ts",
      ]) {
        const prefixedMessages: CodexMessage[] = [
          messages[0]!,
          { role: "assistant", content: [{ type: "toolCall", id: "call_test", name: "exec_command", arguments: { cmd: command } }], timestamp: 2 },
          messages[2]!,
        ];
        expect(validateCompactionQuality(prefixedMessages, summary, { requireStructured: true }).valid).toBe(true);
      }
      const streamedMessages: CodexMessage[] = [
        messages[0]!,
        messages[1]!,
        { role: "toolResult", toolCallId: "call_test", toolName: "exec_command", content: '{"session_id":42}', isError: false, timestamp: 2 },
        { role: "assistant", content: [{ type: "toolCall", id: "call_poll", name: "write_stdin", arguments: { session_id: 42, chars: "" } }], timestamp: 3 },
        { role: "toolResult", toolCallId: "call_poll", toolName: "write_stdin", content: '{"exit_code":0,"output":"bun test bridge.test.ts: 2 pass"}', isError: false, timestamp: 4 },
      ];
      expect(validateCompactionQuality(streamedMessages, summary, { requireStructured: true }).valid).toBe(true);
      const partialMessages: CodexMessage[] = [
        ...streamedMessages.slice(0, -1),
        { role: "toolResult", toolCallId: "call_poll", toolName: "write_stdin", content: "bun test bridge.test.ts: 2 pass", isError: false, timestamp: 4 },
      ];
      expect(validateCompactionQuality(partialMessages, summary, { requireStructured: true }).valid).toBe(false);
      const unfinishedMessages: CodexMessage[] = [
        messages[0]!,
        messages[1]!,
        { role: "toolResult", toolCallId: "call_test", toolName: "exec_command", content: '{"session_id":42,"output":"bun test bridge.test.ts: 2 pass"}', isError: false, timestamp: 2 },
      ];
      expect(validateCompactionQuality(unfinishedMessages, summary, { requireStructured: true }).valid).toBe(false);
    });

    it("fails validation if summary is empty or too brief", () => {
      const messages: CodexMessage[] = [
        { role: "user", content: "Implement spooling in src/adapters/tool-spooler.ts", timestamp: 1000 },
      ];
      const result = validateCompactionQuality(messages, "Done.");
      expect(result.valid).toBe(false);
      expect(result.missingInvariants).toContain("Summary is too short or empty (minimum 50 chars required)");
    });

    it("fails validation if critical files modified in conversation are omitted in summary", () => {
      const messages: CodexMessage[] = [
        {
          role: "user",
          content: "Modify src/adapters/chatgpt-web/tool-spooler.ts and tests/tool-spooler.test.ts to support head/tail.",
          timestamp: 1001,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "I have edited src/adapters/chatgpt-web/tool-spooler.ts with spooling logic." }],
          timestamp: 1002,
        },
      ];

      const incompleteSummary =
        "The conversation completed work on some tool output features, but doesn't mention which files were modified.";

      const result = validateCompactionQuality(messages, incompleteSummary);
      expect(result.valid).toBe(false);
      expect(result.missingInvariants.some(inv => inv.includes("tool-spooler.ts"))).toBe(true);
    });

    it("passes validation when summary accurately references all key files and decisions", () => {
      const messages: CodexMessage[] = [
        {
          role: "user",
          content: "Update src/adapters/chatgpt-web/tool-spooler.ts and tests/tool-output-spooler.test.ts",
          timestamp: 1003,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Completed editing src/adapters/chatgpt-web/tool-spooler.ts with head/tail offload." }],
          timestamp: 1004,
        },
      ];

      const robustSummary =
        "Successfully updated src/adapters/chatgpt-web/tool-spooler.ts with head/tail offload and added coverage in tests/tool-output-spooler.test.ts passing 100%.";

      const result = validateCompactionQuality(messages, robustSummary);
      expect(result.valid).toBe(true);
      expect(result.missingInvariants).toEqual([]);
      expect(result.detectedFiles).toContain("src/adapters/chatgpt-web/tool-spooler.ts");
    });

    it("rejects structured achievements that lack observable evidence", () => {
      const messages: CodexMessage[] = [
        { role: "user", content: "Fix bridge delivery and keep the failed timeout visible", timestamp: 1000 },
      ];
      const summary = `Bridge delivery work is summarized for continuation with enough narrative detail.

<compaction_state>
modified_files:
- src/adapters/chatgpt-web/turn-progress.ts
active_hypothesis: Bound browser observation before Codex emission.
verified_achievements:
- Fixed the delivery timeout
decisions_and_invariants:
- Never emit before browser observation
blockers_or_test_failures:
- Timeout regression remains to be verified
pending_obligations:
- Run the focused timeout test
next_actions:
- Run the focused timeout test
</compaction_state>`;

      const result = validateCompactionQuality(messages, summary);

      expect(result.valid).toBe(false);
      expect(result.missingInvariants).toContain(
        "Verified achievement lacks observable evidence: Fixed the delivery timeout",
      );
    });

    it("rejects invented evidence and dropped checkpoint obligations", () => {
      const messages: CodexMessage[] = [{
        role: "user",
        origin: "compaction_summary",
        content: `Continue the bridge work. bun test timeout.test.ts: 2 pass.
<compaction_state>
modified_files:
- src/bridge.ts
active_hypothesis: Repair delivery.
verified_achievements:
- Timeout test passed — evidence: bun test timeout.test.ts: 2 pass
decisions_and_invariants:
- Preserve call IDs across replay
blockers_or_test_failures:
- DOM rebind has not been tested
pending_obligations:
- Run cancellation E2E
next_actions:
- Run cancellation E2E
</compaction_state>`,
        timestamp: 1000,
      }];
      const summary = `Continue work on src/bridge.ts after the timeout test.
<compaction_state>
modified_files:
- src/bridge.ts
active_hypothesis: Repair delivery.
verified_achievements:
- E2E passed — evidence: bun test e2e.test.ts: 2 pass
decisions_and_invariants:
- Preserve call IDs across replay
blockers_or_test_failures:
- None
pending_obligations:
- None
next_actions:
- Finish
</compaction_state>`;

      const verdict = validateCompactionQuality(messages, summary);
      expect(verdict.valid).toBe(false);
      expect(verdict.missingInvariants.some(value => value.includes("not present in source"))).toBe(true);
      expect(verdict.missingInvariants.some(value => value.includes("DOM rebind"))).toBe(true);
      expect(verdict.missingInvariants.some(value => value.includes("cancellation E2E"))).toBe(true);
    });

    it("requires a structured mission checkpoint when it is going to replace history", () => {
      const messages: CodexMessage[] = [{ role: "user", content: "Continue delivery work", timestamp: 1 }];
      const verdict = validateCompactionQuality(
        messages,
        "Delivery work is ongoing and the next step is to run the cancellation test.",
        { requireStructured: true },
      );

      expect(verdict.valid).toBe(false);
      expect(verdict.missingInvariants).toContain("Missing structured compaction state");
    });

    it("does not treat checkpoint tags quoted in the original-request appendix as generated state", () => {
      const original = "Investigate <compaction_state> and </compaction_state> tags";
      const messages: CodexMessage[] = [{ role: "user", content: original, timestamp: 1 }];
      const summary = [
        "ChatGPT returned only a narrative about the ongoing investigation and no mission checklist.",
        "",
        "CODEX_ORIGINAL_USER_REQUEST_JSON",
        JSON.stringify({ sha256: createHash("sha256").update(original).digest("hex"), text: original }),
        "",
        "CODEX_LATEST_USER_PROMPT_JSON",
        JSON.stringify(original),
      ].join("\n");

      const verdict = validateCompactionQuality(messages, summary, { requireStructured: true });
      expect(verdict.valid).toBe(false);
      expect(verdict.missingInvariants).toContain("Missing structured compaction state");
    });

    it("does not count a trusted appendix toward the generated draft's minimum length", () => {
      const original = "Continue work on src/foo.ts and preserve every outstanding obligation.";
      const summary = [
        "Done.",
        "",
        "CODEX_ORIGINAL_USER_REQUEST_JSON",
        JSON.stringify({ sha256: createHash("sha256").update(original).digest("hex"), text: original }),
        "",
        "CODEX_LATEST_USER_PROMPT_JSON",
        JSON.stringify(original),
      ].join("\n");

      const verdict = validateCompactionQuality(
        [{ role: "user", content: original, timestamp: 1 }],
        summary,
      );
      expect(verdict.valid).toBe(false);
      expect(verdict.missingInvariants[0]).toContain("Summary is too short");
    });

    it("does not satisfy a legacy file reference using only the original-request appendix", () => {
      const original = "Continue work on src/foo.ts and preserve every outstanding obligation.";
      const summary = [
        "The mission remains open. Inspect the implementation and run the relevant tests before closing it.",
        "",
        "CODEX_ORIGINAL_USER_REQUEST_JSON",
        JSON.stringify({ sha256: createHash("sha256").update(original).digest("hex"), text: original }),
        "",
        "CODEX_LATEST_USER_PROMPT_JSON",
        JSON.stringify(original),
      ].join("\n");

      const verdict = validateCompactionQuality(
        [{ role: "user", content: original, timestamp: 1 }],
        summary,
      );
      expect(verdict.valid).toBe(false);
      expect(verdict.missingInvariants).toContain("Missing reference to modified or referenced file: src/foo.ts");
    });

    it("does not promote a planned command into a verified achievement", () => {
      const messages: CodexMessage[] = [
        { role: "user", content: "Run bun test timeout.test.ts and report the result", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "I will run bun test timeout.test.ts" }], timestamp: 2 },
      ];
      const summary = `Continue the delivery task after checking the test outcome.
<compaction_state>
modified_files:
active_hypothesis: Repair delivery.
verified_achievements:
- Timeout test passed — evidence: bun test timeout.test.ts
decisions_and_invariants:
blockers_or_test_failures:
- None
pending_obligations:
- Continue the delivery task
next_actions:
- Inspect the test result
</compaction_state>`;

      const verdict = validateCompactionQuality(messages, summary, { requireStructured: true });
      expect(verdict.valid).toBe(false);
      expect(verdict.missingInvariants.some(value => value.includes("not a completed observation"))).toBe(true);
    });

    it("requires explicit blocker and obligation sections in a replacement checkpoint", () => {
      const messages: CodexMessage[] = [{ role: "user", content: "Continue the task", timestamp: 1 }];
      const summary = `Continue the task using the current mission state.
<compaction_state>
modified_files:
active_hypothesis: Continue the task.
verified_achievements:
decisions_and_invariants:
next_actions:
- Inspect current state
</compaction_state>`;

      const verdict = validateCompactionQuality(messages, summary, { requireStructured: true });
      expect(verdict.valid).toBe(false);
      expect(verdict.missingInvariants).toContain("Missing blockers_or_test_failures section");
      expect(verdict.missingInvariants).toContain("Missing pending_obligations section");
    });
  });

  describe("mergeCompactionIntoWorkspaceState", () => {
    it("merges new milestones into .agents/STATE.md without losing prior completed items", () => {
      const initialState = defaultWorkspaceState();
      initialState.goal = "Build robust ChatGPT Web MCP harness";
      initialState.activePhase = "Sprint U";
      initialState.completedMilestones = ["Sprint T: Tool Output Spooler"];
      initialState.invariantsAndDecisions = ["Preserve canonical 9 MCP tools"];

      writeWorkspaceState(testDir, initialState);

      const summary = "Completed Sprint U persistent state in .agents/STATE.md.";
      const newMilestones = ["Sprint U: Persistent Workspace State (.agents/STATE.md)"];

      const updatedState = mergeCompactionIntoWorkspaceState(testDir, summary, newMilestones);

      expect(updatedState.completedMilestones).toContain("Sprint T: Tool Output Spooler");
      expect(updatedState.completedMilestones).toContain("Sprint U: Persistent Workspace State (.agents/STATE.md)");
      expect(updatedState.invariantsAndDecisions).toContain("Preserve canonical 9 MCP tools");

      // Verify re-reading from disk reflects the merged state
      const reloaded = readWorkspaceState(testDir);
      expect(reloaded).not.toBeNull();
      expect(reloaded?.completedMilestones.length).toBe(2);
    });

    it("does not insert duplicate milestones if already present", () => {
      const initialState = defaultWorkspaceState();
      initialState.completedMilestones = ["Sprint T: Spooler"];
      writeWorkspaceState(testDir, initialState);

      const updatedState = mergeCompactionIntoWorkspaceState(
        testDir,
        "Finished additional work",
        ["Sprint T: Spooler", "Sprint V: Lazy Skills"],
      );

      expect(updatedState.completedMilestones.length).toBe(2);
      expect(updatedState.completedMilestones).toEqual(["Sprint T: Spooler", "Sprint V: Lazy Skills"]);
    });
  });
});
