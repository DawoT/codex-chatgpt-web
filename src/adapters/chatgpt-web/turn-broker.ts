import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { isWindowsPipeEndpoint } from "../../config";
import { runtimeIdentity } from "../../runtime-identity";
import { namespacedToolName } from "../../types";
import { type CompactionTransactionHandle, CompactionTransactionStore } from "./compaction-transaction";
import type { ChatGptTurnEnvironment } from "./environment";
import { McpTelemetry } from "./mcp-telemetry";
import { ToolDeliveryLifecycle, type ToolDeliveryPhase } from "./tool-delivery-lifecycle";
import {
  TurnBrokerProtocolError,
  TurnBrokerRequestError,
  TurnBrokerStateError,
  TurnBrokerTokenError,
} from "./turn-broker/errors";
import {
  assertSurfaceNonce,
  DEFAULT_INTER_TURN_GRACE_WAIT_MS,
  environmentIdentity,
  errorOf,
  handleFingerprint,
  MAX_ACTIVITY_LIVENESS_MS,
  MAX_BROKER_LINE_CHARS,
  MAX_COMPLETED_ACTIVITY_TOMBSTONES,
  MAX_RETIRED_TURN_HANDLES,
  MAX_TOKEN_ALIASES,
  MAX_UNIX_SOCKET_PATH_BYTES,
  opaqueId,
  ownerEnvironment,
  retiredTurnLabel,
  trimOldest,
} from "./turn-broker/helpers";
import {
  activateSafeTurn,
  assertSafeHarnessRunning,
  assertSafeNonce,
  rejectSafeWaiters,
  resolveSafeWaiters,
  waitForSafeState,
} from "./turn-broker/safe-state";
import type {
  BrokerRequest,
  BrokerResponse,
  BrokerToolRequest,
  BrokerToolResult,
  SafeTurnState,
  ToolWaiter,
  TurnBrokerOwner,
  TurnChannel,
} from "./turn-broker/types";
import { injectGracefulYieldNoticeIfRecommended } from "./turn-broker/yield-notice";

export { callTurnBroker, TurnBrokerTimeoutError } from "./turn-broker/client";
export { RemoteTurnBroker } from "./turn-broker/remote";
export type { BrokerToolRequest, BrokerToolResult, SafeTurnState, TurnBrokerOwner };

const brokers = new Map<string, TurnBroker>();

export async function closeTurnBrokers(): Promise<void> {
  const active = [...brokers.values()];
  const results = await Promise.allSettled(active.map((broker) => broker.close()));
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} ChatGPT turn broker(s) failed to close`);
  }
}

export class TurnBroker implements TurnBrokerOwner {
  static forSocket(
    path: string,
    activityLivenessMs = MAX_ACTIVITY_LIVENESS_MS,
    interTurnGraceWaitMs = DEFAULT_INTER_TURN_GRACE_WAIT_MS,
  ): TurnBroker {
    let broker = brokers.get(path);
    if (!broker) {
      broker = new TurnBroker(path, activityLivenessMs, interTurnGraceWaitMs);
      brokers.set(path, broker);
    }
    return broker;
  }

  private readonly channels = new Map<string, TurnChannel>();
  private readonly telemetry = new McpTelemetry();
  private readonly pending = new Map<string, TurnChannel>();
  private readonly compactionTransactions = new CompactionTransactionStore();
  private readonly bindings = new Map<string, { token: string; channel: TurnChannel }>();
  // The Codex context replayed into ChatGPT still carries the handles of finished turns, so a model
  // can present one. Remembering which turn retired a handle is what separates "you are holding a
  // previous turn's handle" from "this handle never existed".
  private readonly retiredBindings = new Map<string, string>();
  private readonly retiredTokens = new Map<string, string>();
  private readonly tokenAliases = new Map<string, string>();
  private readonly traceActiveTokens = new Map<string, string>();
  private readonly traceTokens = new Map<string, string[]>();
  private readonly threadActiveTokens = new Map<string, string>();
  private readonly threadTokens = new Map<string, string[]>();
  private readonly retiredTokenThreads = new Map<string, string>();
  private readonly threadSuccessorWaiters = new Map<string, Set<(token: string) => void>>();
  private acceptingExternalOwners = true;
  private server?: Server;
  private startPromise?: Promise<void>;
  private socketIdentity?: { dev: number; ino: number };

  private constructor(
    readonly socketPath: string,
    private readonly activityLivenessMs = MAX_ACTIVITY_LIVENESS_MS,
    private readonly interTurnGraceWaitMs = DEFAULT_INTER_TURN_GRACE_WAIT_MS,
  ) {}

  /**
   * A ChatGPT turn outlives the request that started it, and its Codex Native calls arrive from a
   * separate MCP process. Creating the socket only once a turn registers leaves that process
   * connecting to a path that does not exist yet, so an in-flight turn reports a filesystem error
   * instead of the broker's own answer. The endpoint belongs to the runtime's lifetime.
   */
  async listen(): Promise<void> {
    await this.start();
  }

  registerAlias(oldToken: string, newToken: string): void {
    if (oldToken.startsWith("host_") || newToken.startsWith("host_")) {
      throw new TurnBrokerProtocolError("host-only capabilities cannot be aliased");
    }
    // Re-inserting refreshes recency, so a re-registered alias is evicted last (LRU, not FIFO).
    this.tokenAliases.delete(oldToken);
    this.tokenAliases.set(oldToken, newToken);
    trimOldest(this.tokenAliases, MAX_TOKEN_ALIASES);
    console.info(
      `[chatgpt-web] broker registered alias ${handleFingerprint(oldToken)} -> ${handleFingerprint(newToken)}`,
    );
  }

  resolveActiveToken(token: string): { resolvedToken: string; channel: TurnChannel } | undefined {
    const directChannel = this.channels.get(token);
    if (directChannel && !directChannel.completionCommitted) {
      return { resolvedToken: token, channel: directChannel };
    }
    // Host capabilities are exact and irrevocable; never recover them through Codex lineage.
    if (token.startsWith("host_")) return undefined;
    // 1. Follow explicit alias chain
    let curr = token;
    const visited = new Set<string>([curr]);
    while (this.tokenAliases.has(curr)) {
      curr = this.tokenAliases.get(curr)!;
      if (visited.has(curr)) break;
      visited.add(curr);
      const target = this.channels.get(curr);
      if (target && target.environment.execution !== "host-only" && !target.completionCommitted) {
        return { resolvedToken: curr, channel: target };
      }
    }
    // 2. Trace lineage lookup: if this token was associated with a trace, check active token
    const traceId = directChannel?.traceId ?? this.retiredTokens.get(token);
    if (traceId && traceId !== "unknown") {
      const activeToken = this.traceActiveTokens.get(traceId);
      if (activeToken) {
        const activeChannel = this.channels.get(activeToken);
        if (
          activeChannel &&
          activeChannel.environment.execution !== "host-only" &&
          !activeChannel.completionCommitted
        ) {
          return { resolvedToken: activeToken, channel: activeChannel };
        }
      }
      const allForTrace = this.traceTokens.get(traceId);
      if (allForTrace) {
        for (let i = allForTrace.length - 1; i >= 0; i--) {
          const cand = allForTrace[i];
          const candChannel = this.channels.get(cand);
          if (candChannel && candChannel.environment.execution !== "host-only" && !candChannel.completionCommitted) {
            return { resolvedToken: cand, channel: candChannel };
          }
        }
      }
    }
    // 3. Thread lineage lookup: if this token was associated with a thread, check active token
    const threadId = directChannel?.threadId ?? this.retiredTokenThreads.get(token);
    if (threadId && threadId !== "unknown") {
      const activeToken = this.threadActiveTokens.get(threadId);
      if (activeToken) {
        const activeChannel = this.channels.get(activeToken);
        if (
          activeChannel &&
          activeChannel.environment.execution !== "host-only" &&
          !activeChannel.completionCommitted
        ) {
          this.registerAlias(token, activeToken);
          return { resolvedToken: activeToken, channel: activeChannel };
        }
      }
      const allForThread = this.threadTokens.get(threadId);
      if (allForThread) {
        for (let i = allForThread.length - 1; i >= 0; i--) {
          const cand = allForThread[i];
          const candChannel = this.channels.get(cand);
          if (candChannel && candChannel.environment.execution !== "host-only" && !candChannel.completionCommitted) {
            this.registerAlias(token, cand);
            return { resolvedToken: cand, channel: candChannel };
          }
        }
      }
    }
    return undefined;
  }

  async register(
    environment: ChatGptTurnEnvironment,
    ttlMs?: number,
    traceId = "unknown",
    externalOwner = false,
    handlePrefix = "turn",
    predecessorToken?: string,
    threadId?: string,
  ): Promise<string> {
    if (environment.execution !== undefined) environment = ownerEnvironment(environment);
    if (predecessorToken && (environment.execution === "host-only" || predecessorToken.startsWith("host_"))) {
      throw new TurnBrokerProtocolError("host-only capabilities cannot inherit predecessor aliases");
    }
    await this.start();
    this.prune();
    if (externalOwner && !this.acceptingExternalOwners) {
      throw new TurnBrokerStateError("turn broker is draining and does not accept new external owners");
    }
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new TurnBrokerProtocolError("ChatGPT web turn broker TTL must be a positive finite number");
    }
    const token = opaqueId(environment.execution === "host-only" ? `host_${handlePrefix}` : handlePrefix);
    const channel: TurnChannel = {
      traceId,
      ...(threadId ? { threadId } : {}),
      externalOwner,
      environment: {
        ...environment,
        ...(ttlMs !== undefined ? { expiresAt: Date.now() + ttlMs } : {}),
      },
      queuedCallIds: [],
      deliveredCallIds: new Set(),
      invocations: new Map(),
      waiters: new Set(),
      compactionRequested: false,
      compactionDeliveryCount: 0,
      completedToolsCount: 0,
      activities: new Map(),
      completedActivities: new Set(),
      activityRevision: 0,
      completionCommitted: false,
      retirementWaiters: new Set(),
      claimWaiters: new Set(),
    };
    this.channels.set(token, channel);
    this.pending.set(token, channel);
    if (predecessorToken) {
      this.tokenAliases.set(predecessorToken, token);
      trimOldest(this.tokenAliases, MAX_TOKEN_ALIASES);
    }
    if (traceId && traceId !== "unknown") {
      this.traceActiveTokens.set(traceId, token);
      const list = this.traceTokens.get(traceId) ?? [];
      list.push(token);
      this.traceTokens.set(traceId, list);
    }
    if (threadId && threadId !== "unknown" && environment.execution !== "host-only") {
      this.threadActiveTokens.set(threadId, token);
      const list = this.threadTokens.get(threadId) ?? [];
      list.push(token);
      this.threadTokens.set(threadId, list);
      const waiters = this.threadSuccessorWaiters.get(threadId);
      if (waiters) {
        for (const waiter of waiters) waiter(token);
        this.threadSuccessorWaiters.delete(threadId);
      }
    }
    console.info(
      `[chatgpt-web] broker trace=${traceId} registered tokenHash=${handleFingerprint(token)}${predecessorToken ? ` predecessor=${handleFingerprint(predecessorToken)}` : ""}${threadId ? ` threadId=${threadId}` : ""}`,
    );
    return token;
  }

  async registerSafe(
    environment: ChatGptTurnEnvironment,
    surfaceNonce: string,
    ttlMs?: number,
    traceId = "unknown",
    externalOwner = false,
    predecessorToken?: string,
    threadId?: string,
  ): Promise<string> {
    assertSurfaceNonce(surfaceNonce);
    const token = await this.register(
      environment,
      ttlMs,
      traceId,
      externalOwner,
      "request",
      predecessorToken,
      threadId,
    );
    const channel = this.channels.get(token);
    if (!channel) throw new TurnBrokerStateError("Zero Risk turn registration was revoked before initialization");
    channel.safe = {
      state: "awaiting_start",
      surfaceNonce,
      launcherSent: false,
      connectorStarted: false,
      sentWaiters: new Set(),
      startWaiters: new Set(),
      completionWaiters: new Set(),
    };
    return token;
  }

  async beginCompactionTransaction(traceId: string, ttlMs = 120_000): Promise<CompactionTransactionHandle> {
    await this.start();
    return this.compactionTransactions.begin(traceId, ttlMs);
  }

  waitForCompactionHandoff(token: string, signal?: AbortSignal): Promise<string> {
    return this.compactionTransactions.wait(token, signal);
  }

  abortCompactionTransaction(token: string): void {
    this.compactionTransactions.abort(token);
  }

  revokeCompactionTransactions(traceId: string): void {
    this.compactionTransactions.abortTrace(traceId);
  }

  updateEnvironment(token: string, environment: ChatGptTurnEnvironment): void {
    if (environment.execution !== undefined) environment = ownerEnvironment(environment);
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new TurnBrokerTokenError("turn token is invalid or expired");
    if (environmentIdentity(channel.environment) !== environmentIdentity(environment)) {
      throw new TurnBrokerStateError("Codex turn environment changed during an active ChatGPT tool loop");
    }
    if (channel.safe?.state === "revoked") throw new TurnBrokerStateError("Zero Risk turn is already terminal");
    // A no-tool Zero Risk answer can complete before its outer Responses observer reaches this owner
    // readback. The environment is already proven identical, so completion makes this a no-op.
    if (channel.safe?.state === "completed") return;
    channel.environment = {
      ...environment,
      ...(channel.environment.expiresAt !== undefined ? { expiresAt: channel.environment.expiresAt } : {}),
    };
  }

  async nextToolBatch(token: string, signal?: AbortSignal): Promise<BrokerToolRequest[]> {
    this.prune();
    let channel = this.channels.get(token);
    if (!channel) throw new TurnBrokerTokenError("turn token is invalid or expired");
    if (signal?.aborted) throw new DOMException("tool wait aborted", "AbortError");
    if (channel.safe?.state === "awaiting_start") {
      // The outer Codex adapter owns this wait. It crosses the start boundary only after the user
      // confirms in the Launcher that the copied prompt was sent in the visible ChatGPT tab.
      await this.waitForSafeStart(token, signal);
      this.prune();
      channel = this.channels.get(token);
      if (!channel) throw new TurnBrokerTokenError("turn token is invalid or expired");
      if (signal?.aborted) throw new DOMException("tool wait aborted", "AbortError");
    }
    // This owner-only empty batch tells the adapter to consume the already accepted completion.
    // Public Zero Risk MCP calls remain fail-closed after the turn reaches its terminal state.
    if (channel.safe?.state === "completed") return [];
    assertSafeHarnessRunning(channel);
    if (channel.compactionRequested) {
      throw new TurnBrokerStateError("Codex context compaction superseded ordinary MCP tool delivery");
    }
    // Delivery is at-least-once until Codex returns the corresponding tool result. If the HTTP
    // observer disconnects after the broker handed off a batch but before the adapter journaled
    // it, the exact reconnect receives the same call ids instead of losing the model's invocation.
    const delivered = [...channel.deliveredCallIds]
      .map((id) => channel.invocations.get(id)?.request)
      .filter((request): request is BrokerToolRequest => Boolean(request));
    if (delivered.length > 0) {
      this.logToolDelivery(channel, delivered, "replay");
      return delivered;
    }
    const ready = this.takeQueued(channel);
    if (ready.length > 0) {
      this.logToolDelivery(channel, ready, "immediate");
      return ready;
    }
    return new Promise<BrokerToolRequest[]>((resolveWait, rejectWait) => {
      const waiter: ToolWaiter = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          channel.waiters.delete(waiter);
          rejectWait(new DOMException("tool wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      channel.waiters.add(waiter);
    });
  }

  completeTool(token: string, callId: string, result: BrokerToolResult): void {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new TurnBrokerTokenError("turn token is invalid or expired");
    assertSafeHarnessRunning(channel, true);
    const invocation = channel.invocations.get(callId);
    if (!invocation) throw new TurnBrokerProtocolError(`tool call is not pending: ${callId}`);
    if (!channel.deliveredCallIds.delete(callId)) {
      throw new TurnBrokerProtocolError(`tool call was completed before it was delivered: ${callId}`);
    }
    if (invocation.lifecycle.current() === "codex_emitted") {
      this.recordToolLifecyclePhase(token, callId, "host_started", "proven_by_result_arrival");
    }
    if (invocation.lifecycle.current() === "host_started") {
      invocation.lifecycle.mark("result_received");
      this.recordToolObservation(
        invocation.request,
        "result_received",
        result.isError === true,
        invocation.observedStarted,
        "tool_result",
      );
    }
    channel.invocations.delete(callId);
    this.recordToolObservation(
      invocation.request,
      "broker_result_received",
      result.isError === true,
      invocation.observedStarted,
    );
    channel.completedToolsCount = (channel.completedToolsCount ?? 0) + 1;
    const finalResult = injectGracefulYieldNoticeIfRecommended(result, channel.completedToolsCount);
    console.info(
      `[chatgpt-web] broker trace=${channel.traceId} completed call=${callId.slice(0, 17)} count=${channel.completedToolsCount} pending=${channel.invocations.size}`,
    );
    invocation.resolve(finalResult);
  }

  recordToolLifecyclePhase(token: string, callId: string, phase: ToolDeliveryPhase, evidence?: string): void {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new TurnBrokerTokenError("turn token is invalid or expired");
    const invocation = channel.invocations.get(callId);
    if (!invocation) throw new TurnBrokerProtocolError(`tool call is not pending: ${callId}`);
    if (invocation.lifecycle.mark(phase)) {
      this.recordToolObservation(invocation.request, phase, false, invocation.observedStarted, evidence);
    }
  }

  /**
   * Refreshes an MCP activity lease without a causal event.
   *
   * A handler that chains several invokes under one claim can spend longer than the activity
   * liveness bound between invokes; with no pending invocation there is nothing else keeping the
   * lease alive, so the sweep would liquidate it and the next invoke would die against a
   * committed fence. Touching resets `claimedAt` only: `activities.size` already vetoes the
   * completion fence, so a touch must not move `activityRevision` and would only break fence
   * begins captured in flight. An activity that is gone (settled, swept, or on a dead channel)
   * returns false and is never revived.
   */
  touchActivity(token: string, activityId: string): boolean {
    this.prune();
    const channel = this.resolveActiveToken(token)?.channel;
    if (!channel?.activities.has(activityId)) return false;
    channel.activities.set(activityId, Date.now());
    return true;
  }

  beginCompletionFence(token: string): number | undefined {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new TurnBrokerTokenError("turn token is invalid or expired");
    if (channel.completionCommitted) return channel.completionRevision;
    if (channel.activities.size > 0 || channel.invocations.size > 0) return undefined;
    return channel.activityRevision;
  }

  commitCompletionFence(token: string, revision: number): boolean {
    this.prune();
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new TurnBrokerProtocolError("turn completion fence revision is invalid");
    }
    const channel = this.channels.get(token);
    if (!channel) throw new TurnBrokerTokenError("turn token is invalid or expired");
    if (channel.completionCommitted) return channel.completionRevision === revision;
    if (channel.activityRevision !== revision || channel.activities.size > 0 || channel.invocations.size > 0)
      return false;
    channel.completionCommitted = true;
    channel.completionRevision = revision;
    console.info(`[chatgpt-web] broker trace=${channel.traceId} committed browser completion revision=${revision}`);
    return true;
  }

  waitForRetirement(token: string, signal?: AbortSignal): Promise<void> {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) return Promise.resolve();
    return waitForSafeState(channel.retirementWaiters, signal, "turn retirement wait aborted");
  }

  waitForClaim(token: string, signal?: AbortSignal): Promise<void> {
    this.prune();
    const resolved = this.resolveActiveToken(token);
    const channel = resolved?.channel ?? this.channels.get(token);
    if (!channel || channel.bindingId) return Promise.resolve();
    return waitForSafeState(channel.claimWaiters, signal, "turn claim wait aborted");
  }

  requestCompaction(token: string, queuedResult: BrokerToolResult): number {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new TurnBrokerTokenError("turn token is invalid or expired");
    assertSafeHarnessRunning(channel);
    if (channel.compactionRequested) {
      throw new TurnBrokerStateError("Codex context compaction was already requested for this turn");
    }
    channel.compactionRequested = true;
    channel.compactionResult = structuredClone(queuedResult);
    if (channel.batchTimer) {
      clearTimeout(channel.batchTimer);
      channel.batchTimer = undefined;
    }
    const queued = channel.queuedCallIds.splice(0);
    for (const callId of queued) {
      const invocation = channel.invocations.get(callId);
      if (!invocation) continue;
      channel.invocations.delete(callId);
      channel.compactionDeliveryCount += 1;
      this.recordToolObservation(invocation.request, "broker_compaction_cancelled", false, invocation.observedStarted);
      invocation.resolve(structuredClone(queuedResult));
    }
    if (queued.length > 0) {
      console.info(
        `[chatgpt-web] broker trace=${channel.traceId} interrupted queued calls=${queued.length} for context compaction`,
      );
    }
    return queued.length;
  }

  compactionDeliveryCount(token: string): number {
    const channel = this.channels.get(token);
    if (!channel) throw new TurnBrokerStateError("Cannot read compaction delivery after the turn capability retired");
    return channel.compactionDeliveryCount;
  }

  startSafeTurn(requestId: string): { started: true; duplicate: boolean } {
    this.prune();
    const channel = this.channels.get(requestId);
    if (!channel) throw new TurnBrokerRequestError("Zero Risk request_id is invalid, expired, or revoked");
    const safe = channel.safe;
    if (!safe) throw new TurnBrokerRequestError("request_id is not registered for Zero Risk browser interaction");
    if (safe.state === "completed" || safe.state === "revoked") {
      throw new TurnBrokerStateError("Zero Risk turn is already terminal");
    }
    if (safe.connectorStarted) return { started: true, duplicate: true };
    safe.connectorStarted = true;
    activateSafeTurn(channel, safe);
    return { started: true, duplicate: false };
  }

  confirmSafeTurnSent(requestId: string, surfaceNonce: string): { confirmed: true; duplicate: boolean } {
    this.prune();
    assertSurfaceNonce(surfaceNonce);
    const channel = this.channels.get(requestId);
    if (!channel) throw new TurnBrokerRequestError("Zero Risk request_id is invalid, expired, or revoked");
    const safe = channel.safe;
    if (!safe) throw new TurnBrokerRequestError("request_id is not registered for Zero Risk browser interaction");
    assertSafeNonce(safe, surfaceNonce);
    if (safe.state === "completed" || safe.state === "revoked") {
      throw new TurnBrokerStateError("Zero Risk turn is already terminal");
    }
    if (safe.launcherSent) return { confirmed: true, duplicate: true };
    safe.launcherSent = true;
    resolveSafeWaiters(safe.sentWaiters, undefined);
    activateSafeTurn(channel, safe);
    return { confirmed: true, duplicate: false };
  }

  completeSafeTurn(requestId: string, finalAnswer: string): { completed: true; duplicate: boolean } {
    this.prune();
    if (typeof finalAnswer !== "string" || finalAnswer.trim().length === 0) {
      throw new TurnBrokerProtocolError("Zero Risk turn final_answer must not be empty");
    }
    const channel = this.channels.get(requestId);
    if (!channel) throw new TurnBrokerRequestError("Zero Risk request_id is invalid, expired, or revoked");
    const safe = channel.safe;
    if (!safe) throw new TurnBrokerRequestError("request_id is not registered for Zero Risk browser interaction");
    if (safe.state === "completed") {
      if (safe.finalAnswer !== finalAnswer) {
        throw new TurnBrokerStateError("Zero Risk turn completion conflicts with the accepted final_answer");
      }
      return { completed: true, duplicate: true };
    }
    if (safe.state === "revoked") throw new TurnBrokerStateError("Zero Risk turn is already terminal");
    if (safe.state !== "running") throw new TurnBrokerStateError("Zero Risk turn has not started");
    if (channel.invocations.size > 0) {
      throw new TurnBrokerProtocolError(
        `Zero Risk turn cannot complete with ${channel.invocations.size} pending Codex tool invocation(s)`,
      );
    }
    if (channel.activities.size > 0) {
      throw new TurnBrokerProtocolError(
        `Zero Risk turn cannot complete with ${channel.activities.size} active Codex MCP request(s)`,
      );
    }
    safe.state = "completed";
    safe.finalAnswer = finalAnswer;
    resolveSafeWaiters(safe.completionWaiters, finalAnswer);
    console.info(`[chatgpt-web] broker trace=${channel.traceId} accepted safe completion`);
    return { completed: true, duplicate: false };
  }

  waitForSafeStart(requestId: string, signal?: AbortSignal): Promise<void> {
    this.prune();
    const channel = this.channels.get(requestId);
    if (!channel) return Promise.reject(new Error("Zero Risk request_id is invalid, expired, or revoked"));
    const safe = channel.safe;
    if (!safe) return Promise.reject(new Error("request_id is not registered for Zero Risk browser interaction"));
    if (safe.state === "running" || safe.state === "completed") return Promise.resolve();
    if (safe.state === "revoked") return Promise.reject(new Error("Zero Risk turn was revoked"));
    return waitForSafeState(safe.startWaiters, signal, "Zero Risk turn start wait aborted");
  }

  private waitForSafeSent(requestId: string, signal?: AbortSignal): Promise<void> {
    this.prune();
    const channel = this.channels.get(requestId);
    if (!channel) return Promise.reject(new Error("Zero Risk request_id is invalid, expired, or revoked"));
    const safe = channel.safe;
    if (!safe) return Promise.reject(new Error("request_id is not registered for Zero Risk browser interaction"));
    if (safe.launcherSent) return Promise.resolve();
    if (safe.state === "revoked") return Promise.reject(new Error("Zero Risk turn was revoked"));
    return waitForSafeState(safe.sentWaiters, signal, "Zero Risk turn Sent wait aborted");
  }

  waitForSafeCompletion(requestId: string, signal?: AbortSignal): Promise<string> {
    this.prune();
    const channel = this.channels.get(requestId);
    if (!channel) return Promise.reject(new Error("Zero Risk request_id is invalid, expired, or revoked"));
    const safe = channel.safe;
    if (!safe) return Promise.reject(new Error("request_id is not registered for Zero Risk browser interaction"));
    if (safe.state === "completed" && safe.finalAnswer !== undefined) return Promise.resolve(safe.finalAnswer);
    if (safe.state === "revoked") return Promise.reject(new Error("Zero Risk turn was revoked"));
    return waitForSafeState(safe.completionWaiters, signal, "Zero Risk turn completion wait aborted");
  }

  revoke(token: string, reason = new Error("Codex turn binding was revoked")): void {
    const channel = this.channels.get(token);
    if (!channel) return;
    console.info(
      `[chatgpt-web] broker_retired ${JSON.stringify({
        traceId: channel.traceId,
        pendingTools: channel.invocations.size,
        queuedTools: channel.queuedCallIds.length,
        deliveredTools: channel.deliveredCallIds.size,
        activeMcpRequests: channel.activities.size,
        completionCommitted: channel.completionCommitted,
      })}`,
    );
    this.channels.delete(token);
    this.pending.delete(token);
    if (this.traceActiveTokens.get(channel.traceId) === token) {
      this.traceActiveTokens.delete(channel.traceId);
    }
    if (channel.bindingId) {
      this.bindings.delete(channel.bindingId);
      this.retire(this.retiredBindings, channel.bindingId, channel.traceId);
    }
    if (channel.safe) {
      channel.safe.state = "revoked";
      rejectSafeWaiters(channel.safe.sentWaiters, reason);
      rejectSafeWaiters(channel.safe.startWaiters, reason);
      rejectSafeWaiters(channel.safe.completionWaiters, reason);
    }
    this.retire(this.retiredTokens, token, channel.traceId);
    if (channel.threadId && channel.environment.execution !== "host-only") {
      this.retire(this.retiredTokenThreads, token, channel.threadId);
      if (this.threadActiveTokens.get(channel.threadId) === token) {
        this.threadActiveTokens.delete(channel.threadId);
      }
      const threadLineage = this.threadTokens.get(channel.threadId);
      if (threadLineage) {
        const index = threadLineage.indexOf(token);
        if (index >= 0) threadLineage.splice(index, 1);
        if (threadLineage.length === 0) this.threadTokens.delete(channel.threadId);
      }
    }
    // Lineage that routes into this token would fail closed anyway (its channel is gone), but
    // leaving it behind keeps the singleton's maps growing for the process lifetime and lets a
    // stale alias chain hop through the revoked handle instead of failing closed here.
    for (const [alias, target] of this.tokenAliases) {
      if (target === token) this.tokenAliases.delete(alias);
    }
    const traceLineage = this.traceTokens.get(channel.traceId);
    if (traceLineage) {
      const index = traceLineage.indexOf(token);
      if (index >= 0) traceLineage.splice(index, 1);
      if (traceLineage.length === 0) this.traceTokens.delete(channel.traceId);
    }
    resolveSafeWaiters(channel.retirementWaiters, undefined);
    this.rejectChannel(channel, reason);
  }

  externalOwnerActiveCount(): number {
    this.prune();
    return [...this.channels.values()].filter((channel) => channel.externalOwner).length;
  }

  revokeExternalOwners(): number {
    const tokens = [...this.channels].filter(([, channel]) => channel.externalOwner).map(([token]) => token);
    for (const token of tokens) this.revoke(token);
    return tokens.length;
  }

  revokeTrace(traceId: string, reason = new Error("Codex turn binding was revoked")): number {
    const tokens = [...this.channels].filter(([, channel]) => channel.traceId === traceId).map(([token]) => token);
    for (const token of tokens) this.revoke(token, reason);
    return tokens.length;
  }

  setExternalOwnersAccepted(accepted: boolean): void {
    this.acceptingExternalOwners = accepted;
  }

  private retire(history: Map<string, string>, handle: string, traceId: string): void {
    history.delete(handle);
    history.set(handle, traceId);
    trimOldest(history, MAX_RETIRED_TURN_HANDLES);
  }

  async close(): Promise<void> {
    this.compactionTransactions.close();
    for (const token of [...this.channels.keys()]) this.revoke(token);
    this.tokenAliases.clear();
    this.traceActiveTokens.clear();
    this.traceTokens.clear();
    this.threadActiveTokens.clear();
    this.threadTokens.clear();
    this.retiredTokenThreads.clear();
    this.threadSuccessorWaiters.clear();
    const server = this.server;
    const socketIdentity = this.socketIdentity;
    this.socketIdentity = undefined;
    this.server = undefined;
    this.startPromise = undefined;
    brokers.delete(this.socketPath);
    if (server?.listening) {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => {
          if (!error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") resolveClose();
          else rejectClose(error);
        }),
      );
    }
    if (socketIdentity && !isWindowsPipeEndpoint(this.socketPath) && existsSync(this.socketPath)) {
      const current = lstatSync(this.socketPath);
      if (current.isSocket() && current.dev === socketIdentity.dev && current.ino === socketIdentity.ino) {
        unlinkSync(this.socketPath);
      }
    }
  }

  private start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    let attemptServer: Server | undefined;
    const attempt = new Promise<void>((resolveStart, rejectStart) => {
      const windowsPipe = isWindowsPipeEndpoint(this.socketPath);
      if (!windowsPipe) {
        // sun_path is a fixed-size field in the kernel, so an over-long path fails inside listen()
        // with nothing but "Failed to listen" and no hint that the length is the problem. Say so.
        const encodedLength = Buffer.byteLength(this.socketPath);
        if (encodedLength > MAX_UNIX_SOCKET_PATH_BYTES) {
          rejectStart(
            new Error(
              `ChatGPT web broker socket path is ${encodedLength} bytes, over the` +
                ` ${MAX_UNIX_SOCKET_PATH_BYTES}-byte limit this platform allows for a Unix socket:` +
                ` ${this.socketPath}. Choose a shorter runtime directory.`,
            ),
          );
          return;
        }
        mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 });
      }
      const listen = () => {
        const server = createServer((socket) => this.handleSocket(socket));
        attemptServer = server;
        this.server = server;
        server.once("error", rejectStart);
        server.on("error", (error) => {
          console.error(`[chatgpt-web] turn broker server error at ${this.socketPath}: ${errorOf(error).message}`);
        });
        server.listen(this.socketPath, () => {
          server.off("error", rejectStart);
          if (!windowsPipe) {
            chmodSync(this.socketPath, 0o600);
            const owned = lstatSync(this.socketPath);
            this.socketIdentity = { dev: owned.dev, ino: owned.ino };
          }
          resolveStart();
        });
      };

      if (windowsPipe) {
        listen();
        return;
      }
      if (!existsSync(this.socketPath)) {
        listen();
        return;
      }
      if (!lstatSync(this.socketPath).isSocket()) {
        rejectStart(new Error(`ChatGPT web broker path exists and is not a socket: ${this.socketPath}`));
        return;
      }
      const socketStat = lstatSync(this.socketPath);
      const getuid = process.getuid;
      if (typeof getuid === "function" && socketStat.uid !== getuid()) {
        rejectStart(new Error(`ChatGPT web broker socket is not owned by the current user: ${this.socketPath}`));
        return;
      }
      if ((socketStat.mode & 0o077) !== 0) {
        rejectStart(new Error(`ChatGPT web broker socket has unsafe permissions: ${this.socketPath}`));
        return;
      }
      const probe = createConnection(this.socketPath);
      let probeSettled = false;
      const finishProbe = (action: () => void) => {
        if (probeSettled) return;
        probeSettled = true;
        probe.destroy();
        action();
      };
      probe.setTimeout(2_000, () =>
        finishProbe(() => {
          rejectStart(new Error(`Timed out while checking existing ChatGPT web broker socket: ${this.socketPath}`));
        }),
      );
      probe.once("connect", () => {
        finishProbe(() => {
          rejectStart(new Error(`ChatGPT web broker socket is already owned by another process: ${this.socketPath}`));
        });
      });
      probe.once("error", (error) => {
        finishProbe(() => {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ECONNREFUSED" && code !== "ENOENT") {
            rejectStart(
              new Error(`Could not verify existing ChatGPT web broker socket ${this.socketPath}: ${error.message}`),
            );
            return;
          }
          try {
            if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
            listen();
          } catch (cleanupError) {
            rejectStart(errorOf(cleanupError));
          }
        });
      });
    });
    // A later caller may acquire a newly available endpoint. This does not retry the
    // failed request or any tool execution, and concurrent callers share one attempt.
    const retryableAttempt = attempt.catch((error) => {
      if (this.startPromise === retryableAttempt) this.startPromise = undefined;
      if (attemptServer && !attemptServer.listening && this.server === attemptServer) {
        this.server = undefined;
      }
      throw error;
    });
    this.startPromise = retryableAttempt;
    return retryableAttempt;
  }

  private handleSocket(socket: Socket): void {
    let buffered = "";
    let handled = false;
    const disconnected = new AbortController();
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.once("close", () => disconnected.abort());
    socket.on("data", (chunk) => {
      if (handled) return;
      buffered += chunk;
      if (buffered.length > MAX_BROKER_LINE_CHARS && !buffered.slice(0, MAX_BROKER_LINE_CHARS + 1).includes("\n")) {
        handled = true;
        this.writeSocketResponse(socket, { id: "unknown", error: "turn broker request exceeds size limit" });
        return;
      }
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      const line = buffered.slice(0, newline);
      let request: BrokerRequest | undefined;
      try {
        if (line.length > MAX_BROKER_LINE_CHARS)
          throw new TurnBrokerProtocolError("turn broker request exceeds size limit");
        request = JSON.parse(line) as BrokerRequest;
        this.validateRequest(request);
      } catch (error) {
        this.writeSocketResponse(socket, { id: request?.id ?? "unknown", error: errorOf(error).message });
        return;
      }
      void Promise.resolve()
        .then(() => this.dispatch(request!, disconnected.signal))
        .then(
          (result) => this.writeSocketResponse(socket, { id: request!.id, result }),
          (error) => this.writeSocketResponse(socket, { id: request!.id, error: errorOf(error).message }),
        );
    });
  }

  private writeSocketResponse(socket: Socket, response: BrokerResponse): void {
    const line = `${JSON.stringify(response)}\n`;
    if (line.length > MAX_BROKER_LINE_CHARS) {
      socket.end(
        `${JSON.stringify({ id: response.id, error: "turn broker response exceeds size limit" } satisfies BrokerResponse)}\n`,
      );
      return;
    }
    socket.end(line);
  }

  private validateRequest(request: BrokerRequest): void {
    if (
      !request ||
      typeof request !== "object" ||
      typeof request.id !== "string" ||
      request.id.length === 0 ||
      request.id.length > 256
    ) {
      throw new TurnBrokerRequestError("turn broker request id is invalid");
    }
    if (
      ![
        "claim",
        "resolve",
        "release",
        "invoke",
        "owner_status",
        "owner_register",
        "owner_register_safe",
        "owner_register_alias",
        "owner_touch_activity",
        "owner_update",
        "owner_safe_sent",
        "owner_next",
        "owner_complete",
        "owner_tool_phase",
        "owner_completion_fence_begin",
        "owner_completion_fence_commit",
        "owner_wait_retirement",
        "owner_revoke",
        "owner_safe_wait_start",
        "owner_safe_wait_completion",
        "owner_request_compaction",
        "owner_compaction_delivery_count",
        "safe_start",
        "safe_complete",
        "activity_complete",
        "submit_compaction_handoff",
      ].includes(request.method)
    ) {
      throw new TurnBrokerProtocolError("turn broker method is invalid");
    }
  }

  private waitForThreadSuccessor(
    threadId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const active = this.threadActiveTokens.get(threadId);
    if (active) {
      const channel = this.channels.get(active);
      if (channel && channel.environment.execution !== "host-only" && !channel.completionCommitted) {
        return Promise.resolve(active);
      }
    }
    if (signal?.aborted) return Promise.resolve(undefined);
    return new Promise<string | undefined>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cleanup: (() => void) | undefined;
      const waiter = (token: string) => {
        if (timer) clearTimeout(timer);
        cleanup?.();
        resolve(token);
      };
      let waiters = this.threadSuccessorWaiters.get(threadId);
      if (!waiters) {
        waiters = new Set();
        this.threadSuccessorWaiters.set(threadId, waiters);
      }
      waiters.add(waiter);
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        cleanup?.();
        resolve(undefined);
      };
      cleanup = () => {
        const current = this.threadSuccessorWaiters.get(threadId);
        current?.delete(waiter);
        if (current && current.size === 0) this.threadSuccessorWaiters.delete(threadId);
        if (signal) signal.removeEventListener("abort", onAbort);
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        cleanup?.();
        resolve(undefined);
      }, timeoutMs);
    });
  }

  private async dispatch(request: BrokerRequest, socketSignal?: AbortSignal): Promise<unknown> {
    this.prune();
    if (request.method === "safe_start") {
      if (!request.token) throw new TurnBrokerRequestError("Zero Risk request_id is required");
      return this.startSafeTurn(request.token);
    }
    if (request.method === "safe_complete") {
      if (!request.token) throw new TurnBrokerRequestError("Zero Risk request_id is required");
      if (typeof request.finalAnswer !== "string")
        throw new TurnBrokerProtocolError("Zero Risk turn final_answer is required");
      let channel = this.channels.get(request.token);
      if (channel?.safe?.state === "awaiting_start" && !channel.safe.launcherSent) {
        await this.waitForSafeSent(request.token, socketSignal);
        this.prune();
        channel = this.channels.get(request.token);
      }
      return this.completeSafeTurn(request.token, request.finalAnswer);
    }
    if (request.method === "submit_compaction_handoff") {
      if (typeof request.token !== "string" || request.token.length === 0) {
        throw new TurnBrokerProtocolError("compaction control token is required");
      }
      if (typeof request.handoffId !== "string" || request.handoffId.length === 0) {
        throw new TurnBrokerProtocolError("compaction handoff id is required");
      }
      if (typeof request.summary !== "string") {
        throw new TurnBrokerProtocolError("compaction handoff summary is required");
      }
      this.compactionTransactions.submit(request.token, request.handoffId, request.summary);
      return { submitted: true };
    }
    if (request.method === "owner_status") {
      return {
        protocolVersion: 6,
        identity: runtimeIdentity,
        acceptingExternalOwners: this.acceptingExternalOwners,
      };
    }
    if (request.method === "owner_register_alias") {
      if (!request.token) throw new TurnBrokerTokenError("old token is required");
      if (!request.newToken) throw new TurnBrokerTokenError("new token is required");
      this.registerAlias(request.token, request.newToken);
      return { registered: true };
    }
    if (request.method === "owner_touch_activity") {
      if (!request.token) throw new TurnBrokerTokenError("turn owner token is required");
      if (typeof request.activityId !== "string" || !/^activity_[A-Za-z0-9_-]{16,128}$/.test(request.activityId)) {
        throw new TurnBrokerProtocolError("turn activity id is invalid");
      }
      return { touched: this.touchActivity(request.token, request.activityId) };
    }
    if (request.method === "owner_register") {
      const environment = ownerEnvironment(request.environment);
      if (request.traceId !== undefined && !/^[A-Za-z0-9_-]{6,128}$/.test(request.traceId)) {
        throw new TurnBrokerProtocolError("turn owner trace id is invalid");
      }
      return this.register(
        environment,
        request.ttlMs,
        request.traceId,
        true,
        "turn",
        request.previousToken,
        request.threadId,
      ).then((token) => ({ token }));
    }
    if (request.method === "owner_register_safe") {
      const environment = ownerEnvironment(request.environment);
      assertSurfaceNonce(request.surfaceNonce);
      if (request.traceId !== undefined && !/^[A-Za-z0-9_-]{6,128}$/.test(request.traceId)) {
        throw new TurnBrokerProtocolError("turn owner trace id is invalid");
      }
      return this.registerSafe(
        environment,
        request.surfaceNonce,
        request.ttlMs,
        request.traceId,
        true,
        request.previousToken,
        request.threadId,
      ).then((token) => ({ token }));
    }
    if (request.method === "owner_update") {
      if (!request.token) throw new TurnBrokerTokenError("turn owner token is required");
      this.updateEnvironment(request.token, ownerEnvironment(request.environment));
      return { updated: true };
    }
    if (request.method === "owner_safe_sent") {
      if (!request.token) throw new TurnBrokerTokenError("turn owner token is required");
      assertSurfaceNonce(request.surfaceNonce);
      return this.confirmSafeTurnSent(request.token, request.surfaceNonce);
    }
    if (request.method === "owner_next") {
      if (!request.token) throw new TurnBrokerTokenError("turn owner token is required");
      return this.nextToolBatch(request.token, socketSignal).then((requests) => ({ requests }));
    }
    if (request.method === "owner_complete") {
      if (!request.token) throw new TurnBrokerTokenError("turn owner token is required");
      if (!request.callId) throw new TurnBrokerProtocolError("turn owner call id is required");
      if (!request.toolResult || !Array.isArray(request.toolResult.content)) {
        throw new TurnBrokerProtocolError("turn owner tool result is invalid");
      }
      this.completeTool(request.token, request.callId, request.toolResult);
      return { completed: true };
    }
    if (request.method === "owner_tool_phase") {
      if (!request.token) throw new TurnBrokerTokenError("turn owner token is required");
      if (!request.callId) throw new TurnBrokerProtocolError("turn owner call id is required");
      if (!request.lifecyclePhase) throw new TurnBrokerProtocolError("turn owner lifecycle phase is required");
      if (request.lifecyclePhase !== "browser_observed" && request.lifecyclePhase !== "codex_emitted") {
        throw new TurnBrokerProtocolError("turn owner may only record browser observation or Codex emission");
      }
      this.recordToolLifecyclePhase(request.token, request.callId, request.lifecyclePhase, request.lifecycleEvidence);
      return { recorded: true };
    }
    if (request.method === "owner_completion_fence_begin") {
      if (!request.token) throw new TurnBrokerTokenError("turn owner token is required");
      return { revision: this.beginCompletionFence(request.token) ?? null };
    }
    if (request.method === "owner_completion_fence_commit") {
      if (!request.token) throw new TurnBrokerTokenError("turn owner token is required");
      if (!Number.isSafeInteger(request.revision) || request.revision! < 0) {
        throw new TurnBrokerProtocolError("turn completion fence revision is invalid");
      }
      return { committed: this.commitCompletionFence(request.token, request.revision!) };
    }
    if (request.method === "owner_wait_retirement") {
      if (!request.token) throw new TurnBrokerTokenError("turn owner token is required");
      return this.waitForRetirement(request.token, socketSignal).then(() => ({ retired: true }));
    }
    if (request.method === "owner_revoke") {
      if (!request.token) throw new TurnBrokerTokenError("turn owner token is required");
      this.revoke(request.token);
      return { revoked: true };
    }
    if (request.method === "owner_safe_wait_start") {
      if (!request.token) throw new TurnBrokerTokenError("turn owner token is required");
      return this.waitForSafeStart(request.token, socketSignal).then(() => ({ started: true }));
    }
    if (request.method === "owner_safe_wait_completion") {
      if (!request.token) throw new TurnBrokerTokenError("turn owner token is required");
      return this.waitForSafeCompletion(request.token, socketSignal).then((finalAnswer) => ({ finalAnswer }));
    }
    if (request.method === "owner_request_compaction") {
      if (!request.token) throw new TurnBrokerTokenError("turn owner token is required");
      if (!request.toolResult || !Array.isArray(request.toolResult.content)) {
        throw new TurnBrokerProtocolError("turn owner compaction result is invalid");
      }
      return { interrupted: this.requestCompaction(request.token, request.toolResult) };
    }
    if (request.method === "owner_compaction_delivery_count") {
      if (!request.token) throw new TurnBrokerTokenError("turn owner token is required");
      return { count: this.compactionDeliveryCount(request.token) };
    }
    if (request.method === "claim") {
      const contract = request.contract ?? "native";
      const token = request.token;
      if (typeof token !== "string" || token.length === 0) {
        throw new Error(contract === "safe" ? "request id is required" : "turn token is required");
      }
      let resolved = this.resolveActiveToken(token);
      let activeChannel = resolved?.channel;
      let effectiveToken = resolved?.resolvedToken ?? token;
      if (!activeChannel && !token.startsWith("host_") && contract !== "safe") {
        const direct = this.channels.get(token);
        const threadId = direct?.threadId ?? this.retiredTokenThreads.get(token);
        if (threadId && threadId !== "unknown" && this.interTurnGraceWaitMs > 0) {
          const successorToken = await this.waitForThreadSuccessor(threadId, this.interTurnGraceWaitMs, socketSignal);
          if (successorToken) {
            resolved = this.resolveActiveToken(token);
            activeChannel = resolved?.channel;
            effectiveToken = resolved?.resolvedToken ?? token;
          }
        }
      }
      if (resolved && resolved.resolvedToken !== token) {
        console.info(
          `[chatgpt-web] broker aliasing token ${handleFingerprint(token)} -> active token ${handleFingerprint(effectiveToken)} (trace=${activeChannel?.traceId})`,
        );
      }
      const channel = this.channels.get(token);
      const retiredTurn = activeChannel
        ? undefined
        : channel?.completionCommitted
          ? channel.traceId
          : this.retiredTokens.get(token);
      console.error(
        `[chatgpt-web] broker claim received (tokenChars=${token.length}, tokenHash=${handleFingerprint(token)}, valid=${Boolean(activeChannel)}` +
          `${activeChannel ? "" : `, retiredTurn=${retiredTurn ?? "unknown"}`})`,
      );
      if (!activeChannel) {
        throw new Error(
          retiredTurn !== undefined
            ? `${contract === "safe" ? "This request_id" : "This turn_token"} was issued for ${retiredTurnLabel(retiredTurn)}, which has already finished.` +
                " This Codex Native action can no longer run."
            : `${contract === "safe" ? "request id" : "turn token"} is invalid, expired, or revoked`,
        );
      }
      if (activeChannel.safe) {
        if (contract !== "safe")
          throw new TurnBrokerRequestError("Zero Risk request id requires the Zero Risk MCP contract");
        if (activeChannel.safe.state === "awaiting_start" && !activeChannel.safe.launcherSent) {
          // ChatGPT can issue its first Harness call in the brief interval between the user sending
          // the copied prompt and confirming Sent in the Launcher. Hold that call behind the local
          // authorization boundary, but still require codex_turn_start before it can run.
          await this.waitForSafeSent(effectiveToken, socketSignal);
          this.prune();
          const refreshed = this.resolveActiveToken(effectiveToken);
          activeChannel = refreshed?.channel;
          if (!activeChannel || activeChannel.completionCommitted) {
            throw new TurnBrokerTokenError("turn token is invalid, expired, or revoked");
          }
        }
        assertSafeHarnessRunning(activeChannel);
      } else if (contract === "safe") {
        throw new TurnBrokerRequestError("Zero Risk MCP contract requires a Zero Risk request id");
      }
      if (typeof request.activityId !== "string" || !/^activity_[A-Za-z0-9_-]{16,128}$/.test(request.activityId)) {
        throw new TurnBrokerProtocolError("turn activity id is invalid");
      }
      const activityId = request.activityId;
      if (activeChannel.completedActivities.has(activityId)) {
        throw new TurnBrokerStateError("turn activity was already completed before this claim settled");
      }
      if (!activeChannel.activities.has(activityId)) {
        activeChannel.activities.set(activityId, Date.now());
        activeChannel.activityRevision += 1;
      }
      if (activeChannel.bindingId) {
        const existing = this.bindings.get(activeChannel.bindingId);
        if (!existing || existing.token !== effectiveToken || existing.channel !== activeChannel) {
          throw new TurnBrokerTokenError("turn token binding state is inconsistent");
        }
        resolveSafeWaiters(activeChannel.claimWaiters, undefined);
        this.recordBrokerClaim(request.observationId);
        return {
          bindingId: activeChannel.bindingId,
          activityId,
          environment: activeChannel.environment,
          traceId: activeChannel.traceId,
        };
      }
      this.pending.delete(effectiveToken);
      const bindingId = opaqueId("binding");
      activeChannel.bindingId = bindingId;
      this.bindings.set(bindingId, { token: effectiveToken, channel: activeChannel });
      resolveSafeWaiters(activeChannel.claimWaiters, undefined);
      this.recordBrokerClaim(request.observationId);
      return { bindingId, activityId, environment: activeChannel.environment, traceId: activeChannel.traceId };
    }

    const bindingId = request.bindingId;
    if (request.method === "activity_complete") {
      const token = request.token;
      if (typeof token !== "string" || token.length === 0) throw new TurnBrokerTokenError("turn token is required");
      if (typeof request.activityId !== "string" || !/^activity_[A-Za-z0-9_-]{16,128}$/.test(request.activityId)) {
        throw new TurnBrokerProtocolError("turn activity id is invalid");
      }
      const resolved = this.resolveActiveToken(token);
      const channel = resolved?.channel ?? this.channels.get(token);
      if (!channel) {
        return { completed: false, retired: this.retiredTokens.has(token) };
      }
      if (channel.completedActivities.has(request.activityId)) {
        return { completed: false, duplicate: true };
      }
      const wasActive = channel.activities.delete(request.activityId);
      channel.completedActivities.add(request.activityId);
      trimOldest(channel.completedActivities, MAX_COMPLETED_ACTIVITY_TOMBSTONES);
      // A cleanup that overtakes an ambiguously delivered claim is still a causal event. Its
      // tombstone makes the delayed claim fail instead of resurrecting activity after a fence.
      channel.activityRevision += 1;
      return { completed: wasActive };
    }

    if (typeof bindingId !== "string" || bindingId.length === 0)
      throw new TurnBrokerProtocolError("binding id is required");
    const binding = this.bindings.get(bindingId);
    if (!binding) {
      const retiredTurn = this.retiredBindings.get(bindingId);
      if (request.method === "release" && retiredTurn !== undefined) {
        return { released: true, duplicate: true };
      }
      console.error(
        `[chatgpt-web] broker rejected ${request.method} (binding=${bindingId.slice(0, 17)},` +
          ` retiredTurn=${retiredTurn ?? "unknown"})`,
      );
      throw new Error(
        retiredTurn !== undefined
          ? `${retiredTurnLabel(retiredTurn)} has already finished; this Codex Native action can no longer run.`
          : "internal Codex turn binding is invalid or expired",
      );
    }
    if (request.method === "release") {
      this.revoke(binding.token);
      return { released: true };
    }
    if (request.method === "resolve") return { environment: binding.channel.environment };
    assertSafeHarnessRunning(binding.channel);
    if (binding.channel.compactionRequested) {
      const result = binding.channel.compactionResult;
      if (!result) throw new TurnBrokerStateError("Codex context compaction control result is unavailable");
      binding.channel.compactionDeliveryCount += 1;
      console.info(`[chatgpt-web] broker trace=${binding.channel.traceId} intercepted a post-compaction MCP call`);
      return structuredClone(result);
    }

    const wireName = request.wireName?.trim();
    if (!wireName) throw new TurnBrokerProtocolError("wire tool name is required");
    if (binding.channel.environment.execution === "host-only") {
      const tool = binding.channel.environment.tools.find(
        (candidate) => namespacedToolName(candidate.namespace, candidate.name) === wireName,
      );
      if (!tool || (tool.freeform === true) !== (request.freeform === true)) {
        throw new TurnBrokerProtocolError("Tool is not advertised by this host-only turn");
      }
    }
    const callId = opaqueId("call");
    const toolRequest: BrokerToolRequest = {
      callId,
      ...(typeof request.observationId === "string" && /^[a-f0-9-]{36}$/.test(request.observationId)
        ? { observationId: request.observationId }
        : {}),
      wireName,
      freeform: request.freeform === true,
      ...(request.freeform === true ? { input: request.input ?? "" } : { arguments: request.arguments ?? {} }),
    };
    return new Promise<BrokerToolResult>((resolveInvoke, rejectInvoke) => {
      binding.channel.invocations.set(callId, {
        request: toolRequest,
        resolve: resolveInvoke,
        reject: rejectInvoke,
        observedStarted: performance.now(),
        lifecycle: new ToolDeliveryLifecycle(),
      });
      this.recordToolObservation(toolRequest, "broker_queued");
      binding.channel.queuedCallIds.push(callId);
      console.info(
        `[chatgpt-web] broker trace=${binding.channel.traceId} queued call=${callId.slice(0, 17)} tool=${wireName} waiters=${binding.channel.waiters.size}`,
      );
      this.scheduleToolWaiters(binding.channel);
    });
  }

  private takeQueued(channel: TurnChannel): BrokerToolRequest[] {
    const ids = channel.queuedCallIds.splice(0);
    for (const id of ids) {
      if (channel.invocations.has(id)) channel.deliveredCallIds.add(id);
    }
    return ids
      .map((id) => channel.invocations.get(id)?.request)
      .filter((request): request is BrokerToolRequest => Boolean(request));
  }

  private logToolDelivery(
    channel: TurnChannel,
    batch: BrokerToolRequest[],
    path: "immediate" | "waiter" | "replay",
  ): void {
    for (const request of batch) {
      this.recordToolObservation(request, "broker_delivered", false, undefined, "handed_to_adapter_only");
      console.info(
        `[chatgpt-web] broker trace=${channel.traceId} delivered call=${request.callId.slice(0, 17)} path=${path} replay=${path === "replay"}`,
      );
    }
  }

  private recordBrokerClaim(observationId: string | undefined): void {
    if (typeof observationId !== "string" || !/^[a-f0-9-]{36}$/.test(observationId)) return;
    this.telemetry.write({
      trace_id: observationId,
      event: "broker_claimed",
      evidence: "broker_claim_succeeded",
    });
  }

  private recordToolObservation(
    request: BrokerToolRequest,
    event: string,
    isError = false,
    started?: number,
    evidence?: string,
  ): void {
    if (!request.observationId) return;
    this.telemetry.write({
      trace_id: request.observationId,
      broker_call_id: request.callId,
      event,
      is_error: isError,
      ...(evidence ? { evidence } : {}),
      ...(started !== undefined ? { elapsed_ms: Math.round(performance.now() - started) } : {}),
    });
  }

  private scheduleToolWaiters(channel: TurnChannel): void {
    if (channel.queuedCallIds.length === 0 || channel.waiters.size === 0) return;
    if (channel.batchTimer) return;
    channel.batchTimer = setTimeout(() => {
      channel.batchTimer = undefined;
      this.wakeToolWaiters(channel);
    }, 15);
  }

  private wakeToolWaiters(channel: TurnChannel): void {
    if (channel.queuedCallIds.length === 0 || channel.waiters.size === 0) return;
    const batch = this.takeQueued(channel);
    this.logToolDelivery(channel, batch, "waiter");
    const waiters = [...channel.waiters];
    channel.waiters.clear();
    const first = waiters.shift();
    if (first) {
      if (first.signal && first.onAbort) first.signal.removeEventListener("abort", first.onAbort);
      first.resolve(batch);
    }
    for (const waiter of waiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(new Error("another adapter waiter already claimed the queued tool batch"));
    }
  }

  private rejectChannel(channel: TurnChannel, error: Error): void {
    if (channel.batchTimer) clearTimeout(channel.batchTimer);
    channel.batchTimer = undefined;
    for (const waiter of channel.waiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
    channel.waiters.clear();
    rejectSafeWaiters(channel.claimWaiters, error);
    for (const invocation of channel.invocations.values()) {
      this.recordToolObservation(invocation.request, "broker_abandoned", false, invocation.observedStarted);
      invocation.reject(error);
    }
    channel.invocations.clear();
    channel.queuedCallIds = [];
    channel.deliveredCallIds.clear();
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, channel] of this.channels) {
      if (channel.environment.expiresAt === undefined || channel.environment.expiresAt > now) continue;
      this.revoke(token);
    }
    this.pruneAbandonedActivities(now);
  }

  /**
   * A claim that reached its channel through an alias or trace lineage may never be settled by its
   * claimant, which would veto the channel's completion fence forever. Sweeping an abandoned lease
   * is a causal event exactly like an `activity_complete` tombstone, so the fence revision moves
   * and a fence captured against the vetoed state fails its commit instead of silently widening.
   */
  private pruneAbandonedActivities(now: number): void {
    for (const channel of this.channels.values()) {
      for (const [activityId, claimedAt] of channel.activities) {
        if (now - claimedAt < this.activityLivenessMs) continue;
        channel.activities.delete(activityId);
        // Sweeping is a cleanup exactly like activity_complete, so it leaves the same tombstone:
        // a retried claim reusing this activity id must fail closed instead of resurrecting the
        // lease the sweep just removed.
        channel.completedActivities.add(activityId);
        trimOldest(channel.completedActivities, MAX_COMPLETED_ACTIVITY_TOMBSTONES);
        channel.activityRevision += 1;
      }
    }
  }
}
