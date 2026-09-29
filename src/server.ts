import { join } from "node:path";
import { HostHttpRoutes } from "./server/host-routes";
import { createChatGptWebAdapter } from "./adapters/chatgpt-web";
import {
  SessionActorJournal,
  SessionActorManager,
  SessionResultStore,
} from "./adapters/chatgpt-web/session-actor";
import { closeChatGptBrowserWorkers } from "./adapters/chatgpt-web/browser-worker";
import { closeTurnBrokers, TurnBroker } from "./adapters/chatgpt-web/turn-broker";
import { chatGptTurnSessions } from "./adapters/chatgpt-web/turn-execution";
import {
  findTaskResumeConversation,
  TaskResumeOrchestrator,
} from "./adapters/chatgpt-web/task-resume-orchestrator";
import { defaultSubagentGovernor } from "./adapters/chatgpt-web/concurrency";
import { defaultPromptContractCache } from "./adapters/chatgpt-web/prompt";
import { sessionHealthGuard } from "./adapters/chatgpt-web/session-guard";
import { TunnelSupervisor } from "./tunnel-supervisor";
import { formatErrorResponse } from "./bridge";
import type { AppConfig } from "./config";
import { getConfigDir, providerConfig } from "./config";
import {
  readCodexModelContextOverride,
  readCodexSubagentProtocol,
} from "./codex-integration";
import type { NativeFetch, NativeImageEndpoint } from "./native-passthrough";
import { flushResponseState } from "./responses/state";
import { SessionStoreJanitor } from "./adapters/chatgpt-web/session-store-pruner";
import { readLauncherBrowserHostDescriptor } from "./launcher-browser-host";
import { runtimeMetrics } from "./adapters/chatgpt-web/runtime-metrics";
import { SlidingWindowRateLimiter } from "./adapters/chatgpt-web/rate-limiter";
import { CircuitBreaker } from "./adapters/chatgpt-web/circuit-breaker";
import {
  HttpTurnCounter,
  type HttpStreamFailureEvidence,
  type HttpStreamFailureReporter,
  type HttpTrackedEndpoint,
  type NativeCodexTurnIdentity,
} from "./server/http-turn-counter";
import {
  modelsRequest,
  type ModelCatalogFailure,
  modelCatalogFailure,
  modelCatalogClient,
} from "./server/models-route";
import {
  compactRequest,
  isLongReasoningTurn,
  nativeImagesRequest,
  nativeSearchRequest,
  responseRequest,
  routeChatGptWebRequest,
  type ChatGptWebAdapterFactory,
  type ResponseRequestOptions,
} from "./server/response-route";
import { handleAdminRoute, type AdminRouteContext } from "./server/admin-routes";
import { runTaskResumeNote } from "./server/task-resume";

export type {
  NativeCodexTurnIdentity,
  HttpStreamFailureEvidence,
  HttpStreamFailureReporter,
  HttpTrackedEndpoint,
  ModelCatalogFailure,
  ResponseRequestOptions,
  ChatGptWebAdapterFactory,
};

export {
  HttpTurnCounter,
  modelsRequest,
  responseRequest,
  compactRequest,
  routeChatGptWebRequest,
  isLongReasoningTurn,
};

export function startServer(
  config: AppConfig,
  dependencies: {
    fetchUpstream?: NativeFetch;
    adapterFactory?: ChatGptWebAdapterFactory;
    tunnelSupervisor?: TunnelSupervisor;
  } = {},
): ReturnType<typeof Bun.serve> {
  if (config.purpose === "dev-harness") {
    throw new Error("DEV harness configuration cannot start a Responses listener");
  }
  const sessionActorEnabled = !dependencies.adapterFactory
    && config.browserHost === "launcher"
    && config.browserInteractionMode === "automatic";
  const actorDirectory = join(getConfigDir(), "runtime", "session-actors");
  const actorResults = sessionActorEnabled
    ? new SessionResultStore(join(actorDirectory, "results"))
    : undefined;
  const actorJournal = sessionActorEnabled
    ? new SessionActorJournal(join(actorDirectory, "events.sqlite"))
    : undefined;
  const actorManager = actorJournal
    ? new SessionActorManager(actorJournal, actorResults, surfaceId => {
      const descriptorPath = config.browserHostDescriptorPath;
      if (!descriptorPath) throw new Error("Session actor requires a launcher descriptor for surface reconciliation");
      return !Object.hasOwn(readLauncherBrowserHostDescriptor(descriptorPath).surfaceTargets, surfaceId);
    })
    : undefined;
  actorManager?.recoverUncertainOperations();

  const adapterFactory: ChatGptWebAdapterFactory = dependencies.adapterFactory
    ?? (actorManager
      ? provider => createChatGptWebAdapter(provider, { sessionActorManager: actorManager })
      : createChatGptWebAdapter);
  const startedAt = Date.now();
  const turnBroker = config.mode === "full" ? TurnBroker.forSocket(config.brokerSocketPath) : undefined;
  if (config.mode === "full") {
    void turnBroker!.listen().catch(error => {
      console.error(
        `[chatgpt-web] turn broker endpoint is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
  const tunnelSupervisor = dependencies.tunnelSupervisor
    ?? (config.mode === "full" && config.tunnel ? new TunnelSupervisor({ config }) : undefined);
  if (tunnelSupervisor) {
    tunnelSupervisor.start();
  }
  if (config.mode === "full") {
    sessionHealthGuard.startWatchdog(120_000);
  }
  const sessionJanitor = config.mode === "full" ? new SessionStoreJanitor() : undefined;
  if (sessionJanitor) {
    sessionJanitor.start();
  }

  // Sprint H3: background-task resume orchestrator
  const backgroundTasksConfig = (config as AppConfig & {
    backgroundTasks?: { resumeNotes?: boolean };
  }).backgroundTasks;
  const resolveTaskResumeConversationKey = (traceId?: string, turnToken?: string): string | undefined => {
    if (traceId) {
      const bound = findTaskResumeConversation(traceId);
      if (bound) return bound;
    }
    if (turnToken) {
      const resolved = turnBroker?.resolveActiveToken(turnToken);
      const tracedId = resolved?.channel.traceId;
      if (tracedId && tracedId !== "unknown") return findTaskResumeConversation(tracedId);
    }
    return undefined;
  };
  let taskResumeOrchestrator: TaskResumeOrchestrator | undefined;
  taskResumeOrchestrator = config.mode === "full" && config.browserInteractionMode === "automatic"
    ? new TaskResumeOrchestrator({
      findConversationHead: (traceId, turnToken) => {
        const conversationKey = resolveTaskResumeConversationKey(traceId, turnToken);
        return conversationKey ? chatGptTurnSessions.findConversationHead(conversationKey) : undefined;
      },
      runResumeTurn: (conversationKey, noteText) => {
        return runTaskResumeNote(
          providerConfig(config),
          conversationKey,
          noteText,
          taskResumeOrchestrator!.abortSignal,
        );
      },
      resumeNotes: backgroundTasksConfig?.resumeNotes ?? true,
    })
    : undefined;
  if (taskResumeOrchestrator) {
    taskResumeOrchestrator.start();
  }

  let draining = false;
  let shutdownPromise: Promise<void> | undefined;
  let successfulModelCatalogRequests = 0;
  let lastSuccessfulModelCatalogRequestAt: string | null = null;
  let modelCatalogRequests = 0;
  let lastModelCatalogResult: {
    request: number; at: string; status: number; failure?: ModelCatalogFailure;
  } | null = null;
  const httpTurns = new HttpTurnCounter();
  const hostRoutes = new HostHttpRoutes(config, httpTurns, adapterFactory, undefined, undefined, actorManager);

  // Sprint AG: Rate limiter
  const rateLimitRpm = config.rateLimitRpm
    ?? (process.env["CODEX_RATE_LIMIT_RPM"] ? parseInt(process.env["CODEX_RATE_LIMIT_RPM"]!, 10) : 60);
  const responsesRateLimiter = new SlidingWindowRateLimiter({
    limitPerWindow: rateLimitRpm,
    windowMs: 60_000,
    disabled: rateLimitRpm <= 0,
  });

  // Sprint AG: Circuit breaker
  const upstreamCircuitBreaker = new CircuitBreaker({
    name: "chatgpt-upstream",
    errorThreshold: parseInt(process.env["CODEX_CB_ERROR_THRESHOLD"] ?? "3", 10),
    recoveryMs: parseInt(process.env["CODEX_CB_RECOVERY_MS"] ?? "30000", 10),
  });

  const activity = () => ({
    active_http_turns: httpTurns.count(),
    active_browser_turns: chatGptTurnSessions.activeCount() + (turnBroker?.externalOwnerActiveCount() ?? 0),
    active_subagents: defaultSubagentGovernor.active,
    queued_subagents: defaultSubagentGovernor.queued,
    contract_assembly_cache: defaultPromptContractCache.getStats(),
  });

  const adminContext: AdminRouteContext = {
    config,
    startedAt,
    isDraining: () => draining,
    setDraining: value => { draining = value; },
    activity,
    modelCatalogStats: {
      get successfulModelCatalogRequests() { return successfulModelCatalogRequests; },
      get lastSuccessfulModelCatalogRequestAt() { return lastSuccessfulModelCatalogRequestAt; },
      get modelCatalogRequests() { return modelCatalogRequests; },
      get lastModelCatalogResult() { return lastModelCatalogResult; },
    },
    tunnelSupervisor,
    sessionJanitor,
    taskResumeOrchestrator,
    turnBroker,
    sessionActorManager: actorManager,
    httpTurns,
    shutdown: () => shutdown(),
  };

  const createListener = (): ReturnType<typeof Bun.serve> => Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/host/v1/")) {
        if (draining && req.method !== "DELETE" && !url.pathname.endsWith("/cancel")) return formatErrorResponse(503, "server_error", "Host bridge is draining");
        return (await hostRoutes.handle(req))!;
      }

      const adminResponse = await handleAdminRoute(req, url, adminContext);
      if (adminResponse !== undefined) return adminResponse;

      if (req.method === "GET" && url.pathname === "/v1/models") {
        if (draining) {
          return formatErrorResponse(
            503,
            "server_error",
            "codex-chatgpt-web is draining for a requested service operation",
          );
        }
        return httpTurns.track(async signal => {
          const request = ++modelCatalogRequests;
          const started = Date.now();
          const recordResult = (response: Response, failure?: ModelCatalogFailure): Response => {
            const result = { request, at: new Date().toISOString(), status: response.status, caller: modelCatalogClient(req), ...(failure ? { failure } : {}) };
            if (!lastModelCatalogResult || request > lastModelCatalogResult.request) lastModelCatalogResult = result;
            if (!response.ok) {
              try {
                console.warn(`[codex-chatgpt-web] model_catalog_failed ${JSON.stringify({ ...result, elapsedMs: Date.now() - started })}`);
              } catch {}
            }
            return response;
          };
          let catalogConfig: AppConfig;
          try {
            catalogConfig = {
              ...config,
              subagentProtocol: readCodexSubagentProtocol(config.subagentProtocol),
            };
          } catch (error) {
            return recordResult(formatErrorResponse(
              500,
              "server_error",
              `Could not resolve the installed subagent protocol: ${error instanceof Error ? error.message : String(error)}`,
            ), modelCatalogFailure("config", error));
          }
          let failure: ModelCatalogFailure | undefined;
          const response = await modelsRequest(
            new Request(req, { signal }),
            catalogConfig,
            dependencies.fetchUpstream,
            readCodexModelContextOverride,
            value => { failure = value; },
          );
          if (response.ok) {
            successfulModelCatalogRequests += 1;
            lastSuccessfulModelCatalogRequestAt = new Date().toISOString();
          }
          return recordResult(response, failure);
        }, req.signal, process.platform, "models");
      }

      if (req.method === "HEAD" && url.pathname === "/v1/responses") {
        return new Response(null, {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "connection": "keep-alive",
            "allow": "GET, POST, HEAD",
          },
        });
      }

      if (req.method === "GET" && url.pathname === "/v1/responses") {
        return new Response("Responses WebSocket transport is not enabled on this local route", {
          status: 426,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "upgrade": "HTTP/1.1",
            "connection": "Upgrade",
            "sec-websocket-version": "13",
            "x-responses-transport": "sse-required",
          },
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/responses") {
        if (draining) return formatErrorResponse(503, "server_error", "codex-chatgpt-web is draining for a requested service operation");

        // Rate limiting
        const rateLimitKey = req.headers.get("authorization") ?? "anonymous";
        const rlResult = responsesRateLimiter.check(rateLimitKey);
        if (!rlResult.allowed) {
          runtimeMetrics.recordRateLimitRejection();
          const retryAfterSec = Math.ceil(rlResult.retryAfterMs / 1000);
          return new Response(
            JSON.stringify({ error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "Too many requests. Please slow down." } }),
            {
              status: 429,
              headers: {
                "content-type": "application/json",
                "retry-after": String(retryAfterSec),
                "x-ratelimit-limit-requests": String(rlResult.limit),
                "x-ratelimit-remaining-requests": "0",
              },
            },
          );
        }

        // Circuit breaker
        runtimeMetrics.setCircuitBreakerState(upstreamCircuitBreaker.getStateNumeric() as 0 | 1 | 2);
        if (!upstreamCircuitBreaker.isAllowed()) {
          return formatErrorResponse(503, "server_error", "Upstream service is temporarily unavailable (circuit open). Please retry later.");
        }

        return httpTurns.track(
          (signal, bindIdentity) => responseRequest(
            new Request(req, { signal }),
            config,
            adapterFactory,
            { onTurnIdentity: bindIdentity },
          ),
          req.signal,
          process.platform,
          "responses",
        );
      }

      if (req.method === "POST" && url.pathname === "/v1/responses/compact") {
        if (draining) return formatErrorResponse(503, "server_error", "codex-chatgpt-web is draining for a requested service operation");
        return httpTurns.track(
          (signal, bindIdentity) => compactRequest(
            new Request(req, { signal }),
            config,
            adapterFactory,
            { onTurnIdentity: bindIdentity },
          ),
          req.signal,
          process.platform,
          "compact",
        );
      }

      if (req.method === "POST" && url.pathname === "/v1/alpha/search") {
        if (draining) return formatErrorResponse(503, "server_error", "codex-chatgpt-web is draining for a requested service operation");
        return httpTurns.track(
          signal => nativeSearchRequest(new Request(req, { signal }), dependencies.fetchUpstream),
          req.signal,
          process.platform,
          "search",
        );
      }

      if (req.method === "POST"
        && (url.pathname === "/v1/images/generations" || url.pathname === "/v1/images/edits")) {
        if (draining) return formatErrorResponse(503, "server_error", "codex-chatgpt-web is draining for a requested service operation");
        const endpoint: NativeImageEndpoint = url.pathname === "/v1/images/generations"
          ? "images/generations"
          : "images/edits";
        return httpTurns.track(
          signal => nativeImagesRequest(new Request(req, { signal }), endpoint, dependencies.fetchUpstream),
          req.signal,
          process.platform,
          endpoint,
        );
      }

      return new Response("Not found", { status: 404 });
    },
  });
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = createListener();
  } catch (error) {
    sessionJanitor?.stop();
    taskResumeOrchestrator?.stop();
    sessionHealthGuard.stopWatchdog();
    tunnelSupervisor?.stop();
    void hostRoutes.close();
    void turnBroker?.close();
    actorJournal?.close();
    throw error;
  }

  const originalStop = server.stop.bind(server);
  server.stop = async (closeActiveConnections?: boolean) => {
    sessionJanitor?.stop();
    taskResumeOrchestrator?.stop();
    sessionHealthGuard.stopWatchdog();
    tunnelSupervisor?.stop();
    try {
      await hostRoutes.close();
      await originalStop(closeActiveConnections);
    } finally {
      actorJournal?.close();
    }
  };

  function shutdown(): void {
    if (shutdownPromise) return;
    draining = true;
    void hostRoutes.close();
    tunnelSupervisor?.stop();
    sessionHealthGuard.stopWatchdog();
    sessionJanitor?.stop();
    taskResumeOrchestrator?.stop();
    chatGptTurnSessions.clear();
    defaultSubagentGovernor.clear(new Error("Server is shutting down"));
    flushResponseState();
    shutdownPromise = (async () => {
      const results = await Promise.allSettled([
        closeChatGptBrowserWorkers(),
        closeTurnBrokers(),
      ]);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map(result => result.reason);
      if (failures.length > 0) {
        process.exitCode = 1;
        for (const failure of failures) {
          console.error(`[codex-chatgpt-web] shutdown cleanup failed: ${failure instanceof Error ? failure.message : String(failure)}`);
        }
      }
      await server.stop(true);
    })().catch(error => {
      process.exitCode = 1;
      console.error(`[codex-chatgpt-web] server shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}
