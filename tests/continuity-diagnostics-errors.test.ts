import { expect, test } from "bun:test";

const api = (await import("../src/diagnostics/errors").catch(() => ({}))) as any;

function serializer() {
  expect(api.serializeDiagnosticError).toBeTypeOf("function");
  return api.serializeDiagnosticError;
}

test("source IDs and shared causes survive round trip without copying arbitrary text", () => {
  const serialize = serializer();
  const shared = Object.assign(new Error("Bearer secret-cookie prompt body"), { code: "ECONNRESET" });
  const root = new AggregateError([shared, new Error("private", { cause: shared })], "private root", { cause: shared });
  const first = serialize(root);
  expect(first.version).toBe(1);
  expect(first.nodes).toHaveLength(3);
  const sharedId = first.nodes[0].causeErrorId;
  expect(first.nodes[0].aggregateErrorIds[0]).toBe(sharedId);
  expect(first.nodes.find((node: any) => node.errorId !== first.errorId && node.causeErrorId)).toMatchObject({
    causeErrorId: sharedId,
  });
  expect(serialize(root).errorId).toBe(first.errorId);
  expect(serialize(shared).errorId).toBe(sharedId);
  expect(JSON.stringify(first)).not.toMatch(/secret-cookie|private|Bearer|prompt body/);
  const restored = api.deserializeDiagnosticError(JSON.parse(JSON.stringify(first)));
  expect(restored.cause).toBe(restored.errors[0]);
  expect(serialize(restored)).toEqual(first);
});

test("cyclic, deep, aggregate and oversized errors remain a bounded cause DAG", () => {
  const serialize = serializer();
  const cyclic = new Error("private");
  cyclic.cause = cyclic;
  const cycle = serialize(cyclic);
  expect(cycle.nodes).toHaveLength(1);
  expect(cycle.nodes[0].causeErrorId).toBeUndefined();
  expect(cycle.truncated.cycle).toBe(true);
  let deep: Error = new Error("private");
  for (let index = 0; index < 30; index += 1) {
    deep = new Error("private", { cause: deep });
  }
  const depth = serialize(deep);
  expect(depth.nodes.length).toBeLessThanOrEqual(9);
  expect(depth.truncated.depth).toBe(true);
  const aggregate = serialize(new AggregateError(Array.from({ length: 40 }, () => new Error("private"))));
  expect(aggregate.nodes[0].aggregateErrorIds).toHaveLength(16);
  expect(aggregate.truncated.aggregate).toBe(true);
  const wide = serialize(
    new AggregateError(
      Array.from(
        { length: 16 },
        () => new AggregateError(Array.from({ length: 16 }, () => new Error("x".repeat(100_000)))),
      ),
    ),
  );
  expect(Buffer.byteLength(JSON.stringify(wide))).toBeLessThanOrEqual(16 * 1024);
  expect(wide.truncated.bytes).toBe(true);
});

test("hostile getters and forged diagnostics cannot leak or break serialization", () => {
  const serialize = serializer();
  const hostile = Object.defineProperty({}, "cause", {
    get() {
      throw new Error("secret");
    },
  });
  expect(() => serialize(hostile)).not.toThrow();
  const safe = serialize(new Error("private"));
  safe.nodes[0].message = "private";
  safe.nodes[0].name = "private";
  safe.nodes[0].code = "sk-secret";
  safe.nodes[0].stack = "private";
  const parsed = api.parseDiagnosticError(safe);
  expect(JSON.stringify(parsed)).not.toMatch(/private|sk-secret|stack/);
  const malformed = { ...safe, nodes: [{ ...safe.nodes[0], causeErrorId: safe.errorId }] };
  expect(() => api.parseDiagnosticError(malformed)).toThrow();
});

test("typed source reasons remain distinct from unknown aborts", async () => {
  serializer();
  const { classifyTurnTermination } = await import("../src/adapters/chatgpt-web/turn-terminal");
  expect(classifyTurnTermination(new DOMException("unknown", "AbortError"))).toBe("internal_failure");
  expect(classifyTurnTermination(new DOMException("unknown", "AbortError"), AbortSignal.abort())).toBe(
    "internal_failure",
  );
  expect(classifyTurnTermination(new api.DiagnosticSourceError("user_cancelled"))).toBe("user_cancelled");
  expect(classifyTurnTermination(new api.DiagnosticSourceError("transport_closed"))).toBe("transport");
  expect(classifyTurnTermination(new api.DiagnosticSourceError("stage_timeout"))).toBe("deadline");
});

test("native I/O facts survive without carrying the private pathname or message", () => {
  const error = Object.assign(new Error("Failed to write /home/private/task-secret"), {
    code: "ENOSPC",
    syscall: "write",
    path: "/home/private/task-secret",
  });
  const diagnostic = api.serializeDiagnosticError(error);
  expect(diagnostic.nodes[0]).toMatchObject({ nativeCode: "ENOSPC", syscall: "write" });
  expect(api.parseDiagnosticError(diagnostic).nodes[0]).toMatchObject({ nativeCode: "ENOSPC", syscall: "write" });
  expect(JSON.stringify(diagnostic)).not.toMatch(/private|task-secret/);
});

test("selection facts preserve numeric expectations and discard arbitrary diagnostic metadata", () => {
  const source = new api.DiagnosticSourceError("model_step_failed", {
    facts: { expectedValue: 3, observedValue: 2, min: 0, max: 4, effortIndex: 3, privatePath: "/private/task" },
  });
  const graph = api.serializeDiagnosticError(source);
  expect(graph.nodes[0].facts).toEqual({ expectedValue: 3, observedValue: 2, min: 0, max: 4, effortIndex: 3 });
  expect(api.serializeDiagnosticError(api.deserializeDiagnosticError(graph))).toEqual(graph);
  expect(JSON.stringify(graph)).not.toContain("private");
});

test("a shared cause DAG is parsed with bounded work instead of expanding every path", async () => {
  const script = `
    import { randomUUID } from "node:crypto";
    import { parseDiagnosticError } from ${JSON.stringify(new URL("../src/diagnostics/errors.ts", import.meta.url).href)};
    const nodes = Array.from({ length: 8 }, () => ({ errorId: randomUUID(), name: "AggregateError", code: "aggregate_failure" }));
    for (let index = 0; index < nodes.length - 1; index += 1) {
      nodes[index].aggregateErrorIds = Array.from({ length: 16 }, () => nodes[index + 1].errorId);
    }
    const graph = parseDiagnosticError({ version: 1, errorId: nodes[0].errorId, nodes });
    if (graph.nodes.length !== 8) process.exit(1);
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "ignore", stderr: "pipe" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await Promise.race([
      child.exited,
      new Promise<number>((resolve) => {
        timer = setTimeout(() => {
          child.kill();
          resolve(-1);
        }, 1500);
      }),
    ]);
    expect(exitCode).toBe(0);
  } finally {
    if (timer) clearTimeout(timer);
    child.kill();
    await child.exited;
  }
});

test.each([undefined, null, "private abort", 0, true])("primitive causes serialize to a valid graph (%s)", (value) => {
  const graph = api.serializeDiagnosticError(value);
  expect(graph.nodes[0].errorId).toBe(graph.errorId);
  expect(api.parseDiagnosticError(graph)).toEqual(graph);
  expect(JSON.stringify(graph)).not.toContain("private abort");
});

test("hostile error names cannot leak object fields or execute coercion", () => {
  const name = {
    privateValue: "private cookie",
    toString() {
      throw new Error("coercion executed");
    },
  };
  const graph = api.serializeDiagnosticError({ name });
  expect(graph.nodes[0].name).toBe("Error");
  expect(JSON.stringify(graph)).not.toContain("private cookie");
});

test("DOM observation deadlines retain their exact typed cause across the diagnostic boundary", async () => {
  const { ChatGptBrowserObservationTimeoutError } = await import(
    "../src/adapters/chatgpt-web/browser/suspension-clock"
  );
  const graph = api.serializeDiagnosticError(new ChatGptBrowserObservationTimeoutError(5250));
  expect(graph.nodes[0].code).toBe("browser_dom_observation_timeout");
});
