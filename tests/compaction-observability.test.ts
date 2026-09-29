import { expect, spyOn, test } from "bun:test";
import {
  checkpointIssueCodes,
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
