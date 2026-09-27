import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { HostHttpRoutes } from "../src/server/host-routes";
import { HostSessionStore } from "../src/server/host-state";
import { HttpTurnCounter } from "../src/server/http-turn-counter";

async function fixture(mode: "tools" | "held" = "tools", rateLimitRpm = 0) {
  let release!: () => void;
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  let calls = 0;
  let failNext = false;
  let now = Date.now();
  const store = new HostSessionStore(() => now);
  const routes = new HostHttpRoutes({
    ...defaultConfig("full"),
    controlToken: "status-pairing",
    rateLimitRpm,
  }, new HttpTurnCounter(), () => ({
    name: "status-fixture",
    async runTurn(_parsed, options, emit) {
      calls += 1;
      if (mode === "held") {
        const signal = options.abortSignal!;
        signal.addEventListener("abort", release, { once: true });
        emit({ type: "text_delta", text: "started" });
        try {
          await held;
        } finally {
          signal.removeEventListener("abort", release);
        }
      }
      if (failNext) {
        failNext = false;
        emit({ type: "error", message: "private model failure", status: 502 });
      } else if (calls === 1 && mode === "tools") {
        emit({ type: "tool_call_start", id: "status-call", name: "read" });
        emit({ type: "tool_call_delta", arguments: '{"path":"private.ts"}' });
        emit({ type: "tool_call_end" });
        emit({ type: "done" });
      } else {
        emit({ type: "text_delta", text: "private final text" });
        emit({ type: "done" });
      }
    },
  }), store);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async request => (await routes.handle(request)) ?? new Response(null, { status: 404 }),
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const pair = async () => {
    const response = await fetch(`${origin}/host/v1/sessions`, {
      method: "POST",
      headers: { authorization: "Bearer status-pairing" },
      body: JSON.stringify({ protocol: 1, host: "pi", cwd: process.cwd() }),
    });
    expect(response.status).toBe(200);
    return await response.json() as { session_id: string; token: string; models: Array<{ id: string }> };
  };
  type Session = Awaited<ReturnType<typeof pair>>;
  const inspect = (session: Session, turnId = "turn", headers: Record<string, string> = {}) => fetch(
    `${origin}/host/v1/sessions/${session.session_id}/turns/${turnId}`,
    { headers: { authorization: `Bearer ${session.token}`, ...headers } },
  );
  const request = (session: Session, sequence: number, turnId = "turn", body = {}) => fetch(`${origin}/host/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.token}`,
      "x-cgw-session-id": session.session_id,
      "x-cgw-turn-id": turnId,
      "x-cgw-sequence": String(sequence),
    },
    body: JSON.stringify({
      model: session.models[0]!.id,
      stream: false,
      input: "Inspect private.ts",
      tools: [{ type: "function", name: "read", parameters: { type: "object", properties: {} } }],
      ...body,
    }),
  });
  return {
    origin, routes, store, pair, inspect, request, release,
    calls: () => calls,
    failNext: () => { failNext = true; },
    expire: () => { now += 2 * 60 * 60 * 1000; },
    async close() {
      release();
      await routes.close();
      server.stop(true);
    },
  };
}

test("host status requires the exact capability, rejects Origin and returns only no-store metadata", async () => {
  const f = await fixture();
  try {
    const a = await f.pair();
    const b = await f.pair();
    const response = await f.inspect(a);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      session_id: a.session_id,
      turn_id: "turn",
      state: "unknown",
      cancellation: null,
      request_sequence: null,
      last_completed_sequence: null,
      last_completed_response_id: null,
      response_retained: false,
      pending_tool_calls: 0,
      scope: "bridge-http-and-browser-only",
      replay_allowed: false,
    });
    for (const token of [b.token, "status-pairing", ""]) {
      const denied = await f.inspect(a, "turn", { authorization: `Bearer ${token}` });
      expect(denied.status).toBe(401);
      expect(denied.headers.get("cache-control")).toBe("no-store");
    }
    expect((await f.inspect(a, "turn", { origin: "https://invalid.test" })).status).toBe(403);
    await fetch(`${f.origin}/host/v1/sessions/${a.session_id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect((await f.inspect(a)).status).toBe(401);
    f.expire();
    expect((await f.inspect(b)).status).toBe(401);
  } finally {
    await f.close();
  }
});

test("status preserves per-turn completed evidence when a later round fails or cache is evicted", async () => {
  const f = await fixture();
  try {
    const session = await f.pair();
    const first = await (await f.request(session, 1)).json() as any;
    const initial = await (await f.inspect(session)).json() as any;
    expect(initial.state).toBe("idle");
    expect(initial.request_sequence).toBe(1);
    expect(initial.last_completed_sequence).toBe(1);
    expect(initial.last_completed_response_id).toBe(first.id);
    expect(initial.response_retained).toBe(true);
    expect(initial.pending_tool_calls).toBe(1);
    f.failNext();
    const failed = await f.request(session, 2, "turn", {
      previous_response_id: first.id,
      input: [{ type: "function_call_output", call_id: first.output[0].call_id, output: "private tool result" }],
    });
    await failed.text();
    const afterFailure = await (await f.inspect(session)).json() as any;
    expect(afterFailure.state).toBe("idle");
    expect(afterFailure.request_sequence).toBe(2);
    expect(afterFailure.last_completed_sequence).toBe(1);
    expect(afterFailure.last_completed_response_id).toBe(first.id);
    expect(afterFailure.pending_tool_calls).toBe(0);
    for (let sequence = 3; sequence <= 19; sequence += 1) {
      await (await f.request(session, sequence, `other-${sequence}`)).text();
    }
    const evicted = await (await f.inspect(session)).json() as any;
    expect(evicted.request_sequence).toBe(2);
    expect(evicted.last_completed_sequence).toBe(1);
    expect(evicted.last_completed_response_id).toBe(first.id);
    expect(evicted.response_retained).toBe(false);
    const text = JSON.stringify(evicted);
    expect(text).not.toContain("private");
    expect(text).not.toContain(session.token);
  } finally {
    await f.close();
  }
});

test("status observes active streaming and cancellation without authority over host commands", async () => {
  const f = await fixture("held");
  let response: Response | undefined;
  try {
    const session = await f.pair();
    response = await f.request(session, 1, "turn", { stream: true });
    const active = await (await f.inspect(session)).json() as any;
    expect(active.state).toBe("active");
    expect(active.request_sequence).toBe(1);
    expect(active.last_completed_sequence).toBeNull();
    const cancelled = await fetch(`${f.origin}/host/v1/sessions/${session.session_id}/turns/turn/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(cancelled.status).toBe(200);
    await response.text();
    const settled = await (await f.inspect(session)).json() as any;
    expect(settled.state).toBe("cancelled");
    expect(["requested", "settled"]).toContain(settled.cancellation);
    expect(settled.last_completed_sequence).toBeNull();
    expect(settled.scope).toBe("bridge-http-and-browser-only");
    expect(settled.replay_allowed).toBe(false);
  } finally {
    await response?.body?.cancel().catch(() => {});
    await f.close();
  }
});

test("status does not consume sequence or model quota", async () => {
  const f = await fixture("tools", 1);
  try {
    const session = await f.pair();
    for (let index = 0; index < 4; index += 1) {
      expect((await f.inspect(session)).status).toBe(200);
    }
    expect(f.store.sessions.get(session.session_id)?.sequence).toBe(0);
    expect(f.calls()).toBe(0);
    const admitted = await f.request(session, 1);
    expect(admitted.status).toBe(200);
    await admitted.text();
    expect((await f.request(session, 2, "next")).status).toBe(429);
    expect((await f.inspect(session)).status).toBe(200);
    expect(f.store.sessions.get(session.session_id)?.sequence).toBe(1);
  } finally {
    await f.close();
  }
});

test("status reports admitting before a body is accepted and cancellation retires that admission", async () => {
  const f = await fixture();
  let cancelledBody = false;
  try {
    const session = await f.pair();
    const pending = f.routes.handle(new Request(`${f.origin}/host/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "x-cgw-session-id": session.session_id,
        "x-cgw-turn-id": "turn",
        "x-cgw-sequence": "1",
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"model":'));
        },
        cancel() {
          cancelledBody = true;
        },
      }),
    }));
    const admitting = await (await f.inspect(session)).json() as any;
    expect(admitting.state).toBe("admitting");
    expect(admitting.request_sequence).toBeNull();
    await fetch(`${f.origin}/host/v1/sessions/${session.session_id}/turns/turn/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect((await pending)?.status).toBe(409);
    expect(cancelledBody).toBe(true);
    expect((await (await f.inspect(session)).json() as any).state).toBe("cancelled");
    expect(f.calls()).toBe(0);
  } finally {
    await f.close();
  }
});
