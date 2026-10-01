/**
 * Scoped, typed event bus for one browser turn's lifecycle.
 *
 * Turn phases used to be sequenced by fixed sleeps and polling beats. This bus lets the phase
 * machine (and the observation loops feeding it) react to discrete signals instead. It is
 * deliberately per-turn — identity `(sessionId, surfaceId, turnId)` mirrors the durable journal
 * model — so N concurrent agent turns never see each other's events.
 *
 * Consumption is waiter-set based (same pattern as `ChatGptExternalTurnProgress`): publishing
 * never queues unbounded work, and a small bounded history lets a waiter that registers after the
 * fact still observe an already-published signal instead of hanging until its deadline.
 */

export type ChatGptTurnEventSource = "dom" | "external_progress" | "network" | "host";

type ChatGptTurnEventPayload =
  | { type: "turn_inserted_detected"; source: "dom"; at: number }
  | { type: "response_mutated"; source: "dom"; at: number }
  | { type: "stop_button_visibility_changed"; source: "dom"; at: number; visible: boolean }
  | { type: "completion_action_changed"; source: "dom"; at: number; visible: boolean }
  | { type: "dom_settled"; source: "dom"; at: number }
  | { type: "connector_pill_mounted"; source: "dom"; at: number }
  | { type: "external_progress_advanced"; source: "external_progress"; at: number; revision: number }
  | { type: "network_submission_observed"; source: "network"; at: number; status: number }
  | { type: "compaction_handoff_observed"; source: "host"; at: number }
  | { type: "observation_faulted"; source: "host"; at: number; message: string }
  | { type: "page_rebound"; source: "host"; at: number }
  | { type: "phase_changed"; source: "host"; at: number; from: string; to: string };

export type ChatGptTurnEvent = ChatGptTurnEventPayload & { sequence: number; documentGeneration: number };

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** A publishable event; the bus stamps `at` when the caller omits it. */
export type ChatGptTurnEventInput = DistributiveOmit<ChatGptTurnEventPayload, "at"> & { at?: number };

export interface ChatGptTurnEventScope {
  sessionId?: string;
  surfaceId?: string;
  turnId: string;
}

export interface ChatGptTurnEventWaitOptions {
  /** Refuse to wait longer than this; the ceiling fires `ChatGptTurnEventWaitTimeoutError`. */
  deadlineMs?: number;
  signal?: AbortSignal;
  afterSequence?: number;
}

export class ChatGptTurnEventWaitTimeoutError extends Error {
  constructor(type: string, deadlineMs: number) {
    super(`ChatGPT turn event "${type}" did not arrive within ${deadlineMs}ms`);
    this.name = "ChatGptTurnEventWaitTimeoutError";
  }
}

export class ChatGptTurnEventResynchronizationError extends Error {
  constructor() {
    super("ChatGPT event cursor requires resynchronization from a current snapshot");
    this.name = "ChatGptTurnEventResynchronizationError";
  }
}

interface ChatGptTurnEventWaiter {
  type: ChatGptTurnEvent["type"];
  matches: (event: ChatGptTurnEvent) => boolean;
  resolve: (event: ChatGptTurnEvent) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const CHATGPT_TURN_EVENT_HISTORY_LIMIT = 32;

export class ChatGptTurnEventBus {
  readonly scope: ChatGptTurnEventScope;
  private history: ChatGptTurnEvent[] = [];
  private waiters: ChatGptTurnEventWaiter[] = [];
  private disposed = false;
  private sequence = 0;
  private generation = 0;

  get cursor(): number {
    return this.sequence;
  }

  get documentGeneration(): number {
    return this.generation;
  }

  constructor(scope: ChatGptTurnEventScope) {
    this.scope = scope;
  }

  get pendingWaiters(): number {
    return this.waiters.length;
  }

  /** Snapshot of the events published so far (oldest first), for diagnostics and post-hoc asserts. */
  exportHistory(): ChatGptTurnEvent[] {
    return [...this.history];
  }

  publish(event: ChatGptTurnEventInput): ChatGptTurnEvent {
    if (!this.disposed && event.type === "page_rebound") this.generation += 1;
    const stamped = {
      ...event,
      at: event.at ?? Date.now(),
      sequence: this.disposed ? this.sequence : ++this.sequence,
      documentGeneration: this.generation,
    } as ChatGptTurnEvent;
    if (this.disposed) return stamped;
    this.history.push(stamped);
    if (this.history.length > CHATGPT_TURN_EVENT_HISTORY_LIMIT) {
      this.history.splice(0, this.history.length - CHATGPT_TURN_EVENT_HISTORY_LIMIT);
    }
    for (const waiter of [...this.waiters]) {
      try {
        if (waiter.type !== stamped.type || !waiter.matches(stamped)) continue;
        this.remove(waiter);
        waiter.resolve(stamped);
      } catch (error) {
        this.remove(waiter);
        waiter.reject(error);
      }
    }
    return stamped;
  }

  waitUntil<K extends ChatGptTurnEvent["type"]>(
    type: K,
    predicate?: (event: Extract<ChatGptTurnEvent, { type: K }>) => boolean,
    options?: ChatGptTurnEventWaitOptions,
  ): Promise<Extract<ChatGptTurnEvent, { type: K }>> {
    if (options?.signal?.aborted) {
      return Promise.reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
    }
    if (this.disposed) {
      return Promise.reject(new Error(`ChatGPT turn event bus for ${this.scope.turnId} was disposed`));
    }
    const after = options?.afterSequence;
    if (after !== undefined && (!Number.isSafeInteger(after) || after < 0 || after > this.sequence)) {
      return Promise.reject(new RangeError("Invalid ChatGPT event cursor"));
    }
    if (after !== undefined && after < (this.history[0]?.sequence ?? 1) - 1) {
      return Promise.reject(new ChatGptTurnEventResynchronizationError());
    }
    const matches = (event: ChatGptTurnEvent): boolean =>
      event.type === type &&
      (after === undefined || event.sequence > after) &&
      (!predicate || (predicate as (candidate: ChatGptTurnEvent) => boolean)(event));
    try {
      const replayed = this.history.find(matches);
      if (replayed) return Promise.resolve(replayed as Extract<ChatGptTurnEvent, { type: K }>);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const waiter: ChatGptTurnEventWaiter = {
        type,
        matches,
        resolve: resolve as (event: ChatGptTurnEvent) => void,
        reject,
        signal: options?.signal,
      };
      if (options?.deadlineMs !== undefined) {
        const deadlineMs = options.deadlineMs;
        waiter.timer = setTimeout(
          () => {
            this.remove(waiter);
            reject(new ChatGptTurnEventWaitTimeoutError(type, deadlineMs));
          },
          Math.max(1, deadlineMs),
        );
      }
      if (options?.signal) {
        waiter.onAbort = () => {
          this.remove(waiter);
          reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
        };
        options.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  /** Ends the turn's event traffic; pending waits reject so no background work survives the turn. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const waiter of this.waiters.splice(0)) {
      this.clearWaiter(waiter);
      waiter.reject(new Error(`ChatGPT turn event bus for ${this.scope.turnId} was disposed`));
    }
  }

  private remove(waiter: ChatGptTurnEventWaiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
    this.clearWaiter(waiter);
  }

  private clearWaiter(waiter: ChatGptTurnEventWaiter): void {
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
  }
}
