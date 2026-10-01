import { ToolDeliveryLifecycle, type ToolDeliveryPhase } from "../tool-delivery-lifecycle";
import { TurnBrokerProtocolError, TurnBrokerStateError } from "./errors";
import { assertSafeHarnessRunning } from "./safe-state";
import type { BrokerToolRequest, BrokerToolResult, ToolWaiter, TurnChannel } from "./types";
import { injectGracefulYieldNoticeIfRecommended } from "./yield-notice";

interface BrokerToolQueueDependencies {
  getChannel: (token: string) => TurnChannel;
  waitForSafeStart: (token: string, signal?: AbortSignal) => Promise<void>;
  recordToolObservation: (
    request: BrokerToolRequest,
    event: string,
    isError?: boolean,
    started?: number,
    evidence?: string,
    channel?: TurnChannel,
  ) => void;
}

/** Owns delivery/replay, tool results and waiter cleanup against shared channels. */
export class BrokerToolQueue {
  constructor(private readonly deps: BrokerToolQueueDependencies) {}

  async nextToolBatch(token: string, signal?: AbortSignal): Promise<BrokerToolRequest[]> {
    let channel = this.deps.getChannel(token);
    if (signal?.aborted) throw new DOMException("tool wait aborted", "AbortError");
    if (channel.safe?.state === "awaiting_start") {
      // The outer Codex adapter owns this wait. It crosses the start boundary only after the user
      // confirms in the Launcher that the copied prompt was sent in the visible ChatGPT tab.
      await this.deps.waitForSafeStart(token, signal);
      channel = this.deps.getChannel(token);
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
    const channel = this.deps.getChannel(token);
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
      this.deps.recordToolObservation(
        invocation.request,
        "result_received",
        result.isError === true,
        invocation.observedStarted,
        "tool_result",
        channel,
      );
    }
    channel.invocations.delete(callId);
    this.deps.recordToolObservation(
      invocation.request,
      "broker_result_received",
      result.isError === true,
      invocation.observedStarted,
      undefined,
      channel,
    );
    channel.completedToolsCount = (channel.completedToolsCount ?? 0) + 1;
    const finalResult = injectGracefulYieldNoticeIfRecommended(
      result,
      channel.completedToolsCount,
      channel.compactionRequested,
    );
    console.info(
      `[chatgpt-web] broker trace=${channel.traceId} completed call=${callId.slice(0, 17)} count=${channel.completedToolsCount} pending=${channel.invocations.size}`,
    );
    invocation.resolve(finalResult);
  }

  recordToolLifecyclePhase(token: string, callId: string, phase: ToolDeliveryPhase, evidence?: string): void {
    const channel = this.deps.getChannel(token);
    const invocation = channel.invocations.get(callId);
    if (!invocation) throw new TurnBrokerProtocolError(`tool call is not pending: ${callId}`);
    if (invocation.lifecycle.mark(phase)) {
      this.deps.recordToolObservation(invocation.request, phase, false, invocation.observedStarted, evidence, channel);
    }
  }

  requestCompaction(channel: TurnChannel, queuedResult: BrokerToolResult): number {
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
      this.deps.recordToolObservation(
        invocation.request,
        "broker_compaction_cancelled",
        false,
        invocation.observedStarted,
        undefined,
        channel,
      );
      invocation.resolve(structuredClone(queuedResult));
    }
    if (queued.length > 0) {
      console.info(
        `[chatgpt-web] broker trace=${channel.traceId} interrupted queued calls=${queued.length} for context compaction`,
      );
    }
    return queued.length;
  }

  enqueue(channel: TurnChannel, request: BrokerToolRequest): Promise<BrokerToolResult> {
    const callId = request.callId;
    return new Promise<BrokerToolResult>((resolveInvoke, rejectInvoke) => {
      channel.invocations.set(callId, {
        request,
        resolve: resolveInvoke,
        reject: rejectInvoke,
        observedStarted: performance.now(),
        lifecycle: new ToolDeliveryLifecycle(),
      });
      this.deps.recordToolObservation(request, "broker_queued", false, undefined, undefined, channel);
      channel.queuedCallIds.push(callId);
      console.info(
        `[chatgpt-web] broker trace=${channel.traceId} queued call=${callId.slice(0, 17)} tool=${request.wireName} waiters=${channel.waiters.size}`,
      );
      this.scheduleToolWaiters(channel);
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
      this.deps.recordToolObservation(request, "broker_delivered", false, undefined, "handed_to_adapter_only", channel);
      console.info(
        `[chatgpt-web] broker trace=${channel.traceId} delivered call=${request.callId.slice(0, 17)} path=${path} replay=${path === "replay"}`,
      );
    }
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

  cancelWaiters(channel: TurnChannel, error: Error): void {
    if (channel.batchTimer) clearTimeout(channel.batchTimer);
    channel.batchTimer = undefined;
    for (const waiter of channel.waiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
    channel.waiters.clear();
  }

  rejectInvocations(channel: TurnChannel, error: Error): void {
    for (const invocation of channel.invocations.values()) {
      this.deps.recordToolObservation(
        invocation.request,
        "broker_abandoned",
        false,
        invocation.observedStarted,
        undefined,
        channel,
      );
      invocation.reject(error);
    }
    channel.invocations.clear();
    channel.queuedCallIds = [];
    channel.deliveredCallIds.clear();
  }
}
