import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

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
