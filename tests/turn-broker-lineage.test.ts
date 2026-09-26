import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import { callTurnBroker, RemoteTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

test("turn broker aliases predecessor token to active successor turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-lineage-1-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [],
    };

    // Register Turn 1
    const token1 = await broker.register(environment, 60_000, "trace-sess-1");
    // Register Turn 2 declaring token1 as predecessor
    const token2 = await broker.register(environment, 60_000, "trace-sess-1", false, "turn", token1);

    // Commit Turn 1 completion fence (so Turn 1 is finished)
    const rev1 = broker.beginCompletionFence(token1);
    expect(rev1).toBeDefined();
    expect(broker.commitCompletionFence(token1, rev1!)).toBeTrue();

    // Now, claim using the retired/committed token1:
    // It should transparently alias to active token2!
    const claimed = await callTurnBroker<{ bindingId: string; activityId: string }>(socketPath, {
      method: "claim",
      token: token1,
      activityId: "activity_test_alias_12345678",
    });
    expect(claimed.bindingId).toBeDefined();
    expect(claimed.activityId).toBe("activity_test_alias_12345678");

    // Settle the activity
    const settled = await callTurnBroker<{ completed: boolean }>(socketPath, {
      method: "activity_complete",
      token: token1,
      activityId: "activity_test_alias_12345678",
    });
    expect(settled.completed).toBeTrue();
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn broker resolves multi-turn alias chains (T1 -> T2 -> T3)", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-lineage-chain-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [],
    };

    const token1 = await broker.register(environment, 60_000, "trace-sess-2");
    const token2 = await broker.register(environment, 60_000, "trace-sess-2", false, "turn", token1);
    const token3 = await broker.register(environment, 60_000, "trace-sess-2", false, "turn", token2);

    // Finish Turn 1 and Turn 2
    const rev1 = broker.beginCompletionFence(token1);
    broker.commitCompletionFence(token1, rev1!);
    const rev2 = broker.beginCompletionFence(token2);
    broker.commitCompletionFence(token2, rev2!);

    // Claim with token1 should resolve directly to token3
    const claimedFrom1 = await callTurnBroker<{ bindingId: string; activityId: string }>(socketPath, {
      method: "claim",
      token: token1,
      activityId: "activity_test_chain_1_12345678",
    });
    expect(claimedFrom1.bindingId).toBeDefined();

    // Claim with token2 should also resolve to token3
    const claimedFrom2 = await callTurnBroker<{ bindingId: string; activityId: string }>(socketPath, {
      method: "claim",
      token: token2,
      activityId: "activity_test_chain_2_12345678",
    });
    expect(claimedFrom2.bindingId).toBe(claimedFrom1.bindingId);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn broker resolves trace lineage when tokens share a traceId", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-lineage-trace-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [],
    };

    // Register token 1 without explicit predecessor
    const token1 = await broker.register(environment, 60_000, "trace-lineage-shared");
    // Register token 2 under the same trace
    const token2 = await broker.register(environment, 60_000, "trace-lineage-shared");

    // Commit token 1
    const rev1 = broker.beginCompletionFence(token1);
    broker.commitCompletionFence(token1, rev1!);

    // Claim with token1 should resolve to active token2 via trace lineage
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, {
      method: "claim",
      token: token1,
      activityId: "activity_test_trace_12345678",
    });
    expect(claimed.bindingId).toBeDefined();
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn broker rejects when entire trace is finished and no active successor exists", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-lineage-term-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [],
    };

    const token1 = await broker.register(environment, 60_000, "trace-terminal");
    const rev1 = broker.beginCompletionFence(token1);
    broker.commitCompletionFence(token1, rev1!);
    broker.revoke(token1);

    await expect(callTurnBroker(socketPath, {
      method: "claim",
      token: token1,
      activityId: "activity_test_term_12345678",
    })).rejects.toThrow("already finished");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a ghost activity from a retired-token claim blocks the successor fence until the liveness sweep", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-lineage-ghost-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath, 40);
  try {
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [],
    };

    const token1 = await broker.register(environment, 60_000, "trace-sess-ghost");
    const token2 = await broker.register(environment, 60_000, "trace-sess-ghost", false, "turn", token1);
    const rev1 = broker.beginCompletionFence(token1);
    broker.commitCompletionFence(token1, rev1!);

    // The claim resolves through the alias, so its activity lease lands on the successor channel.
    await expect(callTurnBroker<{ bindingId: string }>(socketPath, {
      method: "claim",
      token: token1,
      activityId: "activity_ghost_claim_12345678",
    })).resolves.toMatchObject({ bindingId: expect.any(String) });

    // A claimant that never settles it vetoes the successor's completion fence forever.
    expect(broker.beginCompletionFence(token2)).toBeUndefined();
    expect(broker.commitCompletionFence(token2, 0)).toBeFalse();

    // Past the liveness bound the lease is swept as abandoned and the fence reopens.
    await Bun.sleep(60);
    const rev2 = broker.beginCompletionFence(token2);
    expect(rev2).toBeDefined();
    expect(broker.commitCompletionFence(token2, rev2!)).toBeTrue();
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an activity settled before the liveness bound keeps the successor fence working", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-lineage-settle-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath, 40);
  try {
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [],
    };

    const token1 = await broker.register(environment, 60_000, "trace-sess-settle");
    const token2 = await broker.register(environment, 60_000, "trace-sess-settle", false, "turn", token1);
    const rev1 = broker.beginCompletionFence(token1);
    broker.commitCompletionFence(token1, rev1!);

    await expect(callTurnBroker<{ bindingId: string }>(socketPath, {
      method: "claim",
      token: token1,
      activityId: "activity_settled_claim_123456",
    })).resolves.toMatchObject({ bindingId: expect.any(String) });
    await expect(callTurnBroker<{ completed: boolean }>(socketPath, {
      method: "activity_complete",
      token: token1,
      activityId: "activity_settled_claim_123456",
    })).resolves.toMatchObject({ completed: true });

    const rev2 = broker.beginCompletionFence(token2);
    expect(rev2).toBeDefined();
    expect(broker.commitCompletionFence(token2, rev2!)).toBeTrue();
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("revoking a successor keeps the predecessor claim fail-closed without a later successor", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-lineage-revoke-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [],
    };

    const token1 = await broker.register(environment, 60_000, "trace-revoke-closed");
    const token2 = await broker.register(environment, 60_000, "trace-revoke-closed", false, "turn", token1);
    const rev1 = broker.beginCompletionFence(token1);
    broker.commitCompletionFence(token1, rev1!);
    broker.revoke(token2);

    await expect(callTurnBroker(socketPath, {
      method: "claim",
      token: token1,
      activityId: "activity_revoke_closed_123456",
    })).rejects.toThrow("already finished");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("revoking a middle turn keeps later same-trace successors reachable", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-lineage-revoke-chain-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [],
    };

    const token1 = await broker.register(environment, 60_000, "trace-revoke-chain");
    const token2 = await broker.register(environment, 60_000, "trace-revoke-chain", false, "turn", token1);
    const token3 = await broker.register(environment, 60_000, "trace-revoke-chain", false, "turn", token2);
    const rev1 = broker.beginCompletionFence(token1);
    broker.commitCompletionFence(token1, rev1!);
    const rev2 = broker.beginCompletionFence(token2);
    broker.commitCompletionFence(token2, rev2!);
    broker.revoke(token2);

    await expect(callTurnBroker<{ bindingId: string }>(socketPath, {
      method: "claim",
      token: token1,
      activityId: "activity_revoke_chain_123456",
    })).resolves.toMatchObject({ bindingId: expect.any(String) });
    await expect(callTurnBroker<{ bindingId: string }>(socketPath, {
      method: "claim",
      token: token2,
      activityId: "activity_revoke_mid_1234567",
    })).resolves.toMatchObject({ bindingId: expect.any(String) });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("token alias eviction keeps recent lineage routable", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-lineage-alias-evict-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [],
    };

    const token = await broker.register(environment, 60_000, "trace-alias-evict");
    for (let index = 0; index < 300; index += 1) {
      broker.registerAlias(`turn_stale_${index}_aaaaaaaaaaaaaaaa`, token);
    }

    // The oldest aliases are evicted, so their claims can no longer resolve anywhere.
    await expect(callTurnBroker(socketPath, {
      method: "claim",
      token: "turn_stale_0_aaaaaaaaaaaaaaaa",
      activityId: "activity_evict_old_1234567",
    })).rejects.toThrow("turn token is invalid, expired, or revoked");

    // The most recent alias still routes to the active turn.
    await expect(callTurnBroker<{ bindingId: string }>(socketPath, {
      method: "claim",
      token: "turn_stale_299_aaaaaaaaaaaaaaaa",
      activityId: "activity_evict_new_1234567",
    })).resolves.toMatchObject({ bindingId: expect.any(String) });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounded lineage keeps recent turns routable across many registrations and revocations", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-lineage-churn-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [],
    };

    let current = await broker.register(environment, 60_000, "trace-churn");
    let predecessor = current;
    for (let index = 0; index < 300; index += 1) {
      predecessor = current;
      current = await broker.register(environment, 60_000, "trace-churn", false, "turn", current);
      broker.revoke(predecessor);
    }

    // The alias into the still-active successor survives its predecessor's revoke, so a stale
    // claim from the last retired handle keeps routing forward after hundreds of churn cycles.
    await expect(callTurnBroker<{ bindingId: string }>(socketPath, {
      method: "claim",
      token: predecessor,
      activityId: "activity_churn_recent_123456",
    })).resolves.toMatchObject({ bindingId: expect.any(String) });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("touching an activity refreshes its lease past the liveness bound without a fence event", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-lineage-touch-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath, 400);
  const remote = new RemoteTurnBroker(socketPath);
  try {
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [],
    };

    const token1 = await broker.register(environment, 60_000, "trace-sess-touch");
    const token2 = await broker.register(environment, 60_000, "trace-sess-touch", false, "turn", token1);
    const rev1 = broker.beginCompletionFence(token1);
    broker.commitCompletionFence(token1, rev1!);

    // The claim resolves through the alias, so its activity lease lands on the successor channel.
    await expect(callTurnBroker<{ bindingId: string }>(socketPath, {
      method: "claim",
      token: token1,
      activityId: "activity_touch_claim_1234567",
    })).resolves.toMatchObject({ bindingId: expect.any(String) });
    expect(broker.beginCompletionFence(token2)).toBeUndefined();

    // A multi-invoke owner refreshes the lease through the retired handle before each invoke.
    await Bun.sleep(250);
    await expect(remote.touchActivity(token1, "activity_touch_claim_1234567")).resolves.toBeTrue();
    await Bun.sleep(250);

    // Refreshed 250 ms ago: the lease outlives the 400 ms liveness bound — and a turn without
    // the touch would already have swept it at twice the bound — so the fence stays vetoed.
    expect(broker.beginCompletionFence(token2)).toBeUndefined();
    expect(broker.commitCompletionFence(token2, 0)).toBeFalse();

    // A touch is not a causal event: the fence only opens once the claim settles.
    await expect(callTurnBroker<{ completed: boolean }>(socketPath, {
      method: "activity_complete",
      token: token1,
      activityId: "activity_touch_claim_1234567",
    })).resolves.toMatchObject({ completed: true });
    const rev2 = broker.beginCompletionFence(token2);
    expect(rev2).toBeDefined();
    expect(broker.commitCompletionFence(token2, rev2!)).toBeTrue();
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("touching a missing, settled, or revoked activity returns false and moves no revision", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-lineage-touch-miss-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const remote = new RemoteTurnBroker(socketPath);
  try {
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [],
    };

    const token = await broker.register(environment, 60_000, "trace-touch-miss");
    await expect(remote.touchActivity(token, "activity_unknown_touch_123456")).resolves.toBeFalse();

    await expect(callTurnBroker<{ bindingId: string }>(socketPath, {
      method: "claim",
      token,
      activityId: "activity_touch_settled_123456",
    })).resolves.toMatchObject({ bindingId: expect.any(String) });
    await expect(callTurnBroker<{ completed: boolean }>(socketPath, {
      method: "activity_complete",
      token,
      activityId: "activity_touch_settled_123456",
    })).resolves.toMatchObject({ completed: true });
    // A settled (tombstoned) activity is never revived by a touch.
    await expect(remote.touchActivity(token, "activity_touch_settled_123456")).resolves.toBeFalse();

    // The socket path validates the activity id exactly like claim and activity_complete.
    await expect(callTurnBroker(socketPath, {
      method: "owner_touch_activity",
      token,
      activityId: "not-an-activity-id",
    })).rejects.toThrow("turn activity id is invalid");

    broker.revoke(token);
    await expect(remote.touchActivity(token, "activity_unknown_touch_123456")).resolves.toBeFalse();
    await expect(remote.touchActivity("turn_missing_aaaaaaaaaaaaaaaa", "activity_unknown_touch_123456"))
      .resolves.toBeFalse();

    // A touch is not a causal event: two claims plus two settles leave the fence revision at
    // exactly four, where an extra revision bump from either touch would read five.
    const revisionToken = await broker.register(environment, 60_000, "trace-touch-revision");
    for (const activityId of ["activity_touch_first_1234567", "activity_touch_second_123456"]) {
      await expect(callTurnBroker<{ bindingId: string }>(socketPath, {
        method: "claim",
        token: revisionToken,
        activityId,
      })).resolves.toMatchObject({ bindingId: expect.any(String) });
      await expect(remote.touchActivity(revisionToken, activityId)).resolves.toBeTrue();
      await expect(callTurnBroker<{ completed: boolean }>(socketPath, {
        method: "activity_complete",
        token: revisionToken,
        activityId,
      })).resolves.toMatchObject({ completed: true });
    }
    expect(broker.beginCompletionFence(revisionToken)).toBe(4);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
