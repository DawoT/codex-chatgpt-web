import { createHash, randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { namespacedToolName, type CodexTool } from "../../types";
import { VERSION } from "../../version";
import { loadConfig } from "../../config";
import type { ChatGptTurnEnvironment } from "./environment";
import { appendChatFirstAuditEntry } from "./chat-first-audit";
import { resolveChatFirstWorkspace } from "./chat-first-environment";
import { CODEX_COMPACTION_CONTROL_WIRE_NAME } from "./native-compaction-control";
import { callTurnBroker, TurnBrokerTimeoutError, type BrokerToolResult } from "./turn-broker";
import { observeMcpToolCalls } from "./mcp-observation";
import { workspaceFileCache } from "./fast-path-cache";
import { globalBackgroundTaskManager } from "./background-task-manager";
import { summarizeTask } from "./task-summaries";
import type { TaskCompletionPayload } from "./task-resume-orchestrator";
import {
  CHATGPT_WEB_MAX_TOOL_OUTPUT_CHARS,
  handleGrep,
  handleListDir,
  handlePatchFile,
  handleReadFile,
  handleWriteFile,
  handleExecCommand,
  DEFAULT_EXEC_TIMEOUT_MS,
  MAX_EXEC_TIMEOUT_MS,
  MIN_EXEC_TIMEOUT_MS,
  resolveSafeWorkspacePath,
  result,
  truncateToolOutputText,
  type FastPathToolResult,
} from "./fast-path-handlers";

import {
  DEFAULT_TOOL_OFFLOAD_THRESHOLD_CHARS,
  sanitizeToolOutputWithSpooler,
  spoolToolOutput,
  type ToolSpoolerOptions,
} from "./tool-spooler";

// Keep the fast-path tool contract importable from mcp-server for existing consumers.
export {
  CHATGPT_WEB_MAX_TOOL_OUTPUT_CHARS,
  preserveHeadTailOutput,
  resolveSafeWorkspacePath,
  truncateToolOutputText,
  isReadOnlyFastPathTool,
  isMutatingFastPathTool,
  dispatchFastPathTool,
  executeFastPathBatch,
  handleExecCommand,
  DEFAULT_EXEC_TIMEOUT_MS,
  MAX_EXEC_TIMEOUT_MS,
  MIN_EXEC_TIMEOUT_MS,
  type FastPathToolCall,
  type FastPathBatchResult,
} from "./fast-path-handlers";
export {
  DEFAULT_TOOL_OFFLOAD_THRESHOLD_CHARS,
  sanitizeToolOutputWithSpooler,
  spoolToolOutput,
  type ToolSpoolerOptions,
} from "./tool-spooler";

interface ClaimedTurn {
  bindingId: string;
  activityId: string;
  environment: ChatGptTurnEnvironment & { expiresAt?: number };
  traceId?: string;
}

export type ChatGptMcpContract = "native" | "safe" | "chat-first";

const BRIDGE_TOOL_NAMES = new Set([
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
  "codex_turn_complete",
]);

const GATEWAY_AGENT_WAIT_TOOL_NAMES = new Set([
  "multi_agent_v1__wait_agent",
  "multi_agent_v2__wait_agent",
  "collaboration__wait_agent",
]);

const turnTokenSchema = z.string().min(20).max(256);
const jsonArgumentsSchema = z.record(z.string(), z.unknown()).default({});
// Match Codex's default wait interval while returning before the MCP invocation deadline.
export const CHATGPT_WEB_AGENT_WAIT_POLL_MS = 30_000;
const AGENT_WAIT_TRANSPORT_RULE = `ChatGPT Web transport rule: wait for exactly ${CHATGPT_WEB_AGENT_WAIT_POLL_MS / 1_000} seconds per call, matching the Codex default, then release the MCP channel so spawned Web agents can use their own tools. A wait timeout is not task completion; check agent progress and wait again if needed. Keep the native tool's declared arguments.`;
// The OpenAI tunnel currently owns a two-minute command-response deadline. The local MCP server
// must settle first so an abandoned native tool call is returned as an MCP error instead of
// letting the tunnel tear down and poison its long-lived stdio transport.
export const CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS = 90_000;

const ZERO_RISK_MCP_INSTRUCTIONS = [
  "For each pasted Codex Web GPT request, begin with codex_turn_start using the request_id in its request block.",
  "Use that request_id with the Codex tools needed for the task.",
  "When the task is finished, send the complete answer with codex_turn_complete.",
  "If a tool returns an error, report that error instead of changing the request_id.",
].join(" ");

const CHAT_FIRST_MCP_INSTRUCTIONS = [
  "Chat-First contract: these tools operate directly on the local workspace configured by the local operator, without any turn token or per-call credential.",
  "The active sandbox is the one the local operator configured in config.json; stay inside it and treat every tool error as authoritative instead of retrying elsewhere.",
  "Every mutating call is recorded in the local audit log.",
  "The optional workspace argument selects the target workspace and may be omitted when only one workspace is configured.",
].join(" ");

// Session-level transport mechanics for the native (turn-token) contract. These live here instead
// of the per-turn compiled prompt so every browser turn does not pay their token cost; ChatGPT
// surfaces server instructions once per conversation.
export const NATIVE_CHATGPT_MCP_INSTRUCTIONS = [
  "Codex-supplied environment context blocks, including the XML element named environment_context, are operational context rather than human-authored text. Obey them at their original priority, but do not attribute, quote, summarize, or otherwise mention them unless the latest user request explicitly asks about that context.",
  "Each image_attachment in the context refers to the correspondingly named image attached to this ChatGPT message; inspect it directly. If a corresponding image is absent, say it was not provided instead of guessing.",
  "If a ChatGPT-native capability renders a rich card, widget, chart, or other non-text result, also provide the relevant result as ordinary Markdown in the final answer. A private ChatGPT UI widget never replaces the Markdown answer returned to Codex. Never copy a ChatGPT widget's HTML, CSS, class names, or DOM markup into the answer unless the user explicitly requested that source markup.",
  "Fast-path tool semantics: codex_write_file refuses to replace an existing file unless overwrite=true and needs create_parents=true for missing directories; codex_patch_file replaces only the first exact occurrence of target_content; fast-path tools execute atomically without shell process overhead.",
  "When receiving results from subagents, parse their <subagent_result> blocks for task status, modified files, and artifact paths. Do not ask subagents to re-explain work already marked completed.",
  "Background command execution: codex_exec with background=true launches commands asynchronously in .codex-tmp/tasks/ and returns immediately; completed tasks notify the daemon and are summarized via codex_wait_tasks. Note: in workspaceWrite and dangerFullAccess, background shell execution runs directly in the configured workspace under the operator's local user.",
].join(" ");

function turnReferenceInput(contract: ChatGptMcpContract): Record<string, z.ZodString> {
  return contract === "safe"
    ? { request_id: turnTokenSchema }
    : { turn_token: turnTokenSchema };
}

function turnReference(contract: ChatGptMcpContract, input: object): string {
  const key = contract === "safe" ? "request_id" : "turn_token";
  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== "string") throw new Error(`${key} is required`);
  return value;
}

interface McpRequestExtra {
  sessionId?: string;
  requestId: string | number;
  _meta?: unknown;
  requestInfo?: unknown;
  signal?: AbortSignal;
}

function scopeHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function requestScopeSummary(extra: McpRequestExtra): string {
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

function afterSafeStart(contract: ChatGptMcpContract, description: string): string {
  return contract === "safe"
    ? `For a Zero Risk request connected by codex_turn_start. ${description}`
    : description;
}

function wireName(tool: CodexTool): string {
  return namespacedToolName(tool.namespace, tool.name);
}

function exactTool(environment: ChatGptTurnEnvironment, name: string): CodexTool | undefined {
  return environment.tools.find(tool => !tool.namespace && tool.name === name);
}

function gatewayToolNameIsValid(name: string): boolean {
  return /^[A-Za-z0-9_$]+$/.test(name);
}

function safeVisibleTools(environment: ChatGptTurnEnvironment, contract: ChatGptMcpContract): CodexTool[] {
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

function isAgentWaitTool(tool: CodexTool): boolean {
  return isGatewayAgentWaitTool(wireName(tool));
}

function isGatewayAgentWaitTool(name: string): boolean {
  return GATEWAY_AGENT_WAIT_TOOL_NAMES.has(name);
}

function browserToolDescription(tool: CodexTool): string {
  if (isAgentWaitTool(tool)) return `${tool.description}\n\n${AGENT_WAIT_TRANSPORT_RULE}`;
  if (!tool.namespace && tool.name === "exec") {
    return `${tool.description}\n\n${AGENT_WAIT_TRANSPORT_RULE} This rule is enforced for wait_agent calls made inside exec; recursive raw exec is unavailable.`;
  }
  return tool.description;
}

function browserToolParameters(tool: CodexTool): Record<string, unknown> {
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

function assertBrowserToolArguments(tool: CodexTool, args: Record<string, unknown>): void {
  if (!isAgentWaitTool(tool)) return;
  if (args.timeout_ms !== CHATGPT_WEB_AGENT_WAIT_POLL_MS) {
    throw new Error(
      `ChatGPT Web wait_agent requires timeout_ms=${CHATGPT_WEB_AGENT_WAIT_POLL_MS}`
      + " so the shared MCP channel remains available to spawned Web agents",
    );
  }
}

function assertGatewayToolArguments(name: string, args: Record<string, unknown>): void {
  if (!isGatewayAgentWaitTool(name)) return;
  if (args.timeout_ms !== CHATGPT_WEB_AGENT_WAIT_POLL_MS) {
    throw new Error(
      `ChatGPT Web wait_agent requires timeout_ms=${CHATGPT_WEB_AGENT_WAIT_POLL_MS}`
      + " so the shared MCP channel remains available to spawned Web agents",
    );
  }
}

export function chatGptMcpInvocationTimeout(
  environment: ChatGptTurnEnvironment & { expiresAt?: number },
  now = Date.now(),
  requestedTimeoutMs?: number,
): number {
  const baseTimeout = Math.max(CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS, requestedTimeoutMs ?? 0);
  const remaining = environment.expiresAt === undefined
    ? baseTimeout
    : Math.max(1, environment.expiresAt - now);
  return Math.min(baseTimeout, remaining);
}

export function sanitizeToolOutputContent(
  content: unknown[],
  options: ToolSpoolerOptions = {},
): unknown[] {
  return sanitizeToolOutputWithSpooler(content, options);
}

export type McpContentPart = {
  type: "text";
  text: string;
  offloadedPath?: string;
  [key: string]: unknown;
};

export type McpCallResult = {
  content: McpContentPart[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

export function asMcpResult(
  value: BrokerToolResult | import("./fast-path-handlers").FastPathToolResult,
  options: ToolSpoolerOptions = {},
): McpCallResult {
  const sanitizedContent = sanitizeToolOutputContent(value.content, options) as McpContentPart[];
  const spooledPart = Array.isArray(sanitizedContent)
    ? sanitizedContent.find(p => p && typeof p === "object" && typeof p.offloadedPath === "string")
    : undefined;

  let structuredContent = value.structuredContent;
  if (spooledPart && structuredContent && typeof structuredContent === "object") {
    structuredContent = {
      ...structuredContent,
      spooled: true,
      offloadedPath: spooledPart.offloadedPath,
      ...(typeof (structuredContent as { content?: unknown }).content === "string"
      && ((structuredContent as { content: string }).content.length > (options.maxChars ?? DEFAULT_TOOL_OFFLOAD_THRESHOLD_CHARS))
        ? { content: spooledPart.text }
        : {}),
    };
  }

  return {
    content: sanitizedContent,
    ...(structuredContent !== undefined && structuredContent !== null && typeof structuredContent === "object"
      ? { structuredContent: structuredContent as Record<string, unknown> }
      : {}),
    ...(value.isError ? { isError: true } : {}),
    ...("_meta" in value && value._meta !== undefined && value._meta !== null && typeof value._meta === "object"
      ? { _meta: (value as { _meta?: Record<string, unknown> })._meta as Record<string, unknown> }
      : {}),
  };
}

function execGateway(environment: ChatGptTurnEnvironment): CodexTool | undefined {
  const tool = exactTool(environment, "exec");
  return tool?.freeform ? tool : undefined;
}

function gatewayNestedToolName(toolName: string): string {
  return toolName.replace(/[^A-Za-z0-9_$]/g, "_");
}

interface GatewayToolDescriptor {
  name: string;
  description: string;
}

interface GatewayToolCatalogPage {
  tools: GatewayToolDescriptor[];
  total: number;
}

function gatewayToolDescription(tool: GatewayToolDescriptor): string {
  if (!isGatewayAgentWaitTool(tool.name)) return tool.description;
  return `${tool.description}\n\n${AGENT_WAIT_TRANSPORT_RULE}`;
}

function gatewayToolCatalogProgram(options: {
  query?: string;
  offset: number;
  limit: number;
  excludedNames: string[];
}): string {
  const needle = options.query?.trim().toLowerCase() ?? "";
  return [
    "if (typeof ALL_TOOLS === \"undefined\" || !Array.isArray(ALL_TOOLS)) throw new Error(\"Native nested tool registry is unavailable\");",
    `const excludedNames = new Set(${JSON.stringify(options.excludedNames)});`,
    `const needle = ${JSON.stringify(needle)};`,
    "const visibleName = name => {",
    "  return typeof name === \"string\" && /^[A-Za-z0-9_$]+$/.test(name) && !excludedNames.has(name);",
    "};",
    "const matches = ALL_TOOLS",
    "  .filter(tool => visibleName(tool?.name))",
    "  .map(tool => ({ name: tool.name, description: typeof tool.description === \"string\" ? tool.description : \"\" }))",
    "  .filter(tool => !needle || (tool.name + \"\\n\" + tool.description).toLowerCase().includes(needle));",
    `const page = matches.slice(${options.offset}, ${options.offset + options.limit});`,
    "text(JSON.stringify({ tools: page, total: matches.length }));",
  ].join("\n");
}

function gatewayToolCatalogPage(response: {
  content: unknown[];
  isError?: boolean;
}, excludedNames: ReadonlySet<string>): GatewayToolCatalogPage {
  const textBlocks = response.content
    .map(item => item && typeof item === "object" && !Array.isArray(item)
      ? item as Record<string, unknown>
      : undefined)
    .filter((item): item is Record<string, unknown> => item?.type === "text" && typeof item.text === "string")
    .map(item => item.text as string);
  if (response.isError) {
    throw new Error(`Native nested tool inventory failed: ${textBlocks.join("\n") || "unknown error"}`);
  }
  if (textBlocks.length !== 1) {
    throw new Error("Native nested tool inventory returned an invalid text response");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(textBlocks[0]!);
  } catch {
    throw new Error("Native nested tool inventory returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Native nested tool inventory returned an invalid catalog");
  }
  const catalog = parsed as Record<string, unknown>;
  if (!Number.isSafeInteger(catalog.total) || (catalog.total as number) < 0 || !Array.isArray(catalog.tools)) {
    throw new Error("Native nested tool inventory returned invalid pagination");
  }
  const tools = catalog.tools.map((value): GatewayToolDescriptor => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Native nested tool inventory returned an invalid tool entry");
    }
    const tool = value as Record<string, unknown>;
    if (typeof tool.name !== "string"
      || typeof tool.description !== "string"
      || !gatewayToolNameIsValid(tool.name)
      || excludedNames.has(tool.name)) {
      throw new Error("Native nested tool inventory returned an invalid tool descriptor");
    }
    return { name: tool.name, description: tool.description };
  });
  return { tools, total: catalog.total as number };
}

function execGatewayResultProgram(invocation: string[]): string {
  return [
    ...invocation,
    "const emit = value => {",
    "  if (Array.isArray(value)) { for (const item of value) emit(item); return; }",
    "  if (value && typeof value === \"object\") {",
    "    if (value.type === \"image\") { image(value); return; }",
    "    if (value.type === \"audio\") { audio(value); return; }",
    "    if (value.type === \"text\" && typeof value.text === \"string\") { text(value.text); return; }",
    "    if (typeof value.image_url === \"string\" && typeof value.output_hint === \"string\") { generatedImage(value); return; }",
    "    if (typeof value.image_url === \"string\") { image(value.image_url, value.detail ?? \"auto\"); return; }",
    "    if (typeof value.audio_url === \"string\") { audio(value.audio_url); return; }",
    "    if (Array.isArray(value.content)) { for (const item of value.content) emit(item); return; }",
    "  }",
    "  text(value);",
    "};",
    "emit(result);",
  ].join("\n");
}

function execGatewayProgram(
  nestedToolName: string,
  freeform: boolean,
  payload: { arguments?: Record<string, unknown>; input?: string },
  excludedNames: string[],
): string {
  if (!gatewayToolNameIsValid(nestedToolName) || excludedNames.includes(nestedToolName)) {
    throw new Error(`Codex nested tool is not available in this turn: ${nestedToolName}`);
  }
  const gatewayName = gatewayNestedToolName(nestedToolName);
  if (gatewayName !== nestedToolName) {
    throw new Error(`Codex nested tool name is invalid: ${nestedToolName}`);
  }
  const nestedInput = freeform ? payload.input ?? "" : payload.arguments ?? {};
  return execGatewayResultProgram([
    "if (typeof ALL_TOOLS === \"undefined\" || !Array.isArray(ALL_TOOLS)) throw new Error(\"Native nested tool registry is unavailable\");",
    `const nestedToolName = ${JSON.stringify(gatewayName)};`,
    `const excludedNames = new Set(${JSON.stringify(excludedNames)});`,
    "if (excludedNames.has(nestedToolName)) throw new Error(\"Native nested tool is not callable through the structured gateway\");",
    "if (!ALL_TOOLS.some(tool => tool?.name === nestedToolName)) throw new Error(\"Native nested tool is not listed in this turn\");",
    "const nestedTool = tools[nestedToolName];",
    "if (typeof nestedTool !== \"function\") throw new Error(\"Native nested tool is listed but unavailable\");",
    `const result = await nestedTool(${JSON.stringify(nestedInput)});`,
  ]);
}

/**
 * Preserve the native freeform exec surface while applying the same wait_agent deadline contract
 * as direct calls. The model still owns its JavaScript; only the tool registry it receives is a
 * transparent proxy whose native wait functions validate their transport-bound argument before dispatch.
 */
function transportBoundRawExecProgram(input: string, blockedExecName: string): string {
  return [
    "await (async (tools) => {",
    input,
    "})((() => {",
    "  const source = tools;",
    `  const waitNames = new Set(${JSON.stringify([...GATEWAY_AGENT_WAIT_TOOL_NAMES])});`,
    `  const blockedExecName = ${JSON.stringify(blockedExecName)};`,
    `  const pollMs = ${CHATGPT_WEB_AGENT_WAIT_POLL_MS};`,
    "  const registryNames = new Set(Reflect.ownKeys(source));",
    "  if (typeof ALL_TOOLS !== \"undefined\" && Array.isArray(ALL_TOOLS)) {",
    "    for (const tool of ALL_TOOLS) if (typeof tool?.name === \"string\") registryNames.add(tool.name);",
    "  }",
    "  const wrappers = new Map();",
    "  const expose = name => {",
    "    if (wrappers.has(name)) return wrappers.get(name);",
    "    const value = Reflect.get(source, name, source);",
    "    let exposed = value;",
    "    if (typeof value === \"function\" && name === blockedExecName) {",
    "      exposed = () => { throw new Error(\"Nested raw exec is unavailable inside ChatGPT Web exec\"); };",
    "    } else if (typeof value === \"function\" && typeof name === \"string\" && waitNames.has(name)) {",
    "      exposed = args => {",
    "        if (!args || typeof args !== \"object\" || Array.isArray(args) || args.timeout_ms !== pollMs) {",
    "          throw new Error(\"ChatGPT Web wait_agent requires timeout_ms=\" + pollMs + \" so the shared MCP channel remains available to spawned Web agents\");",
    "        }",
    "        return Reflect.apply(value, source, [args]);",
    "      };",
    "    } else if (typeof value === \"function\") {",
    "      exposed = (...args) => Reflect.apply(value, source, args);",
    "    }",
    "    wrappers.set(name, exposed);",
    "    return exposed;",
    "  };",
    "  return new Proxy(Object.create(null), {",
    "    get: (_target, name) => expose(name),",
    "    has: (_target, name) => registryNames.has(name) || Reflect.has(source, name),",
    "    ownKeys: () => [...registryNames],",
    "    getOwnPropertyDescriptor: (_target, name) =>",
    "      registryNames.has(name) || Reflect.has(source, name)",
    "        ? { configurable: true, enumerable: true, writable: false, value: expose(name) }",
    "        : undefined,",
    "    set: () => false,",
    "    defineProperty: () => false,",
    "    deleteProperty: () => false,",
    "    setPrototypeOf: () => false,",
    "    getPrototypeOf: () => null,",
    "    preventExtensions: () => false,",
    "  });",
    "})());",
  ].join("\n");
}

function execCommandGatewayProgram(
  execCommandArguments: Record<string, unknown>,
  shellCommandArguments: Record<string, unknown>,
): string {
  const execCommandName = gatewayNestedToolName("exec_command");
  const shellCommandName = gatewayNestedToolName("shell_command");
  return execGatewayResultProgram([
    "if (typeof ALL_TOOLS === \"undefined\" || !Array.isArray(ALL_TOOLS)) throw new Error(\"Native command tool registry is unavailable\");",
    "const nativeCommandNames = new Set(ALL_TOOLS.map(tool => tool?.name));",
    `const nativeCommandCandidates = ${JSON.stringify([execCommandName, shellCommandName])}.filter(name => nativeCommandNames.has(name));`,
    "if (nativeCommandCandidates.length !== 1) throw new Error(\"Expected exactly one native command tool; found \" + (nativeCommandCandidates.join(\", \") || \"none\"));",
    "const nativeCommandName = nativeCommandCandidates[0];",
    "const nativeCommand = tools[nativeCommandName];",
    "if (typeof nativeCommand !== \"function\") throw new Error(\"Native command tool \" + nativeCommandName + \" is listed but unavailable\");",
    `const nativeCommandInput = nativeCommandName === ${JSON.stringify(execCommandName)} ? ${JSON.stringify(execCommandArguments)} : ${JSON.stringify(shellCommandArguments)};`,
    "const result = await nativeCommand(nativeCommandInput);",
  ]);
}

async function waitOnTasks(taskIds: string[], waitMs: number, lines = 30): Promise<{
  tasks: Array<{
    task_id: string;
    status: string;
    exit_code: number | null;
    summary: string;
    log_path: string;
  }>;
  pending: number;
}> {
  const deadline = Date.now() + Math.max(0, waitMs);
  while (Date.now() < deadline) {
    const running = taskIds
      .map(id => globalBackgroundTaskManager.getTask(id))
      .filter((t): t is NonNullable<typeof t> => t !== undefined && t.status === "running");
    if (running.length === 0) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const slice = Math.min(remaining, 5_000);
    await globalBackgroundTaskManager.pollTask(running[0]!.id, slice, lines);
  }

  const results = taskIds.map(id => {
    const task = globalBackgroundTaskManager.getTask(id);
    if (!task) {
      return {
        task_id: id,
        status: "not_found",
        exit_code: null,
        summary: `Task not found: ${id}`,
        log_path: "",
      };
    }
    const logInfo = globalBackgroundTaskManager.getTaskLog(task.id, lines);
    const summary = summarizeTask(task, logInfo?.logTail ?? "");
    return {
      task_id: task.id,
      status: task.status,
      exit_code: task.exitCode,
      summary,
      log_path: task.fullLogPath,
    };
  });

  const pending = results.filter(r => r.status === "running").length;
  return { tasks: results, pending };
}

export async function runChatGptMcpServer(options: {
  brokerSocketPath: string;
  contract?: ChatGptMcpContract;
}): Promise<void> {
  const contract = options.contract ?? "native";
  // Chat-First derives its authority from the local operator's config.json instead of a per-turn
  // envelope, so it fails closed before any transport is opened. Native/safe keep deriving their
  // authority from Codex envelopes and never read this configuration.
  const chatFirstConfig = contract === "chat-first"
    ? (() => {
      const config = loadConfig();
      if (!config.chatFirst?.enabled) {
        throw new Error("chat-first is not enabled in config.json");
      }
      return config;
    })()
    : undefined;
  const server = new McpServer(
    {
      name: contract === "safe"
        ? "codex-safe"
        : contract === "chat-first"
          ? "codex-chat-first"
          : "codex-native",
      version: VERSION,
    },
    contract === "safe"
      ? { instructions: ZERO_RISK_MCP_INSTRUCTIONS }
      : contract === "chat-first"
        ? { instructions: CHAT_FIRST_MCP_INSTRUCTIONS }
        : { instructions: NATIVE_CHATGPT_MCP_INSTRUCTIONS },
  );

  const claimTurn = async (
    toolName: string,
    turnToken: string,
    extra: McpRequestExtra,
  ): Promise<ClaimedTurn> => {
    console.error(`[chatgpt-web-mcp] ${toolName} scope=${requestScopeSummary(extra)}`);
    const activityId = `activity_${randomBytes(18).toString("base64url")}`;
    try {
      // Chat-First never claims turns (its tools take no turn reference), so the broker contract
      // value only ever observes native/safe here; the mapping keeps the wire type narrow.
      const claimed = await callTurnBroker<Omit<ClaimedTurn, "activityId">>(
        options.brokerSocketPath,
        { method: "claim", token: turnToken, activityId, contract: contract === "chat-first" ? "native" : contract },
        contract === "safe" ? null : 5_000,
        extra.signal,
      );
      return { ...claimed, activityId };
    } catch (error) {
      try {
        await settleTurnActivity(turnToken, activityId);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Codex Native claim failed and its broker activity could not be retired",
        );
      }
      throw error;
    }
  };

  const settleTurnActivity = async (turnToken: string, activityId: string): Promise<void> => {
    let firstError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await callTurnBroker(options.brokerSocketPath, {
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
  };

  // A handler may chain multiple broker invokes with long waits (nested agent polls), and a
  // quiet gap longer than the broker's activity liveness lets the completion fence commit
  // mid-handler, killing the next invoke. The lease is refreshed while the handler runs.
  const CHATGPT_MCP_ACTIVITY_KEEP_ALIVE_MS = 45_000;

  const touchTurnActivity = async (turnToken: string, activityId: string): Promise<boolean> => {
    try {
      const response = await callTurnBroker<{ touched: boolean }>(
        options.brokerSocketPath,
        { method: "owner_touch_activity", token: turnToken, activityId },
        5_000,
      );
      return response.touched === true;
    } catch {
      return false;
    }
  };

  const withClaimedTurn = async <T>(
    toolName: string,
    turnToken: string,
    extra: McpRequestExtra,
    action: (claimed: ClaimedTurn) => Promise<T> | T,
  ): Promise<T> => {
    const claimed = await claimTurn(toolName, turnToken, extra);
    const keepAlive = setInterval(() => {
      void touchTurnActivity(turnToken, claimed.activityId);
    }, CHATGPT_MCP_ACTIVITY_KEEP_ALIVE_MS);
    keepAlive.unref?.();
    try {
      return await action(claimed);
    } finally {
      clearInterval(keepAlive);
      // The broker's terminal fence treats even a fully local inventory lookup as live MCP work.
      // Settle the lease without the request AbortSignal: cancellation must not strand activity
      // and silently prevent every later completion candidate from committing.
      await settleTurnActivity(turnToken, claimed.activityId);
    }
  };

  if (contract === "safe") {
    server.registerTool(
      "codex_turn_start",
      {
        title: "Connect a Codex Zero Risk request",
        description: "Connect the request_id included in the pasted Codex Web GPT request so its Codex tools can be used.",
        inputSchema: {
          request_id: turnTokenSchema,
        },
        outputSchema: {
          started: z.literal(true),
          duplicate: z.boolean(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ request_id }, extra) => {
        console.error(`[chatgpt-web-mcp] codex_turn_start scope=${requestScopeSummary(extra)}`);
        const response = await callTurnBroker<{ started: true; duplicate: boolean }>(options.brokerSocketPath, {
          method: "safe_start",
          token: request_id,
        }, 5_000, extra.signal);
        return result(response);
      },
    );
  }

  const invoke = async (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    tool: CodexTool,
    payload: { arguments?: Record<string, unknown>; input?: string },
    signal?: AbortSignal,
    requestedTimeoutMs?: number,
  ) => {
    const timeoutMs = chatGptMcpInvocationTimeout(bound, Date.now(), requestedTimeoutMs);
    try {
      const response = await callTurnBroker<BrokerToolResult>(options.brokerSocketPath, {
        method: "invoke",
        bindingId,
        wireName: wireName(tool),
        freeform: tool.freeform === true,
        ...(tool.freeform ? { input: payload.input ?? "" } : { arguments: payload.arguments ?? {} }),
      }, timeoutMs, signal);
      return asMcpResult(response, {
        toolName: wireName(tool),
        workspaceRoot: bound.cwd,
      });
    } catch (error) {
      // A cancelled/timed-out MCP request no longer has a consumer for the native result. Revoke
      // the whole turn capability so the broker drops the pending invocation and every later call
      // from that abandoned ChatGPT response fails explicitly against its retired binding.
      try {
        await callTurnBroker(options.brokerSocketPath, {
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
  };

  const invokeNestedNative = (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    nestedToolName: string,
    freeform: boolean,
    payload: { arguments?: Record<string, unknown>; input?: string },
    signal?: AbortSignal,
    requestedTimeoutMs?: number,
  ) => {
    const gateway = execGateway(bound);
    if (!gateway) {
      throw new Error(`This Codex turn did not advertise ${nestedToolName} or the native exec gateway`);
    }
    return invoke(bindingId, bound, gateway, {
      input: execGatewayProgram(nestedToolName, freeform, payload, bound.tools.map(wireName)),
    }, signal, requestedTimeoutMs);
  };

  // Chat-First registers its own token-free versions of the filesystem, inventory, and mutation
  // tools at the end of this function; the turn-bound native registrations below must not run
  // for it, both to avoid duplicate names and to keep turn_token out of its public ABI.
  if (contract !== "chat-first") {
  server.registerTool(
    "codex_exec",
    {
      title: "Run a native Codex command",
      description: afterSafeStart(contract, "Invoke the command tool advertised by the current outer Codex harness. A long-running command returns its native session_id."),
      inputSchema: {
        ...turnReferenceInput(contract),
        cmd: z.string().min(1).max(100_000),
        workdir: z.string().max(16_384).optional(),
        background: z.boolean().default(false).optional()
          .describe("If true, runs command asynchronously in background and returns task_id immediately. Use codex_wait_tasks to pause until finished."),
        yield_time_ms: z.number().int().min(250).max(30_000).optional(),
        max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
        tty: z.boolean().optional(),
        sandbox_permissions: z.enum(["use_default", "require_escalated"]).optional()
          .describe("Native Codex sandbox request, only when the current command tool supports it. Codex decides whether to approve."),
        justification: z.string().optional()
          .describe("Approval question for a native require_escalated request; omit otherwise."),
        prefix_rule: z.array(z.string()).optional()
          .describe("Optional native approval prefix for require_escalated; Codex owns its approval and persistence."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input, extra) => withClaimedTurn(
      "codex_exec",
      turnReference(contract, input),
      extra,
      async claimed => {
        const { cmd, workdir, background, yield_time_ms, max_output_tokens, tty, sandbox_permissions, justification, prefix_rule } = input;
        const bound = claimed.environment;

        if (background) {
          const policyType = bound.sandboxPolicy.type;
          if (policyType !== "dangerFullAccess" && policyType !== "workspaceWrite") {
            throw new Error("background requires write-capable sandbox");
          }
          const targetCwd = workdir ? resolveSafeWorkspacePath(workdir, bound.cwd, bound.roots) : bound.cwd;
          const task = globalBackgroundTaskManager.startTask({
            cmd,
            cwd: targetCwd,
            roots: bound.roots,
            writableRoots: bound.writableRoots,
          });

          const traceId = claimed.traceId;
          const turnToken = turnReference(contract, input);
          const unsubscribe = globalBackgroundTaskManager.onCompletion(async completedTask => {
            if (completedTask.id !== task.id) return;
            unsubscribe();
            try {
              const logInfo = globalBackgroundTaskManager.getTaskLog(task.id, 50);
              const summary = summarizeTask(completedTask, logInfo?.logTail ?? "");
              const envPort = Number(process.env.CODEX_CHATGPT_WEB_PORT);
              let daemonPort = Number.isInteger(envPort) && envPort > 0 ? envPort : undefined;
              if (!daemonPort) {
                try {
                  daemonPort = loadConfig().port;
                } catch {}
              }
              daemonPort ??= 17841;
              const payload: TaskCompletionPayload = {
                source: "chatgpt-web-mcp",
                task: {
                  id: completedTask.id,
                  cmd: completedTask.cmd,
                  cwd: completedTask.cwd,
                  status: completedTask.status === "running" ? "completed" : completedTask.status,
                  exitCode: completedTask.exitCode,
                  startedAt: completedTask.startedAt,
                  completedAt: completedTask.completedAt ?? new Date().toISOString(),
                  logPath: completedTask.fullLogPath,
                },
                summary,
                ...(traceId ? { traceId } : {}),
                turnToken,
              };
              await fetch(`http://127.0.0.1:${daemonPort}/internal/tasks/completed`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
              });
            } catch {
              // fire-and-forget: notification failure never throws
            }
          });

          const ack = {
            task_id: task.id,
            status: task.status,
            cmd: task.cmd,
            pid: task.pid,
            log_path: task.fullLogPath,
            message: "Command started in background. Use codex_wait_tasks to wait for completion or codex_read_file to view the log.",
          };
          workspaceFileCache.clear();
          return result(ack);
        }

        const requestedTimeoutMs = yield_time_ms !== undefined ? yield_time_ms + 15_000 : undefined;
        const permissions = {
          ...(sandbox_permissions !== undefined ? { sandbox_permissions } : {}),
          ...(justification !== undefined ? { justification } : {}),
          ...(prefix_rule !== undefined ? { prefix_rule } : {}),
        };
        const execCommandArguments = {
          cmd,
          ...(workdir ? { workdir } : {}),
          ...(yield_time_ms !== undefined ? { yield_time_ms } : {}),
          ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
          ...(tty !== undefined ? { tty } : {}),
          ...permissions,
        };
        const shellCommandArguments = {
          command: cmd,
          ...(workdir ? { workdir } : {}),
          ...(yield_time_ms !== undefined ? { timeout_ms: yield_time_ms } : {}),
          ...permissions,
        };
        const tool = exactTool(bound, "exec_command") ?? exactTool(bound, "shell_command");
        if (tool) {
          // Never silently discard an approval request on a native registry that cannot express it.
          const properties = tool.parameters.properties;
          for (const key of Object.keys(permissions)) {
            if (!properties || typeof properties !== "object" || !Object.hasOwn(properties, key)) {
              throw new Error(`The current native ${tool.name} tool does not support ${key}`);
            }
          }
          const args = tool.name === "exec_command" ? execCommandArguments : shellCommandArguments;
          const res = await invoke(claimed.bindingId, bound, tool, { arguments: args }, extra.signal, requestedTimeoutMs);
          workspaceFileCache.clear();
          return res;
        }
        const gateway = execGateway(bound);
        if (!gateway) {
          throw new Error("This Codex turn did not advertise a native command tool or the native exec gateway");
        }
        const res = await invoke(claimed.bindingId, bound, gateway, {
          input: execCommandGatewayProgram(execCommandArguments, shellCommandArguments),
        }, extra.signal, requestedTimeoutMs);
        workspaceFileCache.clear();
        return res;
      },
    ),
  );

  server.registerTool(
    "codex_wait_tasks",
    {
      title: "Wait for background tasks and return compact summaries",
      description: afterSafeStart(contract, "Wait for background command tasks to finish or until wait_ms expires. Returns a compact single-line summary for each task and the count of pending tasks."),
      inputSchema: {
        ...turnReferenceInput(contract),
        task_ids: z.array(z.string().min(1)).min(1).max(10).describe("List of 1 to 10 background task IDs to wait for."),
        wait_ms: z.number().int().min(0).max(90_000).default(60_000).optional().describe("Milliseconds to wait for completion (clamped <= 90000, default 60000)."),
        lines: z.number().int().min(1).max(500).default(30).optional().describe("Trailing log lines to inspect for summarizing (default 30)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) => withClaimedTurn(
      "codex_wait_tasks",
      turnReference(contract, input),
      extra,
      async claimed => {
        const rawWait = input.wait_ms ?? 60_000;
        const clampedWait = Math.min(Math.max(rawWait, 0), 90_000);
        const effectiveWaitMs = Math.min(
          clampedWait,
          chatGptMcpInvocationTimeout(claimed.environment, Date.now(), clampedWait),
        );
        const res = await waitOnTasks(input.task_ids, effectiveWaitMs, input.lines ?? 30);
        return result(res);
      },
    ),
  );

  server.registerTool(
    "codex_write_stdin",
    {
      title: "Continue a native Codex command session",
      description: afterSafeStart(contract, "Write characters to, or poll, a session_id returned by codex_exec."),
      inputSchema: {
        ...turnReferenceInput(contract),
        session_id: z.number().int().nonnegative(),
        chars: z.string().max(1_000_000).optional(),
        yield_time_ms: z.number().int().min(250).max(300_000).optional(),
        max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input, extra) => withClaimedTurn(
      "codex_write_stdin",
      turnReference(contract, input),
      extra,
      async claimed => {
        const { session_id, chars, yield_time_ms, max_output_tokens } = input;
        const bound = claimed.environment;
        const requestedTimeoutMs = yield_time_ms !== undefined ? yield_time_ms + 15_000 : undefined;
        const tool = exactTool(bound, "write_stdin");
        const payload = { arguments: {
          session_id,
          ...(chars !== undefined ? { chars } : {}),
          ...(yield_time_ms !== undefined ? { yield_time_ms } : {}),
          ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
        } };
        const res = await (tool
          ? invoke(claimed.bindingId, bound, tool, payload, extra.signal, requestedTimeoutMs)
          : invokeNestedNative(claimed.bindingId, bound, "write_stdin", false, payload, extra.signal, requestedTimeoutMs));
        if (chars !== undefined) {
          workspaceFileCache.clear();
        }
        return res;
      },
    ),
  );

  server.registerTool(
    "codex_apply_patch",
    {
      title: "Apply a native Codex patch",
      description: afterSafeStart(contract, "Invoke the outer Codex apply_patch tool, producing a native file-change item in the Codex task."),
      inputSchema: { ...turnReferenceInput(contract), patch: z.string().min(1).max(5_000_000) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input, extra) => withClaimedTurn(
      "codex_apply_patch",
      turnReference(contract, input),
      extra,
      async claimed => {
        const { patch } = input;
        const bound = claimed.environment;
        const tool = exactTool(bound, "apply_patch");
        let res;
        if (!tool) {
          res = await invokeNestedNative(claimed.bindingId, bound, "apply_patch", true, { input: patch }, extra.signal);
        } else {
          res = tool.freeform
            ? await invoke(claimed.bindingId, bound, tool, { input: patch }, extra.signal)
            : await invoke(claimed.bindingId, bound, tool, { arguments: { input: patch } }, extra.signal);
        }
        workspaceFileCache.clear();
        return res;
      },
    ),
  );

  server.registerTool(
    "codex_view_image",
    {
      title: "View an image through native Codex",
      description: afterSafeStart(contract, "Invoke the outer Codex view_image tool and return its multimodal result to this same ChatGPT response."),
      inputSchema: {
        ...turnReferenceInput(contract),
        path: z.string().min(1).max(16_384),
        detail: z.enum(["high", "original"]).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) => withClaimedTurn(
      "codex_view_image",
      turnReference(contract, input),
      extra,
      async claimed => {
        const { path, detail } = input;
        const bound = claimed.environment;
        const tool = exactTool(bound, "view_image");
        const payload = { arguments: { path, ...(detail ? { detail } : {}) } };
        return tool
          ? invoke(claimed.bindingId, bound, tool, payload, extra.signal)
          : invokeNestedNative(claimed.bindingId, bound, "view_image", false, payload, extra.signal);
      },
    ),
  );

  server.registerTool(
    "codex_read_file",
    {
      title: "Read a file directly from the workspace",
      description: afterSafeStart(
        contract,
        "Read file content directly from the workspace filesystem without shell overhead. Supports line offset and limit.",
      ),
      inputSchema: {
        ...turnReferenceInput(contract),
        path: z.string().min(1).max(16_384).describe("Path to the file (relative to working directory or absolute within sandbox roots)."),
        offset: z.number().int().min(1).default(1).optional().describe("1-indexed line number to start reading from (default: 1)."),
        limit_lines: z.number().int().min(1).max(2_000).default(500).optional().describe("Maximum number of lines to read (default: 500, max: 2000)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) => withClaimedTurn(
      "codex_read_file",
      turnReference(contract, input),
      extra,
      claimed => {
        const { path, offset, limit_lines } = input;
        const bound = claimed.environment;
        const res = handleReadFile({ path, offset, limit_lines, cwd: bound.cwd, roots: bound.roots, cache: workspaceFileCache });
        return asMcpResult(res, { toolName: "codex_read_file", workspaceRoot: bound.cwd });
      },
    ),
  );

  server.registerTool(
    "codex_write_file",
    {
      title: "Write a file directly to the workspace",
      description: afterSafeStart(
        contract,
        "Write complete text content directly to a workspace file without shell overhead. Refuses to clobber an existing file unless overwrite is true.",
      ),
      inputSchema: {
        ...turnReferenceInput(contract),
        path: z.string().min(1).max(16_384).describe("Path to the file (relative to working directory or absolute within sandbox roots)."),
        content: z.string().min(1).max(5_000_000).describe("Complete text content to write to the file."),
        overwrite: z.boolean().default(false).optional().describe("Allow replacing an existing file (default: false)."),
        create_parents: z.boolean().default(false).optional().describe("Create missing parent directories (default: false)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input, extra) => withClaimedTurn(
      "codex_write_file",
      turnReference(contract, input),
      extra,
      claimed => {
        const { path, content, overwrite, create_parents } = input;
        const bound = claimed.environment;
        const res = handleWriteFile({ path, content, overwrite, create_parents, cwd: bound.cwd, roots: bound.roots, writableRoots: bound.writableRoots ?? bound.roots, cache: workspaceFileCache });
        return asMcpResult(res, { toolName: "codex_write_file", workspaceRoot: bound.cwd });
      },
    ),
  );

  server.registerTool(
    "codex_patch_file",
    {
      title: "Patch a workspace file in place",
      description: afterSafeStart(
        contract,
        "Replace the first exact occurrence of target_content with replacement_content in a workspace file without shell overhead.",
      ),
      inputSchema: {
        ...turnReferenceInput(contract),
        path: z.string().min(1).max(16_384).describe("Path to the file (relative to working directory or absolute within sandbox roots)."),
        target_content: z.string().min(1).max(1_000_000).describe("Exact text to replace, including whitespace and indentation. Only the first occurrence is replaced."),
        replacement_content: z.string().max(1_000_000).describe("Replacement text; an empty string deletes the matched target."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input, extra) => withClaimedTurn(
      "codex_patch_file",
      turnReference(contract, input),
      extra,
      claimed => {
        const { path, target_content, replacement_content } = input;
        const bound = claimed.environment;
        const res = handlePatchFile({ path, target_content, replacement_content, cwd: bound.cwd, roots: bound.roots, writableRoots: bound.writableRoots ?? bound.roots, cache: workspaceFileCache });
        return asMcpResult(res, { toolName: "codex_patch_file", workspaceRoot: bound.cwd });
      },
    ),
  );

  server.registerTool(
    "codex_list_dir",
    {
      title: "List directory contents directly",
      description: afterSafeStart(
        contract,
        "List directory contents directly from the filesystem without shell overhead. Supports depth and entry limits.",
      ),
      inputSchema: {
        ...turnReferenceInput(contract),
        path: z.string().max(16_384).default(".").optional().describe("Directory path to list (default: current working directory)."),
        depth: z.number().int().min(1).max(4).default(1).optional().describe("Maximum directory depth to traverse (default: 1 = immediate children)."),
        limit: z.number().int().min(1).max(500).default(100).optional().describe("Maximum number of entries to return (default: 100, max: 500)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) => withClaimedTurn(
      "codex_list_dir",
      turnReference(contract, input),
      extra,
      claimed => {
        const { path, depth, limit } = input;
        const bound = claimed.environment;
        const res = handleListDir({ path, depth, limit, cwd: bound.cwd, roots: bound.roots });
        return asMcpResult(res, { toolName: "codex_list_dir", workspaceRoot: bound.cwd });
      },
    ),
  );

  server.registerTool(
    "codex_grep",
    {
      title: "Search file contents directly",
      description: afterSafeStart(
        contract,
        "Fast workspace text search using ripgrep without shell overhead. Returns matched lines with line numbers.",
      ),
      inputSchema: {
        ...turnReferenceInput(contract),
        query: z.string().min(1).max(1_000).describe("Search string or regular expression pattern."),
        path: z.string().max(16_384).default(".").optional().describe("Directory or file to search in (default: current working directory)."),
        max_results: z.number().int().min(1).max(200).default(50).optional().describe("Maximum matching lines to return (default: 50, max: 200)."),
        case_sensitive: z.boolean().default(false).optional().describe("Whether search is case-sensitive (default: false)."),
        file_pattern: z.string().max(256).optional().describe("Optional glob pattern to filter files (e.g. '*.ts', 'src/**')."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) => withClaimedTurn(
      "codex_grep",
      turnReference(contract, input),
      extra,
      claimed => {
        const { query, path, max_results, case_sensitive, file_pattern } = input;
        const bound = claimed.environment;
        const res = handleGrep({ query, path, max_results, case_sensitive, file_pattern, cwd: bound.cwd, roots: bound.roots });
        return asMcpResult(res, { toolName: "codex_grep", workspaceRoot: bound.cwd });
      },
    ),
  );

  server.registerTool(
    "codex_tool_inventory",
    {
      title: "Discover tools from the current Codex harness",
      description: contract === "safe"
        ? "List tools available to the connected Zero Risk request, including configured MCP and app tools."
        : "Search the exact tool registry supplied to the current outer Codex turn, including configured MCP/app tools.",
      inputSchema: {
        ...turnReferenceInput(contract),
        query: z.string().max(500).optional(),
        offset: z.number().int().min(0).max(100_000).default(0),
        limit: z.number().int().min(1).max(50).default(20),
        include_schema: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) => withClaimedTurn(
      "codex_tool_inventory",
      turnReference(contract, input),
      extra,
      async claimed => {
        const { query, offset, limit, include_schema } = input;
        const bound = claimed.environment;
        const needle = query?.trim().toLowerCase();
        const visibleTools = safeVisibleTools(bound, contract);
        const directMatches = visibleTools.filter(tool => !needle || [
          wireName(tool),
          tool.name,
          tool.namespace ?? "",
          tool.description,
        ].join("\n").toLowerCase().includes(needle));
        const directPage = directMatches.slice(offset, offset + limit).map(tool => ({
          wire_name: wireName(tool),
          name: tool.name,
          namespace: tool.namespace ?? null,
          description: browserToolDescription(tool),
          kind: tool.freeform ? "freeform" : tool.toolSearch ? "tool_search" : "function",
          ...(include_schema ? { parameters: browserToolParameters(tool) } : {}),
        }));
        let nestedTotal = 0;
        let nestedPage: Array<Record<string, unknown>> = [];
        const gateway = execGateway(bound);
        if (gateway) {
          const excludedGatewayNames = bound.tools.map(wireName);
          const nestedOffset = Math.max(0, offset - directMatches.length);
          const nestedLimit = Math.max(0, limit - directPage.length);
          const response = await invoke(claimed.bindingId, bound, gateway, {
            input: gatewayToolCatalogProgram({
              query,
              offset: nestedOffset,
              limit: nestedLimit,
              // A gateway-discovered entry may supplement the outer registry, but it must never
              // duplicate or reopen an outer tool that this contract deliberately hid (including
              // our own MCP namespace in Zero Risk).
              excludedNames: excludedGatewayNames,
            }),
          }, extra.signal);
          const catalog = gatewayToolCatalogPage(response, new Set(excludedGatewayNames));
          nestedTotal = catalog.total;
          nestedPage = catalog.tools.map(tool => ({
            wire_name: tool.name,
            name: tool.name,
            namespace: null,
            description: gatewayToolDescription(tool),
            kind: "gateway",
            ...(include_schema ? {
              parameters: {
                type: "object",
                additionalProperties: true,
                description: "Pass the exact structured arguments declared in this tool's description. For a declared freeform tool, use codex_tool_call.input instead.",
              },
            } : {}),
          }));
        }
        const page = [...directPage, ...nestedPage];
        const total = directMatches.length + nestedTotal;
        // A filtered registry miss does not mean deferred tools are unavailable. Expose the
        // actual native discovery entry separately; it is not a query match or an automatic call.
        const discoveryTools = needle && total === 0
          ? visibleTools.filter(tool => tool.toolSearch).map(tool => ({
            wire_name: wireName(tool),
            name: tool.name,
            namespace: tool.namespace ?? null,
            description: browserToolDescription(tool),
            kind: "tool_search",
            ...(include_schema ? { parameters: browserToolParameters(tool) } : {}),
          }))
          : [];
        return result({
          tools: page,
          total,
          next_offset: offset + page.length < total ? offset + page.length : null,
          ...(discoveryTools.length > 0 ? { discovery_tools: discoveryTools } : {}),
        });
      },
    ),
  );

  server.registerTool(
    "codex_tool_call",
    {
      title: "Call any tool from the current Codex harness",
      description: afterSafeStart(contract, "Invoke an exact wire_name returned by codex_tool_inventory. The outer Codex runtime performs the call, approvals, and UI lifecycle."),
      inputSchema: {
        ...turnReferenceInput(contract),
        wire_name: z.string().min(1).max(1_000),
        arguments: jsonArgumentsSchema.optional(),
        input: z.string().max(5_000_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (toolInput, extra) => {
      const { wire_name, arguments: args, input } = toolInput;
      const requestId = turnReference(contract, toolInput);
      if (contract === "native" && wire_name === CODEX_COMPACTION_CONTROL_WIRE_NAME) {
        if (input !== undefined) {
          throw new Error("Compaction control handoff does not accept freeform input");
        }
        const handoffId = args?.handoff_id;
        const summary = args?.summary;
        if (typeof handoffId !== "string" || handoffId.length === 0) {
          throw new Error("Compaction control handoff requires handoff_id");
        }
        if (typeof summary !== "string") {
          throw new Error("Compaction control handoff requires summary");
        }
        await callTurnBroker(options.brokerSocketPath, {
          method: "submit_compaction_handoff",
          token: requestId,
          handoffId,
          summary,
        }, 5_000, extra.signal);
        return result({ submitted: true });
      }
      return withClaimedTurn("codex_tool_call", requestId, extra, async claimed => {
        const bound = claimed.environment;
        const tool = safeVisibleTools(bound, contract)
          .find(candidate => wireName(candidate) === wire_name);
        if (!tool) {
          const gateway = execGateway(bound);
          const hiddenOuterTool = bound.tools.some(candidate => wireName(candidate) === wire_name);
          if (!gateway || hiddenOuterTool || !gatewayToolNameIsValid(wire_name)) {
            throw new Error(`Codex tool is not available in this turn: ${wire_name}`);
          }
          if (input !== undefined && args && Object.keys(args).length > 0) {
            throw new Error(`Codex nested tool ${wire_name} accepts either arguments or freeform input, not both`);
          }
          if (isGatewayAgentWaitTool(wire_name) && input !== undefined) {
            throw new Error(`ChatGPT Web wait_agent requires structured arguments and timeout_ms=${CHATGPT_WEB_AGENT_WAIT_POLL_MS}`);
          }
          const invocationArguments = args ?? {};
          assertGatewayToolArguments(wire_name, invocationArguments);
          const requested = typeof invocationArguments.yield_time_ms === "number"
            ? invocationArguments.yield_time_ms
            : (typeof invocationArguments.timeout_ms === "number" ? invocationArguments.timeout_ms : undefined);
          const requestedTimeoutMs = requested !== undefined ? requested + 15_000 : undefined;
          return invoke(claimed.bindingId, bound, gateway, {
            input: execGatewayProgram(wire_name, input !== undefined, {
              ...(input !== undefined ? { input } : { arguments: invocationArguments }),
            }, bound.tools.map(wireName)),
          }, extra.signal, requestedTimeoutMs);
        }
        if (tool.freeform) {
          if (input === undefined) throw new Error(`Freeform Codex tool ${wire_name} requires input`);
          if (args && Object.keys(args).length > 0) throw new Error(`Freeform Codex tool ${wire_name} does not accept arguments`);
          return invoke(claimed.bindingId, bound, tool, {
            input: tool === execGateway(bound) ? transportBoundRawExecProgram(input, wireName(tool)) : input,
          }, extra.signal);
        }
        if (input !== undefined) throw new Error(`Function Codex tool ${wire_name} does not accept freeform input`);
        const invocationArguments = args ?? {};
        assertBrowserToolArguments(tool, invocationArguments);
        const requested = typeof invocationArguments.yield_time_ms === "number"
          ? invocationArguments.yield_time_ms
          : (typeof invocationArguments.timeout_ms === "number" ? invocationArguments.timeout_ms : undefined);
        const requestedTimeoutMs = requested !== undefined ? requested + 15_000 : undefined;
        return invoke(claimed.bindingId, bound, tool, { arguments: invocationArguments }, extra.signal, requestedTimeoutMs);
      });
    },
  );
  }

  if (contract === "safe") {
    server.registerTool(
      "codex_turn_complete",
      {
        title: "Return the result to Codex",
        description: "Send the complete answer back to the connected Codex request after its work is finished. For compaction, send the requested compacted summary.",
        inputSchema: {
          request_id: turnTokenSchema,
          final_answer: z.string().min(1).max(5_000_000),
        },
        outputSchema: {
          completed: z.literal(true),
          duplicate: z.boolean(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ request_id, final_answer }, extra) => {
        console.error(`[chatgpt-web-mcp] codex_turn_complete scope=${requestScopeSummary(extra)}`);
        const response = await callTurnBroker<{ completed: true; duplicate: boolean }>(options.brokerSocketPath, {
          method: "safe_complete",
          token: request_id,
          finalAnswer: final_answer,
        }, null, extra.signal);
        return result(response);
      },
    );
  }

  if (contract === "chat-first" && chatFirstConfig?.chatFirst?.enabled) {
    const chatFirstSandboxMode = chatFirstConfig.chatFirst.sandboxMode;
    const chatFirstWritable = chatFirstSandboxMode !== "readOnly";
    const scopeFor = (requested?: string) => resolveChatFirstWorkspace(chatFirstConfig, requested);
    const chatFirstToolResult = (toolName: string, cwd: string, res: FastPathToolResult) =>
      asMcpResult(res, { toolName, workspaceRoot: cwd });
    // Only a completed mutation reaches the audit log; a failed call changed nothing on disk.
    const auditSuccessfulMutation = (tool: string, res: FastPathToolResult, requestedPath: string): void => {
      if (res.isError) return;
      const structured = res.structuredContent;
      appendChatFirstAuditEntry({
        tool,
        path: typeof structured.path === "string" ? structured.path : requestedPath,
        ...(typeof structured.bytes_written === "number" ? { bytes: structured.bytes_written } : {}),
      });
    };

    server.registerTool(
      "codex_read_file",
      {
        title: "Read a chat-first workspace file",
        description: "Read file content directly from the local workspace the operator configured, with no turn to connect. Supports a 1-indexed line offset and a line limit.",
        inputSchema: {
          path: z.string().min(1).max(16_384).describe("Path to the file (relative to the workspace or absolute)."),
          workspace: z.string().max(1_024).optional().describe("Optional configured workspace; omit it to use the default workspace."),
          offset: z.number().int().min(1).default(1).describe("1-indexed line number to start reading from (default: 1)."),
          limit_lines: z.number().int().min(1).max(2_000).default(500).describe("Maximum number of lines to read (default: 500, max: 2000)."),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async input => {
        const scope = scopeFor(input.workspace);
        const res = handleReadFile({
          path: input.path,
          offset: input.offset,
          limit_lines: input.limit_lines,
          cwd: scope.cwd,
          roots: scope.roots,
          cache: workspaceFileCache,
        });
        return chatFirstToolResult("codex_read_file", scope.cwd, res);
      },
    );

    server.registerTool(
      "codex_list_dir",
      {
        title: "List a chat-first workspace directory",
        description: "List directory contents directly from the configured local workspace, with no turn to connect. Supports traversal depth and entry limits.",
        inputSchema: {
          path: z.string().max(16_384).default(".").describe("Directory path to list (default: the workspace root)."),
          workspace: z.string().max(1_024).optional().describe("Optional configured workspace; omit it to use the default workspace."),
          depth: z.number().int().min(1).max(4).default(1).describe("Maximum directory depth to traverse (default: 1 = immediate children)."),
          limit: z.number().int().min(1).max(500).default(100).describe("Maximum number of entries to return (default: 100, max: 500)."),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async input => {
        const scope = scopeFor(input.workspace);
        const res = handleListDir({
          path: input.path,
          depth: input.depth,
          limit: input.limit,
          cwd: scope.cwd,
          roots: scope.roots,
        });
        return chatFirstToolResult("codex_list_dir", scope.cwd, res);
      },
    );

    server.registerTool(
      "codex_grep",
      {
        title: "Search a chat-first workspace",
        description: "Fast text search over the configured local workspace using ripgrep, with no turn to connect. Returns matched lines with line numbers.",
        inputSchema: {
          query: z.string().min(1).max(1_000).describe("Search string or regular expression pattern."),
          path: z.string().max(16_384).default(".").describe("Directory or file to search in (default: the workspace root)."),
          workspace: z.string().max(1_024).optional().describe("Optional configured workspace; omit it to use the default workspace."),
          max_results: z.number().int().min(1).max(200).default(50).describe("Maximum matching lines to return (default: 50, max: 200)."),
          case_sensitive: z.boolean().default(false).describe("Whether search is case-sensitive (default: false)."),
          file_pattern: z.string().max(256).optional().describe("Optional glob pattern to filter files (e.g. '*.ts', 'src/**')."),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async input => {
        const scope = scopeFor(input.workspace);
        const res = handleGrep({
          query: input.query,
          path: input.path,
          max_results: input.max_results,
          case_sensitive: input.case_sensitive,
          file_pattern: input.file_pattern,
          cwd: scope.cwd,
          roots: scope.roots,
        });
        return chatFirstToolResult("codex_grep", scope.cwd, res);
      },
    );

    server.registerTool(
      "codex_tool_inventory",
      {
        title: "List chat-first workspace tools",
        description: "Return the static chat-first inventory: the active sandbox mode and the tools this connector exposes. No turn connection is involved.",
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async () => result({
        contract: "chat-first",
        sandboxMode: chatFirstSandboxMode,
        tools: [
          { name: "codex_read_file", description: "Read a workspace file with line offset and limit." },
          { name: "codex_list_dir", description: "List directory contents with depth and entry limits." },
          { name: "codex_grep", description: "Search workspace file contents with ripgrep." },
          { name: "codex_tool_inventory", description: "Return this inventory with the active sandbox mode." },
          ...(chatFirstWritable ? [
            { name: "codex_write_file", description: "Write a complete file; recorded in the local audit log." },
            { name: "codex_patch_file", description: "Replace an exact text occurrence in a file; recorded in the local audit log." },
            { name: "codex_exec", description: "Run a shell command (tests, builds, git) in the workspace. Supports background=true for async execution." },
            { name: "codex_poll_task", description: "Check status, retrieve output logs, wait, or kill a background task launched with codex_exec(background=true)." },
            { name: "codex_wait_tasks", description: "Wait for background tasks to complete and return compact single-line summaries." },
          ] : []),
        ],
      }),
    );

    if (chatFirstWritable) {
      server.registerTool(
        "codex_write_file",
        {
          title: "Write a chat-first workspace file",
          description: "Write complete text content directly to a file in the configured local workspace; the mutation is recorded in the local audit log. Refuses to clobber an existing file unless overwrite is true.",
          inputSchema: {
            path: z.string().min(1).max(16_384).describe("Path to the file (relative to the workspace or absolute)."),
            content: z.string().min(1).max(5_000_000).describe("Complete text content to write to the file."),
            workspace: z.string().max(1_024).optional().describe("Optional configured workspace; omit it to use the default workspace."),
            overwrite: z.boolean().default(false).describe("Allow replacing an existing file (default: false)."),
            create_parents: z.boolean().default(false).describe("Create missing parent directories (default: false)."),
          },
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        },
        async input => {
          const scope = scopeFor(input.workspace);
          const res = handleWriteFile({
            path: input.path,
            content: input.content,
            overwrite: input.overwrite,
            create_parents: input.create_parents,
            cwd: scope.cwd,
            roots: scope.roots,
            writableRoots: scope.writableRoots,
            cache: workspaceFileCache,
          });
          auditSuccessfulMutation("codex_write_file", res, input.path);
          return chatFirstToolResult("codex_write_file", scope.cwd, res);
        },
      );

      server.registerTool(
        "codex_patch_file",
        {
          title: "Patch a chat-first workspace file",
          description: "Replace the first exact occurrence of target_content with replacement_content in a configured local workspace file; the mutation is recorded in the local audit log.",
          inputSchema: {
            path: z.string().min(1).max(16_384).describe("Path to the file (relative to the workspace or absolute)."),
            target_content: z.string().min(1).max(1_000_000).describe("Exact text to replace, including whitespace and indentation. Only the first occurrence is replaced."),
            replacement_content: z.string().max(1_000_000).describe("Replacement text; an empty string deletes the matched target."),
            workspace: z.string().max(1_024).optional().describe("Optional configured workspace; omit it to use the default workspace."),
          },
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        },
        async input => {
          const scope = scopeFor(input.workspace);
          const res = handlePatchFile({
            path: input.path,
            target_content: input.target_content,
            replacement_content: input.replacement_content,
            cwd: scope.cwd,
            roots: scope.roots,
            writableRoots: scope.writableRoots,
            cache: workspaceFileCache,
          });
          auditSuccessfulMutation("codex_patch_file", res, input.path);
          return chatFirstToolResult("codex_patch_file", scope.cwd, res);
        },
      );

      server.registerTool(
        "codex_exec",
        {
          title: "Run a chat-first shell command",
          description: "Execute a shell command (tests, builds, git, cli) in the configured local workspace; the execution is recorded in the local audit log. Returns stdout, stderr, and exit_code. Set background=true to run asynchronously without waiting.",
          inputSchema: {
            cmd: z.string().min(1).max(32_768).describe("Shell command string to execute."),
            workdir: z.string().max(16_384).optional().describe("Working directory (relative to workspace or absolute). Defaults to workspace root."),
            workspace: z.string().max(1_024).optional().describe("Optional configured workspace; omit it to use the default workspace."),
            background: z.boolean().default(false).optional().describe("If true, runs command asynchronously in background and returns task_id immediately without blocking web chat. Use codex_poll_task to check progress."),
            timeout_ms: z.number().int().min(MIN_EXEC_TIMEOUT_MS).max(MAX_EXEC_TIMEOUT_MS).default(DEFAULT_EXEC_TIMEOUT_MS).optional().describe("Maximum command execution time in milliseconds (for synchronous execution)."),
          },
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        },
        async input => {
          const scope = scopeFor(input.workspace);
          if (input.background) {
            const task = globalBackgroundTaskManager.startTask({
              cmd: input.cmd,
              cwd: scope.cwd,
              roots: scope.roots,
              writableRoots: scope.writableRoots,
            });
            const bgPayload = {
              task_id: task.id,
              status: task.status,
              cmd: task.cmd,
              pid: task.pid,
              log_file: task.logFile,
              message: "Command started in background. The web chat does not need to wait. Use codex_poll_task to check results or inspect the log file with codex_read_file.",
            };
            auditSuccessfulMutation("codex_exec", result(bgPayload), input.cmd);
            return chatFirstToolResult("codex_exec", scope.cwd, result(bgPayload));
          }

          // Clamp chat-first command execution to 55s ceiling to prevent OpenAI cloud tunnel deadline retirement
          const requestedTimeout = input.timeout_ms ?? 55_000;
          const safeTimeout = Math.min(requestedTimeout, 55_000);
          const res = await handleExecCommand({
            cmd: input.cmd,
            workdir: input.workdir,
            timeout_ms: safeTimeout,
            cwd: scope.cwd,
            roots: scope.roots,
            writableRoots: scope.writableRoots,
            cache: workspaceFileCache,
          });
          auditSuccessfulMutation("codex_exec", res, input.cmd);
          return chatFirstToolResult("codex_exec", scope.cwd, res);
        },
      );

      server.registerTool(
        "codex_poll_task",
        {
          title: "Poll or manage a background shell task",
          description: "Check status, retrieve output logs, wait for completion, or terminate a background command launched with codex_exec(background=true). If task_id is omitted, lists recent background tasks.",
          inputSchema: {
            task_id: z.string().optional().describe("Task ID to check or manage. If omitted, lists recent background tasks."),
            wait_ms: z.number().int().min(0).max(30_000).default(0).optional().describe("Milliseconds to wait (0-30000) for task to complete before returning (default: 0, non-blocking)."),
            kill: z.boolean().default(false).optional().describe("If true, terminates the running background task."),
            lines: z.number().int().min(1).max(500).default(100).optional().describe("Number of trailing log lines to return (default: 100)."),
            workspace: z.string().max(1_024).optional().describe("Optional configured workspace; omit it to use the default workspace."),
          },
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async input => {
          const scope = scopeFor(input.workspace);
          if (!input.task_id) {
            const tasks = globalBackgroundTaskManager.listTasks().map(t => ({
              task_id: t.id,
              cmd: t.cmd,
              status: t.status,
              exit_code: t.exitCode,
              started_at: t.startedAt,
              duration_ms: t.durationMs ?? (Date.now() - new Date(t.startedAt).getTime()),
              log_file: t.logFile,
            }));
            return chatFirstToolResult("codex_poll_task", scope.cwd, result({ tasks }));
          }

          if (input.kill) {
            const killed = globalBackgroundTaskManager.killTask(input.task_id);
            const task = globalBackgroundTaskManager.getTask(input.task_id);
            return chatFirstToolResult("codex_poll_task", scope.cwd, result({
              task_id: input.task_id,
              status: task?.status ?? "not_found",
              killed,
            }));
          }

          const polled = await globalBackgroundTaskManager.pollTask(input.task_id, input.wait_ms ?? 0, input.lines ?? 100);
          if (!polled) {
            return chatFirstToolResult("codex_poll_task", scope.cwd, result({ error: `Task not found: ${input.task_id}` }, true));
          }

          return chatFirstToolResult("codex_poll_task", scope.cwd, result({
            task_id: polled.task.id,
            cmd: polled.task.cmd,
            status: polled.task.status,
            exit_code: polled.task.exitCode,
            duration_ms: polled.task.durationMs ?? (Date.now() - new Date(polled.task.startedAt).getTime()),
            started_at: polled.task.startedAt,
            completed_at: polled.task.completedAt,
            log_file: polled.task.logFile,
            output_tail: polled.tail,
          }));
        },
      );

      server.registerTool(
        "codex_wait_tasks",
        {
          title: "Wait for background tasks and return compact summaries",
          description: "Wait for background command tasks to finish or until wait_ms expires. Returns a compact single-line summary for each task and the count of pending tasks.",
          inputSchema: {
            task_ids: z.array(z.string().min(1)).min(1).max(10).describe("List of 1 to 10 background task IDs to wait for."),
            wait_ms: z.number().int().min(0).max(90_000).default(60_000).optional().describe("Milliseconds to wait for completion (clamped <= 90000, default 60000)."),
            lines: z.number().int().min(1).max(500).default(30).optional().describe("Trailing log lines to inspect for summarizing (default 30)."),
            workspace: z.string().max(1_024).optional().describe("Optional configured workspace; omit it to use the default workspace."),
          },
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async input => {
          const scope = scopeFor(input.workspace);
          const rawWait = input.wait_ms ?? 60_000;
          const clampedWait = Math.min(Math.max(rawWait, 0), 90_000);
          const res = await waitOnTasks(input.task_ids, clampedWait, input.lines ?? 30);
          return chatFirstToolResult("codex_wait_tasks", scope.cwd, result(res));
        },
      );
    }
  }

  await server.connect(observeMcpToolCalls(new StdioServerTransport(), BRIDGE_TOOL_NAMES));
}
