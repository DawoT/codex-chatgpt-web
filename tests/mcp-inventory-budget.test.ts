import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";

for (const contract of ["native", "safe"] as const) {
  for (const source of ["direct", "gateway"] as const) {
    test(`${contract} ${source} inventory enforces total delivery bytes while preserving bounded JSON`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), "inventory-budget-"));
      const socket = process.platform === "win32"
        ? String.raw`\\.\pipe\inventory-${process.pid}-${Date.now()}`
        : join(cwd, "broker.sock");
      const broker = TurnBroker.forSocket(socket);
      const large = "x".repeat(600_000);
      const small = "Facts symbol contract. ".repeat(200);
      const environment: ChatGptTurnEnvironment = {
        cwd,
        roots: [cwd],
        writableRoots: [],
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        tools: source === "gateway"
          ? [{ name: "exec", description: "Gateway", parameters: {}, freeform: true }]
          : [
            { name: "facts_large", description: "Large schema", parameters: { description: large } },
            { name: "facts_small", description: small, parameters: {} },
          ],
      };
      const nonce = "inventory_nonce_01234567890123456789";
      const token = contract === "safe"
        ? await broker.registerSafe(environment, nonce, 60_000)
        : await broker.register(environment, 60_000);
      if (contract === "safe") {
        broker.confirmSafeTurnSent(token, nonce);
        broker.startSafeTurn(token);
      }
      const reference = contract === "safe" ? { request_id: token } : { turn_token: token };
      const client = new Client({ name: "inventory-budget", version: "1" });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["src/cli.ts", "mcp", "--contract", contract, "--broker-socket", socket],
        cwd: process.cwd(),
        stderr: "pipe",
      });
      try {
        await client.connect(transport);
        for (const [name, description] of [["facts_large", large], ["facts_small", small]]) {
          const pending = client.callTool({
            name: "codex_tool_inventory",
            arguments: { ...reference, query: name },
          });
          if (source === "gateway") {
            const [request] = await broker.nextToolBatch(token);
            expect(request?.wireName).toBe("exec");
            broker.completeTool(token, request!.callId, {
              content: [{ type: "text", text: JSON.stringify({
                tools: [{ name, description }],
                total: 1,
              }) }],
            });
          }
          const response = await pending;
          if (name === "facts_large") {
            expect(response.isError).toBe(true);
            expect(response.structuredContent).toBeUndefined();
            expect(JSON.parse((response.content as Array<{ text: string }>)[0]!.text).code)
              .toBe("mcp_result_too_large");
            expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(1024);
          } else {
            expect(response.isError).toBeUndefined();
            const text = (response.content as Array<{ text: string }>)[0]!.text;
            expect(text.length).toBeGreaterThan(2500);
            expect(JSON.parse(text)).toEqual(response.structuredContent);
            expect(response.structuredContent).toMatchObject({ tools: [{ name, description }], total: 1 });
          }
        }
      } finally {
        await client.close();
        await broker.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
}
