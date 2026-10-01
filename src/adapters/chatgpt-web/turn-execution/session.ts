import type { AdapterEvent } from "../../../types";
import { ChatGptWebAdapterError } from "../adapter-error";
import type { BrokerToolRequest } from "../turn-broker";
import type { ChatGptBrowserOutcome, ChatGptTurnRuntime } from "./types";

export class ChatGptTurnSession {
  supersededError?: Error;
  readonly createdAt: number;
  private lastTouchedAt: number;
  readonly browserOutcome: Promise<ChatGptBrowserOutcome>;
  readonly physicalSettlement: Promise<void>;
  private readonly outstandingById = new Map<string, BrokerToolRequest>();
  private readonly deliveredResultIds = new Set<string>();
  private outstandingReasoning: string[] = [];
  private finalReasoning: string[] = [];
  private outstandingPrelude: AdapterEvent[] = [];
  private finalPrelude: AdapterEvent[] = [];
  private settledBrowserOutcome?: ChatGptBrowserOutcome;
  private settledPhysical = false;
  private attachedConversationKey: string | undefined;
  private tail: Promise<void> = Promise.resolve();
  private capabilityRetirementScheduled = false;
  private readonly rounds = new Map<
    string,
    {
      events: AdapterEvent[];
      reasoning: string[];
      completed: boolean;
      failure?: Error;
    }
  >();

  constructor(
    readonly runtime: ChatGptTurnRuntime,
    readonly traceId?: string,
    readonly ownerKey?: string,
    readonly nativeTurnId?: string,
    readonly nativeThreadId?: string,
    readonly instruction?: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.createdAt = this.now();
    this.lastTouchedAt = this.createdAt;
    this.attachedConversationKey = runtime.conversationKey;
    this.physicalSettlement = runtime.physicalSettlement.then(
      () => {
        this.settledPhysical = true;
      },
      (error) => {
        this.settledPhysical = true;
        throw error;
      },
    );
    this.browserOutcome = runtime.browser
      .then((answer) => ({ type: "final", answer }) as ChatGptBrowserOutcome)
      .catch(
        (error) =>
          ({
            type: "error",
            error: error instanceof Error ? error : new Error(String(error)),
          }) as ChatGptBrowserOutcome,
      )
      .then((outcome) => {
        this.settledBrowserOutcome = outcome;
        const error =
          outcome.type === "error" && outcome.error instanceof ChatGptWebAdapterError ? outcome.error : undefined;
        console.info(
          `[chatgpt-web] browser_settled ${JSON.stringify({
            traceId: this.traceId,
            outcome: outcome.type,
            compaction: runtime.usageInput?._compactionRequest === true,
            ...(!runtime.usageInput?._compactionRequest ? { submission: runtime.submission?.phase ?? "unknown" } : {}),
            ...(error ? { code: error.code, retryable: error.retryable } : {}),
          })}`,
        );
        return outcome;
      });
  }

  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    this.touch();
    const run = this.tail.then(task);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.scheduleCapabilityRetirement();
    return run;
  }

  touch(): void {
    this.lastTouchedAt = this.now();
  }

  lastUsedAt(): number {
    return this.lastTouchedAt;
  }

  outstanding(): BrokerToolRequest[] {
    return [...this.outstandingById.values()];
  }

  settledOutcome(): ChatGptBrowserOutcome | undefined {
    return this.settledBrowserOutcome;
  }

  conversationKey(): string | undefined {
    return this.attachedConversationKey;
  }

  detachConversation(conversationKey: string): boolean {
    if (this.attachedConversationKey !== conversationKey) return false;
    this.attachedConversationKey = undefined;
    return true;
  }

  isActive(): boolean {
    return this.settledBrowserOutcome === undefined;
  }

  /** The client-visible browser result can settle before launcher/helper cleanup does. */
  isPhysicallySettled(): boolean {
    return this.settledPhysical;
  }

  setOutstanding(requests: BrokerToolRequest[], reasoning: string[] = [], prelude: AdapterEvent[] = []): void {
    if (this.outstandingById.size > 0)
      throw new Error("cannot emit a new ChatGPT tool batch while the previous batch is unresolved");
    for (const request of requests) {
      if (this.deliveredResultIds.has(request.callId) || this.outstandingById.has(request.callId)) {
        throw new Error(`duplicate ChatGPT bridge tool call id: ${request.callId}`);
      }
      this.outstandingById.set(request.callId, request);
    }
    this.outstandingReasoning = [...reasoning];
    this.outstandingPrelude = [...prelude];
  }

  hasOutstanding(callId: string): boolean {
    return this.outstandingById.has(callId);
  }

  markResultDelivered(callId: string): void {
    if (!this.outstandingById.delete(callId))
      throw new Error(`ChatGPT bridge tool result does not match an outstanding call: ${callId}`);
    this.deliveredResultIds.add(callId);
    if (this.outstandingById.size === 0) {
      this.outstandingReasoning = [];
      this.outstandingPrelude = [];
    }
  }

  reasoningForOutstandingReplay(): string[] {
    return [...this.outstandingReasoning];
  }

  eventsForOutstandingReplay(): AdapterEvent[] {
    return [...this.outstandingPrelude];
  }

  setFinalReasoning(reasoning: string[]): void {
    this.finalReasoning = [...reasoning];
  }

  reasoningForFinalReplay(): string[] {
    return [...this.finalReasoning];
  }

  setFinalEvents(events: AdapterEvent[]): void {
    this.finalPrelude = [...events];
  }

  eventsForFinalReplay(): AdapterEvent[] {
    return [...this.finalPrelude];
  }

  roundEvents(key: string): AdapterEvent[] {
    return [...this.round(key).events];
  }

  roundReasoning(key: string): string[] {
    return [...this.round(key).reasoning];
  }

  appendRoundEvent(key: string, event: AdapterEvent): void {
    this.appendRoundEvents(key, [event]);
  }

  appendRoundEvents(key: string, events: readonly AdapterEvent[]): void {
    if (events.length === 0) return;
    const round = this.round(key);
    if (round.completed) throw new Error("cannot append to a completed ChatGPT native round");
    round.events.push(...events);
  }

  appendRoundReasoning(key: string, values: readonly string[]): void {
    if (values.length === 0) return;
    const round = this.round(key);
    if (round.completed) throw new Error("cannot append reasoning to a completed ChatGPT native round");
    round.reasoning.push(...values);
  }

  completeRound(key: string): void {
    this.round(key).completed = true;
  }

  failRound(key: string, error: Error): void {
    const round = this.round(key);
    round.failure = error;
    round.completed = true;
  }

  roundCompleted(key: string): boolean {
    return this.rounds.get(key)?.completed === true;
  }

  roundFailure(key: string): Error | undefined {
    return this.rounds.get(key)?.failure;
  }

  roundHasTerminalEvent(key: string): boolean {
    return this.rounds.get(key)?.events.some((event) => event.type === "done" || event.type === "error") === true;
  }

  cancel(reason?: Error): void {
    this.runtime.cancel(reason);
  }

  private scheduleCapabilityRetirement(): void {
    if (this.capabilityRetirementScheduled || !this.runtime.retireCapability) return;
    this.capabilityRetirementScheduled = true;
    // Register only after the first observer entered `runExclusive`. This ensures an immediately
    // completed mocked/real browser cannot revoke its token ahead of the browser-outcome branch.
    // At physical settlement, read the current tail so every tool-result/reconnect observer that
    // was already admitted finishes before the capability is retired.
    void this.physicalSettlement
      .then(() => this.tail)
      .then(() => this.runtime.retireCapability!())
      .catch((error) => {
        console.error(
          `[chatgpt-web] failed to retire settled turn capability: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  private round(key: string) {
    let round = this.rounds.get(key);
    if (round) return round;
    round = { events: [], reasoning: [], completed: false };
    this.rounds.set(key, round);
    while (this.rounds.size > 512) {
      const oldestCompleted = [...this.rounds].find(([, candidate]) => candidate.completed);
      if (!oldestCompleted) {
        throw new Error("ChatGPT native round journal is full (512 unfinished rounds)");
      }
      this.rounds.delete(oldestCompleted[0]);
    }
    return round;
  }
}
