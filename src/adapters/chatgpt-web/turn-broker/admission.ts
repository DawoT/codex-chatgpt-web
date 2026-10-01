import { TurnBrokerProtocolError, TurnBrokerRequestError } from "./errors";
import { handleFingerprint, MAX_TOKEN_ALIASES, trimOldest } from "./helpers";
import type { BrokerRequest, TurnChannel } from "./types";

/**
 * Why a retired handle can no longer be used directly, and whether lineage may still route it.
 * A record is the positive evidence a retired handle needs before alias, trace or thread
 * lineage may resolve it; a terminal record never routes, and no record (evicted or unknown)
 * routes nothing either, so eviction can only reduce permissions.
 */
export interface RetiredTurnRecord {
  traceId: string;
  threadId?: string;
  /** Terminal revocations (interrupted turns) can never be readmitted through lineage. */
  terminal: boolean;
}

/**
 * An alias edge. Owner-registered aliases are explicit grants and route on their own; lineage
 * edges created by register() carry the predecessor's authorization and may only be traversed
 * from a handle with positive compatible evidence.
 */
export interface TokenAliasEdge {
  target: string;
  lineage: boolean;
}

interface BrokerAdmissionState {
  channels: Map<string, TurnChannel>;
  retiredTurns: Map<string, RetiredTurnRecord>;
  tokenAliases: Map<string, TokenAliasEdge>;
  traceActiveTokens: Map<string, string>;
  traceTokens: Map<string, string[]>;
  threadActiveTokens: Map<string, string>;
  threadTokens: Map<string, string[]>;
}

/** Resolves capability lineage against the facade's sole channel registry. */
export class BrokerAdmission {
  constructor(private readonly state: BrokerAdmissionState) {}

  registerAlias(oldToken: string, newToken: string): void {
    if (oldToken.startsWith("host_") || newToken.startsWith("host_")) {
      throw new TurnBrokerProtocolError("host-only capabilities cannot be aliased");
    }
    // An interrupted (terminally revoked) turn cannot grant anything, not even by explicit alias.
    if (this.state.retiredTurns.get(oldToken)?.terminal) {
      throw new TurnBrokerProtocolError("terminally revoked turns cannot be aliased");
    }
    // Re-inserting refreshes recency, so a re-registered alias is evicted last (LRU, not FIFO).
    this.state.tokenAliases.delete(oldToken);
    this.state.tokenAliases.set(oldToken, { target: newToken, lineage: false });
    trimOldest(this.state.tokenAliases, MAX_TOKEN_ALIASES);
    console.info(
      `[chatgpt-web] broker registered alias ${handleFingerprint(oldToken)} -> ${handleFingerprint(newToken)}`,
    );
  }

  resolveActiveToken(token: string): { resolvedToken: string; channel: TurnChannel } | undefined {
    const directChannel = this.state.channels.get(token);
    if (directChannel && !directChannel.completionCommitted) {
      return { resolvedToken: token, channel: directChannel };
    }
    // Host capabilities are exact and irrevocable; never recover them through Codex lineage.
    if (token.startsWith("host_")) return undefined;
    const record = this.state.retiredTurns.get(token);
    // A terminally revoked turn (interrupted before finishing) never recovers permissions
    // through alias or lineage, whatever registers afterwards on its trace or thread.
    if (record?.terminal) return undefined;
    // Positive compatible evidence: a visibly finished (committed) channel or a compatibly
    // recorded retirement. Unknown, evicted or terminal handles hold none.
    const evidenceOf = (handle: string): boolean => {
      const channel = this.state.channels.get(handle);
      if (channel?.completionCommitted) return true;
      return this.state.retiredTurns.get(handle)?.terminal === false;
    };
    // 1. Follow alias chains. Owner-registered aliases are explicit grants and route on their
    //    own; lineage edges created by register() may only be traversed from a handle with
    //    positive compatible evidence, so an evicted record reduces permissions instead of
    //    restoring them. No chain transits a terminally revoked handle.
    let curr = token;
    let evidence = evidenceOf(token);
    const visited = new Set<string>([curr]);
    while (this.state.tokenAliases.has(curr)) {
      const edge = this.state.tokenAliases.get(curr)!;
      if (edge.lineage && !evidence) break;
      curr = edge.target;
      if (visited.has(curr)) break;
      visited.add(curr);
      const hopRecord = this.state.retiredTurns.get(curr);
      if (hopRecord?.terminal) break;
      const target = this.state.channels.get(curr);
      if (target && target.environment.execution !== "host-only" && !target.completionCommitted) {
        return { resolvedToken: curr, channel: target };
      }
      evidence = evidenceOf(curr);
    }
    // 2. Trace lineage lookup: only with positive compatible evidence recorded for this handle,
    //    or a still-registered (visibly finished) channel to read the trace from.
    const traceId = directChannel?.traceId ?? (record?.terminal === false ? record.traceId : undefined);
    if (traceId && traceId !== "unknown") {
      const activeToken = this.state.traceActiveTokens.get(traceId);
      if (activeToken) {
        const activeChannel = this.state.channels.get(activeToken);
        if (
          activeChannel &&
          activeChannel.environment.execution !== "host-only" &&
          !activeChannel.completionCommitted
        ) {
          return { resolvedToken: activeToken, channel: activeChannel };
        }
      }
      const allForTrace = this.state.traceTokens.get(traceId);
      if (allForTrace) {
        for (let i = allForTrace.length - 1; i >= 0; i--) {
          const cand = allForTrace[i];
          const candChannel = this.state.channels.get(cand);
          if (candChannel && candChannel.environment.execution !== "host-only" && !candChannel.completionCommitted) {
            return { resolvedToken: cand, channel: candChannel };
          }
        }
      }
    }
    // 3. Thread lineage lookup: same evidence rule as trace lineage.
    const threadId = directChannel?.threadId ?? (record?.terminal === false ? record.threadId : undefined);
    if (threadId && threadId !== "unknown") {
      const activeToken = this.state.threadActiveTokens.get(threadId);
      if (activeToken) {
        const activeChannel = this.state.channels.get(activeToken);
        if (
          activeChannel &&
          activeChannel.environment.execution !== "host-only" &&
          !activeChannel.completionCommitted
        ) {
          this.registerAlias(token, activeToken);
          return { resolvedToken: activeToken, channel: activeChannel };
        }
      }
      const allForThread = this.state.threadTokens.get(threadId);
      if (allForThread) {
        for (let i = allForThread.length - 1; i >= 0; i--) {
          const cand = allForThread[i];
          const candChannel = this.state.channels.get(cand);
          if (candChannel && candChannel.environment.execution !== "host-only" && !candChannel.completionCommitted) {
            this.registerAlias(token, cand);
            return { resolvedToken: cand, channel: candChannel };
          }
        }
      }
    }
    return undefined;
  }

  validateRequest(request: BrokerRequest): void {
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
        "submit_phase_checkpoint",
        "read_phase_checkpoint",
      ].includes(request.method)
    ) {
      throw new TurnBrokerProtocolError("turn broker method is invalid");
    }
  }
}
