import { expect, test } from "bun:test";
import {
  buildLiveCanaryMatrix,
  evaluateInactiveRuntimeGate,
  type InactiveRuntimeSnapshot,
} from "../scripts/harness-live-canary";

function readySnapshot(): InactiveRuntimeSnapshot {
  return {
    candidate: {
      sourceTreeMatchesMeasuredGate: true,
      workingTreeClean: true,
      artifactsPrepared: true,
      rollbackPrepared: true,
    },
    admission: {
      active: [],
      waiting: 0,
    },
    runtime: {
      reachable: true,
      service: "codex-chatgpt-web",
      acceptingTurns: false,
      activeHttpTurns: 0,
      activeBrowserTurns: 0,
      activeSubagents: 0,
      queuedSubagents: 0,
      helperRuntimes: [],
    },
    resources: {
      observed: true,
      pendingWaiters: 0,
      pendingTimers: 0,
      pendingTransactions: 0,
      pendingPersistences: 0,
      retainedReleases: 0,
    },
    telemetry: {
      observed: true,
      status: "healthy",
      pendingRecords: 0,
      pendingBytes: 0,
      failedWrites: 0,
      droppedRecords: 0,
    },
  };
}

test("live canary matrix fixes twenty unique checkpoints across two independent sessions", () => {
  const matrix = buildLiveCanaryMatrix();

  expect(matrix).toHaveLength(20);
  expect(new Set(matrix.map((entry) => entry.checkpointId)).size).toBe(20);
  expect(new Set(matrix.map((entry) => entry.sessionId))).toEqual(new Set(["session-a", "session-b"]));

  for (const sessionId of ["session-a", "session-b"]) {
    const session = matrix.filter((entry) => entry.sessionId === sessionId);
    expect(session).toHaveLength(10);
    expect(session.filter((entry) => entry.expectedRoute === "retained")).toHaveLength(5);
    expect(session.filter((entry) => entry.expectedRoute === "fallback")).toHaveLength(5);
    expect(session.every((entry) => entry.requirements.length >= 3)).toBe(true);
    expect(session.every((entry) => entry.pendingObligation.length > 0)).toBe(true);
    expect(session.every((entry) => entry.plannedVerification.length > 0)).toBe(true);
  }
});

test("inactive runtime gate fails closed when the runtime is live or evidence is missing", () => {
  const snapshot = readySnapshot();
  snapshot.runtime.acceptingTurns = true;
  snapshot.runtime.activeHttpTurns = 1;
  snapshot.runtime.activeBrowserTurns = 1;
  snapshot.runtime.helperRuntimes = [{ pid: 42, protocolStatus: "compatible" }];
  snapshot.resources = { observed: false };
  snapshot.telemetry = { observed: false };

  const result = evaluateInactiveRuntimeGate(snapshot);
  const codes = result.blockers.map((blocker) => blocker.code);

  expect(result.ready).toBe(false);
  expect(codes).toContain("runtime_accepting_turns");
  expect(codes).toContain("active_http_turns");
  expect(codes).toContain("active_browser_turns");
  expect(codes).toContain("helper_runtime_present");
  expect(codes).toContain("resource_evidence_missing");
  expect(codes).toContain("telemetry_evidence_missing");
});

test("inactive runtime gate accepts only a clean prepared candidate with zeroed durable resources", () => {
  const result = evaluateInactiveRuntimeGate(readySnapshot());

  expect(result).toEqual({
    ready: true,
    blockers: [],
  });
});
