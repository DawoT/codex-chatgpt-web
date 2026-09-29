import { createConnection, type Socket } from "node:net";
import { errorOf, MAX_BROKER_LINE_CHARS, opaqueId } from "./helpers";
import type { BrokerRequest, BrokerResponse } from "./types";

/**
 * A turn registered without a TTL has no deadline to bound its tool calls against, so a null
 * timeout waits for as long as the turn itself lives. Undefined keeps the bounded default, because
 * a caller that cannot compute a deadline must not silently inherit an unbounded wait. An
 * unbounded call still ends when the turn is revoked or the broker drops the connection.
 */
export class TurnBrokerTimeoutError extends Error {
  constructor() {
    super("ChatGPT web turn broker timed out");
    this.name = "TurnBrokerTimeoutError";
  }
}

export const activeBrokerClientSockets = new Set<Socket>();

export async function callTurnBroker<T>(
  socketPath: string,
  request: Omit<BrokerRequest, "id">,
  timeoutMs: number | null = 5_000,
  signal?: AbortSignal,
): Promise<T> {
  const id = opaqueId("request");
  const settleOnResponseFrame = timeoutMs === null;
  // The wire protocol requires a client-owned activity identity. Most callers never need to see
  // it; the MCP server supplies its own so it can retire an ambiguously delivered claim, while
  // lower-level diagnostics receive an equally client-generated identity here.
  const wireRequest =
    request.method === "claim" && request.activityId === undefined
      ? { ...request, activityId: opaqueId("activity") }
      : request;
  return new Promise<T>((resolveCall, rejectCall) => {
    const socket = createConnection(socketPath);
    activeBrokerClientSockets.add(socket);
    let buffered = "";
    let settled = false;
    let response: BrokerResponse | undefined;
    const onAbort = () => finishError(new DOMException("ChatGPT web turn broker call aborted", "AbortError"));
    const cleanup = () => {
      activeBrokerClientSockets.delete(socket);
      signal?.removeEventListener("abort", onAbort);
    };
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      socket.destroy();
      rejectCall(error);
    };
    const finishResponse = () => {
      if (settled) return;
      if (!response) {
        finishError(new Error("ChatGPT web turn broker closed the connection"));
        return;
      }
      settled = true;
      clearTimeout(timer);
      cleanup();
      if (response.error) rejectCall(new Error(response.error));
      else resolveCall(response.result as T);
    };
    const timer =
      timeoutMs === null ? undefined : setTimeout(() => finishError(new TurnBrokerTimeoutError()), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      finishError(new DOMException("ChatGPT web turn broker call aborted", "AbortError"));
      return;
    }
    socket.setEncoding("utf8");
    socket.once("error", (error) => finishError(new Error(`ChatGPT web turn broker unavailable: ${error.message}`)));
    // The server owns response termination. Waiting for the pipe/socket to close before resolving
    // prevents callers from retiring the broker while Bun still has a named-pipe write in flight.
    socket.once("close", finishResponse);
    socket.once("connect", () => socket.write(`${JSON.stringify({ id, ...wireRequest })}\n`));
    socket.on("data", (chunk) => {
      if (settled || response) return;
      buffered += chunk;
      if (buffered.length > MAX_BROKER_LINE_CHARS) {
        finishError(new Error("ChatGPT web turn broker response exceeds size limit"));
        return;
      }
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      let parsed: BrokerResponse;
      try {
        parsed = JSON.parse(buffered.slice(0, newline)) as BrokerResponse;
      } catch (error) {
        finishError(new Error(`ChatGPT web turn broker returned invalid JSON: ${errorOf(error).message}`));
        return;
      }
      if (parsed.id !== id) {
        finishError(new Error("ChatGPT web turn broker response id mismatch"));
        return;
      }
      response = parsed;
      if (settleOnResponseFrame) {
        // A long-poll keeps its request half open while the server waits. Its complete response
        // frame is therefore the terminal boundary; ordinary calls still wait for physical close.
        finishResponse();
        socket.destroy();
      }
    });
  });
}
