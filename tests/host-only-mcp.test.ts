import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { ownerEnvironment } from "../src/adapters/chatgpt-web/turn-broker/helpers";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import { TurnCoordinator } from "../src/adapters/chatgpt-web/mcp/turn-coordinator";

function environment(cwd: string): ChatGptTurnEnvironment & { execution: "host-only" } {
  return {
    execution: "host-only",
    cwd,
    roots: [cwd],
    writableRoots: [cwd],
    sandboxPolicy: { type: "dangerFullAccess" },
    tools: [
      { name: "facts_query", description: "Query host facts", parameters: { type: "object" } },
      { name: "exec_command", description: "Host command with sessions", parameters: {
        type: "object", properties: { cmd: { type: "string" }, yield_time_ms: { type: "number" } },
      } },
      { name: "exec", description: "An exact host tool, not a discovery gateway", parameters: {}, freeform: true },
    ],
  };
}

test("a freeform host command remains freeform even when named exec_command", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "host-only-freeform-"));
  const broker = TurnBroker.forSocket(join(cwd, "broker.sock"));
  const tool = {
    name: "exec_command",
    description: "Freeform host command",
    parameters: { type: "object", properties: { yield_time_ms: { type: "number" } } },
    freeform: true,
  };
  try {
    const token = await broker.register({ ...environment(cwd), tools: [tool] }, 60_000);
    const { bindingId } = await callTurnBroker<{ bindingId: string }>(broker.socketPath, {
      method: "claim", token, contract: "native", activityId: "activity_freeform_host_command_0123456789",
    });
    const coordinator = new TurnCoordinator(broker.socketPath, "native");
    const pending = coordinator.invokeRaw(bindingId, environment(cwd), tool, { input: "long task" });
    const [request] = await broker.nextToolBatch(token);
    expect(request).toMatchObject({ wireName: "exec_command", freeform: true, input: "long task" });
    broker.completeTool(token, request!.callId, { content: [{ type: "text", text: "done" }] });
    expect((await pending).content).toEqual([{ type: "text", text: "done" }]);
  } finally {
    await broker.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("host-only environment survives owner validation and cannot downgrade or mutate its catalog", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "host-only-identity-"));
  const broker = TurnBroker.forSocket(join(cwd, "broker.sock"));
  try {
    const original = environment(cwd);
    expect(ownerEnvironment(original)).toMatchObject({ execution: "host-only" });
    expect(() => ownerEnvironment({ ...original, execution: "local-fallback" })).toThrow();
    const token = await broker.register(original, 60_000);
    original.tools.push({ name: "injected", description: "Should not change authority", parameters: {} });
    expect(() => broker.updateEnvironment(token, original)).toThrow();
    const { execution: _execution, ...downgrade } = environment(cwd);
    expect(() => broker.updateEnvironment(token, downgrade)).toThrow();
    expect(() => broker.updateEnvironment(token, environment(cwd))).not.toThrow();
    const claimed = await callTurnBroker<{ bindingId: string }>(broker.socketPath, {
      method: "claim", token, contract: "native", activityId: "activity_host_authority_test_0123456789",
    });
    for (const [wireName, freeform] of [["not_advertised", false], ["facts_query", true]] as const) {
      await expect(callTurnBroker(broker.socketPath, {
        method: "invoke", bindingId: claimed.bindingId, wireName, freeform,
      })).rejects.toThrow("host-only");
    }
    const legacy = await broker.register(downgrade, 60_000, "same-trace");
    expect(() => broker.registerAlias(token, legacy)).toThrow();
    expect(() => broker.registerAlias(legacy, token)).toThrow();
    await expect(broker.register(environment(cwd), 60_000, "same-trace", false, "turn", legacy)).rejects.toThrow();
    const isolated = await broker.register(environment(cwd), 60_000, "same-trace");
    broker.revoke(isolated);
    expect(broker.resolveActiveToken(isolated)).toBeUndefined();
    expect(ownerEnvironment({ ...environment(cwd), roots: [], writableRoots: [] })).toMatchObject({ execution: "host-only" });
  } finally {
    await broker.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

for (const contract of ["native", "safe"] as const) {
  test(`${contract} host-only MCP routes exact tools and refuses local aliases without effects`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "host-only-mcp-"));
    const socket = process.platform === "win32"
      ? String.raw`\\.\pipe\host-only-${process.pid}-${Date.now()}`
      : join(cwd, "broker.sock");
    const broker = TurnBroker.forSocket(socket);
    const nonce = "host_only_nonce_01234567890123456789";
    const token = contract === "safe"
      ? await broker.registerSafe(environment(cwd), nonce, 60_000)
      : await broker.register(environment(cwd), 60_000);
    if (contract === "safe") {
      broker.confirmSafeTurnSent(token, nonce);
      broker.startSafeTurn(token);
    }
    const reference = contract === "safe" ? { request_id: token } : { turn_token: token };
    const client = new Client({ name: "host-only-test", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp", "--contract", contract, "--broker-socket", socket],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      for (const [name, args] of [
        ["codex_write_file", { path: "forbidden.txt", content: "must not write" }],
        ["codex_read_file", { path: "forbidden.txt" }],
        ["codex_exec", { cmd: "echo forbidden" }],
        ["codex_write_stdin", { session_id: 1 }],
        ["codex_apply_patch", { patch: "*** Begin Patch\n*** End Patch" }],
      ] as const) {
        const rejected = await client.callTool({ name, arguments: { ...reference, ...args } });
        expect(rejected.isError).toBe(true);
        expect(JSON.stringify(rejected.content)).toContain("host-only");
      }
      const catalog = await client.callTool({
        name: "codex_tool_inventory",
        arguments: { ...reference, query: "facts_query" },
      });
      expect(catalog.structuredContent).toMatchObject({ total: 1, tools: [{ name: "facts_query" }] });
      const unavailable = await client.callTool({
        name: "codex_tool_call",
        arguments: { ...reference, wire_name: "not_advertised" },
      });
      expect(unavailable.isError).toBe(true);
      const pending = client.callTool({
        name: "codex_tool_call",
        arguments: { ...reference, wire_name: "facts_query", arguments: { file: "main.ts" } },
      });
      const [request] = await broker.nextToolBatch(token);
      expect(request).toMatchObject({ wireName: "facts_query", arguments: { file: "main.ts" } });
      broker.completeTool(token, request!.callId, { content: [{ type: "text", text: "host-facts-result" }] });
      expect(JSON.stringify((await pending).content)).toContain("host-facts-result");
      const command = client.callTool({
        name: "codex_tool_call",
        arguments: { ...reference, wire_name: "exec_command", arguments: { cmd: "long task", yield_time_ms: 300_000 } },
      });
      const [commandRequest] = await broker.nextToolBatch(token);
      broker.completeTool(token, commandRequest!.callId, {
        content: [{ type: "text", text: "running" }], structuredContent: { session_id: 42 },
      });
      expect(commandRequest!.arguments).toEqual({ cmd: "long task", yield_time_ms: 30_000 });
      expect((await command).structuredContent).toMatchObject({ session_id: 42 });
      expect(readdirSync(cwd).filter(name => name !== "broker.sock")).toEqual([]);
    } finally {
      await client.close();
      await broker.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
