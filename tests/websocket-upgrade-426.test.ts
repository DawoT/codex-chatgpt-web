/**
 * Sprint AI-Fix: WebSocket upgrade 426 — structured JSON error body
 *
 * Root cause: when Codex CLI tries to use ws://127.0.0.1:17841/v1/responses,
 * the server returns 426 with a plain-text body. The Codex CLI app-server logs
 * "failed to connect to websocket: HTTP error: 426 Upgrade Required" but shows
 * a confusing downstream error ("model is not supported...") because the 426 body
 * is unstructured text — the CLI cannot parse it as an OpenAI error envelope.
 *
 * Fix: the 426 response body becomes a JSON OpenAI-compatible error envelope so
 * the CLI can surface the actionable message "Responses WebSocket transport is not
 * enabled; use SSE (POST /v1/responses with stream: true)".
 *
 * Additionally, the Upgrade response header must advertise "websocket" (RFC 7230
 * §6.7), not "HTTP/1.1", to correctly tell HTTP clients which protocol to use.
 *
 * Seam: GET /v1/responses — tested via startServer HTTP integration.
 */
import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { startServer } from "../src/server";

// ---------------------------------------------------------------------------
// Slice 1: 426 body is a valid OpenAI-style JSON error envelope
// ---------------------------------------------------------------------------

test("GET /v1/responses 426 body is a parseable OpenAI-style JSON error envelope", async () => {
  const config = defaultConfig("browser-only");
  config.port = 17875;
  config.host = "127.0.0.1";
  const server = startServer(config);

  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/v1/responses`, {
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });

    expect(res.status).toBe(426);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);

    const body = (await res.json()) as {
      error: { type: string; code: string; message: string };
    };
    expect(body.error).toBeDefined();
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("websocket_not_supported");
    expect(body.error.message).toContain("SSE");
  } finally {
    server.stop(true);
  }
});

// ---------------------------------------------------------------------------
// Slice 2: 426 response Upgrade header says "websocket" (RFC 7230 §6.7)
// ---------------------------------------------------------------------------

test("GET /v1/responses 426 has Upgrade: websocket header (RFC 7230)", async () => {
  const config = defaultConfig("browser-only");
  config.port = 17874;
  config.host = "127.0.0.1";
  const server = startServer(config);

  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/v1/responses`, {
      method: "GET",
      headers: { Connection: "Upgrade", Upgrade: "websocket" },
    });

    expect(res.status).toBe(426);
    // RFC 7230: Upgrade header lists protocol the server requires/prefers
    // "websocket" tells the client exactly what it needs (even though we don't support it,
    // this is the correct RFC signal; we then explain via body/headers that SSE is the path)
    expect(res.headers.get("upgrade")).toBe("websocket");
  } finally {
    server.stop(true);
  }
});

// ---------------------------------------------------------------------------
// Slice 3: x-responses-transport header retained for diagnostic compatibility
// ---------------------------------------------------------------------------

test("GET /v1/responses 426 retains x-responses-transport: sse-required diagnostic header", async () => {
  const config = defaultConfig("browser-only");
  config.port = 17873;
  config.host = "127.0.0.1";
  const server = startServer(config);

  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/v1/responses`, {
      method: "GET",
    });

    expect(res.status).toBe(426);
    expect(res.headers.get("x-responses-transport")).toBe("sse-required");
  } finally {
    server.stop(true);
  }
});

// ---------------------------------------------------------------------------
// Slice 4: error message in JSON body is actionable — mentions POST and stream
// ---------------------------------------------------------------------------

test("GET /v1/responses 426 JSON error message guides user to correct transport", async () => {
  const config = defaultConfig("browser-only");
  config.port = 17872;
  config.host = "127.0.0.1";
  const server = startServer(config);

  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/v1/responses`, {
      method: "GET",
    });

    expect(res.status).toBe(426);
    const body = (await res.json()) as { error: { message: string } };
    const msg = body.error.message;
    // Message must contain actionable transport guidance
    expect(msg.toLowerCase()).toContain("websocket");
    expect(msg.toLowerCase()).toMatch(/sse|post/);
  } finally {
    server.stop(true);
  }
});
