import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { HostHttpRoutes } from "../src/server/host-routes";
import { HttpTurnCounter } from "../src/server/http-turn-counter";
import type { CodexParsedRequest } from "../src/types";

async function fixture(rateLimitRpm?: number) {
  const seen: CodexParsedRequest[] = [];
  const config = { ...defaultConfig("full"), controlToken: "test-control-secret", rateLimitRpm };
  const routes = new HostHttpRoutes(config, new HttpTurnCounter(), () => ({
    name: "host-test",
    async runTurn(parsed, _options, emit) {
      seen.push(parsed);
      emit({ type: "tool_call_start", id: `call_${seen.length}`, name: "read" });
      emit({ type: "tool_call_delta", arguments: '{"path":"a.ts"}' });
      emit({ type: "tool_call_end" });
      emit({ type: "done" });
    },
  }));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async req => (await routes.handle(req)) ?? new Response(null, { status: 404 }) });
  const url = `http://127.0.0.1:${server.port}`;
  const pair = async () => {
    const response = await fetch(`${url}/host/v1/sessions`, { method: "POST", headers: { authorization: `Bearer ${config.controlToken}`, "content-type": "application/json" }, body: JSON.stringify({ protocol: 1, host: "pi", cwd: process.cwd() }) });
    expect(response.status).toBe(200);
    return await response.json() as any;
  };
  const request = async (session: any, sequence: number, body: any = {}, turn = "turn-one") => fetch(`${url}/host/v1/responses`, {
    method: "POST", headers: { authorization: `Bearer ${session.token}`, "x-cgw-session-id": session.session_id, "x-cgw-turn-id": turn, "x-cgw-sequence": String(sequence), "content-type": "application/json" },
    body: JSON.stringify({ model: session.models[0].id, stream: false, input: [{ role: "user", content: "Read a.ts" }], tools: [{ type: "function", name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }], ...body }),
  });
  return { seen, url, pair, request, stop: async () => { await routes.close(); server.stop(true); } };
}

test("host HTTP binds trusted identity and refuses capability, replay and cross-session continuation", async () => {
  const f = await fixture();
  try {
    const a = await f.pair();
    const b = await f.pair();
    expect(a.token).not.toBe(b.token);
    const response = await f.request(a, 1);
    expect(response.status).toBe(200);
    const output = await response.json() as any;
    expect(f.seen[0]._hostTurn?.sessionId).toBe(a.session_id);
    expect(f.seen[0]._hostTurn?.environment.execution).toBe("host-only");
    expect((await f.request(a, 1)).status).toBe(409);
    expect((await f.request({ ...a, token: b.token }, 2)).status).toBe(401);
    expect((await f.request(b, 1, { previous_response_id: output.id })).status).toBe(409);
    expect((await f.request(a, 3, { _hostTurn: { sessionId: b.session_id } })).status).toBe(400);
    expect(f.seen.length).toBe(1);
  } finally { await f.stop(); }
});

test("host HTTP rejects browser pairing and validates tool results and catalog", async () => {
  const f = await fixture();
  try {
    const browser = await fetch(`${f.url}/host/v1/sessions`, { method: "POST", headers: { origin: "https://evil.test", authorization: "Bearer test-control-secret" }, body: '{}' });
    expect(browser.status).toBe(403);
    const a = await f.pair();
    const first = await (await f.request(a, 1)).json() as any;
    expect((await f.request(a, 2, { input: [{ type: "function_call_output", call_id: "unknown", output: "fake" }] })).status).toBe(409);
    expect((await f.request(a, 3, { tools: [] })).status).toBe(409);
    const result = { type: "function_call_output", call_id: first.output[0].call_id, output: "source" };
    const next = await f.request(a, 4, { previous_response_id: first.id, input: [result] });
    expect(next.status).toBe(200);
    await next.json();
    expect((await f.request(a, 5, { input: [result, result] })).status).toBe(409);
    expect((await f.request(a, 6, { input: [{ ...result, output: "changed" }] })).status).toBe(409);
  } finally { await f.stop(); }
});

test("host accepts paired imported history and exact result replay without giving it live tool authority", async () => {
  const f = await fixture();
  try {
    const a = await f.pair();
    const historical = [
      { role: "user", content: "old question" },
      { type: "function_call", call_id: "imported_call", name: "old_tool", arguments: '{}' },
      { type: "function_call_output", call_id: "imported_call", output: "old result" },
      { role: "user", content: "Read a.ts" },
    ];
    const response = await f.request(a, 1, { input: historical });
    expect(response.status).toBe(200);
    const first = await response.json() as any;
    const result = { type: "function_call_output", call_id: first.output[0].call_id, output: "source" };
    const next = await f.request(a, 2, { input: [...historical, first.output[0], result] });
    expect(next.status).toBe(200);
    await next.json();
    const replay = await f.request(a, 3, { input: [...historical, first.output[0], result] });
    expect(replay.status).toBe(200);
    await replay.json();
    expect((await f.request(a, 4, { input: [...historical, { type: "function_call_output", call_id: "imported_call", output: "spoof" }] })).status).toBe(409);
  } finally { await f.stop(); }
});

test("invalid continuation content does not commit a tool result or consume its sequence", async () => {
  const f = await fixture();
  try {
    const session = await f.pair();
    const first = await (await f.request(session, 1)).json() as any;
    const callId = first.output[0].call_id;
    const invalid = await f.request(session, 2, {
      previous_response_id: first.id,
      input: [{ type: "function_call_output", call_id: callId, output: [{ type: "input_text", text: 123 }] }],
    });
    expect(invalid.status).toBe(400);
    await invalid.text();
    expect(f.seen.length).toBe(1);
    const corrected = await f.request(session, 2, {
      previous_response_id: first.id,
      input: [{ type: "function_call_output", call_id: callId, output: "corrected source evidence" }],
    });
    expect(corrected.status).toBe(200);
    await corrected.text();
    expect(f.seen.length).toBe(2);
  } finally {
    await f.stop();
  }
});

test("host cancellation only aborts its session and preserves honest requested/settled states", async () => {
  const config = { ...defaultConfig("full"), controlToken: "cancel-control" };
  const signals = new Map<string, AbortSignal>();
  const routes = new HostHttpRoutes(config, new HttpTurnCounter(), () => ({
    name: "cancellation-test",
    async runTurn(parsed, options, emit) {
      const signal = options.abortSignal!;
      signals.set(parsed._hostTurn!.sessionId, signal);
      emit({ type: "text_delta", text: "started" });
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  }));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async req => (await routes.handle(req))! });
  const url = `http://127.0.0.1:${server.port}`;
  const pair = async () => await (await fetch(`${url}/host/v1/sessions`, { method: "POST", headers: { authorization: "Bearer cancel-control" }, body: JSON.stringify({ protocol: 1, host: "pi", cwd: process.cwd() }) })).json() as any;
  const active: Response[] = [];
  try {
    const a = await pair();
    const b = await pair();
    for (const session of [a, b]) {
      active.push(await fetch(`${url}/host/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${session.token}`, "x-cgw-session-id": session.session_id, "x-cgw-turn-id": "same-turn", "x-cgw-sequence": "1" }, body: JSON.stringify({ model: session.models[0].id, stream: true, input: "wait" }) }));
    }
    const cancel = async (session: any, turn = "same-turn") => await (await fetch(`${url}/host/v1/sessions/${session.session_id}/turns/${turn}/cancel`, { method: "POST", headers: { authorization: `Bearer ${session.token}` } })).json() as any;
    expect((await cancel(a, "unknown")).state).toBe("unknown");
    expect((await cancel(a)).state).toBe("requested");
    expect(signals.get(a.session_id)?.aborted).toBe(true);
    expect(signals.get(b.session_id)?.aborted).toBe(false);
    expect((await cancel(a)).state).toBe("settled");
    const deleted = await fetch(`${url}/host/v1/sessions/${b.session_id}`, { method: "DELETE", headers: { authorization: `Bearer ${b.token}` } });
    expect(deleted.status).toBe(200);
    expect(signals.get(b.session_id)?.aborted).toBe(true);
    expect((await fetch(`${url}/host/v1/sessions/${b.session_id}`, { method: "DELETE", headers: { authorization: `Bearer ${b.token}` } })).status).toBe(401);
  } finally {
    for (const response of active) await response.body?.cancel().catch(() => {});
    await routes.close();
    server.stop(true);
  }
});

test("host capabilities expire and session quota fails without evicting another owner", async () => {
  const { HostSessionStore } = await import("../src/server/host-state");
  let now = 0;
  const store = new HostSessionStore(() => now, 10, 1);
  const routes = new HostHttpRoutes({ ...defaultConfig("full"), controlToken: "quota-control" }, new HttpTurnCounter(), undefined, store);
  const pairing = () => routes.handle(new Request("http://127.0.0.1/host/v1/sessions", { method: "POST", headers: { authorization: "Bearer quota-control" }, body: JSON.stringify({ protocol: 1, host: "pi", cwd: process.cwd() }) }));
  try {
    const first = await (await pairing())!.json() as any;
    expect((await pairing())!.status).toBe(429);
    expect(store.sessions.has(first.session_id)).toBe(true);
    now = 11;
    const old = await routes.handle(new Request(`http://127.0.0.1/host/v1/sessions/${first.session_id}`, { method: "DELETE", headers: { authorization: `Bearer ${first.token}` } }));
    expect(old!.status).toBe(401);
    expect((await pairing())!.status).toBe(200);
  } finally { await routes.close(); }
});

test("host rejects catalog duplicates, foreign identity, unavailable models and excessive output budgets", async () => {
  const f = await fixture();
  try {
    const a = await f.pair();
    for (const body of [
      { client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "other", turn_id: "other" }) } },
      { prompt_cache_key: "other-session" },
      { model: "gpt-4" },
      { max_output_tokens: 32769 },
      { tools: [{ type: "function", name: "read" }, { type: "function", name: "read" }] },
      { tools: [{ type: "web_search" }] },
    ]) expect((await f.request(a, 1, body)).status).toBe(400);
    expect(f.seen.length).toBe(0);
  } finally { await f.stop(); }
});

test("host replay accepts equivalent JSON tool arguments reserialized by Pi", async () => {
  const f = await fixture();
  try {
    const session = await f.pair();
    const first = await (await f.request(session, 1)).json() as any;
    const call = first.output[0];
    const response = await f.request(session, 2, { input: [
      { role: "user", content: "Read a.ts" },
      { ...call, arguments: ' { "path" : "a.ts" } ' },
      { type: "function_call_output", call_id: call.call_id, output: "source" },
    ] });
    expect(response.status).toBe(200);
    await response.json();
  } finally { await f.stop(); }
});

test("a new user turn retains cancelled tool results as history without reviving execution", async () => {
  const f = await fixture();
  try {
    const session = await f.pair();
    const first = await (await f.request(session, 1)).json() as any;
    await fetch(`${f.url}/host/v1/sessions/${session.session_id}/turns/turn-one/cancel`, {
      method: "POST", headers: { authorization: `Bearer ${session.token}` },
    });
    const history = [
      { role: "user", content: "Read a.ts" },
      first.output[0],
      { type: "function_call_output", call_id: first.output[0].call_id, output: "Host execution aborted" },
      { role: "user", content: "Continue with a new request" },
    ];
    const next = await f.request(session, 2, { input: history }, "turn-two");
    expect(next.status).toBe(200);
    await next.json();
    expect((await f.request(session, 3, { input: history })).status).toBe(409);
    expect((await f.request(session, 4, { input: [{ ...history[2], output: "changed" }] }, "turn-three")).status).toBe(409);
  } finally {
    await f.stop();
  }
});


test("host model rate admission is shared across capabilities and does not block cancellation", async () => {
  const f = await fixture(1);
  try {
    const a = await f.pair();
    const b = await f.pair();
    const first = await f.request(a, 1);
    expect(first.status).toBe(200);
    await first.json();
    const excess = await f.request(b, 1);
    expect(excess.status).toBe(429);
    expect(Number(excess.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(f.seen.length).toBe(1);
    const cancelled = await fetch(`${f.url}/host/v1/sessions/${a.session_id}/turns/turn-one/cancel`, {
      method: "POST", headers: { authorization: `Bearer ${a.token}` },
    });
    expect(cancelled.status).toBe(200);
  } finally {
    await f.stop();
  }
});

for (const action of ["cancel", "delete", "expire"] as const) {
  test(`${action} during HTTP body admission prevents the turn from starting after body completion`, async () => {
    let adapterRuns = 0;
    let bodyCancelled = false;
    let clock = 0;
    const { HostSessionStore } = await import("../src/server/host-state");
    const config = { ...defaultConfig("full"), controlToken: "admission-control" };
    const routes = new HostHttpRoutes(config, new HttpTurnCounter(), () => ({
      name: "admission-cancel",
      async runTurn(_parsed, _options, emit) {
        adapterRuns += 1;
        emit({ type: "text_delta", text: "must not execute" });
        emit({ type: "done" });
      },
    }), new HostSessionStore(() => clock, 1000));
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let pending: Promise<Response | undefined> | undefined;
    try {
      const paired = await routes.handle(new Request("http://127.0.0.1/host/v1/sessions", {
        method: "POST", headers: { authorization: "Bearer admission-control" },
        body: JSON.stringify({ protocol: 1, host: "pi", cwd: process.cwd() }),
      }));
      const session = await paired!.json() as any;
      const payload = JSON.stringify({ model: session.models[0].id, stream: false, input: "hello" });
      const headers = { authorization: `Bearer ${session.token}`, "x-cgw-session-id": session.session_id, "x-cgw-turn-id": "slow-body", "x-cgw-sequence": "1" };
      pending = routes.handle(new Request("http://127.0.0.1/host/v1/responses", {
        method: "POST", headers,
        body: new ReadableStream({
          start(value) {
            controller = value;
            controller.enqueue(new TextEncoder().encode(payload));
          },
          cancel() {
            bodyCancelled = true;
          },
        }),
        duplex: "half",
      } as RequestInit));
      if (action === "expire") clock = 1001;
      const path = action === "cancel" ? `/host/v1/sessions/${session.session_id}/turns/slow-body/cancel`
        : `/host/v1/sessions/${session.session_id}`;
      const retired = await routes.handle(new Request(`http://127.0.0.1${path}`, {
        method: action === "cancel" ? "POST" : "DELETE", headers: { authorization: `Bearer ${session.token}` },
      }));
      if (action === "expire") expect(retired!.status).toBe(401);
      else expect((await retired!.json() as any).state).not.toBe("unknown");
      if (!bodyCancelled) controller.close();
      expect((await pending)!.status).toBe(409);
      expect(bodyCancelled).toBe(true);
      expect(adapterRuns).toBe(0);
      const replay = await routes.handle(new Request("http://127.0.0.1/host/v1/responses", {
        method: "POST", headers: { ...headers, "x-cgw-sequence": "2" }, body: payload,
      }));
      expect(replay!.status).toBe(action === "cancel" ? 409 : 401);
    } finally {
      if (controller && !bodyCancelled) {
        try { controller.close(); } catch {}
      }
      await pending;
      await routes.close();
    }
  });
}
