/**
 * Sprint H3: TaskResumeOrchestrator — daemon-side push + observability for background tasks.
 *
 * The MCP server process runs long-lived background tasks and pushes one completion event per
 * task to the daemon (POST /internal/tasks/completed). This orchestrator buffers those events,
 * coalesces them per retained ChatGPT conversation, waits for the owning browser turn to settle
 * physically, and then submits exactly ONE observation-only note turn listing what finished.
 *
 * ARCHITECTURAL RESTRICTION — the note is observation-only (no tools): it is submitted through
 * the same one-shot native-connector turn shape as the compaction handoff with the ordinary tool
 * environment disabled. Only the CLI may start requests that carry the full Codex history, so a
 * resume note can never mutate Codex state, invoke tools, or claim a new turn identity; it can
 * only tell the user, inside the existing conversation, that background tasks finished and where
 * their logs live.
 *
 * Lifecycle style follows TunnelSupervisor/SessionStoreJanitor: a `setInterval` drain loop with
 * `unref`, start/stop guards, and a `getStats()` snapshot for /healthz and /admin/tasks.
 */

export type TaskCompletionStatus = "completed" | "failed" | "killed";

/** Contract sent by the MCP daemon (Sprint H2 background task manager). */
export interface TaskCompletion {
  id: string;
  cmd: string;
  cwd: string;
  status: TaskCompletionStatus;
  exitCode: number | null;
  startedAt: string;
  completedAt: string;
  logPath: string;
}

export interface TaskCompletionPayload {
  source: "chatgpt-web-mcp";
  task: TaskCompletion;
  /** Emitter-prepared single line (<=300 chars). When absent, the note derives one from `task`. */
  summary?: string;
  traceId?: string;
  turnToken?: string;
}

/**
 * Structural view of the conversation head the orchestrator needs. `ChatGptTurnSession`
 * satisfies this shape; tests substitute plain fakes.
 */
export interface TaskResumeConversationHead {
  conversationKey(): string | undefined;
  /** Physical helper/Playwright settlement of the owning browser turn. */
  readonly physicalSettlement: Promise<void>;
  settledOutcome(): { type: string } | undefined;
}

export interface TaskResumeOrchestratorStats {
  events_received: number;
  notes_sent: number;
  notes_failed: number;
  /** Drained groups whose note merged more than one completion event. */
  coalesced_groups: number;
  skipped_no_session: number;
  last_event_at: string | null;
  last_note_at: string | null;
}

export type TaskResumeActivityKind =
  | "event_received"
  | "note_sent"
  | "note_failed"
  | "skipped_no_session"
  | "event_dropped";

export interface TaskResumeActivityEntry {
  at: string;
  kind: TaskResumeActivityKind;
  taskIds: string[];
  conversationKey?: string;
  detail?: string;
}

export interface TaskResumeOrchestratorOptions {
  /** Resolve the conversation head that owns the pushed trace/turn identity. */
  findConversationHead: (traceId?: string, turnToken?: string) => TaskResumeConversationHead | undefined;
  /** Fire the (single) resume note turn for a conversation. Must never be called concurrently for one group. */
  runResumeTurn: (conversationKey: string, noteText: string) => void | Promise<void>;
  /** Await the conversation's physical settlement before submitting the note. Injectable for tests. */
  waitForSettlement?: (head: TaskResumeConversationHead) => Promise<void>;
  /** Drain cadence. Default 15_000 ms. */
  coalesceWindowMs?: number;
  /** Buffered-event bound across all groups; the oldest event gives way first. Default 64. */
  maxQueue?: number;
  /** When false, events are still accounted for but no browser note turn is ever submitted. */
  resumeNotes?: boolean;
  /** Bounded recent-activity log size for /admin/tasks. Default 50. */
  recentLimit?: number;
}

const DEFAULT_COALESCE_WINDOW_MS = 15_000;
const DEFAULT_MAX_QUEUE = 64;
const DEFAULT_RECENT_LIMIT = 50;
const NOTE_MAX_CHARS = 1200;
const TASK_COMPLETION_STATUSES: readonly TaskCompletionStatus[] = ["completed", "failed", "killed"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Background task completion field ${field} must be a string`);
  return value;
}

/**
 * Validate one daemon push. Throws (translated to HTTP 400 by the endpoint) on any shape
 * violation; the error message names the offending field.
 */
export function parseTaskCompletionPayload(value: unknown): TaskCompletionPayload {
  if (!isRecord(value)) throw new Error("Background task completion payload must be a JSON object");
  if (value["source"] !== "chatgpt-web-mcp") {
    throw new Error('Background task completion payload source must be "chatgpt-web-mcp"');
  }
  const rawTask = value["task"];
  if (!isRecord(rawTask)) throw new Error("Background task completion payload requires a task object");
  const id = rawTask["id"];
  if (typeof id !== "string" || !id.trim()) throw new Error("Background task completion task.id must be a non-empty string");
  for (const field of ["cmd", "cwd", "startedAt", "completedAt", "logPath"] as const) {
    if (typeof rawTask[field] !== "string") throw new Error(`Background task completion task.${field} must be a string`);
  }
  const status = rawTask["status"];
  if (typeof status !== "string" || !TASK_COMPLETION_STATUSES.includes(status as TaskCompletionStatus)) {
    throw new Error(`Background task completion task.status must be one of ${TASK_COMPLETION_STATUSES.join(", ")}`);
  }
  const exitCode = rawTask["exitCode"];
  if (exitCode !== null && (typeof exitCode !== "number" || !Number.isFinite(exitCode))) {
    throw new Error("Background task completion task.exitCode must be a number or null");
  }
  const summary = optionalString(value["summary"], "summary");
  const traceId = optionalString(value["traceId"], "traceId");
  const turnToken = optionalString(value["turnToken"], "turnToken");
  return {
    source: "chatgpt-web-mcp",
    task: {
      id,
      cmd: rawTask["cmd"] as string,
      cwd: rawTask["cwd"] as string,
      status: status as TaskCompletionStatus,
      exitCode: exitCode as number | null,
      startedAt: rawTask["startedAt"] as string,
      completedAt: rawTask["completedAt"] as string,
      logPath: rawTask["logPath"] as string,
    },
    ...(summary !== undefined ? { summary } : {}),
    ...(traceId !== undefined ? { traceId } : {}),
    ...(turnToken !== undefined ? { turnToken } : {}),
  };
}

function truncateText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

function ensurePeriod(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}

function formatTaskCompletionLine(payload: TaskCompletionPayload): string {
  const task = payload.task;
  const summary = payload.summary?.trim();
  const detail = summary || `${task.status} (exit ${task.exitCode ?? "unknown"}) — ${truncateText(task.cmd, 60)}`;
  return `[${task.id}] ${detail} (log: ${task.logPath})`;
}

/**
 * Build the single combined note for one conversation:
 * "Background tasks finished: [T1] exit 0 — 42 pass, 1 fail (log: /path). [T2] exit 1 — build error (log: /path)."
 * Bounded to `maxChars`; overflowing entries collapse into a "(+N more)" suffix.
 */
export function buildTaskResumeNote(
  events: readonly TaskCompletionPayload[],
  maxChars = NOTE_MAX_CHARS,
): string {
  const header = "Background tasks finished:";
  const parts: string[] = [];
  let length = header.length;
  let omitted = 0;
  for (const event of events) {
    const piece = ` ${ensurePeriod(formatTaskCompletionLine(event))}`;
    if (parts.length > 0 && length + piece.length > maxChars) {
      omitted += 1;
      continue;
    }
    parts.push(piece);
    length += piece.length;
  }
  let note = header + parts.join("");
  if (omitted > 0) note += ` (+${omitted} more background task${omitted === 1 ? "" : "s"})`;
  if (note.length > maxChars) note = `${note.slice(0, Math.max(0, maxChars - 1))}…`;
  return note;
}

const defaultWaitForSettlement = async (head: TaskResumeConversationHead): Promise<void> => {
  // A physical cleanup failure must not withhold the observation note from the user.
  try {
    await head.physicalSettlement;
  } catch { /* settlement rejection is not a note failure */ }
};

interface TaskResumeGroup {
  /** conversationKey once resolved; a synthetic pending key while unresolvable. */
  key: string;
  conversationKey?: string;
  /** Representative push identity used to (re-)resolve the conversation head. */
  traceId?: string;
  turnToken?: string;
  events: TaskCompletionPayload[];
  draining: boolean;
}

function pendingGroupKey(traceId?: string, turnToken?: string): string {
  return `pending:${traceId ?? ""}|${turnToken ?? ""}`;
}

export class TaskResumeOrchestrator {
  private readonly options: Required<Pick<TaskResumeOrchestratorOptions, "findConversationHead" | "runResumeTurn">>
    & TaskResumeOrchestratorOptions;
  private readonly coalesceWindowMs: number;
  private readonly maxQueue: number;
  private readonly recentLimit: number;
  private readonly groups = new Map<string, TaskResumeGroup>();
  private readonly recent: TaskResumeActivityEntry[] = [];
  private readonly stats: TaskResumeOrchestratorStats = {
    events_received: 0,
    notes_sent: 0,
    notes_failed: 0,
    coalesced_groups: 0,
    skipped_no_session: 0,
    last_event_at: null,
    last_note_at: null,
  };
  private abortController = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private readonly resumeNotes: boolean;

  constructor(options: TaskResumeOrchestratorOptions) {
    this.options = options;
    this.resumeNotes = options.resumeNotes ?? true;
    this.coalesceWindowMs = options.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
    this.maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
    this.recentLimit = options.recentLimit ?? DEFAULT_RECENT_LIMIT;
  }

  /** Signal passed to every in-flight note turn; aborted by stop() so shutdown can cancel them. */
  get abortSignal(): AbortSignal {
    return this.abortController.signal;
  }

  isRunning(): boolean {
    return this.timer !== undefined;
  }

  start(): void {
    if (this.timer) return;
    if (this.abortController.signal.aborted) this.abortController = new AbortController();
    this.timer = setInterval(() => {
      try {
        this.drainNow();
      } catch (error) {
        // A drain bug must never kill the interval; the counters surface it via notes_failed.
        console.error(
          `[chatgpt-web] task resume drain failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }, this.coalesceWindowMs);
    // Allow the process to exit cleanly while the orchestrator idles.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.abortController.abort(new Error("TaskResumeOrchestrator stopped"));
  }

  /**
   * Buffer one validated daemon push. Throws on an invalid payload (the endpoint translates that
   * into HTTP 400); otherwise the event is accounted for and buffered for the next drain.
   */
  recordCompletion(value: unknown): void {
    const payload = parseTaskCompletionPayload(value);
    const now = new Date().toISOString();
    this.stats.events_received += 1;
    this.stats.last_event_at = now;

    let conversationKey: string | undefined;
    try {
      conversationKey = this.findConversationHead(payload.traceId, payload.turnToken)?.conversationKey();
    } catch {
      conversationKey = undefined;
    }
    if (conversationKey) {
      const pendingKey = pendingGroupKey(payload.traceId, payload.turnToken);
      const pending = this.groups.get(pendingKey);
      if (pending) this.groups.delete(pendingKey);
      const group = this.groups.get(conversationKey) ?? {
        key: conversationKey,
        conversationKey,
        traceId: payload.traceId,
        turnToken: payload.turnToken,
        events: [],
        draining: false,
      };
      if (!this.groups.has(conversationKey)) this.groups.set(conversationKey, group);
      if (pending) group.events.push(...pending.events);
      group.events.push(payload);
    } else if (!payload.traceId && !payload.turnToken) {
      // Without any turn identity the event can never resolve to a conversation.
      this.stats.skipped_no_session += 1;
      this.pushRecent({
        at: now,
        kind: "skipped_no_session",
        taskIds: [payload.task.id],
        detail: "payload carries neither traceId nor turnToken",
      });
      return;
    } else {
      // Unresolvable yet: keep it keyed by its push identity and retry at every drain.
      const key = pendingGroupKey(payload.traceId, payload.turnToken);
      const group = this.groups.get(key) ?? {
        key,
        traceId: payload.traceId,
        turnToken: payload.turnToken,
        events: [],
        draining: false,
      };
      if (!this.groups.has(key)) this.groups.set(key, group);
      group.events.push(payload);
    }
    this.pushRecent({
      at: now,
      kind: "event_received",
      taskIds: [payload.task.id],
      ...(conversationKey ? { conversationKey } : {}),
    });
    this.enforceQueueBound();
  }

  /** Run one drain pass immediately (also the interval body). Sends are tracked, never thrown. */
  drainNow(): void {
    if (!this.resumeNotes) {
      // Registry/stats-only mode: consume buffered events without resolving or sending.
      for (const group of this.groups.values()) {
        const consumed = group.events.splice(0);
        if (consumed.length > 1) this.stats.coalesced_groups += 1;
      }
      for (const [key, group] of this.groups) {
        if (group.events.length === 0) this.groups.delete(key);
      }
      return;
    }
    for (const group of [...this.groups.values()]) {
      if (group.draining || group.events.length === 0) continue;
      if (!group.conversationKey) {
        let conversationKey: string | undefined;
        try {
          conversationKey = this.findConversationHead(group.traceId, group.turnToken)?.conversationKey();
        } catch {
          conversationKey = undefined;
        }
        if (!conversationKey) continue; // still unresolvable; retry in a later window
        this.groups.delete(group.key);
        const existing = this.groups.get(conversationKey);
        if (existing) {
          existing.events.push(...group.events);
          continue;
        }
        group.key = conversationKey;
        group.conversationKey = conversationKey;
        this.groups.set(conversationKey, group);
      }
      group.draining = true;
      void this.dispatchGroup(group);
    }
  }

  getStats(): TaskResumeOrchestratorStats {
    return { ...this.stats };
  }

  /** Newest-first bounded activity log for /admin/tasks. */
  getRecent(limit = this.recentLimit): TaskResumeActivityEntry[] {
    return this.recent.slice(0, Math.max(0, limit));
  }

  private findConversationHead(traceId?: string, turnToken?: string): TaskResumeConversationHead | undefined {
    return this.options.findConversationHead?.(traceId, turnToken);
  }

  private pushRecent(entry: TaskResumeActivityEntry): void {
    this.recent.unshift(entry);
    while (this.recent.length > this.recentLimit) this.recent.pop();
  }

  private enforceQueueBound(): void {
    let total = 0;
    for (const group of this.groups.values()) total += group.events.length;
    while (total > this.maxQueue) {
      // Prefer dropping events that never resolved; otherwise the oldest buffered event gives way.
      const droppable = [...this.groups.values()]
        .filter(group => !group.draining && group.events.length > 0)
        .sort((a, b) => (a.conversationKey ? 1 : 0) - (b.conversationKey ? 1 : 0));
      const target = droppable[0];
      if (!target) return; // everything is draining; the bound self-heals at dispatch
      const dropped = target.events.shift();
      if (dropped) {
        total -= 1;
        const now = new Date().toISOString();
        if (!target.conversationKey) {
          this.stats.skipped_no_session += 1;
          this.pushRecent({
            at: now,
            kind: "skipped_no_session",
            taskIds: [dropped.task.id],
            detail: "dropped: queue bound exceeded before the conversation resolved",
          });
        } else {
          this.pushRecent({
            at: now,
            kind: "event_dropped",
            taskIds: [dropped.task.id],
            conversationKey: target.conversationKey,
            detail: "dropped: queue bound exceeded",
          });
        }
      }
    }
  }

  private async dispatchGroup(group: TaskResumeGroup): Promise<void> {
    try {
      let head: TaskResumeConversationHead | undefined;
      try {
        head = this.findConversationHead(group.traceId, group.turnToken);
      } catch {
        head = undefined;
      }
      if (!head || !head.conversationKey()) {
        this.stats.skipped_no_session += 1;
        this.pushRecent({
          at: new Date().toISOString(),
          kind: "skipped_no_session",
          taskIds: group.events.map(event => event.task.id),
          detail: "conversation head no longer exists",
        });
        group.events.splice(0);
        return;
      }
      await (this.options.waitForSettlement ?? defaultWaitForSettlement)(head);
      // Re-check after the wait: the conversation may have been retired while we waited.
      let stillExists = false;
      try {
        stillExists = this.findConversationHead(group.traceId, group.turnToken) !== undefined;
      } catch {
        stillExists = false;
      }
      if (!stillExists) {
        this.stats.skipped_no_session += 1;
        this.pushRecent({
          at: new Date().toISOString(),
          kind: "skipped_no_session",
          taskIds: group.events.map(event => event.task.id),
          detail: "conversation retired while waiting for settlement",
        });
        group.events.splice(0);
        return;
      }
      // Snapshot after settlement so completions that arrived during the wait join this note
      // instead of triggering a second turn for the same conversation.
      const snapshot = group.events.splice(0);
      if (snapshot.length === 0) return;
      if (snapshot.length > 1) this.stats.coalesced_groups += 1;
      const note = buildTaskResumeNote(snapshot);
      const conversationKey = group.conversationKey!;
      const taskIds = snapshot.map(event => event.task.id);
      try {
        await this.options.runResumeTurn(conversationKey, note);
        const at = new Date().toISOString();
        this.stats.notes_sent += 1;
        this.stats.last_note_at = at;
        this.pushRecent({ at, kind: "note_sent", taskIds, conversationKey });
      } catch (error) {
        this.stats.notes_failed += 1;
        this.pushRecent({
          at: new Date().toISOString(),
          kind: "note_failed",
          taskIds,
          conversationKey,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      group.draining = false;
      if (group.events.length === 0) this.groups.delete(group.key);
    }
  }
}

/**
 * Daemon-side trace index: binds a completed browser turn's traceId to its retained conversation
 * key so a later MCP daemon push (which only knows traceId/turnToken) can resolve the
 * conversation head. The session registry stays authoritative — bindings for turns without a
 * retained conversation never resolve to a head and end up counted as skipped_no_session.
 * Bounded, insertion-ordered; entries live for the process lifetime like the registry's own TTL.
 */
const MAX_TRACE_CONVERSATION_BINDINGS = 512;
const traceConversationBindings = new Map<string, string>();

export function rememberTaskResumeConversation(traceId: string, conversationKey: string): void {
  if (!traceId || !conversationKey) return;
  if (traceConversationBindings.has(traceId)) traceConversationBindings.delete(traceId);
  traceConversationBindings.set(traceId, conversationKey);
  while (traceConversationBindings.size > MAX_TRACE_CONVERSATION_BINDINGS) {
    const oldest = traceConversationBindings.keys().next().value;
    if (oldest === undefined) break;
    traceConversationBindings.delete(oldest);
  }
}

export function findTaskResumeConversation(traceId?: string): string | undefined {
  if (!traceId) return undefined;
  return traceConversationBindings.get(traceId);
}
