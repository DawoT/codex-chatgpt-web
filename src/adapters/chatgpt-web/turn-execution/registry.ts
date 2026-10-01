import { chatGptBrowserTabClosedError, chatGptTurnSupersededError } from "../adapter-error";
import { MAX_CHATGPT_BROWSER_TABS, MAX_CHATGPT_LAUNCHER_PENDING_TURNS } from "../concurrency";
import { awaitWithAbort } from "./abort";
import { TurnRetirementCoordinator } from "./retirement";
import { ChatGptTurnSession } from "./session";
import type { ChatGptInstructionLineage, ChatGptTurnRuntime } from "./types";

export class ChatGptTurnSessions {
  private readonly entries = new Map<string, ChatGptTurnSession>();
  private readonly conversationHeads = new Map<string, ChatGptTurnSession>();
  private readonly retirement = new TurnRetirementCoordinator();

  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly maxEntries = 256,
    private readonly now: () => number = () => Date.now(),
  ) {}

  getOrCreate(
    key: string,
    start: () => ChatGptTurnRuntime,
    traceId?: string,
    ownerKey?: string,
    nativeTurnId?: string,
    nativeThreadId?: string,
    instruction?: string,
    maxActive = MAX_CHATGPT_BROWSER_TABS,
  ): ChatGptTurnSession {
    this.prune();
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.supersededError) throw existing.supersededError;
      existing.touch();
      return existing;
    }
    const active = [...this.entries.values()].filter((session) => session.isActive()).length;
    if (maxActive !== MAX_CHATGPT_BROWSER_TABS && maxActive !== MAX_CHATGPT_LAUNCHER_PENDING_TURNS) {
      throw new Error("ChatGPT browser turn registry capacity is invalid");
    }
    if (active >= maxActive) {
      throw new Error(
        `ChatGPT Web supports at most ${maxActive} simultaneous browser turns; close or finish a browser tab before starting another`,
      );
    }
    if (this.entries.size >= this.maxEntries)
      throw new Error(`ChatGPT web session registry is full (${this.maxEntries} entries)`);
    const session = new ChatGptTurnSession(
      start(),
      traceId,
      ownerKey,
      nativeTurnId,
      nativeThreadId,
      instruction,
      this.now,
    );
    this.entries.set(key, session);
    const conversationKey = session.conversationKey();
    if (conversationKey) this.conversationHeads.set(conversationKey, session);
    return session;
  }

  async getOrCreateAfterOwnerRetirement(
    key: string,
    ownerKey: string,
    start: () => ChatGptTurnRuntime,
    traceId?: string,
    signal?: AbortSignal,
    nativeTurnId?: string,
    nativeThreadId?: string,
    instruction?: ChatGptInstructionLineage,
    maxActive = MAX_CHATGPT_BROWSER_TABS,
  ): Promise<ChatGptTurnSession> {
    for (;;) {
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      const existing = this.entries.get(key);
      if (existing) {
        if (existing.supersededError) throw existing.supersededError;
        existing.touch();
        return existing;
      }
      const pending = this.retirement.pending(key) ?? this.retirement.pendingOwner(ownerKey);
      if (pending) {
        await awaitWithAbort(pending, signal);
        continue;
      }
      const activeOwner = [...this.entries].find(
        ([ownedKey, session]) => ownedKey !== key && session.ownerKey === ownerKey && !session.isPhysicallySettled(),
      );
      if (activeOwner) {
        const [ownedKey, ownedSession] = activeOwner;
        if (
          ownedSession.isActive() &&
          instruction &&
          ownedSession.instruction &&
          instruction.current !== ownedSession.instruction
        ) {
          if (!instruction.predecessors.has(ownedSession.instruction)) throw chatGptTurnSupersededError();
          // Native steering can return the old tool result and a new instruction in one request.
          // Waiting for the old browser here deadlocks before that result can be consumed. Retire
          // its capability and rebuild from the complete canonical history, including that result.
          // Keep the old entry terminal so a delayed replay cannot restart superseded work.
          const reason = chatGptTurnSupersededError();
          ownedSession.supersededError = reason;
          this.forgetConversationHead(ownedSession);
          await awaitWithAbort(this.beginRetirement(ownedKey, ownedSession, reason), signal);
          continue;
        }
        // A completed response may still be releasing its browser surface. Sequential work
        // waits for that cleanup; preemption requires a proven newer canonical instruction.
        await awaitWithAbort(ownedSession.physicalSettlement, signal);
        continue;
      }
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      return this.getOrCreate(
        key,
        start,
        traceId,
        ownerKey,
        nativeTurnId,
        nativeThreadId,
        instruction?.current,
        maxActive,
      );
    }
  }

  find(key: string): ChatGptTurnSession | undefined {
    const session = this.entries.get(key);
    session?.touch();
    return session;
  }

  findConversationHead(conversationKey: string): ChatGptTurnSession | undefined {
    const session = this.conversationHeads.get(conversationKey);
    session?.touch();
    return session;
  }

  /** Wait for a retained conversation epoch that has been detached but not physically released. */
  async waitForConversationRetirement(conversationKey: string, signal?: AbortSignal): Promise<void> {
    const pending = this.retirement.pendingConversation(conversationKey);
    if (pending) await awaitWithAbort(pending, signal);
  }

  async retireConversationAndWait(conversationKey: string): Promise<number> {
    return this.closeConversationAndWait(conversationKey);
  }

  /**
   * Close the physical retained-chat epoch without discarding a terminal response that won the
   * compaction race before any compaction instruction reached that response. The detached logical
   * session remains addressable by its exact Responses execution key, so the post-compaction
   * native round can consume the already-committed answer instead of opening another browser turn.
   */
  async retireConversationPreservingFinalResponse(
    conversationKey: string,
    preserved: ChatGptTurnSession,
    preservedExecutionKey: string,
  ): Promise<number> {
    if (!preservedExecutionKey) throw new Error("Preserved ChatGPT response execution key is required");
    const outcome = preserved.settledOutcome();
    if (outcome?.type !== "final") {
      throw new Error("Only a settled final ChatGPT response can survive retained-conversation retirement");
    }
    return this.closeConversationAndWait(conversationKey, {
      session: preserved,
      executionKey: preservedExecutionKey,
    });
  }

  private async closeConversationAndWait(
    conversationKey: string,
    preserved?: { session: ChatGptTurnSession; executionKey: string },
  ): Promise<number> {
    const pending = this.retirement.pendingConversationClose(conversationKey);
    if (pending) {
      await pending;
      return 0;
    }
    const matches = [...this.entries].filter(([, session]) => session.conversationKey() === conversationKey);
    if (matches.length === 0) return 0;
    if (preserved && !matches.some(([, session]) => session === preserved.session)) {
      throw new Error("The final ChatGPT response does not own the retained conversation being retired");
    }
    const target = preserved ? this.entries.get(preserved.executionKey) : undefined;
    if (target && target !== preserved?.session) {
      throw new Error("The compacted ChatGPT response execution key is already owned by another session");
    }
    this.conversationHeads.delete(conversationKey);
    for (const [key, session] of matches) {
      if (this.entries.get(key) === session && (session !== preserved?.session || key !== preserved.executionKey)) {
        this.entries.delete(key);
      }
      if (session.isActive()) this.beginRetirement(key, session);
      if (!session.detachConversation(conversationKey)) {
        throw new Error("ChatGPT retained-conversation ownership changed during retirement");
      }
    }
    if (preserved) this.entries.set(preserved.executionKey, preserved.session);
    const release = matches.findLast(([, session]) => session.runtime.releaseRetainedConversation !== undefined)?.[1]
      .runtime.releaseRetainedConversation;
    const retirement = Promise.all(matches.map(([, session]) => session.physicalSettlement)).then(async () => {
      await release?.();
    });
    await this.retirement.trackConversation(
      conversationKey,
      retirement,
      matches.flatMap(([, session]) => (session.ownerKey ? [session.ownerKey] : [])),
    );
    return matches.length;
  }

  async waitForRetirement(key: string): Promise<void> {
    await this.retirement.pending(key);
  }

  async retireAndWait(key: string, signal?: AbortSignal): Promise<boolean> {
    const pending = this.retirement.pending(key);
    if (pending) {
      await awaitWithAbort(pending, signal);
      return true;
    }
    const session = this.entries.get(key);
    if (!session) return false;

    this.entries.delete(key);
    this.forgetConversationHead(session);
    await awaitWithAbort(this.beginRetirement(key, session), signal);
    return true;
  }

  retire(key: string, session: ChatGptTurnSession): boolean {
    if (this.entries.get(key) !== session) return false;
    this.entries.delete(key);
    this.forgetConversationHead(session);
    this.beginRetirement(key, session);
    return true;
  }

  /** Cancel only active responses whose exact native turn ids Codex marked as interrupted. */
  retireAbortedOwnerTurns(ownerKey: string, abortedTurnIds: ReadonlySet<string>, keepKey: string): number {
    const matches = [...this.entries].filter(
      ([key, session]) =>
        key !== keepKey &&
        session.ownerKey === ownerKey &&
        session.nativeTurnId !== undefined &&
        abortedTurnIds.has(session.nativeTurnId) &&
        session.isActive(),
    );
    for (const [key, session] of matches) {
      this.entries.delete(key);
      this.forgetConversationHead(session);
      this.beginRetirement(key, session);
    }
    return matches.length;
  }

  clear(): number {
    const cancelled = this.entries.size;
    for (const [key, session] of this.entries) this.beginRetirement(key, session);
    this.entries.clear();
    this.conversationHeads.clear();
    return cancelled;
  }

  async cancelTrace(traceId: string, reason = chatGptBrowserTabClosedError()): Promise<number> {
    const cancellation = this.beginCancelTrace(traceId, reason);
    await cancellation.settlement;
    return cancellation.cancelled;
  }

  /** Revoke execution immediately; keep physical cleanup tracked independently of the UI receipt. */
  beginCancelTrace(traceId: string, reason: Error): { cancelled: number; settlement: Promise<void> } {
    const sessions = [...this.entries].filter(([, session]) => session.traceId === traceId && session.isActive());
    return {
      cancelled: sessions.length,
      settlement: Promise.all(sessions.map(([key, session]) => this.beginRetirement(key, session, reason))).then(
        () => undefined,
      ),
    };
  }

  activeActorOwnerForTrace(traceId: string): { sessionId: string; turnId: string } | null {
    const owners = [...this.entries.values()]
      .filter(
        (session) => session.traceId === traceId && session.isActive() && session.ownerKey && session.nativeTurnId,
      )
      .map((session) => ({ sessionId: session.ownerKey!, turnId: session.nativeTurnId! }));
    if (owners.length > 1) throw new Error("Browser trace has ambiguous active actor ownership");
    return owners[0] ?? null;
  }

  /**
   * Begin retiring only the browser execution owned by the exact native Codex turn.
   *
   * Codex runs Interrupt hooks synchronously with a short deadline. Ownership is removed and the
   * abort is delivered before this method returns; physical helper cleanup remains represented by
   * `settlement`, so replacement turns still serialize behind the real teardown without blocking
   * the hook acknowledgement itself.
   */
  cancelNativeTurn(threadId: string, turnId: string, reason: Error): { cancelled: number; settlement: Promise<void> } {
    const matches = [...this.entries].filter(
      ([, session]) => session.nativeThreadId === threadId && session.nativeTurnId === turnId,
    );
    for (const [key, session] of matches) {
      if (this.entries.get(key) !== session) continue;
      this.entries.delete(key);
      this.forgetConversationHead(session);
    }
    const settlement = Promise.all(matches.map(([key, session]) => this.beginRetirement(key, session, reason))).then(
      () => undefined,
    );
    return { cancelled: matches.length, settlement };
  }

  cancelledError(traceId: string): Error | undefined {
    for (const session of this.entries.values()) {
      if (session.traceId !== traceId) continue;
      if (session.supersededError) return session.supersededError;
      const outcome = session.settledOutcome();
      if (outcome?.type !== "error") continue;
      if ("code" in outcome.error && outcome.error.code === "client_cancelled") return outcome.error;
    }
    return undefined;
  }

  activeCount(): number {
    this.prune();
    let active = 0;
    for (const session of this.entries.values()) if (session.isActive()) active += 1;
    return active;
  }

  resourceDiagnostics(): {
    pending_waiters: number;
    pending_retirements: number;
    retained_releases: number;
  } {
    this.prune();
    let pendingWaiters = 0;
    for (const session of this.entries.values()) {
      pendingWaiters += session.runtime.trace.pendingWaiters;
      pendingWaiters += session.runtime.text.pendingWaiters;
      if (session.runtime.mode === "tools") {
        pendingWaiters += session.runtime.externalProgress.pendingWaiters;
      }
    }
    const retirement = this.retirement.diagnostics();
    return {
      pending_waiters: pendingWaiters,
      pending_retirements: retirement.pendingRetirements,
      retained_releases: retirement.retainedReleases,
    };
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, session] of this.entries) {
      if (session.isActive() || session.lastUsedAt() >= cutoff) continue;
      this.beginRetirement(key, session);
      this.entries.delete(key);
      this.forgetConversationHead(session);
    }
  }

  private forgetConversationHead(session: ChatGptTurnSession): void {
    const conversationKey = session.conversationKey();
    if (conversationKey && this.conversationHeads.get(conversationKey) === session) {
      this.conversationHeads.delete(conversationKey);
    }
  }

  private beginRetirement(key: string, session: ChatGptTurnSession, reason?: Error): Promise<void> {
    return this.retirement.begin(key, session, reason);
  }
}

export const chatGptTurnSessions = new ChatGptTurnSessions();
