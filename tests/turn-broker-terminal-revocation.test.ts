import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";

const environment = (root: string) => ({
  cwd: root,
  roots: [root],
  writableRoots: [root],
  sandboxPolicy: { type: "dangerFullAccess" as const },
  tools: [],
});

test("an interrupted turn capability never readmits a later same-thread successor", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-terminal-1-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const tokenA = await broker.register(
      environment(root),
      60_000,
      "trace-terminal-1",
      false,
      "turn",
      undefined,
      "thread-terminal-1",
    );

    // Interrupt A mid-turn: no completion fence is ever committed.
    broker.revoke(tokenA, new Error("interrupted by the operator"), { terminal: true });

    // The continuation registers B for the same thread, declaring A as predecessor exactly
    // like the production continuation path does.
    const tokenB = await broker.register(
      environment(root),
      60_000,
      "trace-terminal-1",
      false,
      "turn",
      tokenA,
      "thread-terminal-1",
    );

    expect(broker.resolveActiveToken(tokenA)).toBeUndefined();

    await expect(
      callTurnBroker(socketPath, { method: "claim", token: tokenA, activityId: "activity_term_readmit_1234" }),
    ).rejects.toThrow(/interrupted before finishing/);

    // Repeated late claims keep failing closed: no authorization may be created for the
    // interrupted token by resolving or holding it against the successor epoch.
    await expect(
      callTurnBroker(socketPath, { method: "claim", token: tokenA, activityId: "activity_term_readmit_5678" }),
    ).rejects.toThrow(/interrupted before finishing/);

    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, {
      method: "claim",
      token: tokenB,
      activityId: "activity_term_successor_1234",
    });
    expect(claimed.bindingId).toBeDefined();
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("an interrupted turn does not route through pre-existing alias chains", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-terminal-2-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const tokenA = await broker.register(environment(root), 60_000, "trace-terminal-2");
    // C was an authorized successor while A was alive, so the alias A -> C exists.
    await broker.register(environment(root), 60_000, "trace-terminal-2", false, "turn", tokenA);

    broker.revoke(tokenA, new Error("interrupted by the operator"), { terminal: true });

    expect(broker.resolveActiveToken(tokenA)).toBeUndefined();
    await expect(
      callTurnBroker(socketPath, { method: "claim", token: tokenA, activityId: "activity_term_alias_1234" }),
    ).rejects.toThrow(/interrupted before finishing/);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("a late request cannot acquire a successor epoch through the thread grace wait", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-terminal-3-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath, 40, 20);
  try {
    const tokenA = await broker.register(
      environment(root),
      60_000,
      "trace-terminal-3",
      false,
      "turn",
      undefined,
      "thread-terminal-3",
    );
    broker.revoke(tokenA, new Error("interrupted by the operator"), { terminal: true });

    // No successor exists yet: the late claim must fail closed without waiting for one.
    await expect(
      callTurnBroker(socketPath, { method: "claim", token: tokenA, activityId: "activity_term_late_1234" }),
    ).rejects.toThrow(/interrupted before finishing/);

    // A successor registering afterwards must not retroactively authorize the late holder.
    await broker.register(environment(root), 60_000, "trace-terminal-3", false, "turn", undefined, "thread-terminal-3");
    await expect(
      callTurnBroker(socketPath, { method: "claim", token: tokenA, activityId: "activity_term_late_5678" }),
    ).rejects.toThrow(/interrupted before finishing/);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("a committed turn keeps routing to its trace successor after revocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-terminal-4-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const tokenA = await broker.register(
      environment(root),
      60_000,
      "trace-terminal-4",
      false,
      "turn",
      undefined,
      "thread-terminal-4",
    );
    const revision = broker.beginCompletionFence(tokenA);
    expect(broker.commitCompletionFence(tokenA, revision!)).toBeTrue();
    broker.revoke(tokenA);

    const tokenB = await broker.register(
      environment(root),
      60_000,
      "trace-terminal-4",
      false,
      "turn",
      tokenA,
      "thread-terminal-4",
    );
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, {
      method: "claim",
      token: tokenA,
      activityId: "activity_term_compat_1234",
    });
    expect(claimed.bindingId).toBeDefined();
    expect(broker.resolveActiveToken(tokenB)?.resolvedToken).toBe(tokenB);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("an interrupted turn cannot invoke through a binding captured before the interruption", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-terminal-5-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const tokenA = await broker.register(environment(root), 60_000, "trace-terminal-5");
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, {
      method: "claim",
      token: tokenA,
      activityId: "activity_term_invoke_1234",
    });
    broker.revoke(tokenA, new Error("interrupted by the operator"), { terminal: true });

    const rejection = async (request: Parameters<typeof callTurnBroker>[1]): Promise<string> => {
      try {
        await callTurnBroker(socketPath, request);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("turn broker accepted a handle it should have rejected");
    };
    const message = await rejection({ method: "invoke", bindingId: claimed.bindingId, wireName: "exec_command" });
    expect(message).toContain("trace-terminal-5");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
