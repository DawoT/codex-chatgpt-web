import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { BrowserSession } from "../src/adapters/chatgpt-web/browser/browser-session";
import {
  ChatGptBrowserDiagnostics,
  sanitizeChatGptBrowserDiagnosticState,
} from "../src/adapters/chatgpt-web/browser/diagnostics";
import { ChatGptModelControls } from "../src/adapters/chatgpt-web/browser/model-controls";
import {
  createHelperErrorMessage,
  helperMessageError,
  parseHelperMessage,
} from "../src/adapters/chatgpt-web/helper-protocol";
import { classifyTurnTermination } from "../src/adapters/chatgpt-web/turn-terminal";
import { serializeDiagnosticError } from "../src/diagnostics/errors";

test("specific model surface mismatch remains diagnosable without raw DOM causes", async () => {
  const composer = { locator: () => composer, filter: () => composer, count: async () => 2 };
  const controls = new ChatGptModelControls({ activeComposer: async () => composer as any });
  const error = await controls
    .assertSelectedEffort(
      { url: () => "https://chatgpt.com" } as any,
      {
        modelId: "gpt-5.6-sol",
        displayLabel: "High",
        effort: "high",
        uiEffortIndex: 2,
        thinkEnabled: false,
        selection: { url: "https://chatgpt.com/c/private", label: "High" },
      } as any,
    )
    .catch((error) => error);
  expect(error.code).toBe("upstream_server_error");
  expect(serializeDiagnosticError(error.cause).nodes[0].code).toBe("model_surface_changed");
  expect(JSON.stringify(serializeDiagnosticError(error))).not.toContain("private");
});

test("stage timeout uses a typed abort reason and never logs arbitrary exception text", async () => {
  const lines: string[] = [];
  const logger = spyOn(console, "error").mockImplementation((line) => {
    lines.push(String(line));
  });
  const session = new BrowserSession({} as any);
  let reason: unknown;
  try {
    const failed = await session
      .runStage("trace-stage", "prompt_attachment", 3, async (signal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              reason = signal.reason;
              resolve();
            },
            { once: true },
          ),
        );
        throw new Error("private cookie prompt");
      })
      .catch((error) => error);
    expect(classifyTurnTermination(failed)).toBe("deadline");
    expect(classifyTurnTermination(reason)).toBe("deadline");
    await session
      .runStage("trace-stage", "model-selection", 20, async () => {
        throw new Error("private cookie prompt");
      })
      .catch(() => {});
    expect(lines.join("\n")).not.toContain("private cookie prompt");
  } finally {
    logger.mockRestore();
  }
});

test("page-scoped listeners rebind and detach without observing another page or context tracing", () => {
  const diagnostics = new ChatGptBrowserDiagnostics("trace-page", "/tmp/unused", "Codex");
  expect((diagnostics as any).bindPage).toBeTypeOf("function");
  const first = new EventEmitter();
  const second = new EventEmitter();
  const detachFirst = (diagnostics as any).bindPage(first as unknown as Page);
  first.emit("pageerror", new Error("private browser script"));
  const detachSecond = (diagnostics as any).bindPage(second as unknown as Page);
  expect(first.listenerCount("pageerror")).toBe(0);
  first.emit("pageerror", new Error("old page"));
  second.emit("response", {
    status: () => 502,
    url: () => {
      throw new Error("URL must not be read");
    },
  });
  detachFirst();
  expect(second.listenerCount("response")).toBe(1);
  second.emit("requestfailed", {
    failure: () => ({ errorText: "net::ERR_CONNECTION_RESET Cookie private" }),
    resourceType: () => "fetch",
    url: () => "https://chatgpt.com/backend-api/f/conversation",
  });
  const snapshot = (diagnostics as any).snapshot();
  expect(snapshot.events.map((event: any) => event.event)).toEqual([
    "page_error",
    "page_response",
    "page_request_failed",
  ]);
  expect(snapshot.events.every((event: any) => event.correlation.turnId === "trace-page")).toBe(true);
  expect(snapshot.events.at(-1)?.fields).toMatchObject({
    reason: "page_request_failed",
    requestClass: "conversation",
    resourceType: "fetch",
    transportFailure: "connection_reset",
  });
  expect(JSON.stringify(snapshot)).not.toMatch(/private|old page|Cookie/);
  detachSecond();
  expect(second.listenerCount("response")).toBe(0);
});

test.each([
  ["chatgpt_stream_interrupted", 502, "ChatGPT response stream remained interrupted"],
  ["session_reconciliation_required", 409, "Session requires reconciliation before another external effect"],
] as const)(
  "%s preserves its public contract through helper IPC and sanitized diagnostics",
  (code, status, message) => {
    const error = new ChatGptWebAdapterError("private upstream text", {
      status,
      errorType: "server_error",
      code,
      retryable: false,
    });
    const diagnostic = serializeDiagnosticError(error);

    expect(diagnostic.nodes[0]).toMatchObject({
      code,
      message,
      status,
      retryable: false,
    });
    expect(JSON.stringify(diagnostic)).not.toContain("private upstream text");
    const parsed = parseHelperMessage(JSON.stringify(createHelperErrorMessage("turn", error)));
    expect(parsed.type).toBe("error");
    if (parsed.type !== "error") throw new Error("Expected helper error frame");
    expect(helperMessageError(parsed)).toMatchObject({ code, status, retryable: false });
    expect(JSON.stringify(parsed)).not.toContain("private upstream text");
  },
);

test("capture exposes missing state/error evidence and writes only sanitized bounded structure", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-browser-diagnostics-"));
  const diagnostics = new ChatGptBrowserDiagnostics("trace-capture", root, "Codex");
  try {
    await diagnostics.capture(
      {
        evaluate: async () => {
          throw new Error("private cookie prompt");
        },
      } as unknown as Page,
      "turn-failed",
      new Error("private cookie prompt"),
    );
    const [directory] = await readdir(root);
    const [file] = await readdir(join(root, directory!));
    const encoded = await readFile(join(root, directory!, file!), "utf8");
    expect(encoded).not.toContain("private cookie prompt");
    const saved = JSON.parse(encoded);
    expect(saved.diagnostics.evidence).toMatchObject({
      stateCaptured: false,
      stateMissing: true,
      contentCapture: false,
    });
    expect(saved.error.version).toBe(1);
    expect(saved.captureErrors.state.version).toBe(1);
    expect((diagnostics as any).snapshot().evidence.stateMissing).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("state allowlist rejects secret strings, arbitrary keys and cyclic snapshots", () => {
  const state: any = {
    tag: "Cookie secret",
    role: "Bearer secret",
    ariaExpanded: "private",
    origin: "https://private.example",
    secret: 1,
    rect: { x: 1, y: 2, width: 30, height: 40 },
    textChars: 12,
  };
  state.composer = state;
  const safe = sanitizeChatGptBrowserDiagnosticState(state);
  expect(JSON.stringify(safe)).not.toMatch(/secret|private/);
  expect(safe).toMatchObject({ rect: { x: 1, y: 2, width: 30, height: 40 }, textChars: 12 });
});
