import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionActorJournal, SessionActorManager } from "../src/adapters/chatgpt-web/session-actor";
import { chatGptNativeThreadOwnershipKey } from "../src/adapters/chatgpt-web/turn-execution/keys";
import { defaultConfig } from "../src/config";
import { HostHttpRoutes } from "../src/server/host-routes";
import { HostSessionStore } from "../src/server/host-state";
import { HttpTurnCounter } from "../src/server/http-turn-counter";

test("host turn cancellation revokes only its actor before returning", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-host-actor-cancel-"));
  const journal = new SessionActorJournal(join(root, "actors", "events.sqlite"));
  const manager = new SessionActorManager(journal);
  const store = new HostSessionStore();
  const routes = new HostHttpRoutes(
    defaultConfig("full"),
    new HttpTurnCounter(),
    undefined,
    store,
    join(root, "recovery"),
    manager,
  );
  try {
    const a = store.create(process.cwd());
    const b = store.create(process.cwd());
    for (const session of [a, b]) {
      session.turns.set("turn-1", {
        id: "turn-1",
        catalog: "",
        names: new Set(),
        active: true,
        cancelled: false,
      });
      await manager.beginTurn(`namespace:${chatGptNativeThreadOwnershipKey(session.id)}`, "turn-1");
    }
    const request = new Request(`http://localhost/host/v1/sessions/${a.id}/turns/turn-1/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${a.token}` },
    });
    const response = await routes.handle(request);
    expect(response?.status).toBe(200);
    expect(journal.snapshot(`namespace:${chatGptNativeThreadOwnershipKey(a.id)}`)?.generation).toBe(2);
    expect(journal.snapshot(`namespace:${chatGptNativeThreadOwnershipKey(b.id)}`)?.generation).toBe(1);
  } finally {
    await routes.close();
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("host session deletion revokes every active native turn it owns", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-host-actor-delete-"));
  const journal = new SessionActorJournal(join(root, "actors", "events.sqlite"));
  const manager = new SessionActorManager(journal);
  const store = new HostSessionStore();
  const routes = new HostHttpRoutes(
    defaultConfig("full"),
    new HttpTurnCounter(),
    undefined,
    store,
    join(root, "recovery"),
    manager,
  );
  try {
    const session = store.create(process.cwd());
    session.turns.set("turn-1", {
      id: "turn-1",
      catalog: "",
      names: new Set(),
      active: true,
      cancelled: false,
    });
    const sessionId = `namespace:${chatGptNativeThreadOwnershipKey(session.id)}`;
    await manager.beginTurn(sessionId, "turn-1");
    const request = new Request(`http://localhost/host/v1/sessions/${session.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${session.token}` },
    });
    const response = await routes.handle(request);
    expect(response?.status).toBe(200);
    expect(journal.snapshot(sessionId)?.generation).toBe(2);
  } finally {
    await routes.close();
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed actor revocation retains an expired host session for cleanup retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-host-actor-retry-"));
  const store = new HostSessionStore();
  let failRevocation = true;
  let revocations = 0;
  const manager = {
    async revokeNativeTurn() {
      revocations += 1;
      if (failRevocation) throw new Error("journal unavailable");
      return 1;
    },
  } as unknown as SessionActorManager;
  const routes = new HostHttpRoutes(
    defaultConfig("full"),
    new HttpTurnCounter(),
    undefined,
    store,
    join(root, "recovery"),
    manager,
  );
  try {
    const session = store.create(process.cwd());
    const turn = {
      id: "turn-1",
      catalog: "",
      names: new Set<string>(),
      active: true,
      cancelled: false,
    };
    session.turns.set(turn.id, turn);
    const request = new Request(`http://localhost/host/v1/sessions/${session.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${session.token}` },
    });
    const response = await routes.handle(request);
    expect(response?.status).toBe(500);
    expect(store.sessions.get(session.id)).toBe(session);
    expect(session.expires).toBe(0);
    expect(turn.cancelled).toBe(false);
    failRevocation = false;
    await routes.close();
    expect(revocations).toBe(2);
    expect(store.sessions.has(session.id)).toBe(false);
    expect(turn.cancelled).toBe(true);
  } finally {
    failRevocation = false;
    await routes.close();
    rmSync(root, { recursive: true, force: true });
  }
});
