import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import {
  type BrokerToolResult,
  callTurnBroker,
  RemoteTurnBroker,
  TurnBroker,
} from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-composition-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const owner = new RemoteTurnBroker(socketPath);
  const environment: ChatGptTurnEnvironment = {
    cwd: root,
    roots: [root],
    writableRoots: [root],
    sandboxPolicy: { type: "dangerFullAccess" },
    tools: [
      {
        name: "facts_query",
        description: "Read facts supplied by the turn owner",
        parameters: { type: "object" },
      },
    ],
  };
  return {
    broker,
    owner,
    socketPath,
    environment,
    async close() {
      await broker.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("invalid fence revisions are rejected before looking up a revoked owner token", async () => {
  const f = fixture();
  try {
    const token = await f.broker.register(f.environment, 60_000, "invalid-fence-owner");
    f.broker.revoke(token);
    for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => f.broker.commitCompletionFence(token, revision)).toThrow("revision is invalid");
      await expect(
        callTurnBroker(f.socketPath, {
          method: "owner_completion_fence_commit",
          token,
          revision,
        }),
      ).rejects.toThrow("revision is invalid");
    }
    expect(() => f.broker.commitCompletionFence(token, 0)).toThrow("invalid or expired");
    await expect(f.owner.commitCompletionFence(token, 0)).rejects.toThrow("invalid or expired");
  } finally {
    await f.close();
  }
});

test("an activity invalidates an earlier fence and committed fences remain idempotent", async () => {
  const f = fixture();
  try {
    const token = await f.broker.register(f.environment, 60_000, "fence-idempotence");
    const before = await f.owner.beginCompletionFence(token);
    expect(before).toBe(0);
    const activityId = "activity_composition_fence_0123456789";
    const claim = { method: "claim" as const, token, activityId };
    const first = await callTurnBroker<{ bindingId: string }>(f.socketPath, claim);
    const duplicate = await callTurnBroker<{ bindingId: string }>(f.socketPath, claim);
    expect(duplicate.bindingId).toBe(first.bindingId);
    expect(await f.owner.beginCompletionFence(token)).toBeUndefined();
    expect(await f.owner.commitCompletionFence(token, 0)).toBe(false);
    await expect(callTurnBroker(f.socketPath, { method: "activity_complete", token, activityId })).resolves.toEqual({
      completed: true,
    });
    await expect(callTurnBroker(f.socketPath, { method: "activity_complete", token, activityId })).resolves.toEqual({
      completed: false,
      duplicate: true,
    });
    const after = await f.owner.beginCompletionFence(token);
    expect(after).toBe(2);
    expect(await f.owner.commitCompletionFence(token, 0)).toBe(false);
    expect(await f.owner.commitCompletionFence(token, 2)).toBe(true);
    expect(f.broker.commitCompletionFence(token, 2)).toBe(true);
    expect(await f.owner.beginCompletionFence(token)).toBe(2);
    expect(await f.owner.commitCompletionFence(token, 3)).toBe(false);
    await expect(callTurnBroker(f.socketPath, claim)).rejects.toThrow("already finished");
  } finally {
    await f.close();
  }
});

test("a replayed tool batch keeps its call identity and accepts one result only", async () => {
  const f = fixture();
  try {
    const token = await f.broker.register(f.environment, 60_000, "batch-replay");
    const activityId = "activity_composition_batch_0123456789";
    const { bindingId } = await callTurnBroker<{ bindingId: string }>(f.socketPath, {
      method: "claim",
      token,
      activityId,
    });
    const invocation = callTurnBroker<BrokerToolResult>(f.socketPath, {
      method: "invoke",
      bindingId,
      wireName: "facts_query",
      freeform: false,
      arguments: { topic: "ownership" },
    });
    // Attach rejection cleanup immediately if a later assertion fails and closes the broker.
    void invocation.catch(() => {});
    const batch = await f.owner.nextToolBatch(token);
    expect(batch).toHaveLength(1);
    const callId = batch[0]!.callId;
    expect(typeof callId).toBe("string");
    expect(batch[0]).toMatchObject({
      wireName: "facts_query",
      freeform: false,
      arguments: { topic: "ownership" },
    });
    expect(await f.broker.nextToolBatch(token)).toEqual(batch);
    expect(await f.owner.nextToolBatch(token)).toEqual(batch);
    await f.owner.recordToolLifecyclePhase(token, callId, "browser_observed");
    await f.owner.recordToolLifecyclePhase(token, callId, "codex_emitted");
    const result: BrokerToolResult = { content: [{ type: "text", text: "one owner" }] };
    await f.owner.completeTool(token, callId, result);
    expect(await invocation).toEqual({ content: [{ type: "text", text: "one owner" }] });
    await expect(f.owner.completeTool(token, callId, result)).rejects.toThrow("not pending");
    expect(() => f.broker.completeTool(token, callId, result)).toThrow("not pending");
    await callTurnBroker(f.socketPath, { method: "activity_complete", token, activityId });
    const revision = f.broker.beginCompletionFence(token);
    expect(revision).toBe(2);
    expect(f.broker.commitCompletionFence(token, 2)).toBe(true);
  } finally {
    await f.close();
  }
});

test("host-only capabilities reject aliases and cannot recover through matching trace or thread lineage", async () => {
  const f = fixture();
  try {
    const hostEnvironment: ChatGptTurnEnvironment = { ...f.environment, execution: "host-only" };
    const host = await f.broker.register(
      hostEnvironment,
      60_000,
      "shared-lineage",
      false,
      "turn",
      undefined,
      "thread-shared",
    );
    const native = await f.broker.register(
      f.environment,
      60_000,
      "shared-lineage",
      false,
      "turn",
      undefined,
      "thread-shared",
    );
    expect(() => f.broker.registerAlias(host, native)).toThrow("host-only");
    expect(() => f.broker.registerAlias(native, host)).toThrow("host-only");
    await expect(f.owner.registerAlias(host, native)).rejects.toThrow("host-only");
    await expect(f.broker.register(f.environment, 60_000, "shared-lineage", false, "turn", host)).rejects.toThrow(
      "host-only",
    );
    await expect(f.broker.register(hostEnvironment, 60_000, "shared-lineage", false, "turn", native)).rejects.toThrow(
      "host-only",
    );
    f.broker.revoke(host);
    await expect(
      callTurnBroker(f.socketPath, {
        method: "claim",
        token: host,
        activityId: "activity_composition_host_0123456789",
      }),
    ).rejects.toThrow("already finished");
    await expect(
      callTurnBroker(f.socketPath, {
        method: "claim",
        token: native,
        activityId: "activity_composition_native_0123456789",
      }),
    ).resolves.toMatchObject({ bindingId: expect.any(String), traceId: "shared-lineage" });
  } finally {
    await f.close();
  }
});

test("a revoked binding rejects late invocation and its token cannot claim without a successor", async () => {
  const f = fixture();
  try {
    const token = await f.broker.register(f.environment, 60_000, "revoked-no-successor");
    const { bindingId } = await callTurnBroker<{ bindingId: string }>(f.socketPath, {
      method: "claim",
      token,
      activityId: "activity_composition_revoked_0123456789",
    });
    await f.owner.revoke(token);
    await expect(
      callTurnBroker(f.socketPath, {
        method: "invoke",
        bindingId,
        wireName: "facts_query",
        freeform: false,
        arguments: { topic: "late" },
      }),
    ).rejects.toThrow("already finished");
    await expect(
      callTurnBroker(f.socketPath, {
        method: "claim",
        token,
        activityId: "activity_composition_late_0123456789",
      }),
    ).rejects.toThrow("already finished");
    await expect(f.owner.nextToolBatch(token)).rejects.toThrow("invalid or expired");
  } finally {
    await f.close();
  }
});
