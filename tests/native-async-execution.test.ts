import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";

for (const contract of ["native", "safe"] as const) {
  for (const type of ["workspaceWrite", "dangerFullAccess", "readOnly"] as const) {
    test(`${contract} ${type} commands cannot bypass their host through background execution`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), "host-command-"));
      const socket = process.platform === "win32"
        ? String.raw`\\.\pipe\host-command-${process.pid}-${Date.now()}`
        : join(cwd, "broker.sock");
      const broker = TurnBroker.forSocket(socket);
      const environment: ChatGptTurnEnvironment = {
        cwd,
        roots: [cwd],
        writableRoots: type === "readOnly" ? [] : [cwd],
        sandboxPolicy: type === "workspaceWrite"
          ? { type, writableRoots: [cwd], networkAccess: false }
          : type === "readOnly" ? { type, networkAccess: false } : { type },
        tools: [
          { name: "exec_command", description: "Host command", parameters: { type: "object", properties: { cmd: { type: "string" } } } },
          { name: "exec", description: "Nested tool gateway", parameters: {}, freeform: true },
        ],
      };
      const nonce = "host_test_nonce_01234567890123456789";
      const token = contract === "safe"
        ? await broker.registerSafe(environment, nonce, 60_000)
        : await broker.register(environment, 60_000);
      if (contract === "safe") {
        broker.confirmSafeTurnSent(token, nonce);
        broker.startSafeTurn(token);
      }
      const reference = contract === "safe" ? { request_id: token } : { turn_token: token };
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["src/cli.ts", "mcp", "--contract", contract, "--broker-socket", socket],
        cwd: process.cwd(),
        stderr: "pipe",
      });
      const client = new Client({ name: "host-boundary-test", version: "1" });
      try {
        await client.connect(transport);
        const response = await client.callTool({
          name: "codex_exec",
          arguments: { ...reference, cmd: "echo forbidden", background: true },
        });
        expect(response.isError).toBe(true);
        expect(JSON.stringify(response.content)).toContain("host");
        expect(existsSync(join(cwd, ".codex-tmp"))).toBe(false);
        const wait = await client.callTool({
          name: "codex_wait_tasks",
          arguments: { ...reference, task_ids: ["another-host-task"], wait_ms: 0 },
        });
        expect(wait.isError).toBe(true);
        const pending = client.callTool({
          name: "codex_exec",
          arguments: { ...reference, cmd: "echo host-only" },
        });
        const [request] = await broker.nextToolBatch(token);
        expect(request).toMatchObject({ wireName: "exec_command", arguments: { cmd: "echo host-only" } });
        broker.completeTool(token, request!.callId, { content: [{ type: "text", text: "host-response".repeat(1000) }] });
        const completed = await pending;
        expect(JSON.stringify(completed.content)).toContain("host-response");
        expect(existsSync(join(cwd, ".agents"))).toBe(false);
        const inventory = client.callTool({
          name: "codex_tool_inventory",
          arguments: { ...reference, query: "facts_query" },
        });
        const [catalogRequest] = await broker.nextToolBatch(token);
        expect(catalogRequest).toMatchObject({ wireName: "exec", freeform: true });
        const description = "Facts symbol contract. ".repeat(200);
        broker.completeTool(token, catalogRequest!.callId, {
          content: [{ type: "text", text: JSON.stringify({
            total: 1,
            tools: [{ name: "facts_query", description }],
          }) }],
        });
        const catalog = await inventory;
        expect(catalog.isError).toBeUndefined();
        expect(catalog.structuredContent).toMatchObject({
          total: 1,
          tools: [{ name: "facts_query", description }],
        });
        expect(existsSync(join(cwd, ".codex-tmp"))).toBe(false);
      } finally {
        await client.close();
        await broker.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
}
