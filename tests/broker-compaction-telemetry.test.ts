import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { TelemetryTraceSink } from "../src/adapters/chatgpt-web/telemetry-trace";
import { defaultBrokerEndpoint } from "../src/config";

test("compaction closes queued tool traces as cancelled without claiming execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "broker-trace-"));
  const previous = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
  else process.env.CODEX_CHATGPT_WEB_HOME = previous;
  const sink = new TelemetryTraceSink(join(root, "logs", "mcp"));
  const traceId = randomUUID();
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [{ name: "exec_command", description: "Run", parameters: { type: "object" } }],
    }, 10_000);
    const claimed = await callTurnBroker<{ bindingId: string }>(broker.socketPath, {
      method: "claim",
      token,
    });
    const invocation = callTurnBroker(broker.socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      observationId: traceId,
      wireName: "exec_command",
      arguments: { cmd: "private-command-must-not-run" },
    });
    let events = await sink.query({ traceId });
    const queuedDeadline = Date.now() + 3000;
    while (!events.length && Date.now() < queuedDeadline) {
      await Bun.sleep(10);
      events = await sink.query({ traceId });
    }
    expect(events.map(row => row.metadata?.event)).toEqual(["broker_queued"]);
    expect(broker.requestCompaction(token, {
      content: [{ type: "text", text: "compact instead" }],
      isError: true,
    })).toBe(1);
    await expect(invocation).resolves.toMatchObject({ isError: true });
    const deadline = Date.now() + 1000;
    while (events.length < 2 && Date.now() < deadline) {
      await Bun.sleep(10);
      events = await sink.query({ traceId });
    }
    expect(events.map(row => row.metadata?.event).sort()).toEqual(["broker_compaction_cancelled", "broker_queued"]);
    const cancelled = events.find(row => row.metadata?.event === "broker_compaction_cancelled");
    const queued = events.find(row => row.metadata?.event === "broker_queued");
    expect(cancelled?.terminalState).toBe("cancelled");
    expect(cancelled?.brokerCallId).toBe(queued?.brokerCallId);
    expect(cancelled?.metadata?.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(events)).not.toContain("private-command");
    broker.revoke(token);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
