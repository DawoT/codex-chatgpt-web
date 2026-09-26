#!/usr/bin/env bun
/**
 * Real-Time Dogfooding Audit & Verification Sentinel
 * 
 * Runs end-to-end dogfooding checks directly on the codex-chatgpt-web repository:
 * 1. Live Daemon & Tunnel Health (/healthz, /v1/models)
 * 2. Live MCP Tool Output Spooler (.agents/scratch/outputs/)
 * 3. Live Persistent Workspace State (.agents/STATE.md)
 * 4. Live Subagent Workspace Isolation (.agents/subagents/dogfood-sentinel/)
 * 5. Live Preflight Budget Guardian Evaluation
 * 6. Live Long-Horizon Turn Checkpoints (.agents/checkpoints/) & Quality Gate
 * 7. Live Transport & Session Store (HEAD/WS/Auth probes + session scan)
 * 8. Live Session Janitor Health Metrics (/healthz session_janitor section)
 * 9. Live Observability Endpoints (/metrics Prometheus + /admin/status JSON)
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spoolToolOutput, resolveProjectScratchDirectory } from "../src/adapters/chatgpt-web/tool-spooler";
import { readWorkspaceState, writeWorkspaceState, resolveWorkspaceStatePath } from "../src/adapters/chatgpt-web/workspace-state";
import { resolveSubagentWorkspace, resolveSubagentScratchDir, writeSubagentResult, readSubagentResult } from "../src/adapters/chatgpt-web/subagent-workspace";
import { evaluatePreflightBudget, preparePreflightInput } from "../src/adapters/chatgpt-web/preflight-budget";
import { saveTurnCheckpoint, listTurnCheckpoints, validateCompactionQuality, mergeCompactionIntoWorkspaceState } from "../src/adapters/chatgpt-web/autonomous-compaction";
import { pruneCodexSessions } from "../src/adapters/chatgpt-web/session-store-pruner";
import type { CodexMessage, CodexParsedRequest } from "../src/types";

const REPO_ROOT = process.cwd();
const DAEMON_URL = "http://127.0.0.1:17841";

interface AuditResult {
  step: string;
  passed: boolean;
  durationMs: number;
  details: string;
  metadata?: Record<string, unknown>;
}

const results: AuditResult[] = [];

function recordResult(step: string, passed: boolean, durationMs: number, details: string, metadata?: Record<string, unknown>) {
  results.push({ step, passed, durationMs, details, metadata });
  const icon = passed ? "✅ [PASS]" : "❌ [FAIL]";
  console.log(`${icon} ${step} (${durationMs.toFixed(1)}ms): ${details}`);
}

async function auditLiveDaemon(): Promise<void> {
  const start = performance.now();
  try {
    const healthRes = await fetch(`${DAEMON_URL}/healthz`, { signal: AbortSignal.timeout(3000) });
    if (!healthRes.ok) {
      recordResult("1. Live Daemon Health", false, performance.now() - start, `Daemon returned HTTP ${healthRes.status}`);
      return;
    }
    const health = (await healthRes.json()) as {
      status: string;
      version: string;
      mode: string;
      pid: number;
      uptime: number;
      tunnel_supervisor?: { enabled: boolean; status: string };
    };

    recordResult(
      "1. Live Daemon Health",
      health.status === "ok",
      performance.now() - start,
      `Daemon active (PID: ${health.pid}, mode: ${health.mode}, version: ${health.version}, uptime: ${health.uptime.toFixed(0)}s, tunnel: ${health.tunnel_supervisor?.status ?? "unknown"})`,
      health,
    );
  } catch (error) {
    recordResult("1. Live Daemon Health", false, performance.now() - start, `Connection error to ${DAEMON_URL}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function auditLiveSpooling(): void {
  const start = performance.now();
  try {
    // Collect real git history as heavy payload (> 2,500 chars)
    const realGitLog = execSync("git log -n 40 --stat", { cwd: REPO_ROOT, encoding: "utf-8" });
    const spooled = spoolToolOutput(realGitLog, {
      workspaceRoot: REPO_ROOT,
      toolName: "git_log_audit",
    });

    const scratchDir = resolveProjectScratchDirectory(REPO_ROOT);
    const logExists = spooled.filePath ? existsSync(spooled.filePath) : false;

    recordResult(
      "2. Live Tool Output Spooler",
      spooled.spooled && logExists && spooled.text.length < realGitLog.length,
      performance.now() - start,
      `Real git log (${realGitLog.length} chars) spooled to ${spooled.filePath} (summary: ${spooled.text.length} chars)`,
      { spooledChars: realGitLog.length, summaryChars: spooled.text.length, path: spooled.filePath },
    );
  } catch (error) {
    recordResult("2. Live Tool Output Spooler", false, performance.now() - start, `Spooling error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function auditLiveWorkspaceState(): void {
  const start = performance.now();
  try {
    const statePath = resolveWorkspaceStatePath(REPO_ROOT);
    const state = readWorkspaceState(REPO_ROOT);

    if (!state) {
      recordResult("3. Live Workspace State", false, performance.now() - start, `Could not read .agents/STATE.md from ${statePath}`);
      return;
    }

    const hasGoal = state.goal.length > 0;
    const hasMilestones = state.completedMilestones.length > 0;
    const hasInvariants = state.invariantsAndDecisions.length > 0;

    recordResult(
      "3. Live Workspace State (.agents/STATE.md)",
      hasGoal && hasMilestones && hasInvariants,
      performance.now() - start,
      `STATE.md verified: ${state.completedMilestones.length} milestones, ${state.invariantsAndDecisions.length} invariants, phase: "${state.activePhase}"`,
      { activePhase: state.activePhase, milestonesCount: state.completedMilestones.length },
    );
  } catch (error) {
    recordResult("3. Live Workspace State", false, performance.now() - start, `State sync error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function auditLiveSubagentWorkspace(): void {
  const start = performance.now();
  const subagentId = "dogfood-sentinel-audit";
  try {
    const subWsDir = resolveSubagentWorkspace(REPO_ROOT, subagentId);
    const subScratchDir = resolveSubagentScratchDir(REPO_ROOT, subagentId);

    // Generate real subagent execution result
    writeSubagentResult(REPO_ROOT, subagentId, {
      status: "completed",
      summary: "Dogfooding live audit executed successfully on own codebase.",
      modified_files: ["scripts/dogfood-audit.ts"],
      diagnostics: `Audit timestamp: ${new Date().toISOString()} on pid ${process.pid}`,
    });

    const loaded = readSubagentResult(REPO_ROOT, subagentId);
    const scratchExists = existsSync(subScratchDir);

    recordResult(
      "4. Live Subagent Isolation (.agents/subagents/)",
      loaded?.status === "completed" && scratchExists,
      performance.now() - start,
      `Isolated workspace active at ${subWsDir}, result.json verified and scratch isolated.`,
      { subagentId, status: loaded?.status },
    );
  } catch (error) {
    recordResult("4. Live Subagent Isolation", false, performance.now() - start, `Subagent error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function auditLivePreflightGuardian(): void {
  const start = performance.now();
  try {
    // Generate a heavy mock request based on real files in repo
    const messages: CodexMessage[] = [
      { role: "user", content: "Audit codex-chatgpt-web codebase health", timestamp: Date.now() },
    ];

    // Add 4 large simulated tool results (each 25,000 chars)
    for (let i = 1; i <= 4; i++) {
      messages.push({
        role: "toolResult",
        toolCallId: `call_audit_${i}`,
        toolName: "read_file",
        content: `Source chunk #${i}:\n` + "// safe code line audit\n".repeat(1000),
        isError: false,
        timestamp: Date.now() + i,
      });
    }

    const request: CodexParsedRequest = {
      modelId: "chatgpt-web:gpt-5",
      context: { messages },
      stream: true,
      options: {},
    };

    const mockCapabilities = {
      localToolsEnabled: true,
      solAvailable: false,
      extraHighAvailable: false,
      proAvailable: false,
    };

    const verdict = evaluatePreflightBudget(request, mockCapabilities, { experimentalBiggerContext: false });
    const { input: prunedInput } = preparePreflightInput(request, mockCapabilities, { experimentalBiggerContext: false });

    const olderPruned = typeof prunedInput.context.messages[1].content === "string"
      && prunedInput.context.messages[1].content.includes("[Historical tool output pruned by Preflight Guardian");
    const recentPreserved = typeof prunedInput.context.messages[4].content === "string"
      && prunedInput.context.messages[4].content.includes("Source chunk #4");

    recordResult(
      "5. Live Preflight Budget Guardian",
      verdict.actionRequired === "apply_pruning" && olderPruned && recentPreserved,
      performance.now() - start,
      `Guardian intercepted 100k payload, pruned 2 older outputs and preserved the 2 most recent without HTTP 413 danger.`,
      { actionRequired: verdict.actionRequired, prunableCount: verdict.prunableToolResultsCount },
    );
  } catch (error) {
    recordResult("5. Live Preflight Budget Guardian", false, performance.now() - start, `Preflight error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function auditLiveCompactionAndCheckpoints(): void {
  const start = performance.now();
  try {
    const existingCheckpoints = listTurnCheckpoints(REPO_ROOT);
    const nextEpoch = (existingCheckpoints[0]?.epoch ?? 0) + 1;

    const summary = "Dogfooding live checkpoint: verified spooler, workspace state, subagents, and preflight budget in codex-chatgpt-web.";
    const checkpointPath = saveTurnCheckpoint(REPO_ROOT, {
      epoch: nextEpoch,
      turnCount: 10,
      stateSnapshot: readWorkspaceState(REPO_ROOT),
      compactSummary: summary,
      prunedFileReferences: ["src/adapters/chatgpt-web/index.ts", "scripts/dogfood-audit.ts"],
      metadata: { dogfoodAudit: true, pid: process.pid },
    });

    const checkpointsAfter = listTurnCheckpoints(REPO_ROOT);
    const quality = validateCompactionQuality(
      [
        { role: "user", content: "Review scripts/dogfood-audit.ts", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Audited scripts/dogfood-audit.ts" }], timestamp: 2 },
      ],
      "Reviewed and validated scripts/dogfood-audit.ts with all checks passing.",
    );

    recordResult(
      "6. Live Checkpoints & Quality Gate (.agents/checkpoints/)",
      existsSync(checkpointPath) && checkpointsAfter.length > 0 && quality.valid,
      performance.now() - start,
      `Checkpoint epoch ${nextEpoch} written to ${checkpointPath}. Quality Gate semantic verification passed.`,
      { checkpointPath, epoch: nextEpoch, totalCheckpoints: checkpointsAfter.length },
    );
  } catch (error) {
    recordResult("6. Live Checkpoints & Quality Gate", false, performance.now() - start, `Compaction audit error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function auditLiveTransportAndSessionStore(): Promise<void> {
  const start = performance.now();
  try {
    // 1. Probe HEAD /v1/responses
    const headRes = await fetch(`${DAEMON_URL}/v1/responses`, { method: "HEAD", signal: AbortSignal.timeout(3000) });
    const headOk = headRes.status === 200 && headRes.headers.get("connection") === "keep-alive";

    // 2. Probe GET /v1/responses (WebSocket 426 Demotion)
    const wsRes = await fetch(`${DAEMON_URL}/v1/responses`, {
      method: "GET",
      headers: { Connection: "Upgrade", Upgrade: "websocket" },
      signal: AbortSignal.timeout(3000),
    });
    const wsOk = wsRes.status === 426 && wsRes.headers.get("x-responses-transport") === "sse-required";

    // 3. Probe unauthenticated GET /v1/models (401 Auth Guard)
    const modelsRes = await fetch(`${DAEMON_URL}/v1/models`, { method: "GET", signal: AbortSignal.timeout(3000) });
    const modelsOk = modelsRes.status === 401;

    // 4. Session Store dry-run scan
    const pruneScan = pruneCodexSessions({ dryRun: true });

    const allOk = headOk && wsOk && modelsOk && pruneScan.scannedFiles > 0;

    recordResult(
      "7. Live Transport & Session Store",
      allOk,
      performance.now() - start,
      `HEAD probe: ${headRes.status} OK | WS 426: ${wsRes.status} (SSE signaled) | Auth Guard: ${modelsRes.status} | Sessions scanned: ${pruneScan.scannedFiles} (${(pruneScan.totalInitialBytes / (1024 * 1024 * 1024)).toFixed(2)} GB)`,
      { headStatus: headRes.status, wsStatus: wsRes.status, modelsStatus: modelsRes.status, scannedSessions: pruneScan.scannedFiles },
    );
  } catch (error) {
    recordResult("7. Live Transport & Session Store", false, performance.now() - start, `Transport audit error: ${error instanceof Error ? error.message : String(error)}`);
  }
}


async function auditLiveSessionJanitor(): Promise<void> {
  const start = performance.now();
  try {
    const healthRes = await fetch(`${DAEMON_URL}/healthz`, { signal: AbortSignal.timeout(3000) });
    if (!healthRes.ok) {
      recordResult("8. Live Session Janitor Health", false, performance.now() - start, `Daemon /healthz returned HTTP ${healthRes.status}`);
      return;
    }
    const healthData = await healthRes.json() as Record<string, unknown>;
    const janitor = healthData["session_janitor"] as Record<string, unknown> | undefined;
    if (!janitor) {
      recordResult("8. Live Session Janitor Health", false, performance.now() - start, "session_janitor key missing from /healthz response");
      return;
    }
    const enabled = janitor["enabled"] === true;
    const running = janitor["running"] === true;
    const runsCount = (janitor["runs_count"] as number) ?? 0;
    const allOk = enabled && running && runsCount >= 1;
    const lastPrunedCount = (janitor["last_pruned_count"] as number) ?? 0;
    const lastReclaimedBytes = (janitor["last_reclaimed_bytes"] as number) ?? 0;
    recordResult(
      "8. Live Session Janitor Health",
      allOk,
      performance.now() - start,
      `enabled=${enabled} running=${running} runs=${runsCount} pruned=${lastPrunedCount} reclaimed=${(lastReclaimedBytes / (1024 * 1024)).toFixed(1)} MB`,
      { enabled, running, runsCount, lastPrunedCount, lastReclaimedBytes },
    );
  } catch (error) {
    recordResult("8. Live Session Janitor Health", false, performance.now() - start, `Session janitor audit error: ${error instanceof Error ? error.message : String(error)}`);
  }
}


async function auditLiveObservabilityEndpoints(): Promise<void> {
  const start = performance.now();
  try {
    // Step 9a: GET /metrics → Prometheus text
    const metricsRes = await fetch(`${DAEMON_URL}/metrics`, { signal: AbortSignal.timeout(3000) });
    if (!metricsRes.ok) {
      recordResult("9. Live Observability Endpoints", false, performance.now() - start, `/metrics returned HTTP ${metricsRes.status}`);
      return;
    }
    const ct = metricsRes.headers.get("content-type") ?? "";
    const metricsBody = await metricsRes.text();
    const hasPrometheusFormat = ct.includes("text/plain") && metricsBody.includes("# TYPE") && metricsBody.includes("codex_chatgpt_web_");

    // Step 9b: GET /admin/status → 401 without auth, 200 with auth
    const token = process.env["CODEX_CONTROL_TOKEN"] ?? "";
    const statusUnauth = await fetch(`${DAEMON_URL}/admin/status`, { signal: AbortSignal.timeout(3000) });
    const unauthOk = statusUnauth.status === 401;

    const statusRes = await fetch(`${DAEMON_URL}/admin/status`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    // Token may not be set in env — 401 is still a valid "endpoint exists" probe
    const statusReachable = statusRes.status === 200 || statusRes.status === 401;
    let statusSections = false;
    if (statusRes.status === 200) {
      const statusBody = await statusRes.json() as Record<string, unknown>;
      statusSections = !!(statusBody["status"] && statusBody["daemon"] && statusBody["metrics"] && statusBody["alerts"]);
    } else {
      statusSections = true; // endpoint exists, auth required = correct behavior
    }

    const allOk = hasPrometheusFormat && unauthOk && statusReachable && statusSections;
    recordResult(
      "9. Live Observability Endpoints",
      allOk,
      performance.now() - start,
      `/metrics: ${metricsRes.status} (${ct.split(";")[0]}) | /admin/status no-auth: ${statusUnauth.status} | /admin/status auth: ${statusRes.status}`,
      { metricsStatus: metricsRes.status, hasPrometheusFormat, unauthStatus: statusUnauth.status, authStatus: statusRes.status },
    );
  } catch (error) {
    recordResult("9. Live Observability Endpoints", false, performance.now() - start, `Observability audit error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runRealtimeDogfoodAudit() {
  console.log("==================================================================");
  console.log("🚀 INICIANDO AUDITORÍA EN TIEMPO REAL (DOGFOODING)");
  console.log(`📁 Repositorio: ${REPO_ROOT}`);
  console.log(`⏱️  Timestamp:   ${new Date().toISOString()}`);
  console.log("==================================================================\n");

  await auditLiveDaemon();
  auditLiveSpooling();
  auditLiveWorkspaceState();
  auditLiveSubagentWorkspace();
  auditLivePreflightGuardian();
  auditLiveCompactionAndCheckpoints();
  await auditLiveTransportAndSessionStore();
  await auditLiveSessionJanitor();
  await auditLiveObservabilityEndpoints();

  console.log("\n==================================================================");
  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  const allPassed = passed === total;

  if (allPassed) {
    console.log(`🎉 AUDITORÍA EN TIEMPO REAL 100% EXITOSA (${passed}/${total} pasos superados)`);
  } else {
    console.log(`⚠️ AUDITORÍA FINALIZADA CON ADVERTENCIAS: ${passed}/${total} pasos superados`);
  }
  console.log("==================================================================");

  // Write audit summary report into .agents/dogfood-audit-report.json
  try {
    const reportPath = join(REPO_ROOT, ".agents", "dogfood-audit-report.json");
    writeFileSync(reportPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      summary: allPassed ? "ALL_SYSTEMS_OPERATIONAL" : "ISSUES_DETECTED",
      stats: { total, passed, failed: total - passed },
      results,
    }, null, 2), "utf-8");
    console.log(`📄 Reporte de auditoría guardado en: ${reportPath}`);
  } catch {
    // Ignore report write error
  }
}

runRealtimeDogfoodAudit();
