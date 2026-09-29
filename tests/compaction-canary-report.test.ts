import { expect, test } from "bun:test";
import { summarizeCompactionCanaryLines } from "../scripts/compaction-canary-report";

function event(traceId: string, phase: string, options: Record<string, unknown> = {}): string {
  return `journal prefix [chatgpt-web] compaction_event ${JSON.stringify({
    schemaVersion: 1,
    traceId,
    phase,
    outcome: "succeeded",
    route: "retained",
    runtime: { generation: "gen-a", artifactSha256: "build-a", protocolVersion: 1 },
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
      runtime: { generation: "gen-b", artifactSha256: "build-b", protocolVersion: 1 },
    }),
  ]);
  expect(report).toMatchObject({ durableCompleted: 0, mixedBuildTraces: 1 });
});
