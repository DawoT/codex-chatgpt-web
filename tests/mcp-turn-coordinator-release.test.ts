import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import { TurnCoordinator } from "../src/adapters/chatgpt-web/mcp/turn-coordinator";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

const environment = (cwd: string): ChatGptTurnEnvironment => ({
  cwd,
  roots: [cwd],
  writableRoots: [cwd],
  sandboxPolicy: { type: "dangerFullAccess" as const },
  tools: [
    {
      name: "exec_command",
      description: "Run a command",
      parameters: { type: "object", properties: { cmd: { type: "string" }, yield_time_ms: { type: "number" } } },
    },
  ],
});

const tool = {
  name: "exec_command",
  description: "Run a command",
  parameters: { type: "object", properties: { cmd: { type: "string" }, yield_time_ms: { type: "number" } } },
};

test("a timed-out MCP invocation retires its turn capability terminally", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cgw-coordinator-timeout-"));
  const broker = TurnBroker.forSocket(join(cwd, "broker.sock"));
  const coordinator = new TurnCoordinator(broker.socketPath, "native");
  try {
    const tokenA = await broker.register(
      environment(cwd),
      60_000,
      "trace-coordinator-release",
      false,
      "turn",
      undefined,
      "thread-coordinator-release",
    );
    const claimed = await coordinator.claimTurn("exec_command", tokenA, { requestId: "req-coordinator-timeout" });

    const outcome = await coordinator.invokeRaw(
      claimed.bindingId,
      environment(cwd),
      tool,
      {
        arguments: { cmd: "slow work", yield_time_ms: 60_000 },
      },
      undefined,
      50,
    );
    expect(JSON.stringify(outcome)).toContain("codex_tool_timeout");

    // A successor for the same thread may register, but the abandoned capability stays dead.
    const tokenB = await broker.register(
      environment(cwd),
      60_000,
      "trace-coordinator-release",
      false,
      "turn",
      tokenA,
      "thread-coordinator-release",
    );
    expect(broker.resolveActiveToken(tokenA)).toBeUndefined();
    await expect(
      callTurnBroker(broker.socketPath, {
        method: "claim",
        token: tokenA,
        activityId: "activity_coord_release_123456789",
      }),
    ).rejects.toThrow(/interrupted before finishing/);
    expect(broker.resolveActiveToken(tokenB)?.resolvedToken).toBe(tokenB);
  } finally {
    await broker.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 15_000);

test("aborting an MCP invocation and cancelling after retirement keep the turn terminal", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cgw-coordinator-abort-"));
  const broker = TurnBroker.forSocket(join(cwd, "broker.sock"));
  const coordinator = new TurnCoordinator(broker.socketPath, "native");
  try {
    const tokenA = await broker.register(
      environment(cwd),
      60_000,
      "trace-coordinator-abort",
      false,
      "turn",
      undefined,
      "thread-coordinator-abort",
    );
    const claimed = await coordinator.claimTurn("exec_command", tokenA, { requestId: "req-coordinator-abort" });

    const abort = new AbortController();
    abort.abort(new Error("ChatGPT response was stopped"));
    await expect(
      coordinator.invokeRaw(
        claimed.bindingId,
        environment(cwd),
        tool,
        { arguments: { cmd: "work" } },
        abort.signal,
        50_000,
      ),
    ).rejects.toThrow();
    expect(broker.resolveActiveToken(tokenA)).toBeUndefined();

    // Cancelling after retirement must keep the terminal result, not resurrect compatibility.
    const tokenB = await broker.register(
      environment(cwd),
      60_000,
      "trace-coordinator-abort",
      false,
      "turn",
      tokenA,
      "thread-coordinator-abort",
    );
    await expect(
      callTurnBroker(broker.socketPath, {
        method: "claim",
        token: tokenA,
        activityId: "activity_coord_abort_123456789",
      }),
    ).rejects.toThrow(/interrupted before finishing/);
    expect(broker.resolveActiveToken(tokenB)?.resolvedToken).toBe(tokenB);
  } finally {
    await broker.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 15_000);
