import type { ChatGptTurnEnvironment } from "../environment";

export type ChatGptMcpContract = "native" | "safe" | "chat-first";

export interface ClaimedTurn {
  bindingId: string;
  activityId: string;
  environment: ChatGptTurnEnvironment & { expiresAt?: number };
  traceId?: string;
}

export interface McpRequestExtra {
  sessionId?: string;
  requestId: string | number;
  _meta?: unknown;
  requestInfo?: unknown;
  signal?: AbortSignal;
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

export interface GatewayToolDescriptor {
  name: string;
  description: string;
}

export interface GatewayToolCatalogPage {
  tools: GatewayToolDescriptor[];
  total: number;
}
