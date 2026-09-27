import { AsyncLocalStorage } from "node:async_hooks";

export const mcpTraceContext = new AsyncLocalStorage<string>();

export function currentMcpTrace(): string | undefined {
  return mcpTraceContext.getStore();
}
