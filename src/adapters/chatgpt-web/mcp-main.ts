import { defaultBrokerEndpoint, loadConfig, resolveBrokerEndpoint } from "../../config";
import { runChatGptMcpServer, type ChatGptMcpContract } from "./mcp-server";

function option(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1]?.trim();
  if (!value) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

export async function runChatGptMcpMain(args: string[]): Promise<void> {
  const remaining = [...args];
  const brokerSocketPath = resolveBrokerEndpoint(option(remaining, "--broker-socket", defaultBrokerEndpoint()));
  const requestedContract = option(remaining, "--contract", "native");
  if (requestedContract !== "native" && requestedContract !== "safe" && requestedContract !== "chat-first") {
    throw new Error(`--contract must be native, safe, or chat-first, received ${requestedContract}`);
  }
  if (requestedContract === "chat-first") {
    // Fail closed before the stdio transport opens. The MCP server revalidates this; the entry
    // point check keeps a disabled chat-first process from ever starting.
    if (!loadConfig().chatFirst?.enabled) {
      throw new Error("chat-first is not enabled in config.json; set chatFirst.enabled = true");
    }
  }
  if (remaining.length > 0) throw new Error(`Unknown MCP arguments: ${remaining.join(" ")}`);
  await runChatGptMcpServer({
    brokerSocketPath,
    contract: requestedContract as ChatGptMcpContract,
  });
}
