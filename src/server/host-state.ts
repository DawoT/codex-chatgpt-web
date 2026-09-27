import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export class HostProtocolError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function canonical(value: unknown, depth = 0): string {
  if (depth > 64) throw new HostProtocolError(400, "Host JSON nesting exceeds 64 levels");
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function toolArgumentsDigest(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return digest(parsed);
  } catch {
    throw new HostProtocolError(400, "Host tool arguments must be a JSON object");
  }
}

export function authorized(request: Request, token: string): boolean {
  if (!token) return false;
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface HostTurn {
  id: string;
  catalog: string;
  names: Set<string>;
  active: boolean;
  cancelled: boolean;
  cancellation?: "requested" | "settled";
}

export interface HostCall {
  turnId: string;
  name: string;
  arguments: string;
  result?: string;
}

export interface HostSession {
  id: string;
  token: string;
  cwd: string;
  expires: number;
  sequence: number;
  admitting?: { turnId: string; abort: AbortController };
  turns: Map<string, HostTurn>;
  calls: Map<string, HostCall>;
  responses: Map<string, { input: unknown[]; bytes: number }>;
  bytes: number;
}

export class HostSessionStore {
  readonly sessions = new Map<string, HostSession>();
  constructor(readonly now = Date.now, readonly ttl = 60 * 60 * 1000, readonly maxSessions = 64) {}

  create(cwd: string): HostSession {
    if (this.sessions.size >= this.maxSessions) throw new HostProtocolError(429, "Host session capacity reached; close an existing session");
    const session: HostSession = {
      id: `pi_${randomBytes(24).toString("hex")}`,
      token: randomBytes(32).toString("base64url"),
      cwd,
      expires: this.now() + this.ttl,
      sequence: 0,
      turns: new Map(),
      calls: new Map(),
      responses: new Map(),
      bytes: 0,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  authenticate(request: Request, id: string): HostSession {
    const session = this.sessions.get(id);
    if (!session || session.expires <= this.now() || !authorized(request, session.token)) {
      throw new HostProtocolError(401, "Invalid or expired host session capability");
    }
    return session;
  }

  remember(session: HostSession, turn: HostTurn, input: unknown[], response: Record<string, unknown>): void {
    if (turn.cancelled || response.status !== "completed" || typeof response.id !== "string" || !Array.isArray(response.output)) return;
    const output = response.output as Array<Record<string, unknown>>;
    const items = [...input, ...output];
    const bytes = Buffer.byteLength(JSON.stringify(items));
    if (bytes > 4 * 1024 * 1024) throw new HostProtocolError(413, "Host continuation exceeds session capacity");
    const newCalls = output.filter(item => item.type === "function_call");
    if (session.calls.size + newCalls.length > 4096) throw new HostProtocolError(429, "Host tool call capacity reached; start a new session");
    const callIds = new Set<string>();
    if (session.responses.has(response.id)) throw new HostProtocolError(409, "Repeated host response identity");
    for (const call of newCalls) {
      if (typeof call.call_id !== "string" || call.call_id.length > 256 || typeof call.name !== "string" || !turn.names.has(call.name) || typeof call.arguments !== "string" || session.calls.has(call.call_id) || callIds.has(call.call_id)) {
        throw new HostProtocolError(409, "Invalid or repeated emitted host tool call");
      }
      toolArgumentsDigest(call.arguments);
      callIds.add(call.call_id);
    }
    for (const call of newCalls) {
      session.calls.set(call.call_id as string, { turnId: turn.id, name: call.name as string, arguments: toolArgumentsDigest(call.arguments as string) });
    }
    while (session.responses.size >= 16 || session.bytes + bytes > 4 * 1024 * 1024) {
      const key = session.responses.keys().next().value;
      if (!key) break;
      session.bytes -= session.responses.get(key)!.bytes;
      session.responses.delete(key);
    }
    session.responses.set(response.id, { input: items, bytes });
    session.bytes += bytes;
  }
}
