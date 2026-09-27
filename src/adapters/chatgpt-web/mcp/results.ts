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

const MAX_MCP_RESULT_BYTES = 1024 * 1024;

export function chatGptMcpInvocationTimeout(
  environment: ChatGptTurnEnvironment & { expiresAt?: number },
  now = Date.now(),
  _requestedTimeoutMs?: number,
): number {
  // A host wait hint cannot extend the transport deadline. Long jobs must yield
  // through host sessions; cancellation here does not prove a command stopped.
  const baseTimeout = CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS;
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
  const page = value.structuredContent !== null && typeof value.structuredContent === "object"
    ? value.structuredContent as Record<string, unknown>
    : undefined;
  const bytePage = options.toolName === "codex_read_file" && page
    && Number.isSafeInteger(page.read_bytes) && Number(page.read_bytes) >= 0 && Number(page.read_bytes) <= 131072
    && Number.isSafeInteger(page.offset_bytes) && Number(page.offset_bytes) >= 0
    && typeof page.content === "string" && Buffer.byteLength(page.content, "utf8") <= 131072;
  // A bounded byte page is already selected at the producer. Truncating its
  // visible JSON would skip evidence while still advancing the continuation.
  const sanitizedContent = (bytePage ? value.content : sanitizeToolOutputContent(value.content, options)) as McpContentPart[];
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

  const response: McpCallResult = {
    content: sanitizedContent,
    ...(structuredContent !== undefined && structuredContent !== null && typeof structuredContent === "object"
      ? { structuredContent: structuredContent as Record<string, unknown> }
      : {}),
    ...(value.isError ? { isError: true } : {}),
    ...("_meta" in value && value._meta !== undefined && value._meta !== null && typeof value._meta === "object"
      ? { _meta: (value as { _meta?: Record<string, unknown> })._meta as Record<string, unknown> }
      : {}),
  };
  return enforceMcpResultBudget(response);
}

/** Bound a complete MCP response without altering valid protocol JSON or schemas. */
export function enforceMcpResultBudget(response: McpCallResult): McpCallResult {
  // Include structured data, images and metadata, not just visible text. This is
  // a wire budget; upstream handlers still need their own allocation limits.
  const bytes = Buffer.byteLength(JSON.stringify(response), "utf8");
  if (bytes > MAX_MCP_RESULT_BYTES) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: JSON.stringify({
          code: "mcp_result_too_large",
          bytes,
          limit_bytes: MAX_MCP_RESULT_BYTES,
          retryable: false,
          message: "The tool returned a result larger than the MCP delivery budget. Effects may already have occurred. Do not repeat mutations; use narrower read queries or supported pagination to retrieve evidence.",
        }),
      }],
    };
  }
  return response;
}
