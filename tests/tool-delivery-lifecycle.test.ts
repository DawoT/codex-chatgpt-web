import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import {
  callTurnBroker,
  RemoteTurnBroker,
  TurnBroker,
  type BrokerToolResult,
} from "../src/adapters/chatgpt-web/turn-broker";
import { ToolDeliveryLifecycle } from "../src/adapters/chatgpt-web/tool-delivery-lifecycle";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import { McpTelemetry } from "../src/adapters/chatgpt-web/mcp-telemetry";
import { TelemetryTraceSink } from "../src/adapters/chatgpt-web/telemetry-trace";

test("tool delivery lifecycle enforces causal phase ordering", () => {
  const lifecycle = new ToolDeliveryLifecycle();

  expect(() => lifecycle.mark("codex_emitted")).toThrow("expected browser_observed before codex_emitted");
  lifecycle.mark("browser_observed");
  lifecycle.mark("codex_emitted");
  lifecycle.mark("host_started");
  lifecycle.mark("result_received");

  expect(lifecycle.phases()).toEqual([
    "browser_observed",
    "codex_emitted",
    "host_started",
    "result_received",
  ]);
});

test("replayed owner observations do not duplicate lifecycle phases", () => {
  const lifecycle = new ToolDeliveryLifecycle();

  expect(lifecycle.mark("browser_observed")).toBe(true);
  expect(lifecycle.mark("browser_observed")).toBe(false);
  expect(lifecycle.mark("codex_emitted")).toBe(true);
  expect(lifecycle.mark("browser_observed")).toBe(false);
  expect(lifecycle.phases()).toEqual(["browser_observed", "codex_emitted"]);
  expect(() => lifecycle.mark("result_received")).toThrow("expected host_started before result_received");
});

test("broker keeps one call ID across replay and rejects a result after revocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-delivery-lifecycle-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const owner = new RemoteTurnBroker(socketPath);
  const environment = {
    cwd: root,
    roots: [root],
    writableRoots: [root],
    sandboxPolicy: { type: "dangerFullAccess" as const },
    tools: [{ name: "exec_command", description: "Run a command", parameters: { type: "object" as const } }],
  };
  try {
    const token = await broker.register(environment, 30_000, "delivery-lifecycle-test");
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const invocation = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "pwd" },
    }, 30_000);
    const [request] = await owner.nextToolBatch(token);
    expect(request).toBeDefined();
    await owner.recordToolLifecyclePhase(token, request!.callId, "browser_observed", "browser_acknowledged");
    const [replayed] = await owner.nextToolBatch(token);
    expect(replayed!.callId).toBe(request!.callId);
    await owner.recordToolLifecyclePhase(token, request!.callId, "browser_observed", "replayed_boundary");
    await owner.recordToolLifecyclePhase(token, request!.callId, "codex_emitted", "adapter_emitted");
    await expect(callTurnBroker(socketPath, {
      method: "owner_tool_phase",
      token,
      callId: request!.callId,
      lifecyclePhase: "host_started",
    })).rejects.toThrow("may only record");
    const result: BrokerToolResult = { content: [{ type: "text", text: "ok" }] };
    await owner.completeTool(token, request!.callId, result);
    expect(await invocation).toEqual(result);
    await owner.revoke(token);
    await expect(owner.completeTool(token, request!.callId, result)).rejects.toThrow("invalid or expired");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("lifecycle telemetry keeps each phase on the same trace and call ID", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-delivery-trace-"));
  const traceId = randomUUID();
  const callId = "call_delivery0123456789";
  try {
    const telemetry = new McpTelemetry(root);
    for (const event of [
      "broker_claimed",
      "browser_observed",
      "codex_emitted",
      "host_started",
      "result_received",
    ]) {
      telemetry.write({ trace_id: traceId, broker_call_id: callId, event, evidence: "test_observation" });
    }
    const sink = new TelemetryTraceSink(root);
    let records = await sink.query({ traceId });
    for (let attempt = 0; records.length < 5 && attempt < 40; attempt += 1) {
      await Bun.sleep(25);
      records = await sink.query({ traceId });
    }
    expect(records).toHaveLength(5);
    expect(new Set(records.map(record => record.metadata?.event))).toEqual(new Set([
      "broker_claimed",
      "browser_observed",
      "codex_emitted",
      "host_started",
      "result_received",
    ]));
    expect(records.every(record => record.brokerCallId === callId)).toBe(true);
    expect(records.every(record => record.metadata?.scope === "broker_tool_lifecycle")).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stalled browser boundary times out and revokes the pending MCP call", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-stalled-boundary-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const environment = {
    cwd: root,
    roots: [root],
    writableRoots: [root],
    sandboxPolicy: { type: "dangerFullAccess" as const },
    tools: [{ name: "exec_command", description: "Run a command", parameters: { type: "object" as const } }],
  };
  try {
    const token = await broker.register(environment, 30_000, "stalled-boundary-test");
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const invocation = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "pwd" },
    }, 30_000);
    const invocationOutcome = invocation.then(
      () => "completed",
      () => "revoked",
    );
    const [request] = await broker.nextToolBatch(token);
    const progress = new ChatGptExternalTurnProgress();
    const revision = progress.recordToolBatch(1);
    const started = performance.now();
    await expect(progress.waitForToolBatchObservation(revision, undefined, 30))
      .rejects.toMatchObject({ code: "chatgpt_tool_boundary_observation_timeout" });
    expect(performance.now() - started).toBeLessThan(1_000);
    broker.revoke(token);
    expect(await invocationOutcome).toBe("revoked");
    expect(() => broker.completeTool(token, request!.callId, { content: [] }))
      .toThrow("invalid or expired");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
