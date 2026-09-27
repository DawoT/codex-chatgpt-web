import { toolArgumentsDigest, digest, HostProtocolError, type HostSession, type HostTurn } from "./host-state";

const BODY_KEYS = new Set([
  "model", "input", "instructions", "tools", "tool_choice", "parallel_tool_calls",
  "reasoning", "text", "stream", "store", "max_output_tokens", "previous_response_id",
  "include", "truncation", "temperature", "top_p",
]);

export async function readHostBody(request: Request, signal = request.signal): Promise<Record<string, unknown>> {
  if (request.headers.has("content-encoding") && request.headers.get("content-encoding") !== "identity") {
    throw new HostProtocolError(415, "Host requests require uncompressed JSON");
  }
  signal.throwIfAborted();
  const reader = request.body?.getReader();
  if (!reader) throw new HostProtocolError(400, "Host request requires JSON");
  const onAbort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, 15_000);
  timer.unref();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 4 * 1024 * 1024) {
        await reader.cancel();
        throw new HostProtocolError(413, "Host request exceeds 4 MiB");
      }
      chunks.push(next.value);
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  signal.throwIfAborted();
  if (timedOut) throw new HostProtocolError(408, "Host body read deadline exceeded");
  try {
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
    return result as Record<string, unknown>;
  } catch {
    throw new HostProtocolError(400, "Host request must be a JSON object");
  }
}

export function prepareHostRequest(session: HostSession, turnId: string, body: Record<string, unknown>): {
  body: Record<string, unknown>;
  turn: HostTurn;
  accept: () => void;
} {
  if (Object.keys(body).some(key => !BODY_KEYS.has(key))) throw new HostProtocolError(400, "Unsupported host request field or identity override");
  const tools = body.tools ?? [];
  if (!Array.isArray(tools) || tools.length > 256) throw new HostProtocolError(400, "Invalid host tool catalog");
  const names = new Set<string>();
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || tool.type !== "function" || typeof tool.name !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(tool.name) || names.has(tool.name)) {
      throw new HostProtocolError(400, "Host tools must be unique named functions");
    }
    names.add(tool.name);
  }
  const catalog = digest(tools);
  const existing = session.turns.get(turnId);
  if (existing?.cancelled) throw new HostProtocolError(409, "Host turn was cancelled; use a new turn ID");
  if (existing?.active) throw new HostProtocolError(409, "Host turn already has an active response");
  if (existing && existing.catalog !== catalog) throw new HostProtocolError(409, "Host tool catalog cannot change within a turn");
  if (!existing && session.turns.size >= 256) throw new HostProtocolError(429, "Host turn capacity reached; start a new session");
  const turn = existing ?? { id: turnId, catalog, names, active: false, cancelled: false };
  const rawInput = typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input ?? [];
  if (Array.isArray(rawInput) && rawInput.length > 10000) throw new HostProtocolError(413, "Host input item capacity exceeded");
  if (!Array.isArray(rawInput)) throw new HostProtocolError(400, "Host input must be an array or string");
  let prefix: unknown[] = [];
  if (body.previous_response_id !== undefined) {
    const previous = typeof body.previous_response_id === "string" ? session.responses.get(body.previous_response_id) : undefined;
    if (!previous) throw new HostProtocolError(409, "Host continuation is unavailable in this session");
    prefix = previous.input;
  }
  const lastUser = rawInput.findLastIndex(item => item && typeof item === "object" && item.role === "user");
  const historicalCalls = new Map<string, Record<string, unknown>>();
  const historicalResults = new Set<string>();
  for (const item of rawInput.slice(0, Math.max(0, lastUser))) {
    if (item?.type === "function_call") {
      if (typeof item.call_id !== "string" || typeof item.name !== "string" || typeof item.arguments !== "string" || historicalCalls.has(item.call_id)) throw new HostProtocolError(409, "Invalid historical host tool call");
      historicalCalls.set(item.call_id, item);
    } else if (item?.type === "function_call_output") {
      if (!historicalCalls.has(item.call_id) || historicalResults.has(item.call_id)) throw new HostProtocolError(409, "Unpaired historical host tool result");
      historicalResults.add(item.call_id);
    }
  }
  const seen = new Set(prefix.flatMap(item => {
    const row = item as Record<string, unknown> | null;
    return row?.type === "function_call_output" && typeof row.call_id === "string" ? [row.call_id] : [];
  }));
  const accepted: Array<[string, string]> = [];
  for (const [index, item] of rawInput.entries()) {
    if (!item || typeof item !== "object") throw new HostProtocolError(400, "Invalid host input item");
    const row = item as Record<string, unknown>;
    if (row.namespace !== undefined) throw new HostProtocolError(400, "Host tools do not use namespaces");
    if (row.type === "function_call_output") {
      const id = typeof row.call_id === "string" ? row.call_id : "";
      const call = session.calls.get(id);
      if (index < lastUser && !call && historicalResults.has(id)) continue;
      if (!call || seen.has(id)) throw new HostProtocolError(409, "Unknown or duplicate host tool result");
      seen.add(id);
      if (typeof row.output !== "string" && !Array.isArray(row.output)) throw new HostProtocolError(400, "Host tool result requires output");
      const hash = digest(row.output);
      if (call.result !== undefined && call.result !== hash) throw new HostProtocolError(409, "Host tool result replay changed content");
      const cancelledHistory = index < lastUser && historicalResults.has(id)
        && call.turnId !== turnId && session.turns.get(call.turnId)?.cancelled;
      if (call.result === undefined && !cancelledHistory && (call.turnId !== turnId || index < lastUser)) {
        throw new HostProtocolError(409, "Host tool result belongs to another turn");
      }
      accepted.push([id, hash]);
    } else if (row.type === "function_call") {
      const call = typeof row.call_id === "string" ? session.calls.get(row.call_id) : undefined;
      if (index < lastUser && !call && typeof row.call_id === "string" && historicalResults.has(row.call_id)) continue;
      if (!call || row.name !== call.name || typeof row.arguments !== "string" || toolArgumentsDigest(row.arguments) !== call.arguments) throw new HostProtocolError(409, "Host tool call replay does not match emitted evidence");
    } else if (row.type !== undefined && row.type !== "message" && row.type !== "reasoning") {
      throw new HostProtocolError(400, "Unsupported host input item type");
    }
  }
  const expanded: Record<string, unknown> = { ...body, input: [...prefix, ...rawInput] };
  delete expanded.previous_response_id;
  return {
    body: expanded,
    turn,
    accept() {
      for (const [id, hash] of accepted) session.calls.get(id)!.result = hash;
      session.turns.set(turnId, turn);
      turn.active = true;
    },
  };
}
