import type { ChatGptTurnEnvironment } from "../environment";
import { runtimeIdentity } from "../../../runtime-identity";
import { callTurnBroker } from "./client";
import { assertSurfaceNonce } from "./helpers";
import type { BrokerToolRequest, BrokerToolResult, TurnBrokerOwner } from "./types";
import type { ToolDeliveryPhase } from "../tool-delivery-lifecycle";
import { TurnBrokerProtocolError, TurnBrokerStateError } from "./errors";

/**
 * Outer-harness client for a broker already owned by the live launcher runtime. It lets a
 * working-tree DEV driver exercise the production adapter and MCP connector without binding a
 * Responses port or replacing the active Codex route.
 */
export class RemoteTurnBroker implements TurnBrokerOwner {
  constructor(readonly socketPath: string) {}

  async assertCompatible(): Promise<void> {
    let status: {
      protocolVersion?: unknown;
      identity?: { buildCommit?: unknown };
      acceptingExternalOwners?: unknown;
    };
    try {
      status = await callTurnBroker(this.socketPath, { method: "owner_status" });
    } catch (error) {
      throw new Error(
        "The running launcher runtime does not expose the DEV turn-owner protocol; update and restart Codex Web GPT once before using the working-tree DEV chat"
        + ` (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (status.protocolVersion !== 6) {
      throw new TurnBrokerProtocolError(`Unsupported DEV turn-owner protocol version: ${String(status.protocolVersion)}`);
    }
    if (runtimeIdentity.buildCommit !== null
      && status.identity?.buildCommit !== runtimeIdentity.buildCommit) {
      throw new TurnBrokerProtocolError(`Broker build does not match owner build ${runtimeIdentity.buildCommit}`);
    }
    if (status.acceptingExternalOwners !== true) {
      throw new TurnBrokerStateError("The running launcher runtime is draining and is not accepting DEV chat turns");
    }
  }

  async registerAlias(oldToken: string, newToken: string): Promise<void> {
    await callTurnBroker(this.socketPath, {
      method: "owner_register_alias",
      token: oldToken,
      newToken,
    });
  }

  async touchActivity(token: string, activityId: string): Promise<boolean> {
    const response = await callTurnBroker<{ touched?: unknown }>(this.socketPath, {
      method: "owner_touch_activity",
      token,
      activityId,
    });
    if (typeof response.touched !== "boolean") {
      throw new TurnBrokerProtocolError("DEV turn owner received an invalid activity touch result");
    }
    return response.touched;
  }

  async register(
    environment: ChatGptTurnEnvironment,
    ttlMs?: number,
    traceId = "unknown",
    _externalOwner?: boolean,
    _handlePrefix?: string,
    predecessorToken?: string,
  ): Promise<string> {
    const response = await callTurnBroker<{ token?: unknown }>(this.socketPath, {
      method: "owner_register",
      environment,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      ...(traceId !== "unknown" ? { traceId } : {}),
      ...(predecessorToken ? { previousToken: predecessorToken } : {}),
    });
    if (typeof response.token !== "string" || !response.token.startsWith("turn_")) {
      throw new TurnBrokerProtocolError("DEV turn owner received an invalid broker token");
    }
    return response.token;
  }

  async registerSafe(
    environment: ChatGptTurnEnvironment,
    surfaceNonce: string,
    ttlMs?: number,
    traceId = "unknown",
    _externalOwner?: boolean,
    predecessorToken?: string,
  ): Promise<string> {
    assertSurfaceNonce(surfaceNonce);
    const response = await callTurnBroker<{ token?: unknown }>(this.socketPath, {
      method: "owner_register_safe",
      environment,
      surfaceNonce,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      ...(traceId !== "unknown" ? { traceId } : {}),
      ...(predecessorToken ? { previousToken: predecessorToken } : {}),
    });
    if (typeof response.token !== "string" || !response.token.startsWith("request_")) {
      throw new TurnBrokerProtocolError("DEV Zero Risk turn owner received an invalid broker request id");
    }
    return response.token;
  }

  async updateEnvironment(token: string, environment: ChatGptTurnEnvironment): Promise<void> {
    await callTurnBroker(this.socketPath, { method: "owner_update", token, environment });
  }

  async confirmSafeTurnSent(
    token: string,
    surfaceNonce: string,
  ): Promise<{ confirmed: true; duplicate: boolean }> {
    const response = await callTurnBroker<{ confirmed?: unknown; duplicate?: unknown }>(this.socketPath, {
      method: "owner_safe_sent",
      token,
      surfaceNonce,
    });
    if (response.confirmed !== true || typeof response.duplicate !== "boolean") {
      throw new TurnBrokerProtocolError("DEV Zero Risk turn owner received an invalid Sent confirmation result");
    }
    return { confirmed: true, duplicate: response.duplicate };
  }

  async nextToolBatch(token: string, signal?: AbortSignal): Promise<BrokerToolRequest[]> {
    const response = await callTurnBroker<{ requests?: unknown }>(
      this.socketPath,
      { method: "owner_next", token },
      null,
      signal,
    );
    if (!Array.isArray(response.requests) || response.requests.some(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return true;
      const request = value as Partial<BrokerToolRequest>;
      return typeof request.callId !== "string" || typeof request.wireName !== "string"
        || typeof request.freeform !== "boolean"
        || (request.freeform
          ? typeof request.input !== "string"
          : !request.arguments || typeof request.arguments !== "object" || Array.isArray(request.arguments));
    })) throw new TurnBrokerProtocolError("DEV turn owner received an invalid tool batch");
    return response.requests as BrokerToolRequest[];
  }

  async completeTool(token: string, callId: string, result: BrokerToolResult): Promise<void> {
    await callTurnBroker(this.socketPath, {
      method: "owner_complete",
      token,
      callId,
      toolResult: result,
    }, null);
  }

  async recordToolLifecyclePhase(
    token: string,
    callId: string,
    phase: ToolDeliveryPhase,
    evidence?: string,
  ): Promise<void> {
    await callTurnBroker(this.socketPath, {
      method: "owner_tool_phase",
      token,
      callId,
      lifecyclePhase: phase,
      ...(evidence ? { lifecycleEvidence: evidence } : {}),
    });
  }

  async waitForSafeStart(token: string, signal?: AbortSignal): Promise<void> {
    const response = await callTurnBroker<{ started?: unknown }>(
      this.socketPath,
      { method: "owner_safe_wait_start", token },
      null,
      signal,
    );
    if (response.started !== true) throw new TurnBrokerProtocolError("DEV Zero Risk turn owner received an invalid start result");
  }

  async waitForSafeCompletion(token: string, signal?: AbortSignal): Promise<string> {
    const response = await callTurnBroker<{ finalAnswer?: unknown }>(
      this.socketPath,
      { method: "owner_safe_wait_completion", token },
      null,
      signal,
    );
    if (typeof response.finalAnswer !== "string" || response.finalAnswer.trim().length === 0) {
      throw new TurnBrokerProtocolError("DEV Zero Risk turn owner received an invalid completion result");
    }
    return response.finalAnswer;
  }

  async requestCompaction(token: string, queuedResult: BrokerToolResult): Promise<number> {
    const response = await callTurnBroker<{ interrupted?: unknown }>(this.socketPath, {
      method: "owner_request_compaction",
      token,
      toolResult: queuedResult,
    }, null);
    if (!Number.isSafeInteger(response.interrupted) || Number(response.interrupted) < 0) {
      throw new TurnBrokerProtocolError("DEV Zero Risk turn owner received an invalid compaction interrupt count");
    }
    return Number(response.interrupted);
  }

  async compactionDeliveryCount(token: string): Promise<number> {
    const response = await callTurnBroker<{ count?: unknown }>(this.socketPath, {
      method: "owner_compaction_delivery_count",
      token,
    });
    if (!Number.isSafeInteger(response.count) || Number(response.count) < 0) {
      throw new TurnBrokerProtocolError("DEV Zero Risk turn owner received an invalid compaction delivery count");
    }
    return Number(response.count);
  }

  async beginCompletionFence(token: string): Promise<number | undefined> {
    const response = await callTurnBroker<{ revision?: unknown }>(this.socketPath, {
      method: "owner_completion_fence_begin",
      token,
    });
    if (response.revision === null) return undefined;
    if (!Number.isSafeInteger(response.revision) || (response.revision as number) < 0) {
      throw new TurnBrokerProtocolError("DEV turn owner received an invalid completion fence revision");
    }
    return response.revision as number;
  }

  async commitCompletionFence(token: string, revision: number): Promise<boolean> {
    const response = await callTurnBroker<{ committed?: unknown }>(this.socketPath, {
      method: "owner_completion_fence_commit",
      token,
      revision,
    });
    if (typeof response.committed !== "boolean") {
      throw new TurnBrokerProtocolError("DEV turn owner received an invalid completion fence result");
    }
    return response.committed;
  }

  async waitForRetirement(token: string, signal?: AbortSignal): Promise<void> {
    const response = await callTurnBroker<{ retired?: unknown }>(
      this.socketPath,
      { method: "owner_wait_retirement", token },
      null,
      signal,
    );
    if (response.retired !== true) throw new TurnBrokerProtocolError("DEV turn owner received an invalid retirement result");
  }

  async revoke(token: string, _reason?: Error): Promise<void> {
    await callTurnBroker(this.socketPath, { method: "owner_revoke", token });
  }
}
