import { isAbsolute, join } from "node:path";
import { SlidingWindowRateLimiter } from "../adapters/chatgpt-web/rate-limiter";
import { ChatGptWebAdapterError } from "../adapters/chatgpt-web/adapter-error";
import { getConfigDir, type AppConfig } from "../config";
import { availableChatGptWebModelRoutes, resolveChatGptWebContextLimits } from "../chatgpt-web-models";
import { chatGptTurnSessions } from "../adapters/chatgpt-web/turn-execution";
import {
  isLongReasoningTurn,
  responseRequest,
  routeChatGptWebRequest,
  type ChatGptWebAdapterFactory,
} from "./response-route";
import { parseRequest } from "../responses/parser";
import { HttpTurnCounter } from "./http-turn-counter";
import { authorized, digest, HostProtocolError, HostSessionStore, type HostSession, type HostTurn } from "./host-state";
import { prepareHostRequest, readHostBody } from "./host-request";
import { assertFirstHostPromptWithinLimits } from "./host-prompt-preflight";
import { HostRecoveryStore } from "./host-recovery";
import { inspectHostTurn } from "./host-status";

/** Local capability boundary. Never executes tools; all tool execution belongs to the paired host. */
export class HostHttpRoutes {
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly rateLimiter: SlidingWindowRateLimiter;
  private readonly recovery: HostRecoveryStore;
  constructor(
    private readonly config: AppConfig,
    private readonly httpTurns: HttpTurnCounter,
    private readonly adapterFactory?: ChatGptWebAdapterFactory,
    readonly store = new HostSessionStore(),
    recoveryRoot = join(getConfigDir(), "host-recovery"),
  ) {
    this.recovery = new HostRecoveryStore(recoveryRoot);
    const configuredRate = config.rateLimitRpm ?? Number(process.env.CODEX_RATE_LIMIT_RPM ?? 60);
    const rate = Number.isSafeInteger(configuredRate) ? configuredRate : 60;
    this.rateLimiter = new SlidingWindowRateLimiter({ limitPerWindow: rate, disabled: rate <= 0 });
    this.timer = setInterval(() => this.expire(), 30_000);
    this.timer.unref();
  }

  private models() {
    return availableChatGptWebModelRoutes(this.config).filter(route => route.interactionMode === "automatic").map(route => ({
      id: route.slug,
      name: route.displayName,
      reasoning: true,
      reasoningEffort: route.codexEffort,
      supportedReasoningEfforts: route.supportedCodexEfforts ?? [route.codexEffort],
      contextWindow: resolveChatGptWebContextLimits(route.backendModel, route.adapterEffort, this.config).contextWindow,
      // Host output admission budget, not an upstream model capacity claim.
      maxTokens: 32_768,
    }));
  }

  private cancel(session: HostSession, turn: HostTurn): "requested" | "settled" {
    if (turn.cancellation) return turn.cancellation;
    turn.cancelled = true;
    turn.cancellation = "requested";
    const reason = new DOMException("Host turn cancelled", "AbortError");
    if (session.admitting?.turnId === turn.id) session.admitting.abort.abort(reason);
    const identity = { threadId: session.id, turnId: turn.id };
    const http = this.httpTurns.beginCancelTurn(identity, reason);
    const browser = chatGptTurnSessions.cancelNativeTurn(session.id, turn.id, reason);
    if (session.recoveryScope) {
      try {
        this.recovery.markCancelled(session.recoveryScope, turn.id, "requested");
      } catch (error) {
        console.warn("[host] recovery cancellation receipt failed:", error instanceof Error ? error.message : "unknown error");
      }
    }
    void Promise.all([http.settlement, browser.settlement]).then(() => {
      turn.cancellation = "settled";
      if (session.recoveryScope) {
        try {
          this.recovery.markCancelled(session.recoveryScope, turn.id, "settled");
        } catch (error) {
          console.warn("[host] recovery cancellation settlement receipt failed:", error instanceof Error ? error.message : "unknown error");
        }
      }
    }, () => {});
    return turn.cancellation;
  }

  private remove(session: HostSession): void {
    this.store.sessions.delete(session.id);
    session.admitting?.abort.abort(new DOMException("Host session revoked", "AbortError"));
    for (const turn of session.turns.values()) {
      if (turn.active) this.cancel(session, turn);
    }
    session.responses.clear();
    session.calls.clear();
    session.bytes = 0;
  }

  private expire(): void {
    for (const session of this.store.sessions.values()) {
      if (session.expires <= this.store.now()) this.remove(session);
    }
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    for (const session of [...this.store.sessions.values()]) this.remove(session);
  }

  async handle(request: Request): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/host/v1/")) return undefined;
    try {
      if (request.headers.has("origin")) throw new HostProtocolError(403, "Browser-origin host requests are not allowed");
      this.expire();
      if (path === "/host/v1/sessions" && request.method === "POST") {
        if (!authorized(request, this.config.controlToken)) throw new HostProtocolError(401, "Host pairing requires local control authorization");
        if (this.config.mode !== "full") throw new HostProtocolError(409, "Host integration requires full mode with host-owned tools");
        const body = await readHostBody(request);
        if (body.protocol !== 1 || body.host !== "pi" || typeof body.cwd !== "string" || !isAbsolute(body.cwd) || body.cwd.length > 4096 || /[\x00-\x1f]/.test(body.cwd)
          || (body.recovery_scope !== undefined && (typeof body.recovery_scope !== "string" || !/^[a-f0-9]{64}$/.test(body.recovery_scope)))
          || Object.keys(body).some(key => !["protocol", "host", "cwd", "recovery_scope"].includes(key))) {
          throw new HostProtocolError(400, "Expected protocol 1, host pi and an absolute cwd");
        }
        const models = this.models();
        if (!models.length) throw new HostProtocolError(409, "No automatic ChatGPT Web routes are available");
        const session = this.store.create(body.cwd, body.recovery_scope as string | undefined);
        return Response.json({ protocol: 1, session_id: session.id, token: session.token, models }, { headers: { "cache-control": "no-store" } });
      }
      if (path === "/host/v1/responses" && request.method === "POST") return await this.respond(request);
      const recoveryMatch = /^\/host\/v1\/sessions\/([A-Za-z0-9_-]+)\/recovery$/.exec(path);
      if (recoveryMatch && request.method === "GET") {
        const session = this.store.authenticate(request, recoveryMatch[1]!);
        if (!session.recoveryScope) throw new HostProtocolError(409, "This host session has no persistent recovery scope");
        return Response.json(this.recovery.inspectLatest(session.recoveryScope), { headers: { "cache-control": "no-store" } });
      }
      const match = /^\/host\/v1\/sessions\/([A-Za-z0-9_-]+)(?:\/turns\/([A-Za-z0-9_-]{1,128})(?:\/(cancel))?)?$/.exec(path);
      if (match) {
        const session = this.store.authenticate(request, match[1]!);
        if (match[2] && !match[3] && request.method === "GET") {
          return Response.json(inspectHostTurn(session, match[2]), { headers: { "cache-control": "no-store" } });
        }
        if (match[2] && match[3] === "cancel" && request.method === "POST") {
          let turn = session.turns.get(match[2]);
          if (!turn && session.admitting?.turnId === match[2]) {
            turn = { id: match[2], catalog: "", names: new Set(), active: false, cancelled: false };
            session.turns.set(turn.id, turn);
          }
          return Response.json({ state: turn ? this.cancel(session, turn) : "unknown", scope: "bridge-http-and-browser-only" });
        }
        if (!match[2] && request.method === "DELETE") {
          this.remove(session);
          return Response.json({ state: "requested", scope: "bridge-http-and-browser-only" });
        }
      }
      throw new HostProtocolError(404, "Unknown host endpoint");
    } catch (error) {
      const status = error instanceof HostProtocolError ? error.status : 500;
      return Response.json({ error: {
        type: "host_protocol_error",
        message: error instanceof HostProtocolError ? error.message : "Host request failed",
        ...(error instanceof HostProtocolError && error.code ? { code: error.code } : {}),
      } }, { status, headers: { "cache-control": "no-store" } });
    }
  }

  private async respond(request: Request): Promise<Response> {
    const session = this.store.authenticate(request, request.headers.get("x-cgw-session-id") ?? "");
    const turnId = request.headers.get("x-cgw-turn-id") ?? "";
    const sequence = request.headers.get("x-cgw-sequence") ?? "";
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(turnId) || !/^[1-9]\d{0,15}$/.test(sequence) || !Number.isSafeInteger(Number(sequence))) throw new HostProtocolError(400, "Invalid host turn or sequence");
    if (session.admitting || [...session.turns.values()].some(turn => turn.active)) throw new HostProtocolError(409, "Host session already has an active request");
    if (session.turns.get(turnId)?.cancelled) throw new HostProtocolError(409, "Host turn was cancelled; use a new turn ID");
    if (!session.turns.has(turnId) && session.turns.size >= 256) throw new HostProtocolError(429, "Host turn capacity reached; start a new session");
    // Cap model admission across every Pi capability; opening a session cannot reset quota.
    // Cancellation and session deletion remain available even when model admission is full.
    const admission = this.rateLimiter.check("pi");
    if (!admission.allowed) {
      return Response.json({ error: { type: "rate_limit_error", message: "Host model rate limit exceeded" } }, {
        status: 429,
        headers: { "retry-after": String(Math.ceil(admission.retryAfterMs / 1000)), "cache-control": "no-store" },
      });
    }
    const admitting = { turnId, abort: new AbortController() };
    session.admitting = admitting;
    let body: Record<string, unknown>;
    try {
      body = await readHostBody(request, AbortSignal.any([request.signal, admitting.abort.signal]));
    } catch (error) {
      if (admitting.abort.signal.aborted) throw new HostProtocolError(409, "Host request was cancelled during admission");
      throw error;
    } finally {
      if (session.admitting === admitting) session.admitting = undefined;
    }
    // Reauthenticate after asynchronous body acquisition; expiry/deletion can happen meanwhile.
    this.store.authenticate(request, session.id);
    if (Number(sequence) <= session.sequence) throw new HostProtocolError(409, "Host request sequence was already consumed");
    if (!this.models().some(model => model.id === body.model)) throw new HostProtocolError(400, "Requested model is unavailable for this host");
    if (body.max_output_tokens !== undefined && (!Number.isSafeInteger(body.max_output_tokens) || Number(body.max_output_tokens) < 1 || Number(body.max_output_tokens) > 32_768)) throw new HostProtocolError(400, "Host output budget must be between 1 and 32768 tokens");
    body.max_output_tokens ??= 32_768;
    const prepared = prepareHostRequest(session, turnId, body);
    // Reuse the route and parser that the adapter will use. Reject local
    // preconditions before a durable admission can imply model delivery.
    let parsed;
    try {
      parsed = parseRequest(prepared.body);
      routeChatGptWebRequest(parsed, this.config);
    } catch {
      throw new HostProtocolError(400, "Host request cannot be routed to the selected Web model");
    }
    const metadata = (parsed._rawBody as { client_metadata?: Record<string, unknown> } | undefined)?.client_metadata;
    if (!parsed.stream && !parsed._compactionRequest
      && !metadata?.["x-codex-turn-metadata"] && isLongReasoningTurn(parsed)) {
      throw new HostProtocolError(400, "High-reasoning Web turns require streaming before host admission");
    }
    // A fresh full-history prompt has no retained browser conversation to rescue it.
    // Reject a deterministic transport failure before recovery and sequence admission.
    if (!session.turns.has(turnId) && body.previous_response_id === undefined && !parsed._compactionRequest) {
      parsed._hostTurn = {
        sessionId: session.id,
        turnId,
        environment: {
          execution: "host-only",
          cwd: session.cwd,
          roots: [],
          writableRoots: [],
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          tools: parsed.context.tools ?? [],
        },
      };
      try {
        assertFirstHostPromptWithinLimits(parsed, this.config);
      } catch (error) {
        if (error instanceof ChatGptWebAdapterError && error.code === "context_compaction_required") {
          throw new HostProtocolError(400, error.message, error.code);
        }
        throw new HostProtocolError(400, "Host request exceeds compiled Web context or transport limits");
      }
    }
    if (session.recoveryScope) {
      if (session.turns.has(turnId)) this.recovery.assertAdmitted(session.recoveryScope, turnId);
      else this.recovery.admitTurn(session.recoveryScope, turnId, digest(prepared.body));
    }
    session.sequence = Number(sequence);
    prepared.accept();
    const turn = prepared.turn;
    turn.requestSequence = Number(sequence);
    try {
      return await this.httpTurns.track(async (signal, bindIdentity) => {
        bindIdentity({ threadId: session.id, turnId });
        const response = await responseRequest(new Request(request.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(prepared.body),
          signal,
        }), this.config, this.adapterFactory, {
          rememberState: false,
          hostTurn: { sessionId: session.id, turnId, cwd: session.cwd },
          onTurnIdentity: bindIdentity,
          onCompletedResponse: output => {
            this.store.remember(session, turn, prepared.body.input as unknown[], output);
            if (session.recoveryScope && typeof output.id === "string"
              && turn.completedSequence === turn.requestSequence
              && turn.completedResponseId === output.id && turn.requestSequence !== undefined) {
              this.recovery.complete(session.recoveryScope, turnId, turn.requestSequence, output.id);
            }
          },
        });
        if (!response.body) {
          turn.active = false;
          return response;
        }
        const headers = new Headers(response.headers);
        headers.set("cache-control", "no-store");
        const reader = response.body.getReader();
        return new Response(new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) {
                turn.active = false;
                controller.close();
              } else controller.enqueue(next.value);
            } catch (error) {
              turn.active = false;
              controller.error(error);
            }
          },
          async cancel(reason) {
            try { await reader.cancel(reason); }
            finally { turn.active = false; }
          },
        }), { status: response.status, headers });
      }, request.signal, process.platform, "responses");
    } catch (error) {
      turn.active = false;
      throw error;
    }
  }
}
