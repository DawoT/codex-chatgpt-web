import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { HostRecoveryStore } from "../src/server/host-recovery";
import { HostHttpRoutes } from "../src/server/host-routes";
import { HttpTurnCounter } from "../src/server/http-turn-counter";

const scopeA = "a".repeat(64);
const scopeB = "b".repeat(64);

function host(root: string, onTurn: () => void, overrides: Partial<ReturnType<typeof defaultConfig>> = {}) {
  const routes = new HostHttpRoutes(
    {
      ...defaultConfig("full"),
      ...overrides,
      controlToken: "recovery-pairing",
      rateLimitRpm: 0,
    },
    new HttpTurnCounter(),
    () => ({
      name: "recovery-fixture",
      async runTurn(_parsed, _options, emit) {
        onTurn();
        emit({ type: "text_delta", text: "private response" });
        emit({ type: "done" });
      },
    }),
    undefined,
    join(root, "journal"),
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => (await routes.handle(request)) ?? new Response(null, { status: 404 }),
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const pair = async (scope: string) => {
    const response = await fetch(`${origin}/host/v1/sessions`, {
      method: "POST",
      headers: { authorization: "Bearer recovery-pairing" },
      body: JSON.stringify({ protocol: 1, host: "pi", cwd: process.cwd(), recovery_scope: scope }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as { session_id: string; token: string; models: Array<{ id: string }> };
  };
  type Session = Awaited<ReturnType<typeof pair>>;
  const request = (session: Session, turnId: string, sequence = 1, overrides: Record<string, unknown> = {}) =>
    fetch(`${origin}/host/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "x-cgw-session-id": session.session_id,
        "x-cgw-turn-id": turnId,
        "x-cgw-sequence": String(sequence),
      },
      body: JSON.stringify({ model: session.models[0]!.id, input: "private prompt", stream: false, ...overrides }),
    });
  const inspect = (session: Session) =>
    fetch(`${origin}/host/v1/sessions/${session.session_id}/recovery`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
  const cancel = (session: Session, turnId: string) =>
    fetch(`${origin}/host/v1/sessions/${session.session_id}/turns/${turnId}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}` },
    });
  return {
    origin,
    pair,
    request,
    inspect,
    cancel,
    async close() {
      await routes.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
      server.stop(true);
    },
  };
}

test("invalid Responses content leaves recovery unobserved and the sequence reusable", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-invalid-admission-"));
  let calls = 0;
  const runtime = host(root, () => {
    calls += 1;
  });
  try {
    const session = await runtime.pair(scopeA);
    const invalid = await runtime.request(session, "turn-invalid", 1, {
      input: [{ role: "user", content: { invalid: "content-shape" } }],
    });
    expect(invalid.status).toBe(400);
    await invalid.text();
    expect(calls).toBe(0);
    expect(await (await runtime.inspect(session)).json()).toMatchObject({ state: "unobserved", turn_id: null });
    const corrected = await runtime.request(session, "turn-invalid", 1);
    expect(corrected.status).toBe(200);
    await corrected.text();
    expect(calls).toBe(1);
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("high-reasoning requests without streaming leave recovery unobserved", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-stream-admission-"));
  let calls = 0;
  const runtime = host(
    root,
    () => {
      calls += 1;
    },
    { solAvailable: true },
  );
  try {
    const session = await runtime.pair(scopeA);
    const high = session.models.find((model) => model.id === "chatgpt-web/gpt-5.6-sol");
    expect(high).toBeDefined();
    const invalid = await runtime.request(session, "turn-high", 1, {
      model: high!.id,
      stream: false,
    });
    expect(invalid.status).toBe(400);
    await invalid.text();
    expect(calls).toBe(0);
    expect(await (await runtime.inspect(session)).json()).toMatchObject({ state: "unobserved", turn_id: null });
    const corrected = await runtime.request(session, "turn-high", 1, {
      model: high!.id,
      stream: true,
    });
    expect(corrected.status).toBe(200);
    await corrected.text();
    expect(calls).toBe(1);
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("oversized first host prompt is rejected before durable recovery admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-compiled-budget-"));
  let calls = 0;
  const runtime = host(root, () => {
    calls += 1;
  });
  try {
    const session = await runtime.pair(scopeA);
    const oversized = await runtime.request(session, "turn-budget", 1, {
      input: "evidence ".repeat(50_000),
    });
    expect(oversized.status).toBe(400);
    await oversized.text();
    expect(calls).toBe(0);
    expect(await (await runtime.inspect(session)).json()).toMatchObject({ state: "unobserved", turn_id: null });
    const corrected = await runtime.request(session, "turn-budget", 1);
    expect(corrected.status).toBe(200);
    await corrected.text();
    expect(calls).toBe(1);
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an indivisible 160k character first host prompt is rejected before admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-preventive-budget-"));
  let calls = 0;
  const runtime = host(
    root,
    () => {
      calls += 1;
    },
    { experimentalBiggerContext: true },
  );
  try {
    const session = await runtime.pair(scopeA);
    const response = await runtime.request(session, "turn-preventive", 1, {
      input: "evidence ".repeat(19_000),
    });
    expect(response.status).toBe(400);
    await response.text();
    expect(calls).toBe(0);
    expect(await (await runtime.inspect(session)).json()).toMatchObject({ state: "unobserved", turn_id: null });
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("first host prompt preserves multipart admission when complete records fit", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-multipart-admission-"));
  let calls = 0;
  const runtime = host(
    root,
    () => {
      calls += 1;
    },
    { experimentalBiggerContext: true },
  );
  try {
    const session = await runtime.pair(scopeA);
    const input = Array.from({ length: 12 }, (_, index) => ({
      role: "user",
      content: `record ${index}: ${"evidence ".repeat(1_000)}`,
    }));
    const response = await runtime.request(session, "turn-multipart", 1, { input });
    expect(response.status).toBe(200);
    await response.text();
    expect(calls).toBe(1);
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function startHostChild(root: string, mode: "held" | "complete") {
  const child = spawn(process.execPath, [join(import.meta.dirname, "support", "host-recovery-child.ts"), root, mode], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += String(chunk);
  });
  const port = await new Promise<number>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Host child did not start: ${errors}`)), 5000);
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (!output.includes("\n")) return;
      clearTimeout(timer);
      resolve(JSON.parse(output.split("\n")[0]!).port);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`Host child exited before start: ${errors}`));
    });
  });
  return {
    child,
    exited,
    origin: `http://127.0.0.1:${port}`,
  };
}

async function pairChild(origin: string) {
  const response = await fetch(`${origin}/host/v1/sessions`, {
    method: "POST",
    headers: { authorization: "Bearer recovery-pairing" },
    body: JSON.stringify({ protocol: 1, host: "pi", cwd: process.cwd(), recovery_scope: scopeA }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { session_id: string; token: string; models: Array<{ id: string }> };
}

function requestChild(origin: string, session: Awaited<ReturnType<typeof pairChild>>, turnId: string, stream: boolean) {
  return fetch(`${origin}/host/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.token}`,
      "x-cgw-session-id": session.session_id,
      "x-cgw-turn-id": turnId,
      "x-cgw-sequence": "1",
    },
    body: JSON.stringify({ model: session.models[0]!.id, input: "private prompt", stream }),
  });
}

test("a re-paired Pi scope retains model completion after graceful shutdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-recovery-"));
  let calls = 0;
  let first: ReturnType<typeof host> | undefined;
  let reopened: ReturnType<typeof host> | undefined;
  try {
    first = host(root, () => {
      calls += 1;
    });
    const session = await first.pair(scopeA);
    const response = await first.request(session, "turn-one");
    if (!response.ok) throw new Error(`Host model request failed: ${await response.text()}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string };
    expect(calls).toBe(1);
    await first.close();
    first = undefined;

    reopened = host(root, () => {
      calls += 1;
    });
    const recovered = await reopened.pair(scopeA);
    const status = await reopened.inspect(recovered);
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("no-store");
    const metadata = (await status.json()) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      turn_id: "turn-one",
      state: "model-completed",
      cancellation: null,
      last_completed_response_id: body.id,
      replay_allowed: false,
      scope: "bridge-model-only",
    });
    expect(JSON.stringify(metadata)).not.toContain("private prompt");
    expect(JSON.stringify(metadata)).not.toContain("private response");
    expect(JSON.stringify(metadata)).not.toContain(session.token);
    expect((await reopened.request(recovered, "turn-one")).status).toBe(409);
    expect(calls).toBe(1);
    expect((await reopened.request(recovered, "turn-two")).status).toBe(200);
    expect(calls).toBe(2);

    const other = await reopened.pair(scopeB);
    expect((await reopened.request(other, "turn-one")).status).toBe(200);
    expect(calls).toBe(3);
    expect((await reopened.inspect(other)).status).toBe(200);
    const files = readdirSync(join(root, "journal"), { recursive: true }).map(String);
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const contents = readFileSync(join(root, "journal", file), "utf8");
      expect(contents).not.toContain("private prompt");
      expect(contents).not.toContain("private response");
      expect(contents).not.toContain(session.token);
    }
  } finally {
    await first?.close();
    await reopened?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("orphan completion and cancellation receipts block another model execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-recovery-orphan-"));
  let calls = 0;
  let first: ReturnType<typeof host> | undefined;
  let reopened: ReturnType<typeof host> | undefined;
  try {
    first = host(root, () => {
      calls += 1;
    });
    const session = await first.pair(scopeA);
    expect((await first.request(session, "orphan-turn")).status).toBe(200);
    await first.cancel(session, "orphan-turn");
    await first.close();
    first = undefined;
    const scopeDirectory = join(root, "journal", scopeA);
    const [claim] = readdirSync(scopeDirectory).filter((name) => name.endsWith(".claim.json"));
    unlinkSync(join(scopeDirectory, claim!));

    reopened = host(root, () => {
      calls += 1;
    });
    const recovered = await reopened.pair(scopeA);
    expect((await reopened.inspect(recovered)).status).toBe(500);
    expect((await reopened.request(recovered, "orphan-turn")).status).toBe(409);
    expect(calls).toBe(1);
  } finally {
    await first?.close();
    await reopened?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery inspection chooses admission order when two turns share a clock tick", () => {
  const root = mkdtempSync(join(tmpdir(), "host-recovery-order-"));
  const now = Date.now;
  try {
    Date.now = () => 1000;
    const store = new HostRecoveryStore(join(root, "journal"));
    store.admitTurn(scopeA, "z-turn", "f".repeat(64));
    store.admitTurn(scopeA, "a-turn", "f".repeat(64));
    expect(store.inspectLatest(scopeA).turn_id).toBe("a-turn");
  } finally {
    Date.now = now;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a crashed unpublished admission leaves an ignorable temporary file", () => {
  const root = mkdtempSync(join(tmpdir(), "host-recovery-unpublished-"));
  try {
    const store = new HostRecoveryStore(join(root, "journal"));
    store.admitTurn(scopeA, "first-turn", "f".repeat(64));
    const scopeDirectory = join(root, "journal", scopeA);
    writeFileSync(join(scopeDirectory, ".0000000000000002.claim.json.crashed.tmp"), "{");
    store.admitTurn(scopeA, "second-turn", "f".repeat(64));
    expect(store.inspectLatest(scopeA).turn_id).toBe("second-turn");
    expect(readdirSync(scopeDirectory).filter((name) => name.endsWith(".claim.json"))).toHaveLength(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two host capabilities racing for one scope and turn admit one model execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-recovery-race-"));
  let calls = 0;
  const first = host(root, () => {
    calls += 1;
  });
  const second = host(root, () => {
    calls += 1;
  });
  try {
    const [a, b] = await Promise.all([first.pair(scopeA), second.pair(scopeA)]);
    const responses = await Promise.all([first.request(a, "shared-turn"), second.request(b, "shared-turn")]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    await Promise.all(responses.map((response) => response.text()));
    expect(calls).toBe(1);
    expect((await first.inspect(a)).status).toBe(200);
    expect(readdirSync(join(root, "journal", scopeA)).filter((name) => name.endsWith(".claim.json"))).toHaveLength(1);
    expect(readdirSync(join(root, "journal", scopeA)).filter((name) => name.endsWith(".order.json"))).toHaveLength(0);
  } finally {
    await first.close();
    await second.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery metadata requires its capability and corrupt admission cannot authorize replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-recovery-corrupt-"));
  let calls = 0;
  const running = host(root, () => {
    calls += 1;
  });
  try {
    const a = await running.pair(scopeA);
    const b = await running.pair(scopeB);
    expect((await running.request(a, "turn-one")).status).toBe(200);
    const foreign = await fetch(`${running.origin}/host/v1/sessions/${a.session_id}/recovery`, {
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(foreign.status).toBe(401);
    const browser = await fetch(`${running.origin}/host/v1/sessions/${a.session_id}/recovery`, {
      headers: { authorization: `Bearer ${a.token}`, origin: "https://example.invalid" },
    });
    expect(browser.status).toBe(403);
    const scopeDirectory = join(root, "journal", scopeA);
    const [claim] = readdirSync(scopeDirectory).filter((name) => name.endsWith(".claim.json"));
    writeFileSync(join(scopeDirectory, claim!), "{");
    expect((await running.inspect(a)).status).toBe(500);
    expect((await running.request(a, "turn-one", 2)).status).toBe(500);
    expect(calls).toBe(1);
  } finally {
    await running.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("SIGKILL during model delivery leaves an admitted turn visible and blocked after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-recovery-kill-"));
  const { child, exited, origin } = await startHostChild(root, "held");
  let restarted: ReturnType<typeof host> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const session = await pairChild(origin);
    const pending = await requestChild(origin, session, "interrupted-turn", true);
    expect(pending.status).toBe(200);
    reader = pending.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    child.kill("SIGKILL");
    await exited;

    let calls = 0;
    restarted = host(root, () => {
      calls += 1;
    });
    const recovered = await restarted.pair(scopeA);
    expect(await (await restarted.inspect(recovered)).json()).toMatchObject({
      turn_id: "interrupted-turn",
      state: "admitted",
      last_completed_response_id: null,
      replay_allowed: false,
    });
    expect((await restarted.request(recovered, "interrupted-turn")).status).toBe(409);
    expect(calls).toBe(0);
    expect((await restarted.request(recovered, "new-turn")).status).toBe(200);
    expect(calls).toBe(1);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited;
    await reader?.cancel().catch(() => {});
    await restarted?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("SIGKILL after model completion retains completion metadata without claiming Pi delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-recovery-complete-"));
  const { child, exited, origin } = await startHostChild(root, "complete");
  let restarted: ReturnType<typeof host> | undefined;
  try {
    const session = await pairChild(origin);
    const response = await requestChild(origin, session, "completed-turn", false);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string };
    child.kill("SIGKILL");
    await exited;

    restarted = host(root, () => {});
    const recovered = await restarted.pair(scopeA);
    expect(await (await restarted.inspect(recovered)).json()).toMatchObject({
      turn_id: "completed-turn",
      state: "model-completed",
      cancellation: null,
      last_completed_sequence: 1,
      last_completed_response_id: body.id,
      replay_allowed: false,
    });
    expect((await restarted.request(recovered, "completed-turn")).status).toBe(409);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited;
    await restarted?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a cancelled host turn keeps its cancellation milestone after re-pairing", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-recovery-cancel-"));
  let first: ReturnType<typeof host> | undefined;
  let reopened: ReturnType<typeof host> | undefined;
  try {
    first = host(root, () => {});
    const session = await first.pair(scopeA);
    const response = await first.request(session, "cancelled-turn");
    expect(response.status).toBe(200);
    await response.text();
    const cancellation = await first.cancel(session, "cancelled-turn");
    expect(cancellation.status).toBe(200);
    await first.close();
    first = undefined;

    reopened = host(root, () => {});
    const recovered = await reopened.pair(scopeA);
    const metadata = (await (await reopened.inspect(recovered)).json()) as Record<string, unknown>;
    expect(metadata.state).toBe("cancelled");
    expect(["requested", "settled"]).toContain(metadata.cancellation as string);
    expect(metadata.last_completed_sequence).toBe(1);
    expect(metadata.replay_allowed).toBe(false);
  } finally {
    await first?.close();
    await reopened?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
