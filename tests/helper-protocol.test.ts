import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  type HelperMessage,
  type InputMessage,
  parseHelperInputMessage,
  parseHelperMessage,
} from "../src/adapters/chatgpt-web/helper-protocol";

const root = resolve(import.meta.dir, "..");
const unsupportedFrame = '{"type":"unsupported_operation","id":"unsupported_id"}';

test.each(["null", "[]", "42", unsupportedFrame])(
  "real helper rejects the invalid frame %s and continues processing valid input",
  async (malformedFrame) => {
    const child = spawn(process.execPath, ["src/adapters/chatgpt-web/browser-helper-main.ts"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5_000,
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      child.once("close", (code, signal) => {
        resolveExit({ code, signal });
      });
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const output = lines[Symbol.asyncIterator]();
    let outputClosed = false;
    let diagnostics = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data: string) => {
      diagnostics += data;
    });
    async function nextFrame(): Promise<unknown> {
      const line = await output.next();
      outputClosed = line.done === true;
      return line.done ? { type: "unexpected_exit", diagnostics } : JSON.parse(line.value);
    }
    try {
      expect(await nextFrame()).toMatchObject({ type: "ready", protocolVersion: 2 });
      child.stdin.write(`${malformedFrame}\n`);
      const errorFrame = await nextFrame();
      expect(errorFrame).toMatchObject({
        type: "error",
        id: expect.any(String),
        message: expect.any(String),
      });
      if (malformedFrame === unsupportedFrame) {
        expect(errorFrame).toMatchObject({
          id: "unsupported_id",
          message: "Browser helper received an unsupported message type: unsupported_operation",
        });
      }

      // A valid acknowledgement reaches the production handler without launching a browser.
      child.stdin.write(`${JSON.stringify({ type: "send_activation_ack", id: "protocol_after_invalid" })}\n`);
      expect(await nextFrame()).toMatchObject({
        type: "error",
        id: "protocol_after_invalid",
        message: "Browser helper has no pending Send activation",
      });
      child.stdin.end(`${JSON.stringify({ type: "shutdown" })}\n`);
      expect(await exited).toEqual({ code: 0, signal: null });
    } finally {
      if (!outputClosed && child.exitCode === null && !child.stdin.destroyed) {
        child.stdin.end(`${JSON.stringify({ type: "shutdown" })}\n`);
      }
      await exited;
      lines.close();
    }
  },
  10_000,
);

const digestOfDone = "a4c3ed04a95a3da14a9d235c83d868bed7c0f45cf7f3faa751ee8f50598d2211";
const identity = {
  protocolVersion: 2,
  generation: "12345678-1234-1234-1234-123456789abc",
  pid: 123,
  buildCommit: null,
  artifactSha256: null,
};

const validOutputFrames: HelperMessage[] = [
  { type: "ready" },
  { type: "ready", features: [] },
  { type: "ready", protocolVersion: 2, features: ["progress"], identity },
  { type: "event", id: "turn", event: "heartbeat" },
  { type: "event", id: "turn", event: "send_activated" },
  { type: "event", id: "turn", event: "submitted" },
  { type: "event", id: "turn", event: "reasoning", text: "Thinking", continuation: false },
  { type: "event", id: "turn", event: "commentary", text: "Continuing", continuation: true },
  { type: "event", id: "turn", event: "text", text: "" },
  { type: "event", id: "turn", event: "prepared_selected", reused: false },
  { type: "event", id: "turn", event: "multipart_stage_acknowledged", stageIndex: 1 },
  { type: "event", id: "turn", event: "tool_batch_observed", requestId: 1, revision: 1 },
  { type: "event", id: "turn", event: "surface_ownership", phase: "leased", surfaceId: "a".repeat(32) },
  { type: "event", id: "turn", event: "surface_ownership", phase: "released", surfaceId: "a".repeat(32) },
  { type: "event", id: "turn", event: "completion_fence_begin", requestId: 1 },
  { type: "event", id: "turn", event: "completion_fence_commit", requestId: 1, revision: 0 },
  {
    type: "event",
    id: "turn",
    event: "luna_checkpoint",
    answerHash: "a".repeat(64),
    checkpoint: { version: 2, summary: "The first task is verified; finish the remaining change." },
  },
  { type: "result", id: "turn", text: "" },
  { type: "error", id: "turn", message: "cancelled", name: "AbortError" },
  {
    type: "error",
    id: "turn",
    message: "upstream unavailable",
    status: 503,
    errorType: "upstream_error",
    code: "unavailable",
    retryable: false,
  },
];

test.each(validOutputFrames.map((frame) => ({ frame })))(
  "output decoder preserves valid wire payload %j",
  ({ frame }) => {
    expect(parseHelperMessage(JSON.stringify(frame))).toEqual(frame);
  },
);

test("output decoder accepts an independently checked result persistence digest", () => {
  const frame: HelperMessage = {
    type: "event",
    id: "turn",
    event: "result_ready",
    text: "done",
    textSha256: digestOfDone,
  };
  expect(parseHelperMessage(JSON.stringify(frame))).toEqual(frame);
});

const invalidOutputFrames: unknown[] = [
  null,
  [],
  42,
  { type: "ready", features: "progress" },
  { type: "ready", features: [1] },
  { type: "ready", protocolVersion: 0 },
  { type: "ready", protocolVersion: 1.5 },
  { type: "ready", protocolVersion: 2, identity: null },
  { type: "ready", protocolVersion: 2, identity: { ...identity, protocolVersion: 1 } },
  { type: "ready", protocolVersion: 2, identity: { ...identity, pid: 0 } },
  { type: "ready", protocolVersion: 2, identity: { ...identity, generation: "invalid" } },
  { type: "ready", protocolVersion: 2, identity: { ...identity, buildCommit: "short" } },
  { type: "ready", protocolVersion: 2, identity: { ...identity, artifactSha256: "short" } },
  { type: "result", text: "no identity" },
  { type: "result", id: "", text: "empty identity" },
  { type: "result", id: "turn", text: 42 },
  { type: "result", id: "turn", value: { enabled: true } },
  { type: "unknown", id: "turn" },
  { type: "event", id: "turn", event: "unknown" },
  { type: "event", id: "turn", event: "text", text: 42 },
  { type: "event", id: "turn", event: "text", continuation: "true" },
  { type: "event", id: "turn", event: "prepared_selected", reused: "false" },
  { type: "event", id: "turn", event: "multipart_stage_acknowledged", stageIndex: 0 },
  { type: "event", id: "turn", event: "tool_batch_observed", requestId: 0, revision: 1 },
  { type: "event", id: "turn", event: "tool_batch_observed", requestId: 1, revision: 0 },
  { type: "event", id: "turn", event: "surface_ownership", phase: "other", surfaceId: "a".repeat(32) },
  { type: "event", id: "turn", event: "surface_ownership", phase: "leased", surfaceId: "short" },
  { type: "event", id: "turn", event: "result_ready", text: "changed", textSha256: digestOfDone },
  { type: "event", id: "turn", event: "result_ready", text: "done", textSha256: "malformed" },
  { type: "event", id: "turn", event: "completion_fence_begin", requestId: 1.5 },
  { type: "event", id: "turn", event: "completion_fence_commit", requestId: 1, revision: -1 },
  {
    type: "event",
    id: "turn",
    event: "luna_checkpoint",
    answerHash: "short",
    checkpoint: { version: 2, summary: "ok" },
  },
  { type: "event", id: "turn", event: "luna_checkpoint", answerHash: "a".repeat(64), checkpoint: { version: 3 } },
  { type: "error", id: "turn", message: 42 },
  { type: "error", id: "turn", message: "oops", name: 42 },
  { type: "error", id: "turn", message: "oops", status: 503 },
  { type: "error", id: "turn", message: "oops", status: 399, errorType: "upstream", code: "oops", retryable: false },
  { type: "error", id: "turn", message: "oops", status: 600, errorType: "upstream", code: "oops", retryable: false },
  { type: "error", id: "turn", message: "oops", status: 503, errorType: "", code: "oops", retryable: false },
  { type: "error", id: "turn", message: "oops", status: 503, errorType: "upstream", code: "", retryable: false },
  { type: "error", id: "turn", message: "oops", status: 503, errorType: "upstream", code: "oops", retryable: "false" },
];

test.each(invalidOutputFrames.map((frame) => ({ frame })))(
  "output decoder rejects malformed wire payload %j",
  ({ frame }) => {
    expect(() => parseHelperMessage(JSON.stringify(frame))).toThrow();
  },
);

test("output decoder rejects invalid JSON", () => {
  expect(() => parseHelperMessage("{unfinished")).toThrow();
});

test("output decoder reconstructs identity without forwarding unvalidated fields", () => {
  expect(
    parseHelperMessage(
      JSON.stringify({ type: "ready", protocolVersion: 2, identity: { ...identity, extra: "discard" } }),
    ),
  ).toEqual({ type: "ready", protocolVersion: 2, identity });
});

const validInputFrames: InputMessage[] = [
  { type: "shutdown" },
  { type: "release_context_pressure", conversationKey: "a".repeat(64) },
  { type: "send_activation_ack", id: "turn_ack" },
  { type: "abort", id: "turn_ack" },
  { type: "abort", id: "turn_ack", reason: "compaction_handoff_accepted" },
  { type: "surface_ownership_ack", id: "turn_ack", phase: "leased", surfaceId: "a".repeat(32), accepted: true },
  { type: "surface_ownership_ack", id: "turn_ack", phase: "released", surfaceId: "a".repeat(32), accepted: false },
  { type: "result_ready_ack", id: "turn_ack", textSha256: "a".repeat(64), accepted: false },
  { type: "tool_batch_observed_ack", id: "turn_ack", requestId: 1, revision: 1, accepted: false },
  { type: "completion_fence_begin_ack", id: "turn_ack", requestId: 1, revision: null },
  { type: "completion_fence_begin_ack", id: "turn_ack", requestId: 1, revision: 0 },
  { type: "completion_fence_commit_ack", id: "turn_ack", requestId: 1, committed: false },
  {
    type: "inspect",
    id: "maintenance_legacy_id",
    config: { appName: "Codex Native", browserHostDescriptorPath: "/workspace/launcher.json" },
    detectCapabilities: false,
  },
];

test.each(validInputFrames.map((frame) => ({ frame })))(
  "input decoder preserves valid control payload %j",
  ({ frame }) => {
    expect(parseHelperInputMessage(JSON.stringify(frame))).toEqual(frame);
  },
);

test.each([
  { type: "surface_ownership_ack", id: "turn_ack", phase: "leased", surfaceId: "a".repeat(32), accepted: "false" },
  { type: "surface_ownership_ack", id: "turn_ack", phase: "released", surfaceId: "a".repeat(32), accepted: 1 },
  { type: "result_ready_ack", id: "turn_ack", textSha256: "a".repeat(64), accepted: "false" },
  { type: "tool_batch_observed_ack", id: "turn_ack", requestId: 1, revision: 1, accepted: "false" },
  { type: "completion_fence_commit_ack", id: "turn_ack", requestId: 1, committed: "false" },
  { type: "completion_fence_commit_ack", id: "turn_ack", requestId: 1, committed: 1 },
])("input decoder rejects a non-boolean acknowledgement flag %j", (frame) => {
  expect(() => parseHelperInputMessage(JSON.stringify(frame))).toThrow();
});

test.each([
  { type: "send_activation_ack" },
  { type: "send_activation_ack", id: "" },
  { type: "send_activation_ack", id: 42 },
  { id: "turn_ack" },
  { type: 42, id: "turn_ack" },
  { type: "unsupported_operation", id: "unsupported_id" },
  { type: "surface_ownership_ack", id: "turn_ack", phase: "invalid", surfaceId: "a".repeat(32), accepted: true },
  { type: "surface_ownership_ack", id: "turn_ack", phase: "leased", surfaceId: "short", accepted: true },
  { type: "result_ready_ack", id: "turn_ack", textSha256: "short", accepted: true },
  { type: "tool_batch_observed_ack", id: "turn_ack", requestId: 0, revision: 1, accepted: true },
  { type: "tool_batch_observed_ack", id: "turn_ack", requestId: 1, revision: -1, accepted: true },
  { type: "completion_fence_begin_ack", id: "turn_ack", requestId: 0, revision: null },
  { type: "completion_fence_begin_ack", id: "turn_ack", requestId: 1, revision: "0" },
  { type: "completion_fence_commit_ack", id: "turn_ack", requestId: 1.5, committed: true },
])("input decoder rejects malformed control framing %j", (frame) => {
  expect(() => parseHelperInputMessage(JSON.stringify(frame))).toThrow();
});

test("context health crosses the helper boundary without resetting physical pressure", () => {
  const frame = {
    type: "event" as const,
    id: "health_turn",
    event: "context_health" as const,
    health: {
      observedDomChars: 320_000,
      estimatedTokens: 12_000,
      compactionRequired: false,
      recoveryRequired: false,
    },
  };
  expect(parseHelperMessage(JSON.stringify(frame))).toEqual(frame);
  expect(() =>
    parseHelperMessage(JSON.stringify({ ...frame, health: { ...frame.health, estimatedTokens: -1 } })),
  ).toThrow();
  expect(() =>
    parseHelperMessage(JSON.stringify({ ...frame, health: { ...frame.health, recoveryRequired: "false" } })),
  ).toThrow();
});
