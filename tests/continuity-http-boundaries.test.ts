import { expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { defaultConfig } from "../src/config";
import { responseRequest } from "../src/server/response-route";
import type { AdapterEvent } from "../src/types";

function request(signal?: AbortSignal): Request {
  return new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    signal,
    body: JSON.stringify({
      model: "chatgpt-web/high",
      stream: false,
      input: [
        {
          role: "user",
          content: "Preserve this task",
          internal_chat_message_metadata_passthrough: { turn_id: "turn-http" },
        },
      ],
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-http", turn_id: "turn-http" }) },
    }),
  });
}

test("the HTTP boundary preserves typed errors when a provider throws instead of emitting", async () => {
  const events: AdapterEvent[] = [];
  const response = await responseRequest(
    request(),
    defaultConfig("full"),
    () => ({
      name: "external-provider-fixture",
      async runTurn() {
        throw new ChatGptWebAdapterError("Requested effort control changed", {
          status: 409,
          errorType: "invalid_request_error",
          code: "model_selection_changed",
          retryable: false,
          cause: Object.assign(new Error("private task content"), { code: "ECONNRESET" }),
        });
      },
    }),
    { onAdapterEvent: (event) => events.push(event) },
  );
  expect(events.at(-1)).toMatchObject({
    type: "error",
    code: "model_selection_changed",
    status: 409,
    errorType: "invalid_request_error",
    retryable: false,
  });
  expect((await response.json()).error.code).toBe("model_selection_changed");
});

test("one hundred HTTP settlements detach the request listener they own", async () => {
  for (let cycle = 0; cycle < 100; cycle += 1) {
    const incoming = request();
    const baseline = getEventListeners(incoming.signal, "abort").length;
    await responseRequest(incoming, defaultConfig("full"), () => ({
      name: "external-provider-fixture",
      async runTurn(_parsed, _meta, emit) {
        emit({ type: "text_delta", text: "Completed fixture response" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
      },
    }));
    expect(getEventListeners(incoming.signal, "abort").length).toBe(baseline);
  }
});
