import { expect, test } from "bun:test";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import * as protocol from "../src/adapters/chatgpt-web/helper-protocol";
import { DiagnosticSourceError, serializeDiagnosticError } from "../src/diagnostics/errors";

const api = protocol as any;

test("helper errors preserve source DAG with sanitized outer fields and unchanged structured contract", () => {
  expect(api.createHelperErrorMessage).toBeTypeOf("function");
  const source = new DiagnosticSourceError("model_slider_not_ready", {
    cause: Object.assign(new Error("Cookie secret"), { code: "ECONNRESET" }),
  });
  const error = new ChatGptWebAdapterError("private prompt", {
    status: 502,
    code: "upstream_server_error",
    errorType: "server_error",
    retryable: false,
    cause: source,
  });
  const frame = api.createHelperErrorMessage("operation", error);
  const parsed = protocol.parseHelperMessage(JSON.stringify(frame));
  expect(parsed).toMatchObject({
    type: "error",
    status: 502,
    code: "upstream_server_error",
    errorType: "server_error",
    retryable: false,
  });
  expect(JSON.stringify(parsed)).not.toMatch(/private prompt|Cookie secret/);
  const restored = api.helperMessageError(parsed);
  expect(restored).toBeInstanceOf(ChatGptWebAdapterError);
  expect(serializeDiagnosticError(restored)).toEqual(serializeDiagnosticError(error));
  expect(serializeDiagnosticError(restored.cause).nodes[0].code).toBe("model_slider_not_ready");
});

test("helper parser rejects dangling causes and sanitizes forged diagnostic messages", () => {
  const diagnostic = serializeDiagnosticError(new DiagnosticSourceError("model_step_failed"));
  diagnostic.nodes[0].message = "private prompt";
  const parsed = protocol.parseHelperMessage(
    JSON.stringify({ type: "error", id: "operation", message: "public", diagnostic }),
  ) as any;
  expect(parsed.diagnostic).toBeDefined();
  expect(JSON.stringify(parsed.diagnostic)).not.toContain("private prompt");
  diagnostic.nodes[0].causeErrorId = "00000000-0000-0000-0000-000000000000";
  expect(() =>
    protocol.parseHelperMessage(JSON.stringify({ type: "error", id: "operation", message: "public", diagnostic })),
  ).toThrow();
  expect(protocol.parseHelperMessage(JSON.stringify({ type: "error", id: "legacy", message: "legacy error" }))).toEqual(
    { type: "error", id: "legacy", message: "legacy error" },
  );
});

test("optional internal abort diagnostic survives protocol without reclassifying unknown abort", () => {
  const diagnostic = serializeDiagnosticError(new DiagnosticSourceError("stage_timeout"));
  const parsed = protocol.parseHelperInputMessage(
    JSON.stringify({ type: "abort", id: "operation", diagnostic }),
  ) as any;
  expect(parsed.diagnostic).toEqual(diagnostic);
  expect(() =>
    protocol.parseHelperInputMessage(JSON.stringify({ type: "abort", id: "operation", diagnostic: { version: 1 } })),
  ).toThrow();
});

test("real helper emits negotiated sanitized causes and keeps stdout free of browser log secrets", async () => {
  const { spawn } = await import("node:child_process");
  const { randomUUID } = await import("node:crypto");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createInterface } = await import("node:readline");
  const root = await mkdtemp(join(tmpdir(), "diagnostic-helper-ipc-"));
  const wrapper = join(root, "helper.ts");
  await writeFile(
    wrapper,
    `
import { ChatGptBrowserWorker } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href)};
import { DiagnosticSourceError } from ${JSON.stringify(new URL("../src/diagnostics/errors.ts", import.meta.url).href)};
import { ChatGptWebAdapterError } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/adapter-error.ts", import.meta.url).href)};
ChatGptBrowserWorker.forProvider = () => ({
  async run() {
    console.error("Cookie secret prompt");
    throw new ChatGptWebAdapterError("Cookie secret prompt", {
      status: 502,
      code: "upstream_server_error",
      errorType: "server_error",
      retryable: false,
      cause: new DiagnosticSourceError("model_slider_not_ready", { cause: new Error("Cookie secret prompt") }),
    });
  },
});
await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href)});
`,
  );
  const child = spawn(process.execPath, [wrapper], {
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 5000,
    env: { ...process.env, CODEX_CHATGPT_WEB_HOME: root },
  });
  const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  try {
    const ready = JSON.parse((await output.next()).value!);
    expect(ready.features).toContain("diagnostic-error-v1");
    expect(ready.features).toContain("typed-abort-reason-v1");
    child.stdin.write(
      `${JSON.stringify({ type: "run", id: randomUUID(), config: { appName: "Codex", browserHostDescriptorPath: "/tmp/unused", autoApproveToolCalls: false }, turn: { traceId: "trace-real-helper", modelId: "gpt-5.6-sol", capabilities: { solAvailable: true } } })}\n`,
    );
    const frame = protocol.parseHelperMessage((await output.next()).value!) as any;
    expect(frame.diagnostic.nodes.map((node: any) => node.code)).toEqual([
      "upstream_server_error",
      "model_slider_not_ready",
      "operation_failed",
    ]);
    expect(JSON.stringify(frame)).not.toContain("Cookie secret prompt");
    child.stdin.end(`${JSON.stringify({ type: "shutdown" })}\n`);
    await exited;
    expect(stderr).not.toContain("Cookie secret prompt");
    const { DiagnosticSink } = await import("../src/diagnostics/sink");
    const saved = await new DiagnosticSink<any>(join(root, "logs", "harness")).query();
    const failure = saved.find((event) => event.event === "helper_error");
    expect(failure?.error.errorId).toBe(frame.diagnostic.errorId);
    expect(failure?.error.nodes.map((node: any) => node.code)).toContain("model_slider_not_ready");
  } finally {
    child.stdin.end(`${JSON.stringify({ type: "shutdown" })}\n`);
    await exited;
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

test("helper runtime pairing fields are optional but validated and survive ready parsing", () => {
  const identity = {
    protocolVersion: 2,
    pid: process.pid,
    generation: "12345678-1234-1234-1234-123456789abc",
    buildCommit: null,
    artifactSha256: "a".repeat(64),
    artifactSetSha256: "b".repeat(64),
    artifactVerification: "paired_manifest_verified",
  };
  const frame = { type: "ready", protocolVersion: 2, identity };
  expect(protocol.parseHelperMessage(JSON.stringify(frame))).toMatchObject({
    identity: { artifactSetSha256: "b".repeat(64), artifactVerification: "paired_manifest_verified" },
  });
  expect(() =>
    protocol.parseHelperMessage(JSON.stringify({ ...frame, identity: { ...identity, artifactSetSha256: "secret" } })),
  ).toThrow();
  expect(() =>
    protocol.parseHelperMessage(
      JSON.stringify({ ...frame, identity: { ...identity, artifactVerification: "secret" } }),
    ),
  ).toThrow();
  expect(() =>
    protocol.parseHelperMessage(JSON.stringify({ ...frame, identity: { ...identity, artifactSetSha256: null } })),
  ).toThrow();
});
