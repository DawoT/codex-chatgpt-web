import { expect, test } from "bun:test";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { observeMcpToolCalls } from "../src/adapters/chatgpt-web/mcp-observation";

test("ambiguous IDs remain uncorrelated until all replies settle and then release capacity", async () => {
  const events: Array<Record<string, unknown>> = [];
  const transport: Transport = {
    start: async () => {},
    close: async () => {},
    send: async () => {},
  };
  observeMcpToolCalls(transport, new Set(["codex_exec"]), event => events.push(event));
  const receive = (id: number) => transport.onmessage?.({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "codex_exec" },
  });
  const reply = (id: number) => transport.send({ jsonrpc: "2.0", id, result: {} });

  for (let id = 0; id < 1024; id++) {
    receive(id);
    receive(id);
  }
  await reply(0);
  receive(0);
  expect(events.at(-1)).toMatchObject({ event: "uncorrelated_call", reason: "duplicate_id" });
  await reply(0);
  await reply(0);
  for (let id = 1; id < 1024; id++) {
    await reply(id);
    await reply(id);
  }
  expect(events.filter(event => event.event === "reply_sent")).toHaveLength(0);
  receive(2000);
  expect(events.at(-1)).toMatchObject({ event: "call_received", tool: "codex_exec" });
  await reply(2000);
  expect(events.at(-1)).toMatchObject({ event: "reply_sent", tool: "codex_exec" });
});

test("a duplicate arriving while send is pending invalidates its correlation", async () => {
  const events: Array<Record<string, unknown>> = [];
  let finishSend: () => void = () => {};
  const transport: Transport = {
    start: async () => {},
    close: async () => {},
    send: () => new Promise<void>(resolve => {
      finishSend = resolve;
    }),
  };
  observeMcpToolCalls(transport, new Set(["codex_exec"]), event => events.push(event));
  const request = {
    jsonrpc: "2.0" as const,
    id: 1,
    method: "tools/call",
    params: { name: "codex_exec" },
  };
  transport.onmessage?.(request);
  const pending = transport.send({ jsonrpc: "2.0", id: 1, result: {} });
  transport.onmessage?.(request);
  finishSend();
  await pending;
  expect(events.filter(event => event.event === "reply_sent")).toHaveLength(0);
});

test("failed ambiguous replies release tracking without reporting a correlated failure", async () => {
  const events: Array<Record<string, unknown>> = [];
  const failure = new Error("transport failed");
  const transport: Transport = {
    start: async () => {},
    close: async () => {},
    send: async () => {
      throw failure;
    },
  };
  observeMcpToolCalls(transport, new Set(["codex_exec"]), event => events.push(event));
  const request = {
    jsonrpc: "2.0" as const,
    id: 1,
    method: "tools/call",
    params: { name: "codex_exec" },
  };
  transport.onmessage?.(request);
  transport.onmessage?.(request);
  for (let reply = 0; reply < 2; reply++) {
    await expect(transport.send({ jsonrpc: "2.0", id: 1, result: {} })).rejects.toBe(failure);
  }
  expect(events.filter(event => event.event === "reply_send_failed")).toHaveLength(0);
  transport.onmessage?.(request);
  expect(events.at(-1)).toMatchObject({ event: "call_received", call: 2 });
});
