import { createHash } from "node:crypto";
import * as z from "zod/v4";
import { namespacedToolName, type CodexTool } from "../../../types";
import type { ChatGptTurnEnvironment } from "../environment";
import { CODEX_COMPACTION_CONTROL_WIRE_NAME } from "../native-compaction-control";
import { AGENT_WAIT_TRANSPORT_RULE, CHATGPT_WEB_AGENT_WAIT_POLL_MS } from "./instructions";
import type { ChatGptMcpContract, McpRequestExtra } from "./types";

export const BRIDGE_TOOL_NAMES = new Set([
  "codex_turn_start",
  "codex_exec",
  "codex_write_stdin",
  "codex_apply_patch",
  "codex_view_image",
  "codex_read_file",
  "codex_write_file",
  "codex_patch_file",
  "codex_list_dir",
  "codex_grep",
  "codex_tool_inventory",
  "codex_tool_call",
  "codex_poll_task",
  "codex_wait_tasks",
  "codex_turn_complete",
]);

export const GATEWAY_AGENT_WAIT_TOOL_NAMES = new Set([
  "multi_agent_v1__wait_agent",
  "multi_agent_v2__wait_agent",
  "collaboration__wait_agent",
]);

export const turnTokenSchema = z.string().min(20).max(256);
export const jsonArgumentsSchema = z.record(z.string(), z.unknown()).default({});

export function turnReferenceInput(contract: ChatGptMcpContract): Record<string, z.ZodString> {
  return contract === "safe"
    ? { request_id: turnTokenSchema }
    : { turn_token: turnTokenSchema };
}

export function turnReference(contract: ChatGptMcpContract, input: object): string {
  const key = contract === "safe" ? "request_id" : "turn_token";
  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== "string") throw new Error(`${key} is required`);
  return value;
}

export function scopeHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function requestScopeSummary(extra: McpRequestExtra): string {
  const meta = extra._meta && typeof extra._meta === "object" && !Array.isArray(extra._meta)
    ? Object.entries(extra._meta as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({
        key,
        type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
        ...(typeof value === "string" ? { chars: value.length, hash: scopeHash(value) } : {}),
      }))
    : [];
  const requestInfoKeys = extra.requestInfo && typeof extra.requestInfo === "object"
    ? Object.keys(extra.requestInfo as Record<string, unknown>).sort()
    : [];
  return JSON.stringify({
    requestId: String(extra.requestId),
    session: extra.sessionId ? { chars: extra.sessionId.length, hash: scopeHash(extra.sessionId) } : null,
    meta,
    requestInfoKeys,
  });
}

export function wireName(tool: CodexTool): string {
  return namespacedToolName(tool.namespace, tool.name);
}

export function exactTool(environment: ChatGptTurnEnvironment, name: string): CodexTool | undefined {
  return environment.tools.find(tool => !tool.namespace && tool.name === name);
}

export function gatewayToolNameIsValid(name: string): boolean {
  return /^[A-Za-z0-9_$]+$/.test(name);
}

export function safeVisibleTools(environment: ChatGptTurnEnvironment, contract: ChatGptMcpContract): CodexTool[] {
  if (environment.execution === "host-only") return environment.tools;
  if (contract === "native") return environment.tools;
  const bridgeNamespaces = new Set(environment.tools
    .filter(tool => tool.namespace && BRIDGE_TOOL_NAMES.has(tool.name))
    .map(tool => tool.namespace!));
  return environment.tools.filter(tool => (
    wireName(tool) !== CODEX_COMPACTION_CONTROL_WIRE_NAME
    && !BRIDGE_TOOL_NAMES.has(tool.name)
    // Zero Risk does not expose model-authored JavaScript. Automatic Full mode keeps the native
    // Codex exec surface and applies its transport guard at invocation time below.
    && (tool.namespace !== undefined || tool.name !== "exec")
    && (!tool.namespace || !bridgeNamespaces.has(tool.namespace))
  ));
}

export function isAgentWaitTool(tool: CodexTool): boolean {
  return isGatewayAgentWaitTool(wireName(tool));
}

export function isGatewayAgentWaitTool(name: string): boolean {
  return GATEWAY_AGENT_WAIT_TOOL_NAMES.has(name);
}

export function browserToolDescription(tool: CodexTool): string {
  if (isAgentWaitTool(tool)) return `${tool.description}\n\n${AGENT_WAIT_TRANSPORT_RULE}`;
  if (!tool.namespace && tool.name === "exec") {
    return `${tool.description}\n\n${AGENT_WAIT_TRANSPORT_RULE} This rule is enforced for wait_agent calls made inside exec; recursive raw exec is unavailable.`;
  }
  return tool.description;
}

export function browserToolParameters(tool: CodexTool): Record<string, unknown> {
  if (!isAgentWaitTool(tool)) return tool.parameters;
  const parameters = structuredClone(tool.parameters);
  const properties = parameters.properties && typeof parameters.properties === "object" && !Array.isArray(parameters.properties)
    ? parameters.properties as Record<string, unknown>
    : {};
  const timeout = properties.timeout_ms && typeof properties.timeout_ms === "object" && !Array.isArray(properties.timeout_ms)
    ? properties.timeout_ms as Record<string, unknown>
    : {};
  // The cloned native schema must not advertise a default that contradicts our required interval.
  delete timeout.default;
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((value): value is string => typeof value === "string")
    : [];
  return {
    ...parameters,
    properties: {
      ...properties,
      timeout_ms: {
        ...timeout,
        type: "number",
        const: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
        minimum: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
        maximum: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
        description: `Required transport-safe polling interval. Use exactly ${CHATGPT_WEB_AGENT_WAIT_POLL_MS}; a timed-out wait does not mean the agents have finished.`,
      },
    },
    required: [...new Set([...required, "timeout_ms"])],
  };
}

export function assertBrowserToolArguments(tool: CodexTool, args: Record<string, unknown>): void {
  if (!isAgentWaitTool(tool)) return;
  if (args.timeout_ms !== CHATGPT_WEB_AGENT_WAIT_POLL_MS) {
    throw new Error(
      `ChatGPT Web wait_agent requires timeout_ms=${CHATGPT_WEB_AGENT_WAIT_POLL_MS}`
      + " so the shared MCP channel remains available to spawned Web agents",
    );
  }
}

export function assertGatewayToolArguments(name: string, args: Record<string, unknown>): void {
  if (!isGatewayAgentWaitTool(name)) return;
  if (args.timeout_ms !== CHATGPT_WEB_AGENT_WAIT_POLL_MS) {
    throw new Error(
      `ChatGPT Web wait_agent requires timeout_ms=${CHATGPT_WEB_AGENT_WAIT_POLL_MS}`
      + " so the shared MCP channel remains available to spawned Web agents",
    );
  }
}

export function execGateway(environment: ChatGptTurnEnvironment): CodexTool | undefined {
  if (environment.execution === "host-only") return undefined;
  const tool = exactTool(environment, "exec");
  return tool?.freeform ? tool : undefined;
}
