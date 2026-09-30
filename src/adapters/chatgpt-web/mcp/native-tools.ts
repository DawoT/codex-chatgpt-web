import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { result } from "../fast-path-handlers";
import { callTurnBroker } from "../turn-broker";
import { registerHostCommandTools } from "./host-command-tools";
import { registerHostRegistryTools } from "./host-registry-tools";
import { registerImageTools } from "./image-tools";
import { registerLegacyFilesystemTools } from "./legacy-filesystem-tools";
import { requestScopeSummary, turnTokenSchema } from "./tool-visibility";
import type { TurnCoordinator } from "./turn-coordinator";

export function registerNativeAndSafeTools(server: McpServer, coordinator: TurnCoordinator): void {
  const contract = coordinator.contract;

  if (contract === "safe") {
    server.registerTool(
      "codex_turn_start",
      {
        title: "Connect a Codex Zero Risk request",
        description:
          "Connect the request_id included in the pasted Codex Web GPT request so its Codex tools can be used.",
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
        const response = await callTurnBroker<{ started: true; duplicate: boolean }>(
          coordinator.brokerSocketPath,
          {
            method: "safe_start",
            token: request_id,
          },
          5_000,
          extra.signal,
        );
        return result(response);
      },
    );
  }

  if (contract !== "chat-first") {
    registerHostCommandTools(server, coordinator);

    registerLegacyFilesystemTools(server, coordinator);
    registerHostRegistryTools(server, coordinator);
    registerImageTools(server, { contract });
  }

  if (contract === "safe") {
    server.registerTool(
      "codex_turn_complete",
      {
        title: "Return the result to Codex",
        description:
          "Send the complete answer back to the connected Codex request after its work is finished. For compaction, send the requested compacted summary.",
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
        const response = await callTurnBroker<{ completed: true; duplicate: boolean }>(
          coordinator.brokerSocketPath,
          {
            method: "safe_complete",
            token: request_id,
            finalAnswer: final_answer,
          },
          null,
          extra.signal,
        );
        return result(response);
      },
    );
  }
}
