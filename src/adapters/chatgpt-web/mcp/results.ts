import type { ChatGptTurnEnvironment } from "../environment";
import type { BrokerToolResult } from "../turn-broker";
import type { FastPathToolResult } from "../fast-path-handlers";
import {
  DEFAULT_TOOL_OFFLOAD_THRESHOLD_CHARS,
  sanitizeToolOutputWithSpooler,
  type ToolSpoolerOptions,
} from "../tool-spooler";
import { CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS } from "./instructions";
import type { McpContentPart, McpCallResult } from "./types";

export type { McpContentPart, McpCallResult };

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

export function asMcpResult(
  value: BrokerToolResult | FastPathToolResult,
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
