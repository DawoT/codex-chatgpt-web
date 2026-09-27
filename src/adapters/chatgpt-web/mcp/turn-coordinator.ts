import { boundedSessionArguments } from "./session-yield";
import { randomBytes } from "node:crypto";
import type { CodexTool } from "../../../types";
import type { ChatGptTurnEnvironment } from "../environment";
import { callTurnBroker, TurnBrokerTimeoutError, type BrokerToolResult } from "../turn-broker";
import { result } from "../fast-path-handlers";
import { execGatewayProgram } from "./gateway-programs";
import { asMcpResult, chatGptMcpInvocationTimeout } from "./results";
import { execGateway, requestScopeSummary, wireName } from "./tool-visibility";
import type { ChatGptMcpContract, ClaimedTurn, McpRequestExtra } from "./types";

const CHATGPT_MCP_ACTIVITY_KEEP_ALIVE_MS = 45_000;

export class TurnCoordinator {
  constructor(
    readonly brokerSocketPath: string,
    readonly contract: ChatGptMcpContract,
  ) {}

  async claimTurn(
    toolName: string,
    turnToken: string,
    extra: McpRequestExtra,
  ): Promise<ClaimedTurn> {
    console.error(`[chatgpt-web-mcp] ${toolName} scope=${requestScopeSummary(extra)}`);
    const activityId = `activity_${randomBytes(18).toString("base64url")}`;
    try {
      // Chat-First never claims turns (its tools take no turn reference), so the broker contract
      // value only ever observes native/safe here; the mapping keeps the wire type narrow.
      const claimed = await callTurnBroker<Omit<ClaimedTurn, "activityId">>(
        this.brokerSocketPath,
        { method: "claim", token: turnToken, activityId, contract: this.contract === "chat-first" ? "native" : this.contract },
        this.contract === "safe" ? null : 5_000,
        extra.signal,
      );
      return { ...claimed, activityId };
    } catch (error) {
      try {
        await this.settleTurnActivity(turnToken, activityId);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Codex Native claim failed and its broker activity could not be retired",
        );
      }
      throw error;
    }
  }

  async settleTurnActivity(turnToken: string, activityId: string): Promise<void> {
    let firstError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await callTurnBroker(this.brokerSocketPath, {
          method: "activity_complete",
          token: turnToken,
          activityId,
        }, 5_000);
        return;
      } catch (error) {
        firstError ??= error;
      }
    }
    throw new AggregateError(
      [firstError],
      "Codex Native broker activity cleanup failed after an idempotent retry",
    );
  }

  async touchTurnActivity(turnToken: string, activityId: string): Promise<boolean> {
    try {
      const response = await callTurnBroker<{ touched: boolean }>(
        this.brokerSocketPath,
        { method: "owner_touch_activity", token: turnToken, activityId },
        5_000,
      );
      return response.touched === true;
    } catch {
      return false;
    }
  }

  async withClaimedTurn<T>(
    toolName: string,
    turnToken: string,
    extra: McpRequestExtra,
    action: (claimed: ClaimedTurn) => Promise<T> | T,
  ): Promise<T> {
    const claimed = await this.claimTurn(toolName, turnToken, extra);
    const keepAlive = setInterval(() => {
      void this.touchTurnActivity(turnToken, claimed.activityId);
    }, CHATGPT_MCP_ACTIVITY_KEEP_ALIVE_MS);
    keepAlive.unref?.();
    try {
      if (claimed.environment.execution === "host-only"
        && toolName !== "codex_tool_inventory" && toolName !== "codex_tool_call") {
        throw new Error("This host-only turn requires exact advertised tools through codex_tool_call; local handlers and aliases are unavailable");
      }
      return await action(claimed);
    } finally {
      clearInterval(keepAlive);
      // The broker's terminal fence treats even a fully local inventory lookup as live MCP work.
      // Settle the lease without the request AbortSignal: cancellation must not strand activity
      // and silently prevent every later completion candidate from committing.
      await this.settleTurnActivity(turnToken, claimed.activityId);
    }
  }

  async invoke(
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    tool: CodexTool,
    payload: { arguments?: Record<string, unknown>; input?: string },
    signal?: AbortSignal,
    requestedTimeoutMs?: number,
  ) {
    const response = await this.invokeRaw(bindingId, bound, tool, payload, signal, requestedTimeoutMs);
    return asMcpResult(response, {
      toolName: wireName(tool),
      offload: false,
    });
  }

  /** Internal protocol consumers validate their own payload before presenting it to a model. */
  async invokeRaw(
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    tool: CodexTool,
    payload: { arguments?: Record<string, unknown>; input?: string },
    signal?: AbortSignal,
    requestedTimeoutMs?: number,
  ) {
    const timeoutMs = chatGptMcpInvocationTimeout(bound, Date.now(), requestedTimeoutMs);
    try {
      const response = await callTurnBroker<BrokerToolResult>(this.brokerSocketPath, {
        method: "invoke",
        bindingId,
        wireName: wireName(tool),
        freeform: tool.freeform === true,
        ...(tool.freeform ? { input: payload.input ?? "" } : { arguments: bound.execution === "host-only" || tool.namespace
          ? payload.arguments ?? {}
          : boundedSessionArguments(tool.name, payload.arguments ?? {}) }),
      }, timeoutMs, signal);
      return response;
    } catch (error) {
      // A cancelled/timed-out MCP request no longer has a consumer for the native result. Revoke
      // the whole turn capability so the broker drops the pending invocation and every later call
      // from that abandoned ChatGPT response fails explicitly against its retired binding.
      try {
        await callTurnBroker(this.brokerSocketPath, {
          method: "release",
          bindingId,
        });
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          "Codex Native invocation failed and its abandoned broker binding could not be retired",
        );
      }
      if (error instanceof TurnBrokerTimeoutError) {
        const toolName = wireName(tool);
        console.error(
          `[chatgpt-web-mcp] ${toolName} did not complete within ${timeoutMs}ms; retired its turn binding`,
        );
        return result({
          code: "codex_tool_timeout",
          tool: toolName,
          timeout_ms: timeoutMs,
          retryable: false,
          message: `Codex tool ${toolName} did not complete before the MCP transport deadline. The current turn binding was retired; do not retry it in this ChatGPT response.`,
        }, true);
      }
      throw error;
    }
  }

  invokeNestedNative(
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    nestedToolName: string,
    freeform: boolean,
    payload: { arguments?: Record<string, unknown>; input?: string },
    signal?: AbortSignal,
    requestedTimeoutMs?: number,
  ) {
    const gateway = execGateway(bound);
    if (!gateway) {
      throw new Error(`This Codex turn did not advertise ${nestedToolName} or the native exec gateway`);
    }
    return this.invoke(bindingId, bound, gateway, {
      input: execGatewayProgram(nestedToolName, freeform, payload, bound.tools.map(wireName)),
    }, signal, requestedTimeoutMs);
  }
}
