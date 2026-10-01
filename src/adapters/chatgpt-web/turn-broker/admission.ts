import { TurnBrokerProtocolError, TurnBrokerRequestError } from "./errors";
import { handleFingerprint, MAX_TOKEN_ALIASES, trimOldest } from "./helpers";
import type { BrokerRequest, TurnChannel } from "./types";

interface BrokerAdmissionState {
  channels: Map<string, TurnChannel>;
  retiredTokens: Map<string, string>;
  terminatedTokens: Map<string, string>;
  tokenAliases: Map<string, string>;
  traceActiveTokens: Map<string, string>;
  traceTokens: Map<string, string[]>;
  threadActiveTokens: Map<string, string>;
  threadTokens: Map<string, string[]>;
  retiredTokenThreads: Map<string, string>;
}

/** Resolves capability lineage against the facade's sole channel registry. */
export class BrokerAdmission {
  constructor(private readonly state: BrokerAdmissionState) {}

  registerAlias(oldToken: string, newToken: string): void {
    if (oldToken.startsWith("host_") || newToken.startsWith("host_")) {
      throw new TurnBrokerProtocolError("host-only capabilities cannot be aliased");
    }
    // Re-inserting refreshes recency, so a re-registered alias is evicted last (LRU, not FIFO).
    this.state.tokenAliases.delete(oldToken);
    this.state.tokenAliases.set(oldToken, newToken);
    trimOldest(this.state.tokenAliases, MAX_TOKEN_ALIASES);
    console.info(
      `[chatgpt-web] broker registered alias ${handleFingerprint(oldToken)} -> ${handleFingerprint(newToken)}`,
    );
  }

  resolveActiveToken(token: string): { resolvedToken: string; channel: TurnChannel } | undefined {
    // A turn interrupted before its completion fence committed is terminally revoked: it never
    // recovers permissions through alias or lineage, whatever registers afterwards on its
    // trace or thread. A later turn is a new capability, not a revival of this one.
    if (this.state.terminatedTokens.has(token)) return undefined;
    const directChannel = this.state.channels.get(token);
    if (directChannel && !directChannel.completionCommitted) {
      return { resolvedToken: token, channel: directChannel };
    }
    // Host capabilities are exact and irrevocable; never recover them through Codex lineage.
    if (token.startsWith("host_")) return undefined;
    // 1. Follow explicit alias chain
    let curr = token;
    const visited = new Set<string>([curr]);
    while (this.state.tokenAliases.has(curr)) {
      curr = this.state.tokenAliases.get(curr)!;
      if (visited.has(curr)) break;
      visited.add(curr);
      // A chain may not transit a terminally revoked handle: it would route older lineage
      // around the revoked turn and readmit it through its successor.
      if (this.state.terminatedTokens.has(curr)) break;
      const target = this.state.channels.get(curr);
      if (target && target.environment.execution !== "host-only" && !target.completionCommitted) {
        return { resolvedToken: curr, channel: target };
      }
    }
    // 2. Trace lineage lookup: if this token was associated with a trace, check active token
    const traceId = directChannel?.traceId ?? this.state.retiredTokens.get(token);
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
    // 3. Thread lineage lookup: if this token was associated with a thread, check active token
    const threadId = directChannel?.threadId ?? this.state.retiredTokenThreads.get(token);
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
