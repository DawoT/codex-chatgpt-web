import { expect, test } from "bun:test";
import { summarizeCompactionCanaryLines } from "../scripts/compaction-canary-report";

function event(traceId: string, phase: string, options: Record<string, unknown> = {}): string {
  return `journal prefix [chatgpt-web] compaction_event ${JSON.stringify({
    schemaVersion: 1,
    traceId,
    phase,
    outcome: "succeeded",
    route: "retained",
    runtime: { generation: "gen-a", artifactSha256: "a".repeat(64), protocolVersion: 1 },
    ...options,
  })}`;
}

test("canary report separates durable completion from delivery without local persistence", () => {
  const report = summarizeCompactionCanaryLines([
    event("aaa", "persisted", { localPersisted: true }),
    event("aaa", "accepted"),
    event("aaa", "delivered"),
    event("bbb", "persisted", { outcome: "skipped", localPersisted: false, route: "fallback" }),
    event("bbb", "accepted", { route: "fallback" }),
    event("bbb", "delivered", { route: "fallback" }),
    event("ccc", "failed", { outcome: "rejected", reasonCode: "context_checkpoint_validation_failed" }),
    event("ddd", "received"),
    "irrelevant line",
  ]);
  expect(report).toMatchObject({
    traces: 4,
    durableCompleted: 1,
    deliveredWithoutLocalPersistence: 1,
    rejected: 1,
    incomplete: 1,
    retainedDurableCompleted: 1,
    fallbackDurableCompleted: 0,
    mixedBuildTraces: 0,
  });
});

test("mixed build identity cannot certify a durable canary", () => {
  const report = summarizeCompactionCanaryLines([
    event("aaa", "persisted", { localPersisted: true }),
    event("aaa", "accepted"),
    event("aaa", "delivered", {
      runtime: { generation: "gen-b", artifactSha256: "b".repeat(64), protocolVersion: 1 },
    }),
  ]);
  expect(report).toMatchObject({ durableCompleted: 0, mixedBuildTraces: 1 });
});

test("a completed browser draft and repair with repeated validation failures count as one rejected canary", () => {
  const report = summarizeCompactionCanaryLines([
    event("incident", "prepared", { route: "fallback", outcome: "pending" }),
    event("incident", "received", { route: "fallback", attempt: 1 }),
    event("incident", "validated", { route: "fallback", attempt: 1, outcome: "rejected" }),
    event("incident", "repair_started", { route: "fallback", attempt: 2, outcome: "pending" }),
    event("incident", "received", { route: "fallback", attempt: 2 }),
    event("incident", "validated", { route: "fallback", attempt: 2, outcome: "rejected" }),
    event("incident", "failed", {
      route: "fallback",
      outcome: "rejected",
      reasonCode: "context_checkpoint_validation_failed",
    }),
    event("incident", "failed", {
      route: "unknown",
      outcome: "rejected",
      reasonCode: "context_checkpoint_validation_failed",
    }),
  ]);
  expect(report).toMatchObject({
    traces: 1,
    rejected: 1,
    failed: 0,
    incomplete: 0,
    durableCompleted: 0,
    deliveredWithoutLocalPersistence: 0,
    fallbackDurableCompleted: 0,
  });
});

test("missing artifact or protocol identity cannot certify a durable canary", () => {
  for (const runtime of [{ generation: "gen-a" }, { generation: "gen-a", protocolVersion: 1, artifactSha256: null }]) {
    const report = summarizeCompactionCanaryLines([
      event("incomplete-build", "persisted", { runtime, localPersisted: true }),
      event("incomplete-build", "accepted", { runtime }),
      event("incomplete-build", "delivered", { runtime }),
    ]);
    expect(report.durableCompleted).toBe(0);
    expect(report.malformedEvents).toBe(3);
  }
});

test("rejected acceptance or delivery never counts as durable completion", () => {
  for (const phase of ["accepted", "delivered"]) {
    const report = summarizeCompactionCanaryLines([
      event("rejected-terminal", "persisted", { localPersisted: true }),
      event("rejected-terminal", "accepted", { outcome: phase === "accepted" ? "rejected" : "succeeded" }),
      event("rejected-terminal", "delivered", { outcome: phase === "delivered" ? "rejected" : "succeeded" }),
    ]);
    expect(report.durableCompleted).toBe(0);
    expect(report.rejected).toBe(1);
  }
});

test("non-object JSON events are counted as malformed without crashing reporting", () => {
  const report = summarizeCompactionCanaryLines([
    "[chatgpt-web] compaction_event null",
    "[chatgpt-web] compaction_event []",
    '[chatgpt-web] compaction_event "invalid"',
  ]);
  expect(report.malformedEvents).toBe(3);
  expect(report.traces).toBe(0);
});
