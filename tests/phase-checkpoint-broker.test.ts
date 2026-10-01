import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const environment: ChatGptTurnEnvironment = {
  cwd: "/tmp",
  roots: ["/tmp"],
  writableRoots: [],
  sandboxPolicy: { type: "readOnly", networkAccess: false },
  tools: [],
};

test("phase checkpoint control is bound to the exact active capability and never queues a work tool", async () => {
  const root = mkdtempSync("/tmp/cgw-phase-broker-");
  roots.push(root);
  const broker = TurnBroker.forSocket(join(root, "broker.sock"));
  try {
    const first = await broker.register(environment, 10_000, "phase-1", false, "turn", undefined, "mission");
    let accepted = "";
    broker.bindPhaseCheckpoint(
      first,
      async (summary) => {
        accepted = summary;
      },
      async () => ({ text: "evidence" }),
    );
    await expect(
      callTurnBroker(broker.socketPath, { method: "submit_phase_checkpoint", token: first, summary: "state" }),
    ).resolves.toEqual({ submitted: true });
    expect(accepted).toBe("state");
    expect(broker.resourceDiagnostics().pending_transactions).toBe(0);
    const revision = broker.beginCompletionFence(first);
    expect(revision).toBeDefined();
    expect(broker.commitCompletionFence(first, revision!)).toBe(true);
    const second = await broker.register(environment, 10_000, "phase-2", false, "turn", first, "mission");
    broker.bindPhaseCheckpoint(
      second,
      async () => {
        accepted = "wrong owner";
      },
      async () => ({ text: "other evidence" }),
    );
    await expect(
      callTurnBroker(broker.socketPath, { method: "submit_phase_checkpoint", token: first, summary: "late" }),
    ).rejects.toThrow();
    expect(accepted).toBe("state");
    await expect(
      callTurnBroker(broker.socketPath, { method: "read_phase_checkpoint", token: first, arguments: {} }),
    ).rejects.toThrow();
    await expect(
      callTurnBroker(broker.socketPath, { method: "read_phase_checkpoint", token: second, arguments: {} }),
    ).resolves.toEqual({ text: "other evidence" });
  } finally {
    await broker.close();
  }
});

test("revocation during checkpoint control fences its acknowledgement and browser completion", async () => {
  const root = mkdtempSync("/tmp/cgw-phase-revoke-");
  roots.push(root);
  const broker = TurnBroker.forSocket(join(root, "broker.sock"));
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  try {
    const token = await broker.register(environment, 10_000, "phase-race", false, "turn", undefined, "mission");
    broker.bindPhaseCheckpoint(
      token,
      async () => {
        started();
        await gate;
      },
      async () => ({}),
    );
    const pending = callTurnBroker(broker.socketPath, { method: "submit_phase_checkpoint", token, summary: "state" });
    const outcome = pending.then(
      () => "accepted",
      () => "rejected",
    );
    await ready;
    expect(broker.beginCompletionFence(token)).toBeUndefined();
    await broker.revoke(token);
    unblock();
    expect(await outcome).toBe("rejected");
    expect(broker.resourceDiagnostics().pending_waiters).toBe(0);
  } finally {
    unblock();
    await broker.close();
  }
});

test("the actual Codex Native MCP tool dispatches phase controls over stdio", async () => {
  const root = mkdtempSync("/tmp/cgw-phase-mcp-");
  roots.push(root);
  const broker = TurnBroker.forSocket(join(root, "broker.sock"));
  const client = new Client({ name: "phase-control-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--contract", "native", "--broker-socket", broker.socketPath],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  try {
    const token = await broker.register(environment, 10_000, "phase-stdio", false, "turn", undefined, "mission");
    let summary: string | undefined;
    broker.bindPhaseCheckpoint(
      token,
      async (value) => {
        summary = value;
      },
      async () => ({ text: "confirmed evidence" }),
    );
    await client.connect(transport);
    const catalogue = await client.listTools();
    expect(catalogue.tools.some((tool) => tool.name === "codex_tool_call")).toBe(true);
    const submitted = await client.callTool({
      name: "codex_tool_call",
      arguments: {
        turn_token: token,
        wire_name: "codex.control.phase_checkpoint",
        arguments: { summary: "structured state" },
      },
    });
    expect(submitted.isError).not.toBe(true);
    expect(submitted.structuredContent).toEqual({ submitted: true });
    expect(summary).toBe("structured state");
    const read = await client.callTool({
      name: "codex_tool_call",
      arguments: {
        turn_token: token,
        wire_name: "codex.control.checkpoint_evidence",
        arguments: { checkpoint_ref: "current", ref: "manifest" },
      },
    });
    expect(read.structuredContent).toEqual({ text: "confirmed evidence" });
    expect(broker.resourceDiagnostics().pending_transactions).toBe(0);
  } finally {
    await client.close();
    await broker.close();
  }
});
