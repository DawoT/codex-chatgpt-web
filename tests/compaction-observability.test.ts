import { expect, spyOn, test } from "bun:test";
import {
  checkpointIssueCodes,
  checkpointStructuralDiagnostic,
  logCompactionEvent,
} from "../src/adapters/chatgpt-web/compaction-observability";

test("canary events are structured, correlated, build identified and bounded", () => {
  const lines: string[] = [];
  const logger = spyOn(console, "info").mockImplementation((line) => {
    lines.push(String(line));
  });
  try {
    logCompactionEvent({
      traceId: "abc123def456",
      handoffTraceId: "def456abc123",
      phase: "validated",
      outcome: "rejected",
      route: "fallback",
      attempt: 1,
      elapsedMs: 123,
      reasonCode: "context_checkpoint_validation_failed",
      issueCodes: checkpointIssueCodes([
        "Missing modified file from successful patch: /private/customer/project.ts",
        "Duplicate requirement ID: SECRET-123",
      ]),
    });
  } finally {
    logger.mockRestore();
  }
  expect(lines).toHaveLength(1);
  expect(lines[0]).toStartWith("[chatgpt-web] compaction_event ");
  const event = JSON.parse(lines[0]!.slice("[chatgpt-web] compaction_event ".length));
  expect(event).toMatchObject({
    schemaVersion: 1,
    traceId: "abc123def456",
    handoffTraceId: "def456abc123",
    phase: "validated",
    outcome: "rejected",
    route: "fallback",
    attempt: 1,
    elapsedMs: 123,
    reasonCode: "context_checkpoint_validation_failed",
    issueCodes: ["missing_modified_file", "duplicate_requirement_id"],
    runtime: {
      protocolVersion: expect.any(Number),
      generation: expect.any(String),
      pid: expect.any(Number),
    },
  });
  expect(lines[0]).not.toContain("/private/customer");
  expect(lines[0]).not.toContain("SECRET-123");
});

test("unknown diagnostic text is reduced to an allowlisted code", () => {
  expect(checkpointIssueCodes(["secret prompt: sk-123"])).toEqual(["other_validation_issue"]);
  const lines: string[] = [];
  const logger = spyOn(console, "info").mockImplementation((line) => {
    lines.push(String(line));
  });
  try {
    logCompactionEvent({
      traceId: "abc123def456",
      phase: "failed",
      outcome: "failed",
      route: "unknown",
      issueCodes: ["/private/secret/customer.ts"],
    });
  } finally {
    logger.mockRestore();
  }
  expect(lines[0]).not.toContain("/private/secret");
});

test("invalid checkpoint diagnostics expose recognized structure without paths or requirement text", () => {
  const draft = `<compaction_state>
version: 2
modified_files:
- /private/customer/project.ts
requirements:
- {"id":"SECRET-123","status":"pending","source":"private instruction"}
</compaction_state>`;
  expect(checkpointStructuralDiagnostic(draft)).toMatchObject({
    openingTags: 1,
    closingTags: 1,
    version: 2,
    recognizedFields: ["version", "modified_files", "requirements"],
    requirementCount: 1,
    modifiedFileCount: 1,
  });
  const encoded = JSON.stringify(checkpointStructuralDiagnostic(draft));
  expect(encoded).not.toContain("/private/customer");
  expect(encoded).not.toContain("SECRET-123");
});

test("checkpoint field diagnosis ignores narrative lines outside the state block", () => {
  const draft = `requirements: quoted user request\n<compaction_state>\nversion: 2\nnext_actions:\n- Continue\n</compaction_state>`;
  expect(checkpointStructuralDiagnostic(draft).recognizedFields).toEqual(["version", "next_actions"]);
});
