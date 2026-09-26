import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

function makeTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "cgw-async-ws-"));
  return dir;
}

function makeEnvironment(workspaceRoot: string, sandboxType: "workspaceWrite" | "dangerFullAccess" | "readOnly"): ChatGptTurnEnvironment {
  return {
    cwd: workspaceRoot,
    roots: [workspaceRoot],
    writableRoots: sandboxType === "readOnly" ? [] : [workspaceRoot],
    sandboxPolicy: sandboxType === "readOnly"
      ? { type: "readOnly", networkAccess: false }
      : sandboxType === "workspaceWrite"
        ? { type: "workspaceWrite", writableRoots: [workspaceRoot], networkAccess: true }
        : { type: "dangerFullAccess" },
    tools: [
      { name: "exec", description: "Native gateway", parameters: {}, freeform: true },
      { name: "exec_command", description: "Run command", parameters: { type: "object", properties: { cmd: { type: "string" } } } },
    ],
  };
}

describe("Sprint H2: Native Async Execution & codex_wait_tasks", () => {
  test("executes command with background=true, returns immediate ack, and codex_wait_tasks returns summary", async () => {
    const ws = makeTempWorkspace();
    const socketPath = join(tmpdir(), `cgw-broker-${process.pid}-${Date.now()}.sock`);
    const broker = TurnBroker.forSocket(socketPath);
    const env = makeEnvironment(ws, "workspaceWrite");
    const traceId = `trace-async-${Date.now()}`;
    const token = await broker.register(env, 60_000, traceId);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp", "--contract", "native", "--broker-socket", socketPath],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({ name: "native-async-test", version: "1.0.0" });

    try {
      await client.connect(transport);

      // 1. Launch background task
      const execResult = await client.callTool({
        name: "codex_exec",
        arguments: {
          turn_token: token,
          cmd: "echo 'async-test-output-42'",
          background: true,
        },
      });

      expect(execResult.isError).toBeUndefined();
      const ack = execResult.structuredContent as Record<string, unknown>;
      expect(ack.task_id).toBeDefined();
      expect(typeof ack.task_id).toBe("string");
      expect(ack.status).toBe("running");
      expect(ack.log_path).toBeDefined();
      expect(ack.message).toContain("Command started in background");

      const taskId = ack.task_id as string;

      // 2. Wait for completion with codex_wait_tasks
      const waitResult = await client.callTool({
        name: "codex_wait_tasks",
        arguments: {
          turn_token: token,
          task_ids: [taskId],
          wait_ms: 10_000,
        },
      });

      expect(waitResult.isError).toBeUndefined();
      const waitData = waitResult.structuredContent as {
        pending: number;
        tasks: Array<{ task_id: string; status: string; exit_code: number | null; summary: string; log_path: string }>;
      };
      expect(waitData.pending).toBe(0);
      expect(waitData.tasks).toHaveLength(1);
      expect(waitData.tasks[0]!.task_id).toBe(taskId);
      expect(waitData.tasks[0]!.status).toBe("completed");
      expect(waitData.tasks[0]!.exit_code).toBe(0);
      expect(waitData.tasks[0]!.summary).toContain("completed");
      expect(waitData.tasks[0]!.log_path).toContain(taskId);
    } finally {
      await client.close().catch(() => {});
      await broker.close().catch(() => {});
    }
  });

  test("rejects background=true with clear error in readOnly sandbox mode", async () => {
    const ws = makeTempWorkspace();
    const socketPath = join(tmpdir(), `cgw-broker-${process.pid}-${Date.now()}-ro.sock`);
    const broker = TurnBroker.forSocket(socketPath);
    const env = makeEnvironment(ws, "readOnly");
    const token = await broker.register(env, 60_000, "trace-ro");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp", "--contract", "native", "--broker-socket", socketPath],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({ name: "native-async-ro-test", version: "1.0.0" });

    try {
      await client.connect(transport);

      const res = await client.callTool({
        name: "codex_exec",
        arguments: {
          turn_token: token,
          cmd: "echo 'should fail in read-only'",
          background: true,
        },
      });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain("background requires write-capable sandbox");
    } finally {
      await client.close().catch(() => {});
      await broker.close().catch(() => {});
    }
  });

  test("codex_wait_tasks returns graceful summaries for unknown task IDs", async () => {
    const ws = makeTempWorkspace();
    const socketPath = join(tmpdir(), `cgw-broker-${process.pid}-${Date.now()}-wait.sock`);
    const broker = TurnBroker.forSocket(socketPath);
    const env = makeEnvironment(ws, "workspaceWrite");
    const token = await broker.register(env, 60_000, "trace-wait");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp", "--contract", "native", "--broker-socket", socketPath],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({ name: "native-wait-test", version: "1.0.0" });

    try {
      await client.connect(transport);

      const waitResult = await client.callTool({
        name: "codex_wait_tasks",
        arguments: {
          turn_token: token,
          task_ids: ["nonexistent_task_123"],
          wait_ms: 100,
        },
      });

      expect(waitResult.isError).toBeUndefined();
      const waitData = waitResult.structuredContent as {
        pending: number;
        tasks: Array<{ task_id: string; status: string; summary: string }>;
      };
      expect(waitData.pending).toBe(0);
      expect(waitData.tasks).toHaveLength(1);
      expect(waitData.tasks[0]!.task_id).toBe("nonexistent_task_123");
      expect(waitData.tasks[0]!.status).toBe("not_found");
      expect(waitData.tasks[0]!.summary).toContain("Task not found");
    } finally {
      await client.close().catch(() => {});
      await broker.close().catch(() => {});
    }
  });

  test("background task completion notifies daemon /internal/tasks/completed endpoint", async () => {
    let receivedPayload: Record<string, unknown> | undefined;
    const server = Bun.serve({
      port: 0,
      fetch: async req => {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === "/internal/tasks/completed") {
          receivedPayload = (await req.json()) as Record<string, unknown>;
          return Response.json({ accepted: true }, { status: 202 });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    const tempConfigDir = mkdtempSync(join(tmpdir(), "cgw-cfg-"));
    const configPath = join(tempConfigDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ port: server.port }), "utf8");

    const ws = makeTempWorkspace();
    const socketPath = join(tmpdir(), `cgw-broker-${process.pid}-${Date.now()}-notify.sock`);
    const broker = TurnBroker.forSocket(socketPath);
    const env = makeEnvironment(ws, "workspaceWrite");
    const traceId = `trace-notify-${Date.now()}`;
    const token = await broker.register(env, 60_000, traceId);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp", "--contract", "native", "--broker-socket", socketPath],
      cwd: process.cwd(),
      env: { ...process.env, CODEX_CHATGPT_WEB_PORT: String(server.port) },
      stderr: "pipe",
    });
    const client = new Client({ name: "native-notify-test", version: "1.0.0" });

    try {
      await client.connect(transport);

      const execResult = await client.callTool({
        name: "codex_exec",
        arguments: {
          turn_token: token,
          cmd: "echo 'notify-payload-test'",
          background: true,
        },
      });
      const ack = execResult.structuredContent as { task_id: string };

      const deadline = Date.now() + 5_000;
      while (!receivedPayload && Date.now() < deadline) {
        await Bun.sleep(50);
      }

      expect(receivedPayload).toBeDefined();
      expect(receivedPayload!.source).toBe("chatgpt-web-mcp");
      expect(receivedPayload!.traceId).toBe(traceId);
      expect(receivedPayload!.turnToken).toBe(token);
      expect(receivedPayload!.summary).toBeDefined();
      expect((receivedPayload!.task as Record<string, unknown>).id).toBe(ack.task_id);
      expect((receivedPayload!.task as Record<string, unknown>).status).toBe("completed");
    } finally {
      await client.close().catch(() => {});
      await broker.close().catch(() => {});
      server.stop(true);
    }
  });
});
