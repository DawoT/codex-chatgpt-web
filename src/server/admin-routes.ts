import { timingSafeEqual } from "node:crypto";
import { ChatGptWebAdapterError, chatGptBrowserTabClosedError } from "../adapters/chatgpt-web/adapter-error";
import { dispatchAlertWebhook, getDefaultAlertWebhookUrl } from "../adapters/chatgpt-web/alert-webhook";
import {
  beginCancelStructuredCompactionTrace,
  cancelAllStructuredCompactions,
  cancelStructuredCompactionNativeTurn,
} from "../adapters/chatgpt-web/compaction-handoff";
import { defaultSubagentGovernor } from "../adapters/chatgpt-web/concurrency";
import { workspaceFileCache } from "../adapters/chatgpt-web/fast-path-cache";
import { runtimeMetrics } from "../adapters/chatgpt-web/runtime-metrics";
import type { SessionActorManager } from "../adapters/chatgpt-web/session-actor";
import { sessionHealthGuard } from "../adapters/chatgpt-web/session-guard";
import type { SessionStoreJanitor } from "../adapters/chatgpt-web/session-store-pruner";
import {
  parseTaskCompletionPayload,
  type TaskResumeOrchestrator,
} from "../adapters/chatgpt-web/task-resume-orchestrator";
import type { TurnBroker } from "../adapters/chatgpt-web/turn-broker";
import { chatGptTurnSessions } from "../adapters/chatgpt-web/turn-execution";
import { formatErrorResponse } from "../bridge";
import type { AppConfig } from "../config";
import { readJsonRequestBody } from "../http-body";
import { getObservedHelperDiagnostics, runtimeIdentity } from "../runtime-identity";
import type { TunnelSupervisor } from "../tunnel-supervisor";
import { VERSION } from "../version";
import type { HttpTurnCounter } from "./http-turn-counter";
import type { NativeCodexTurnIdentity } from "./types";

export interface AdminRouteContext {
  config: AppConfig;
  startedAt: number;
  isDraining: () => boolean;
  setDraining: (draining: boolean) => void;
  activity: () => Record<string, unknown>;
  modelCatalogStats: {
    successfulModelCatalogRequests: number;
    lastSuccessfulModelCatalogRequestAt: string | null;
    modelCatalogRequests: number;
    lastModelCatalogResult: unknown;
  };
  tunnelSupervisor?: TunnelSupervisor;
  sessionJanitor?: SessionStoreJanitor;
  taskResumeOrchestrator?: TaskResumeOrchestrator;
  turnBroker?: TurnBroker;
  sessionActorManager?: SessionActorManager;
  httpTurns: HttpTurnCounter;
  shutdown: () => void;
}

export function controlAuthorized(req: Request, controlToken: string): boolean {
  if (!controlToken || typeof controlToken !== "string" || controlToken.trim().length === 0) return false;
  const header = req.headers.get("authorization") ?? "";
  const expected = Buffer.from(`Bearer ${controlToken}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function handleAdminRoute(req: Request, url: URL, ctx: AdminRouteContext): Promise<Response | undefined> {
  const {
    config,
    startedAt,
    isDraining,
    setDraining,
    activity,
    modelCatalogStats,
    tunnelSupervisor,
    sessionJanitor,
    taskResumeOrchestrator,
    turnBroker,
    sessionActorManager,
    httpTurns,
    shutdown,
  } = ctx;
  const isAuthorized = () => controlAuthorized(req, config.controlToken);

  if (req.method === "GET" && url.pathname === "/healthz") {
    const healthzPayload = {
      status: "ok",
      service: "codex-chatgpt-web",
      hostProtocol: 1,
      version: VERSION,
      runtime_identity: runtimeIdentity,
      helper_runtimes: getObservedHelperDiagnostics(),
      mode: config.mode,
      pid: process.pid,
      port: config.port,
      uptime: (Date.now() - startedAt) / 1_000,
      accepting_turns: !isDraining(),
      successful_model_catalog_requests: modelCatalogStats.successfulModelCatalogRequests,
      last_successful_model_catalog_request_at: modelCatalogStats.lastSuccessfulModelCatalogRequestAt,
      model_catalog_requests: modelCatalogStats.modelCatalogRequests,
      last_model_catalog_result: modelCatalogStats.lastModelCatalogResult,
      tunnel_auto_restarts: tunnelSupervisor?.getStats().auto_restarts ?? 0,
      last_tunnel_auto_restart_at: tunnelSupervisor?.getStats().last_auto_restart_at ?? null,
      tunnel_supervisor: tunnelSupervisor?.getStats() ?? {
        enabled: false,
        status: "disabled",
        auto_restarts: 0,
        last_auto_restart_at: null,
        consecutive_failures: 0,
        last_probe_at: null,
        last_probe_ok: null,
        last_probe_detail: null,
        last_error: null,
      },
      fast_path_cache: workspaceFileCache.getStats(),
      auth_session: sessionHealthGuard.getStats(),
      session_janitor: sessionJanitor?.getStats(),
      background_tasks: taskResumeOrchestrator?.getStats() ?? null,
      alerts: runtimeMetrics.getAlerts(),
      ...activity(),
    };
    // Fire-and-forget auto-alert dispatch when alerts are present
    const healthzAlerts = healthzPayload.alerts as ReturnType<typeof runtimeMetrics.getAlerts>;
    const alertWebhookUrl = getDefaultAlertWebhookUrl();
    if (healthzAlerts.length > 0 && alertWebhookUrl != null) {
      void dispatchAlertWebhook(alertWebhookUrl, healthzAlerts, {
        daemonPid: process.pid,
        version: VERSION,
      }).catch(() => {
        /* silently swallow */
      });
    }
    return Response.json(healthzPayload);
  }

  if (req.method === "POST" && (url.pathname === "/admin/drain" || url.pathname === "/admin/resume")) {
    if (!isAuthorized()) return new Response("Unauthorized", { status: 401 });
    const draining = url.pathname === "/admin/drain";
    setDraining(draining);
    turnBroker?.setExternalOwnersAccepted(!draining);
    return Response.json({ status: "ok", accepting_turns: !draining, ...activity() });
  }

  if (req.method === "POST" && url.pathname === "/admin/cancel-turn") {
    if (!isAuthorized()) return new Response("Unauthorized", { status: 401 });
    let traceId: string;
    let leaseFailure: "browser_surface_bootstrap_timeout" | "helper_heartbeat_expired" | undefined;
    try {
      const body = (await readJsonRequestBody(req)) as { traceId?: unknown; reason?: unknown };
      traceId = typeof body?.traceId === "string" ? body.traceId : "";
      if (!/^[A-Za-z0-9_-]{6,128}$/.test(traceId)) throw new Error("traceId is invalid");
      if (body.reason !== undefined) {
        if (body.reason !== "browser_surface_bootstrap_timeout" && body.reason !== "helper_heartbeat_expired") {
          throw new Error("Browser turn cancellation reason is invalid");
        }
        leaseFailure = body.reason;
      }
    } catch (error) {
      return Response.json(
        { status: "error", error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }
    const reason = leaseFailure
      ? new ChatGptWebAdapterError(
          leaseFailure === "browser_surface_bootstrap_timeout"
            ? "The ChatGPT browser turn did not finish browser setup before its lease expired. The turn was stopped."
            : "The ChatGPT browser helper stopped reporting progress and its lease expired. The turn was stopped.",
          { status: 504, errorType: "server_error", code: leaseFailure, retryable: false },
        )
      : chatGptBrowserTabClosedError();
    const actorRevoked = await sessionActorManager?.revokeBrowserTrace(traceId);
    if (sessionActorManager && !actorRevoked) {
      const owner = chatGptTurnSessions.activeActorOwnerForTrace(traceId);
      if (owner) {
        await sessionActorManager.revokeAdmittedTurn(owner.sessionId, owner.turnId, traceId);
      }
    }
    // Revoke the owner first. This prevents a compaction callback that observes its retained
    // source being cancelled below from starting a fresh fallback during operator shutdown.
    const compactionCancellation = beginCancelStructuredCompactionTrace(traceId, reason);
    const browserCancellation = chatGptTurnSessions.beginCancelTrace(traceId, reason);
    const cancelledBrokerTurns = turnBroker?.revokeTrace(traceId, reason) ?? 0;
    const settlement = Promise.all([browserCancellation.settlement, compactionCancellation.settlement]);
    // Explicit tab close acknowledges revoked authority, then destroys its document. Waiting
    // for that document's helper first can deadlock the UI behind a stalled browser operation.
    // Lease cleanup still requires physical settlement before declaring the runtime idle.
    if (leaseFailure) await settlement;
    else
      void settlement.catch((error) =>
        console.error(
          `[chatgpt-web] cancelled turn cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    return Response.json({
      status: "ok",
      trace_id: traceId,
      cancelled_browser_turns: browserCancellation.cancelled,
      cancelled_broker_turns: cancelledBrokerTurns,
      cancelled_compaction_runs: compactionCancellation.cancelled,
      ...activity(),
    });
  }

  if (req.method === "POST" && url.pathname === "/admin/interrupt-turn") {
    if (!isAuthorized()) return new Response("Unauthorized", { status: 401 });
    let identity: NativeCodexTurnIdentity;
    try {
      const body = (await readJsonRequestBody(req)) as { threadId?: unknown; turnId?: unknown };
      const threadId = typeof body?.threadId === "string" ? body.threadId.trim() : "";
      const turnId = typeof body?.turnId === "string" ? body.turnId.trim() : "";
      if (!/^[A-Za-z0-9_-]{6,128}$/.test(threadId) || !/^[A-Za-z0-9_-]{6,128}$/.test(turnId)) {
        throw new Error("native Codex threadId or turnId is invalid");
      }
      identity = { threadId, turnId };
    } catch (error) {
      return Response.json(
        { status: "error", error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }
    const reason = new DOMException("Codex turn interrupted", "AbortError");
    await sessionActorManager?.revokeNativeTurn(identity.threadId, identity.turnId);
    const browserCancellation = chatGptTurnSessions.cancelNativeTurn(identity.threadId, identity.turnId, reason);
    const compactionCancellation = cancelStructuredCompactionNativeTurn(identity.threadId, identity.turnId, reason);
    const httpCancellation = httpTurns.beginCancelTurn(identity, reason);
    const settlement = Promise.allSettled([
      browserCancellation.settlement,
      compactionCancellation.settlement,
      httpCancellation.settlement,
    ]);
    void settlement.then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          console.error(
            `[chatgpt-web] interrupted turn cleanup failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
          );
        }
      }
    });
    return Response.json({
      status: "ok",
      cancelled_http_turns: httpCancellation.cancelled,
      cancelled_browser_turns: browserCancellation.cancelled,
      cancelled_compaction_runs: compactionCancellation.cancelled,
    });
  }

  if (req.method === "POST" && url.pathname === "/admin/cancel-turns") {
    if (!isAuthorized()) return new Response("Unauthorized", { status: 401 });
    const reason = new Error("Active turn cancelled by launcher");
    await sessionActorManager?.revokeAllCurrentTurns();
    const compactionCancellation = cancelAllStructuredCompactions(reason);
    const cancelledBrowserTurns = chatGptTurnSessions.clear() + (turnBroker?.revokeExternalOwners() ?? 0);
    defaultSubagentGovernor.clear(reason);
    const [cancelledHttpTurns, cancelledCompactionRuns] = await Promise.all([
      httpTurns.cancelAll(reason),
      compactionCancellation,
    ]);
    return Response.json({
      status: "ok",
      cancelled_http_turns: cancelledHttpTurns,
      cancelled_browser_turns: cancelledBrowserTurns,
      cancelled_compaction_runs: cancelledCompactionRuns,
      ...activity(),
    });
  }

  if (req.method === "POST" && url.pathname === "/admin/shutdown") {
    if (!isAuthorized()) return new Response("Unauthorized", { status: 401 });
    const current = activity();
    if (!isDraining() || (current.active_http_turns as number) > 0 || (current.active_browser_turns as number) > 0) {
      return Response.json(
        {
          status: "refused",
          accepting_turns: !isDraining(),
          ...current,
        },
        { status: 409 },
      );
    }
    setTimeout(shutdown, 0);
    return Response.json({ status: "ok", accepting_turns: false, ...current });
  }

  if (req.method === "POST" && url.pathname === "/admin/tunnel/restart") {
    if (!isAuthorized()) return new Response("Unauthorized", { status: 401 });
    if (!tunnelSupervisor?.getStats().enabled) {
      return Response.json(
        { status: "disabled", error: "Tunnel supervisor is not enabled on this server" },
        { status: 400 },
      );
    }
    const recovered = await tunnelSupervisor.recover(true);
    return Response.json({
      status: "ok",
      recovered,
      supervisor: tunnelSupervisor.getStats(),
    });
  }

  if (req.method === "POST" && url.pathname === "/admin/session-janitor/run") {
    if (!isAuthorized()) return new Response("Unauthorized", { status: 401 });
    if (!sessionJanitor) {
      return Response.json(
        { status: "disabled", error: "Session janitor is not active on this server" },
        { status: 400 },
      );
    }
    const result = sessionJanitor.runNow();
    return Response.json({
      status: "ok",
      result,
      stats: sessionJanitor.getStats(),
    });
  }

  if (req.method === "POST" && url.pathname === "/internal/tasks/completed") {
    if (!taskResumeOrchestrator) {
      return formatErrorResponse(503, "server_error", "Background task resume notes are not active on this server");
    }
    try {
      const payload = parseTaskCompletionPayload(await readJsonRequestBody(req));
      taskResumeOrchestrator.recordCompletion(payload);
      return Response.json({ accepted: true }, { status: 202 });
    } catch (error) {
      return Response.json(
        { accepted: false, error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }
  }

  if (req.method === "GET" && url.pathname === "/admin/tasks") {
    if (!isAuthorized()) return new Response("Unauthorized", { status: 401 });
    return Response.json({
      status: "ok",
      stats: taskResumeOrchestrator?.getStats() ?? null,
      recent: taskResumeOrchestrator?.getRecent() ?? [],
    });
  }

  if (req.method === "GET" && url.pathname === "/metrics") {
    const body = runtimeMetrics.serializePrometheusMetrics();
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
    });
  }

  if (req.method === "GET" && url.pathname === "/admin/status") {
    if (!isAuthorized()) return new Response("Unauthorized", { status: 401 });
    const janitorStats = sessionJanitor?.getStats() as Record<string, unknown> | undefined;
    const tunnelStats = tunnelSupervisor?.getStats() as Record<string, unknown> | undefined;
    const body = runtimeMetrics.buildAdminStatus({
      daemonPid: process.pid,
      version: VERSION,
      mode: config.mode,
      uptimeMs: Date.now() - startedAt,
      janitorStats,
      tunnelStats,
    });
    return Response.json({
      ...body,
      runtime_identity: runtimeIdentity,
      helper_runtimes: getObservedHelperDiagnostics(),
    });
  }

  return undefined;
}
