import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import {
  SESSION_ACTOR_PROTOCOL_VERSION,
  SessionActorJournal,
  SessionActorManager,
  SessionResultStore,
} from "../src/adapters/chatgpt-web/session-actor";
import { handleAdminRoute, type AdminRouteContext } from "../src/server/admin-routes";
import { HttpTurnCounter } from "../src/server/http-turn-counter";

function nativeSessionId(threadId: string): string {
  const owner = createHash("sha256")
    .update(JSON.stringify({ kind: "thread", id: threadId }))
    .digest("hex");
  return `namespace:${owner}`;
}

test("admin cancel-turn revokes only the actor generation owned by its trace", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-admin-actor-cancel-"));
  const journal = new SessionActorJournal(join(root, "actors", "events.sqlite"));
  try {
    const manager = new SessionActorManager(journal, new SessionResultStore(join(root, "actors", "results")));
    for (const [index, traceId] of ["trace-A", "trace-B"].entries()) {
      const sessionId = `namespace/thread-${index}`;
      const turnId = `turn-${index}`;
      await manager.beginTurn(sessionId, turnId);
      const actor = manager.actor(sessionId);
      await actor.dispatch({
        protocolVersion: SESSION_ACTOR_PROTOCOL_VERSION,
        sessionId,
        generation: 1,
        turnId,
        operationId: `browser:${traceId}`,
        producerId: `test:${traceId}`,
        producerSequence: 1,
        type: "operation_intent",
        operationKind: "browser_send",
        historyRevision: 0,
      });
      await actor.dispatch({
        protocolVersion: SESSION_ACTOR_PROTOCOL_VERSION,
        sessionId,
        generation: 1,
        turnId,
        operationId: `browser:${traceId}`,
        producerId: `test:${traceId}`,
        producerSequence: 2,
        type: "operation_accepted",
      });
    }
    const config = defaultConfig("full");
    const context = {
      config,
      startedAt: Date.now(),
      isDraining: () => false,
      setDraining: () => {},
      activity: () => ({}),
      modelCatalogStats: {
        successfulModelCatalogRequests: 0,
        lastSuccessfulModelCatalogRequestAt: null,
        modelCatalogRequests: 0,
        lastModelCatalogResult: null,
      },
      httpTurns: new HttpTurnCounter(),
      sessionActorManager: manager,
      shutdown: () => {},
    } satisfies AdminRouteContext & { sessionActorManager: SessionActorManager };
    const request = new Request("http://127.0.0.1/admin/cancel-turn", {
      method: "POST",
      headers: { authorization: `Bearer ${config.controlToken}` },
      body: JSON.stringify({ traceId: "trace-A" }),
    });
    const response = await handleAdminRoute(request, new URL(request.url), context);
    expect(response?.status).toBe(200);
    expect(journal.snapshot("namespace/thread-0")?.generation).toBe(2);
    expect(journal.snapshot("namespace/thread-1")?.generation).toBe(1);
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("admin interrupt-turn revokes only its native actor thread", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-admin-native-cancel-"));
  const journal = new SessionActorJournal(join(root, "actors", "events.sqlite"));
  try {
    const manager = new SessionActorManager(journal, new SessionResultStore(join(root, "actors", "results")));
    const threadA = "thread_native_A";
    const threadB = "thread_native_B";
    const turnId = "turn_native_1";
    await manager.beginTurn(nativeSessionId(threadA), turnId);
    await manager.beginTurn(nativeSessionId(threadB), turnId);
    const config = defaultConfig("full");
    const context = {
      config,
      startedAt: Date.now(),
      isDraining: () => false,
      setDraining: () => {},
      activity: () => ({}),
      modelCatalogStats: {
        successfulModelCatalogRequests: 0,
        lastSuccessfulModelCatalogRequestAt: null,
        modelCatalogRequests: 0,
        lastModelCatalogResult: null,
      },
      httpTurns: new HttpTurnCounter(),
      sessionActorManager: manager,
      shutdown: () => {},
    } satisfies AdminRouteContext;
    const request = new Request("http://127.0.0.1/admin/interrupt-turn", {
      method: "POST",
      headers: { authorization: `Bearer ${config.controlToken}` },
      body: JSON.stringify({ threadId: threadA, turnId }),
    });
    const response = await handleAdminRoute(request, new URL(request.url), context);
    expect(response?.status).toBe(200);
    expect(journal.snapshot(nativeSessionId(threadA))?.generation).toBe(2);
    expect(journal.snapshot(nativeSessionId(threadB))?.generation).toBe(1);
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("admin cancel-turns revokes every active actor generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-admin-all-cancel-"));
  const journal = new SessionActorJournal(join(root, "actors", "events.sqlite"));
  try {
    const manager = new SessionActorManager(journal, new SessionResultStore(join(root, "actors", "results")));
    for (const [index, traceId] of ["trace-all-A", "trace-all-B"].entries()) {
      const sessionId = `namespace/thread-all-${index}`;
      const turnId = `turn-all-${index}`;
      await manager.beginTurn(sessionId, turnId);
      await manager.actor(sessionId).dispatch({
        protocolVersion: SESSION_ACTOR_PROTOCOL_VERSION,
        sessionId,
        generation: 1,
        turnId,
        operationId: `browser:${traceId}`,
        producerId: `test:${traceId}`,
        producerSequence: 1,
        type: "operation_intent",
        operationKind: "browser_send",
        historyRevision: 0,
      });
    }
    const config = defaultConfig("full");
    const context = {
      config,
      startedAt: Date.now(),
      isDraining: () => false,
      setDraining: () => {},
      activity: () => ({}),
      modelCatalogStats: {
        successfulModelCatalogRequests: 0,
        lastSuccessfulModelCatalogRequestAt: null,
        modelCatalogRequests: 0,
        lastModelCatalogResult: null,
      },
      httpTurns: new HttpTurnCounter(),
      sessionActorManager: manager,
      shutdown: () => {},
    } satisfies AdminRouteContext;
    const request = new Request("http://127.0.0.1/admin/cancel-turns", {
      method: "POST",
      headers: { authorization: `Bearer ${config.controlToken}` },
    });
    const response = await handleAdminRoute(request, new URL(request.url), context);
    expect(response?.status).toBe(200);
    expect(journal.snapshot("namespace/thread-all-0")?.generation).toBe(2);
    expect(journal.snapshot("namespace/thread-all-1")?.generation).toBe(2);
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("admin cancel-turns preserves a completed idle actor while revoking pending work", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-admin-idle-cancel-"));
  const journal = new SessionActorJournal(join(root, "actors", "events.sqlite"));
  try {
    const manager = new SessionActorManager(journal, new SessionResultStore(join(root, "actors", "results")));
    await manager.runBrowserTurn(
      "namespace/idle",
      "idle-turn",
      "browser:idle",
      async onAccepted => {
        await onAccepted();
        return "completed";
      },
    );
    await manager.beginTurn("namespace/active", "active-turn");
    await manager.actor("namespace/active").dispatch({
      protocolVersion: SESSION_ACTOR_PROTOCOL_VERSION,
      sessionId: "namespace/active",
      generation: 1,
      turnId: "active-turn",
      operationId: "browser:active",
      producerId: "test:active",
      producerSequence: 1,
      type: "operation_intent",
      operationKind: "browser_send",
      historyRevision: 0,
    });
    const config = defaultConfig("full");
    const context = {
      config,
      startedAt: Date.now(),
      isDraining: () => false,
      setDraining: () => {},
      activity: () => ({}),
      modelCatalogStats: {
        successfulModelCatalogRequests: 0,
        lastSuccessfulModelCatalogRequestAt: null,
        modelCatalogRequests: 0,
        lastModelCatalogResult: null,
      },
      httpTurns: new HttpTurnCounter(),
      sessionActorManager: manager,
      shutdown: () => {},
    } satisfies AdminRouteContext;
    const request = new Request("http://127.0.0.1/admin/cancel-turns", {
      method: "POST",
      headers: { authorization: `Bearer ${config.controlToken}` },
    });
    const response = await handleAdminRoute(request, new URL(request.url), context);
    expect(response?.status).toBe(200);
    expect(journal.snapshot("namespace/idle")?.generation).toBe(1);
    expect(journal.snapshot("namespace/active")?.generation).toBe(2);
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});
