import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VERSION } from "../../version";
import { loadConfig } from "../../config";
import { observeMcpToolCalls } from "./mcp-observation";
import {
  CHAT_FIRST_MCP_INSTRUCTIONS,
  CHATGPT_WEB_AGENT_WAIT_POLL_MS,
  CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS,
  NATIVE_CHATGPT_MCP_INSTRUCTIONS,
  ZERO_RISK_MCP_INSTRUCTIONS,
} from "./mcp/instructions";
import {
  asMcpResult,
  chatGptMcpInvocationTimeout,
  sanitizeToolOutputContent,
} from "./mcp/results";
import { BRIDGE_TOOL_NAMES } from "./mcp/tool-visibility";
import { TurnCoordinator } from "./mcp/turn-coordinator";
import { registerNativeAndSafeTools } from "./mcp/native-tools";
import { registerChatFirstTools } from "./mcp/chat-first-tools";
import type { ChatGptMcpContract, McpCallResult, McpContentPart } from "./mcp/types";

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

export type { ChatGptMcpContract, McpContentPart, McpCallResult };
export {
  CHATGPT_WEB_AGENT_WAIT_POLL_MS,
  CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS,
  NATIVE_CHATGPT_MCP_INSTRUCTIONS,
  chatGptMcpInvocationTimeout,
  sanitizeToolOutputContent,
  asMcpResult,
};

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

  if (contract === "chat-first" && chatFirstConfig) {
    registerChatFirstTools(server, chatFirstConfig);
  } else {
    const coordinator = new TurnCoordinator(options.brokerSocketPath, contract);
    registerNativeAndSafeTools(server, coordinator);
  }

  if (contract === "chat-first") {
    process.stdin.once("end", () => {
      void server.close().catch(() => {});
    });
  }
  await server.connect(observeMcpToolCalls(new StdioServerTransport(), BRIDGE_TOOL_NAMES));
}
