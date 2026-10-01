import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { RUNTIME_PROTOCOL_VERSION } from "../src/runtime-identity";

export type CanaryRoute = "retained" | "fallback";

export interface CanaryRequirement {
  id: string;
  text: string;
}

export interface LiveCanaryMatrixEntry {
  checkpointId: string;
  sessionId: "session-a" | "session-b";
  checkpointIndex: number;
  expectedRoute: CanaryRoute;
  taskId: string;
  objective: string;
  requirements: CanaryRequirement[];
  expectedFiles: string[];
  pendingObligation: string;
  plannedVerification: string;
}

export interface InactiveRuntimeSnapshot {
  candidate: {
    sourceTreeMatchesMeasuredGate: boolean;
    workingTreeClean: boolean;
    artifactsPrepared: boolean;
    rollbackPrepared: boolean;
  };
  admission: {
    active: unknown[];
    waiting: number;
  };
  runtime: {
    reachable: boolean;
    service?: string;
    acceptingTurns?: boolean;
    activeHttpTurns?: number;
    activeBrowserTurns?: number;
    activeSubagents?: number;
    queuedSubagents?: number;
    helperRuntimes?: Array<Record<string, unknown>>;
  };
  resources:
    | {
        observed: false;
      }
    | {
        observed: true;
        pendingWaiters: number;
        pendingTimers: number;
        pendingTransactions: number;
        pendingPersistences: number;
        retainedReleases: number;
      };
  telemetry:
    | {
        observed: false;
        invalid?: true;
      }
    | {
        observed: true;
        status: "healthy" | "degraded";
        pendingRecords: number;
        pendingBytes: number;
        failedWrites: number;
        droppedRecords: number;
      };
}

export interface InactiveRuntimeBlocker {
  code: string;
  detail: string;
}

export interface InactiveRuntimeGate {
  ready: boolean;
  blockers: InactiveRuntimeBlocker[];
}

export interface LegacyBootstrapShutdownGateOptions {
  runtimePredatesQuiescenceSeam: boolean;
}

export interface LiveCanaryPreparationOptions {
  healthUrl?: string;
  candidateDir?: string;
  rollbackDir?: string;
  runtimePredatesQuiescenceSeam?: boolean;
}

interface HealthPayload {
  service?: unknown;
  accepting_turns?: unknown;
  active_http_turns?: unknown;
  active_browser_turns?: unknown;
  active_subagents?: unknown;
  queued_subagents?: unknown;
  runtime_identity?: unknown;
  helper_runtimes?: unknown;
  resource_diagnostics?: unknown;
  telemetry_health?: unknown;
  diagnostic_health?: unknown;
}

interface AdmissionPayload {
  active?: unknown;
  waiting?: unknown;
}

interface VerificationEvidence {
  verifiedProductionTree?: unknown;
  finalGateCommit?: unknown;
}

interface GatesEvidence {
  build?: {
    bundles?: Array<{
      name?: unknown;
      sha256?: unknown;
    }>;
  };
}

const CASES = [
  {
    taskId: "unicode-regression",
    objective: "Preserve a Unicode normalization requirement while adding a focused regression.",
    expectedFiles: ["tests/prompt-equivalence.test.ts"],
    pendingObligation: "Run the focused regression and record its real exit code after the compacted continuation.",
    plannedVerification: "bun test tests/prompt-equivalence.test.ts",
  },
  {
    taskId: "abort-settlement",
    objective: "Carry an unresolved browser-wait cleanup obligation across compaction.",
    expectedFiles: ["tests/harness-continuity-lifecycle.test.ts"],
    pendingObligation: "Prove abort removes listeners and physical settlement reaches baseline.",
    plannedVerification: "bun test tests/harness-continuity-lifecycle.test.ts",
  },
  {
    taskId: "multipart-digest",
    objective: "Retain payload identity requirements while validating multipart digest behavior.",
    expectedFiles: ["tests/browser-multipart-compilation.test.ts"],
    pendingObligation: "Compare payload digests for distinct multipart inputs after the continuation.",
    plannedVerification: "bun test tests/browser-multipart-compilation.test.ts",
  },
  {
    taskId: "checkpoint-reference",
    objective: "Preserve original-request provenance while changing a strict checkpoint regression.",
    expectedFiles: ["tests/compaction-checkpoint.test.ts"],
    pendingObligation: "Verify an absent original request reference remains a validation defect.",
    plannedVerification: "bun test tests/compaction-checkpoint.test.ts",
  },
  {
    taskId: "telemetry-budget",
    objective: "Keep telemetry queue and fallback requirements while exercising bounded writes.",
    expectedFiles: ["tests/harness-continuity-telemetry.test.ts"],
    pendingObligation: "Verify pending records return to zero and dropped writes remain visible.",
    plannedVerification: "bun test tests/harness-continuity-telemetry.test.ts",
  },
  {
    taskId: "deadline-classification",
    objective: "Preserve typed deadline semantics through a compaction boundary.",
    expectedFiles: ["tests/harness-continuity-replay.test.ts"],
    pendingObligation: "Verify the producer emits a deadline cause that the terminal classifier recognizes.",
    plannedVerification: "bun test tests/harness-continuity-replay.test.ts",
  },
  {
    taskId: "retained-release",
    objective: "Carry retained-conversation release ownership into the next action.",
    expectedFiles: ["tests/retained-compaction.test.ts"],
    pendingObligation: "Verify retained release settles before a replacement owner is admitted.",
    plannedVerification: "bun test tests/retained-compaction.test.ts",
  },
  {
    taskId: "tool-delivery",
    objective: "Preserve the distinction between tool execution and MCP delivery evidence.",
    expectedFiles: ["tests/mcp-observation.test.ts"],
    pendingObligation: "Verify result reception and reply delivery remain separate observations.",
    plannedVerification: "bun test tests/mcp-observation.test.ts",
  },
  {
    taskId: "browser-rebind",
    objective: "Retain document generation and event cursor requirements across browser rebind.",
    expectedFiles: ["tests/browser-dom-events.test.ts"],
    pendingObligation: "Verify page rebound increments generation and leaves zero pending waiters.",
    plannedVerification: "bun test tests/browser-dom-events.test.ts",
  },
  {
    taskId: "single-send",
    objective: "Carry the no-resend obligation through an ambiguous submission checkpoint.",
    expectedFiles: ["tests/browser-worker-contract.test.ts"],
    pendingObligation: "Verify physical Send count remains one when acceptance is ambiguous.",
    plannedVerification: "bun test tests/browser-worker-contract.test.ts",
  },
] as const;

export function buildLiveCanaryMatrix(): LiveCanaryMatrixEntry[] {
  const matrix: LiveCanaryMatrixEntry[] = [];
  for (const sessionId of ["session-a", "session-b"] as const) {
    for (let index = 0; index < CASES.length; index += 1) {
      const scenario = CASES[index]!;
      const checkpointIndex = index + 1;
      const prefix = sessionId === "session-a" ? "A" : "B";
      matrix.push({
        checkpointId: `${prefix}-CP-${String(checkpointIndex).padStart(2, "0")}`,
        sessionId,
        checkpointIndex,
        expectedRoute: checkpointIndex % 2 === 1 ? "retained" : "fallback",
        taskId: scenario.taskId,
        objective: scenario.objective,
        requirements: [
          {
            id: `${prefix}-REQ-${String(checkpointIndex).padStart(2, "0")}-1`,
            text: "Preserve the original user objective and latest steering verbatim by reference.",
          },
          {
            id: `${prefix}-REQ-${String(checkpointIndex).padStart(2, "0")}-2`,
            text: "Preserve completed evidence without inventing successful commands or results.",
          },
          {
            id: `${prefix}-REQ-${String(checkpointIndex).padStart(2, "0")}-3`,
            text: scenario.pendingObligation,
          },
        ],
        expectedFiles: [...scenario.expectedFiles],
        pendingObligation: scenario.pendingObligation,
        plannedVerification: scenario.plannedVerification,
      });
    }
  }
  return matrix;
}

function addBlocker(blockers: InactiveRuntimeBlocker[], code: string, detail: string): void {
  blockers.push({ code, detail });
}

export function evaluateInactiveRuntimeGate(snapshot: InactiveRuntimeSnapshot): InactiveRuntimeGate {
  const blockers: InactiveRuntimeBlocker[] = [];

  if (!snapshot.candidate.sourceTreeMatchesMeasuredGate) {
    addBlocker(
      blockers,
      "candidate_source_mismatch",
      "The production source tree differs from the measured gate tree.",
    );
  }
  if (!snapshot.candidate.workingTreeClean) {
    addBlocker(blockers, "working_tree_dirty", "The working tree is not clean.");
  }
  if (!snapshot.candidate.artifactsPrepared) {
    addBlocker(
      blockers,
      "candidate_artifacts_missing",
      "Candidate CLI/helper artifacts are not prepared and verified.",
    );
  }
  if (!snapshot.candidate.rollbackPrepared) {
    addBlocker(blockers, "rollback_missing", "The currently loaded helper/source rollback material is not preserved.");
  }
  if (snapshot.admission.active.length > 0) {
    addBlocker(
      blockers,
      "admission_active",
      `${snapshot.admission.active.length} admitted execution(s) remain active.`,
    );
  }
  if (snapshot.admission.waiting !== 0) {
    addBlocker(blockers, "admission_waiting", `${snapshot.admission.waiting} admission waiter(s) remain queued.`);
  }
  if (!snapshot.runtime.reachable) {
    addBlocker(
      blockers,
      "runtime_unreachable",
      "The runtime health surface is not reachable, so inactivity cannot be proven.",
    );
  } else {
    if (snapshot.runtime.service !== "codex-chatgpt-web") {
      addBlocker(blockers, "runtime_identity_unknown", "The health endpoint does not identify codex-chatgpt-web.");
    }
    if (snapshot.runtime.acceptingTurns !== false) {
      addBlocker(blockers, "runtime_accepting_turns", "The runtime has not been drained and still accepts new turns.");
    }
    if (snapshot.runtime.activeHttpTurns !== 0) {
      addBlocker(
        blockers,
        "active_http_turns",
        `${snapshot.runtime.activeHttpTurns ?? "unknown"} active HTTP turn(s) remain.`,
      );
    }
    if (snapshot.runtime.activeBrowserTurns !== 0) {
      addBlocker(
        blockers,
        "active_browser_turns",
        `${snapshot.runtime.activeBrowserTurns ?? "unknown"} active browser turn(s) remain.`,
      );
    }
    if (snapshot.runtime.activeSubagents !== 0) {
      addBlocker(
        blockers,
        "active_subagents",
        `${snapshot.runtime.activeSubagents ?? "unknown"} active subagent(s) remain.`,
      );
    }
    if (snapshot.runtime.queuedSubagents !== 0) {
      addBlocker(
        blockers,
        "queued_subagents",
        `${snapshot.runtime.queuedSubagents ?? "unknown"} queued subagent(s) remain.`,
      );
    }
    if ((snapshot.runtime.helperRuntimes?.length ?? 0) > 0) {
      addBlocker(
        blockers,
        "helper_runtime_present",
        `${snapshot.runtime.helperRuntimes!.length} helper runtime(s) are still observed.`,
      );
    }
  }

  if (!snapshot.resources.observed) {
    addBlocker(
      blockers,
      "resource_evidence_missing",
      "Pending waiters, transactions, persistences and retained releases are not exposed by the runtime.",
    );
  } else {
    for (const [code, value] of [
      ["pending_waiters", snapshot.resources.pendingWaiters],
      ["pending_timers", snapshot.resources.pendingTimers],
      ["pending_transactions", snapshot.resources.pendingTransactions],
      ["pending_persistences", snapshot.resources.pendingPersistences],
      ["retained_releases", snapshot.resources.retainedReleases],
    ] as const) {
      if (value !== 0) addBlocker(blockers, code, `${value} resource(s) remain for ${code}.`);
    }
  }

  if (!snapshot.telemetry.observed) {
    if (snapshot.telemetry.invalid)
      addBlocker(blockers, "telemetry_invalid", "Advertised runtime telemetry health is malformed.");
    addBlocker(
      blockers,
      "telemetry_evidence_missing",
      "Telemetry queue health and pending bytes/records are not exposed by the runtime.",
    );
  } else {
    if (snapshot.telemetry.status !== "healthy") {
      addBlocker(blockers, "telemetry_degraded", "Telemetry reports a degraded status.");
    }
    if (snapshot.telemetry.pendingRecords !== 0) {
      addBlocker(
        blockers,
        "telemetry_pending_records",
        `${snapshot.telemetry.pendingRecords} telemetry record(s) remain.`,
      );
    }
    if (snapshot.telemetry.pendingBytes !== 0) {
      addBlocker(blockers, "telemetry_pending_bytes", `${snapshot.telemetry.pendingBytes} telemetry byte(s) remain.`);
    }
    if (snapshot.telemetry.failedWrites !== 0) {
      addBlocker(blockers, "telemetry_failed_writes", `${snapshot.telemetry.failedWrites} telemetry write(s) failed.`);
    }
    if (snapshot.telemetry.droppedRecords !== 0) {
      addBlocker(
        blockers,
        "telemetry_dropped_records",
        `${snapshot.telemetry.droppedRecords} telemetry record(s) were dropped.`,
      );
    }
  }

  return { ready: blockers.length === 0, blockers };
}

export function evaluateLegacyBootstrapShutdownGate(
  snapshot: InactiveRuntimeSnapshot,
  options: LegacyBootstrapShutdownGateOptions,
): InactiveRuntimeGate {
  const strict = evaluateInactiveRuntimeGate(snapshot);
  const blockers = strict.blockers.filter(
    (blocker) => blocker.code !== "resource_evidence_missing" && blocker.code !== "telemetry_evidence_missing",
  );

  if (!options.runtimePredatesQuiescenceSeam) {
    addBlocker(
      blockers,
      "legacy_bootstrap_not_applicable",
      "The compatibility shutdown gate is only valid for a runtime proven to predate the quiescence health seam.",
    );
  }

  return { ready: blockers.length === 0, blockers };
}

function sha256(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(command: string[]): string {
  const result = Bun.spawnSync(command, {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || result.stdout.toString().trim() || command.join(" "));
  }
  return result.stdout.toString().trim();
}

function git(...args: string[]): string {
  return run(["git", ...args]);
}

function parseObject(value: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function finiteInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? Number(value) : undefined;
}

function resourcesFromHealth(health: HealthPayload): InactiveRuntimeSnapshot["resources"] {
  const value = health.resource_diagnostics;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { observed: false };
  const record = value as Record<string, unknown>;
  const pendingWaiters = finiteInteger(record.pending_waiters);
  const pendingTimers = finiteInteger(record.pending_timers);
  const pendingTransactions = finiteInteger(record.pending_transactions);
  const pendingPersistences = finiteInteger(record.pending_persistences);
  const retainedReleases = finiteInteger(record.retained_releases);
  if (
    [pendingWaiters, pendingTimers, pendingTransactions, pendingPersistences, retainedReleases].some(
      (entry) => entry === undefined,
    )
  ) {
    return { observed: false };
  }
  return {
    observed: true,
    pendingWaiters: pendingWaiters!,
    pendingTimers: pendingTimers!,
    pendingTransactions: pendingTransactions!,
    pendingPersistences: pendingPersistences!,
    retainedReleases: retainedReleases!,
  };
}

export function readRuntimeTelemetryHealth(health: HealthPayload): InactiveRuntimeSnapshot["telemetry"] {
  const value = health.telemetry_health;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { observed: false };
  const record = value as Record<string, unknown>;
  const status = record.status === "healthy" || record.status === "degraded" ? record.status : undefined;
  const pendingRecords = finiteInteger(record.pending_records);
  const pendingBytes = finiteInteger(record.pending_bytes);
  const failedWrites = finiteInteger(record.failed_writes);
  const droppedRecords = finiteInteger(record.dropped_records);
  if (
    status === undefined ||
    [pendingRecords, pendingBytes, failedWrites, droppedRecords].some((entry) => entry === undefined)
  ) {
    return { observed: false };
  }
  const diagnostic = health.diagnostic_health;
  if (diagnostic !== undefined) {
    if (!diagnostic || typeof diagnostic !== "object" || Array.isArray(diagnostic))
      return { observed: false, invalid: true };
    const causal = diagnostic as Record<string, unknown>;
    const counters = [causal.pendingRecords, causal.pendingBytes, causal.failedWrites, causal.droppedRecords].map(
      finiteInteger,
    );
    if (
      (causal.status !== "healthy" && causal.status !== "degraded") ||
      counters.some((counter) => counter === undefined)
    )
      return { observed: false, invalid: true };
    const combined = [pendingRecords!, pendingBytes!, failedWrites!, droppedRecords!].map(
      (counter, index) => counter + counters[index]!,
    );
    if (combined.some((counter) => !Number.isSafeInteger(counter))) return { observed: false, invalid: true };
    return {
      observed: true,
      status: status === "healthy" && causal.status === "healthy" ? "healthy" : "degraded",
      pendingRecords: combined[0]!,
      pendingBytes: combined[1]!,
      failedWrites: combined[2]!,
      droppedRecords: combined[3]!,
    };
  }
  return {
    observed: true,
    status,
    pendingRecords: pendingRecords!,
    pendingBytes: pendingBytes!,
    failedWrites: failedWrites!,
    droppedRecords: droppedRecords!,
  };
}

async function readHealth(url: string): Promise<{ reachable: boolean; payload?: HealthPayload; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return { reachable: false, error: `HTTP ${response.status}` };
    return { reachable: true, payload: (await response.json()) as HealthPayload };
  } catch (error) {
    return { reachable: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (index < 0) return undefined;
  const current = args[index]!;
  if (current.startsWith(`${name}=`)) {
    args.splice(index, 1);
    return current.slice(name.length + 1);
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

export async function collectLiveCanaryPreparation(
  options: LiveCanaryPreparationOptions = {},
): Promise<Record<string, unknown>> {
  const head = git("rev-parse", "HEAD");
  const shortHead = head.slice(0, 7);
  const sourceTree = git("rev-parse", "HEAD:src");
  const status = git("status", "--porcelain=v1");
  const verification = JSON.parse(
    readFileSync(resolve("docs/evidence/harness-continuity-verification.json"), "utf8"),
  ) as VerificationEvidence;
  const gates = JSON.parse(
    readFileSync(resolve("docs/evidence/harness-continuity-gates.json"), "utf8"),
  ) as GatesEvidence;
  const expectedBundles = Object.fromEntries(
    (gates.build?.bundles ?? [])
      .filter((bundle) => typeof bundle.name === "string" && typeof bundle.sha256 === "string")
      .map((bundle) => [bundle.name as string, bundle.sha256 as string]),
  );
  const candidateDir = resolve(options.candidateDir ?? `/tmp/continuity-candidate-${shortHead}`);
  const rollbackDir = resolve(options.rollbackDir ?? `/tmp/continuity-rollback-${shortHead}`);
  const candidateCli = resolve(candidateDir, "cli.js");
  const candidateHelper = resolve(candidateDir, "browser-helper.cjs");
  const rollbackHelper = resolve(rollbackDir, "browser-helper.cjs");
  const rollbackSourceCommit = resolve(rollbackDir, "source-commit.txt");
  const candidateCliSha256 = sha256(candidateCli);
  const candidateHelperSha256 = sha256(candidateHelper);
  const rollbackHelperSha256 = sha256(rollbackHelper);

  const admissionRaw = run([process.execPath, "run", "src/cli.ts", "admission", "status", "--json"]);
  const admission = parseObject(admissionRaw, "admission status") as AdmissionPayload;
  const active = Array.isArray(admission.active) ? admission.active : [];
  const waiting = finiteInteger(admission.waiting) ?? -1;
  const healthResult = await readHealth(options.healthUrl ?? "http://127.0.0.1:17841/healthz");
  const health = healthResult.payload ?? {};
  const helperRuntimes = Array.isArray(health.helper_runtimes)
    ? health.helper_runtimes.filter((entry): entry is Record<string, unknown> =>
        Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
      )
    : [];

  const artifactsPrepared =
    candidateCliSha256 !== null &&
    candidateHelperSha256 !== null &&
    candidateCliSha256 === expectedBundles.cli &&
    candidateHelperSha256 === expectedBundles["browser-helper"];
  const rollbackPrepared = rollbackHelperSha256 !== null && existsSync(rollbackSourceCommit);
  const snapshot: InactiveRuntimeSnapshot = {
    candidate: {
      sourceTreeMatchesMeasuredGate:
        typeof verification.verifiedProductionTree === "string" && sourceTree === verification.verifiedProductionTree,
      workingTreeClean: status.length === 0,
      artifactsPrepared,
      rollbackPrepared,
    },
    admission: {
      active,
      waiting,
    },
    runtime: {
      reachable: healthResult.reachable,
      ...(typeof health.service === "string" ? { service: health.service } : {}),
      ...(typeof health.accepting_turns === "boolean" ? { acceptingTurns: health.accepting_turns } : {}),
      ...(finiteInteger(health.active_http_turns) !== undefined
        ? { activeHttpTurns: finiteInteger(health.active_http_turns) }
        : {}),
      ...(finiteInteger(health.active_browser_turns) !== undefined
        ? { activeBrowserTurns: finiteInteger(health.active_browser_turns) }
        : {}),
      ...(finiteInteger(health.active_subagents) !== undefined
        ? { activeSubagents: finiteInteger(health.active_subagents) }
        : {}),
      ...(finiteInteger(health.queued_subagents) !== undefined
        ? { queuedSubagents: finiteInteger(health.queued_subagents) }
        : {}),
      helperRuntimes,
    },
    resources: resourcesFromHealth(health),
    telemetry: readRuntimeTelemetryHealth(health),
  };
  const gate = evaluateInactiveRuntimeGate(snapshot);
  const legacyBootstrapShutdownGate = options.runtimePredatesQuiescenceSeam
    ? evaluateLegacyBootstrapShutdownGate(snapshot, { runtimePredatesQuiescenceSeam: true })
    : null;

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    risk: "R2xL",
    candidate: {
      head,
      sourceTree,
      measuredGateCommit: typeof verification.finalGateCommit === "string" ? verification.finalGateCommit : null,
      measuredSourceTree:
        typeof verification.verifiedProductionTree === "string" ? verification.verifiedProductionTree : null,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      artifacts: {
        cli: {
          path: candidateCli,
          sha256: candidateCliSha256,
          expectedSha256: expectedBundles.cli ?? null,
        },
        browserHelper: {
          path: candidateHelper,
          sha256: candidateHelperSha256,
          expectedSha256: expectedBundles["browser-helper"] ?? null,
        },
      },
      rollback: {
        sourceCommitPath: rollbackSourceCommit,
        helperPath: rollbackHelper,
        helperSha256: rollbackHelperSha256,
      },
    },
    currentRuntime: {
      healthUrl: options.healthUrl ?? "http://127.0.0.1:17841/healthz",
      healthError: healthResult.error ?? null,
      runtimeIdentity: health.runtime_identity ?? null,
      helperRuntimes,
    },
    snapshot,
    inactivityGate: gate,
    legacyBootstrapShutdownGate,
    sessionRequirements: {
      sessions: 2,
      minimumMinutesExclusive: 22,
      checkpointsPerSession: 10,
      totalCheckpoints: 20,
      requiredRoutes: ["retained", "fallback"],
      durationClock: "monotonic-real-time",
    },
    matrix: buildLiveCanaryMatrix(),
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const report = takeOption(args, "--report");
  const healthUrl = takeOption(args, "--health-url");
  const candidateDir = takeOption(args, "--candidate-dir");
  const rollbackDir = takeOption(args, "--rollback-dir");
  const legacyBootstrapShutdown = takeFlag(args, "--legacy-bootstrap-shutdown");
  const requireReady = takeFlag(args, "--require-ready");
  if (args.length > 0) throw new Error(`Unknown arguments: ${args.join(" ")}`);

  const result = await collectLiveCanaryPreparation({
    ...(healthUrl ? { healthUrl } : {}),
    ...(candidateDir ? { candidateDir } : {}),
    ...(rollbackDir ? { rollbackDir } : {}),
    ...(legacyBootstrapShutdown ? { runtimePredatesQuiescenceSeam: true } : {}),
  });
  const encoded = `${JSON.stringify(result, null, 2)}\n`;
  if (report) writeFileSync(resolve(report), encoded, { mode: 0o600 });
  process.stdout.write(encoded);
  const selectedGate = legacyBootstrapShutdown
    ? (result.legacyBootstrapShutdownGate as InactiveRuntimeGate)
    : (result.inactivityGate as InactiveRuntimeGate);
  if (requireReady && !selectedGate.ready) process.exitCode = 2;
}
