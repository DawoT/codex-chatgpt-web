import { Database } from "bun:sqlite";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  SESSION_ACTOR_PROTOCOL_VERSION,
  type SessionAcknowledgement,
  type SessionCommand,
} from "./types";

interface SessionRow {
  generation: number;
  sequence: number;
  turnId: string | null;
  historyRevision: number;
  compactionEpoch: number;
}

interface CompactionRow {
  state: "prepared" | "received" | "validated" | "persisted" | "accepted" | "rejected";
  historyRevision: number;
  checkpointRef: string | null;
}

interface EventRow {
  commandJson: string;
  acknowledgementJson: string;
}

interface OperationRow {
  sessionId: string;
  generation: number;
  operationId: string;
  turnId: string;
  historyRevision: number;
  kind: string;
  state: "intent" | "accepted" | "completed" | "uncertain" | "abandoned";
  resultRef: string | null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertCommand(command: SessionCommand): void {
  if (command.protocolVersion !== SESSION_ACTOR_PROTOCOL_VERSION) {
    throw new Error("Session actor protocol is incompatible");
  }
  for (const value of [command.sessionId, command.turnId, command.operationId, command.producerId]) {
    if (typeof value !== "string" || value.length === 0 || value.length > 256) {
      throw new Error("Session actor command identity is invalid");
    }
  }
  if (!Number.isSafeInteger(command.generation) || command.generation < 1
    || !Number.isSafeInteger(command.producerSequence) || command.producerSequence < 1) {
    throw new Error("Session actor command sequence is invalid");
  }
}

/** The daemon is the only writer; every accepted transition commits its event and state together. */
export class SessionActorJournal {
  private readonly database!: Database;
  private closed = false;

  constructor(path: string) {
    const home = dirname(path);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const directory = lstatSync(home);
    if (!directory.isDirectory() || directory.isSymbolicLink()
      || (process.platform !== "win32" && (
        directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0
      ))) {
      throw new Error("Session actor journal requires a private owned directory");
    }
    try {
      const existing = lstatSync(path);
      if (!existing.isFile() || existing.isSymbolicLink()
        || (process.platform !== "win32" && existing.uid !== process.getuid?.())) {
        throw new Error("Session actor journal requires an owned regular database file");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      this.database = new Database(path, { create: true, strict: true });
      chmodSync(path, 0o600);
      this.initialize();
      this.recoverInterrupted();
    } catch (error) {
      this.database?.close();
      if (error instanceof Error && /database is locked/.test(error.message)) {
        throw new Error("Session actor journal is already owned by another daemon", { cause: error });
      }
      throw error;
    }
  }

  private initialize(): void {
    this.database.run("PRAGMA busy_timeout = 100");
    this.database.run("PRAGMA journal_mode = WAL");
    this.database.run("PRAGMA locking_mode = EXCLUSIVE");
    this.database.run("PRAGMA synchronous = FULL");
    this.database.run("BEGIN IMMEDIATE");
    this.database.run("COMMIT");
    this.database.run(`
      CREATE TABLE IF NOT EXISTS session_actor (
        session_id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        turn_id TEXT,
        history_revision INTEGER NOT NULL,
        compaction_epoch INTEGER NOT NULL
      )
    `);
    this.database.run(`
      CREATE TABLE IF NOT EXISTS session_event (
        session_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        producer_id TEXT NOT NULL,
        producer_sequence INTEGER NOT NULL,
        command_json TEXT NOT NULL,
        acknowledgement_json TEXT NOT NULL,
        PRIMARY KEY (session_id, sequence),
        UNIQUE (session_id, generation, producer_id, producer_sequence)
      )
    `);
    this.database.run(`
      CREATE TABLE IF NOT EXISTS session_operation (
        session_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        operation_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        history_revision INTEGER NOT NULL,
        kind TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('intent', 'accepted', 'completed', 'uncertain', 'abandoned')),
        result_ref TEXT,
        PRIMARY KEY (session_id, generation, operation_id)
      )
    `);
    this.database.run(`
      CREATE TABLE IF NOT EXISTS session_surface (
        surface_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        UNIQUE (session_id, generation)
      )
    `);
    this.database.run(`
      CREATE TABLE IF NOT EXISTS session_compaction (
        session_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        operation_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        history_revision INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'prepared', 'received', 'validated', 'persisted', 'accepted', 'rejected'
        )),
        checkpoint_ref TEXT,
        PRIMARY KEY (session_id, generation, operation_id)
      )
    `);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  operation(sessionId: string, generation: number, operationId: string): OperationRow | null {
    return this.database.query<OperationRow, [string, number, string]>(`
      SELECT session_id AS sessionId, generation, operation_id AS operationId,
        turn_id AS turnId, history_revision AS historyRevision, kind, state,
        result_ref AS resultRef
      FROM session_operation
      WHERE session_id = ? AND generation = ? AND operation_id = ?
    `).get(sessionId, generation, operationId);
  }

  uncertainBrowserSendOperations(): Array<OperationRow> {
    return this.database.query<OperationRow, []>(`
      SELECT session_id AS sessionId, generation, operation_id AS operationId,
        turn_id AS turnId, history_revision AS historyRevision, kind, state,
        result_ref AS resultRef
      FROM session_operation
      WHERE state = 'uncertain' AND kind = 'browser_send'
      ORDER BY session_id, generation, operation_id
    `).all();
  }

  activeBrowserOwner(operationId: string): { sessionId: string; generation: number; turnId: string } | null {
    const owners = this.database.query<{
      sessionId: string;
      generation: number;
      turnId: string;
    }, [string]>(`
      SELECT operation.session_id AS sessionId, operation.generation,
        operation.turn_id AS turnId
      FROM session_operation AS operation
      JOIN session_actor AS session
        ON session.session_id = operation.session_id
        AND session.generation = operation.generation
      WHERE operation.operation_id = ? AND operation.kind = 'browser_send'
        AND operation.state IN ('intent', 'accepted')
      LIMIT 2
    `).all(operationId);
    if (owners.length > 1) throw new Error("Browser trace has ambiguous session ownership");
    return owners[0] ?? null;
  }

  nativeTurnOwners(ownershipKey: string, turnId: string): Array<{
    sessionId: string;
    generation: number;
    turnId: string;
  }> {
    return this.database.query<{
      sessionId: string;
      generation: number;
      turnId: string;
    }, [string, string]>(`
      SELECT session_id AS sessionId, generation, turn_id AS turnId
      FROM session_actor
      WHERE turn_id = ? AND substr(session_id, -65) = ':' || ?
    `).all(turnId, ownershipKey);
  }

  currentTurnOwners(): Array<{ sessionId: string; generation: number; turnId: string }> {
    return this.database.query<{
      sessionId: string;
      generation: number;
      turnId: string;
    }, []>(`
      SELECT actor.session_id AS sessionId, actor.generation,
        actor.turn_id AS turnId
      FROM session_actor AS actor
      WHERE actor.turn_id IS NOT NULL AND (
        EXISTS (
          SELECT 1 FROM session_operation AS operation
          WHERE operation.session_id = actor.session_id
            AND operation.generation = actor.generation
            AND operation.turn_id = actor.turn_id
            AND operation.state IN ('intent', 'accepted')
        )
        OR EXISTS (
          SELECT 1 FROM session_compaction AS checkpoint
          WHERE checkpoint.session_id = actor.session_id
            AND checkpoint.generation = actor.generation
            AND checkpoint.turn_id = actor.turn_id
            AND checkpoint.state IN ('prepared', 'received', 'validated', 'persisted')
        )
        OR (
          NOT EXISTS (
            SELECT 1 FROM session_operation AS operation
            WHERE operation.session_id = actor.session_id
              AND operation.generation = actor.generation
              AND operation.turn_id = actor.turn_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM session_compaction AS checkpoint
            WHERE checkpoint.session_id = actor.session_id
              AND checkpoint.generation = actor.generation
              AND checkpoint.turn_id = actor.turn_id
          )
        )
      )
      ORDER BY actor.session_id
    `).all();
  }

  surfaceOwner(surfaceId: string): { sessionId: string; generation: number } | null {
    return this.database.query<{ sessionId: string; generation: number }, [string]>(`
      SELECT session_id AS sessionId, generation
      FROM session_surface WHERE surface_id = ?
    `).get(surfaceId);
  }

  surfaceForSession(sessionId: string, generation: number): string | null {
    const row = this.database.query<{ surfaceId: string }, [string, number]>(`
      SELECT surface_id AS surfaceId FROM session_surface
      WHERE session_id = ? AND generation = ?
    `).get(sessionId, generation);
    return row?.surfaceId ?? null;
  }

  revokedSurfaces(sessionId: string): Array<{ surfaceId: string; generation: number }> {
    return this.database.query<{
      surfaceId: string;
      generation: number;
    }, [string]>(`
      SELECT surface.surface_id AS surfaceId, surface.generation
      FROM session_surface AS surface
      JOIN session_actor AS actor ON actor.session_id = surface.session_id
      WHERE surface.session_id = ? AND surface.generation < actor.generation
      ORDER BY surface.generation, surface.surface_id
    `).all(sessionId);
  }

  snapshot(sessionId: string): SessionRow | null {
    return this.database.query<SessionRow, [string]>(`
      SELECT generation, sequence, turn_id AS turnId,
        history_revision AS historyRevision, compaction_epoch AS compactionEpoch
      FROM session_actor WHERE session_id = ?
    `).get(sessionId);
  }

  compaction(
    sessionId: string,
    generation: number,
    operationId: string,
  ): (CompactionRow & { turnId: string }) | null {
    return this.database.query<CompactionRow & { turnId: string }, [string, number, string]>(`
      SELECT turn_id AS turnId, state, history_revision AS historyRevision,
        checkpoint_ref AS checkpointRef
      FROM session_compaction
      WHERE session_id = ? AND generation = ? AND operation_id = ?
    `).get(sessionId, generation, operationId);
  }

  findLocalTransition(
    sessionId: string,
    generation: number,
    type: SessionCommand["type"],
    operationId: string,
  ): { command: SessionCommand; acknowledgement: SessionAcknowledgement } | null {
    const row = this.database.query<EventRow, [string, number, string, string]>(`
      SELECT command_json AS commandJson, acknowledgement_json AS acknowledgementJson
      FROM session_event
      WHERE session_id = ? AND generation = ?
        AND json_extract(command_json, '$.type') = ?
        AND json_extract(command_json, '$.operationId') = ?
      ORDER BY sequence LIMIT 1
    `).get(sessionId, generation, type, operationId);
    return row ? {
      command: JSON.parse(row.commandJson) as SessionCommand,
      acknowledgement: JSON.parse(row.acknowledgementJson) as SessionAcknowledgement,
    } : null;
  }

  nextProducerSequence(sessionId: string, generation: number, producerId: string): number {
    const row = this.database.query<{ latest: number | null }, [string, number, string]>(`
      SELECT MAX(producer_sequence) AS latest FROM session_event
      WHERE session_id = ? AND generation = ? AND producer_id = ?
    `).get(sessionId, generation, producerId);
    return (row?.latest ?? 0) + 1;
  }

  apply(command: SessionCommand): SessionAcknowledgement {
    assertCommand(command);
    return this.database.transaction(() => this.applyTransaction(command))();
  }

  reconcileOperation(
    sessionId: string,
    generation: number,
    operationId: string,
    outcome: "not_sent" | "completed",
    evidenceRef: string,
  ): number {
    if (!evidenceRef || evidenceRef.length > 256) {
      throw new Error("Session actor reconciliation requires an evidence reference");
    }
    return this.database.transaction(() => {
      const operation = this.operation(sessionId, generation, operationId);
      const session = this.snapshot(sessionId);
      if (!operation || operation.state !== "uncertain" || !session) {
        throw new Error("Session actor operation is not pending reconciliation");
      }
      const state = outcome === "not_sent" ? "abandoned" : "completed";
      this.database.query(`
        UPDATE session_operation SET state = ?, result_ref = ?
        WHERE session_id = ? AND generation = ? AND operation_id = ?
      `).run(state, evidenceRef, sessionId, generation, operationId);
      const sequence = session.sequence + 1;
      this.database.query("UPDATE session_actor SET sequence = ? WHERE session_id = ?")
        .run(sequence, sessionId);
      const event = {
        protocolVersion: SESSION_ACTOR_PROTOCOL_VERSION,
        sessionId,
        generation,
        turnId: operation.turnId,
        operationId,
        producerId: "recovery",
        producerSequence: sequence,
        type: "operation_reconciled",
        outcome,
        evidenceRef,
      };
      this.database.query(`
        INSERT INTO session_event
        (session_id, generation, sequence, producer_id, producer_sequence, command_json, acknowledgement_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(sessionId, generation, sequence, "recovery", sequence,
        canonicalJson(event), JSON.stringify({ status: "accepted", sequence }));
      return sequence;
    })();
  }

  private applyTransaction(command: SessionCommand): SessionAcknowledgement {
    const current = this.snapshot(command.sessionId);
    const generation = current?.generation ?? 1;
    if (command.generation !== generation) {
      return { status: "stale_generation", currentGeneration: generation };
    }
    const existing = this.database.query<EventRow, [string, number, string, number]>(`
      SELECT command_json AS commandJson, acknowledgement_json AS acknowledgementJson
      FROM session_event
      WHERE session_id = ? AND generation = ? AND producer_id = ? AND producer_sequence = ?
    `).get(command.sessionId, command.generation, command.producerId, command.producerSequence);
    if (existing) {
      if (existing.commandJson !== canonicalJson(command)) {
        throw new Error("Session actor duplicate producer sequence has different contents");
      }
      return JSON.parse(existing.acknowledgementJson) as SessionAcknowledgement;
    }
    const producer = this.database.query<{ latest: number }, [string, number, string]>(`
      SELECT MAX(producer_sequence) AS latest FROM session_event
      WHERE session_id = ? AND generation = ? AND producer_id = ?
    `).get(command.sessionId, generation, command.producerId);
    const expected = (producer?.latest ?? 0) + 1;
    if (command.producerSequence !== expected) {
      return { status: "recovery_required", expectedProducerSequence: expected };
    }
    if (!current) {
      this.database.query("INSERT INTO session_actor VALUES (?, 1, 0, NULL, 0, 0)").run(command.sessionId);
    }
    this.applyEffect(command, current ?? {
      generation: 1,
      sequence: 0,
      turnId: null,
      historyRevision: 0,
      compactionEpoch: 0,
    });
    const sequence = (current?.sequence ?? 0) + 1;
    const acknowledgement: SessionAcknowledgement = { status: "accepted", sequence };
    this.database.query("UPDATE session_actor SET sequence = ? WHERE session_id = ?")
      .run(sequence, command.sessionId);
    this.database.query(`
      INSERT INTO session_event
      (session_id, generation, sequence, producer_id, producer_sequence, command_json, acknowledgement_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      command.sessionId,
      command.generation,
      sequence,
      command.producerId,
      command.producerSequence,
      canonicalJson(command),
      JSON.stringify(acknowledgement),
    );
    return acknowledgement;
  }

  private applyEffect(command: SessionCommand, session: SessionRow): void {
    const operation = () => this.operation(command.sessionId, command.generation, command.operationId);
    if (command.type === "turn_started") {
      if (session.turnId && session.turnId !== command.turnId) {
        const active = this.database.query<{ count: number }, [string, number]>(`
          SELECT COUNT(*) AS count FROM session_operation
          WHERE session_id = ? AND generation = ? AND state IN ('intent', 'accepted')
        `).get(command.sessionId, command.generation)?.count ?? 0;
        if (active > 0) throw new Error("Session actor cannot replace a turn with pending effects");
      }
      this.database.query("UPDATE session_actor SET turn_id = ? WHERE session_id = ?")
        .run(command.turnId, command.sessionId);
      return;
    }
    if (command.type === "generation_revoked") {
      if (session.turnId !== command.turnId) {
        throw new Error("Session actor revocation turn ownership changed");
      }
      this.database.query(`
        UPDATE session_operation SET state = 'uncertain'
        WHERE session_id = ? AND generation = ? AND state IN ('intent', 'accepted')
      `).run(command.sessionId, command.generation);
      this.database.query(`
        UPDATE session_actor SET generation = generation + 1, turn_id = NULL
        WHERE session_id = ?
      `).run(command.sessionId);
      return;
    }
    if (command.type === "surface_reconciled") {
      if (!command.surfaceId || !Number.isSafeInteger(command.surfaceGeneration)
        || command.surfaceGeneration! < 1
        || command.surfaceGeneration! >= session.generation) {
        throw new Error("Session actor revoked surface generation is invalid");
      }
      const removed = this.database.query(`
        DELETE FROM session_surface
        WHERE surface_id = ? AND session_id = ? AND generation = ?
      `).run(command.surfaceId, command.sessionId, command.surfaceGeneration!);
      if (removed.changes !== 1) {
        throw new Error("Session actor revoked surface release owner mismatch");
      }
      return;
    }
    if (session.turnId !== command.turnId) {
      throw new Error("Session actor turn ownership mismatch");
    }
    if (command.type === "operation_intent") {
      if (!command.operationKind || !Number.isSafeInteger(command.historyRevision)
        || command.historyRevision !== session.historyRevision) {
        throw new Error("Session actor operation revision or kind is invalid");
      }
      if (command.operationKind === "tool_result_delivery") {
        const parent = command.parentOperationId
          ? this.operation(command.sessionId, command.generation, command.parentOperationId)
          : null;
        const emitted = this.findLocalTransition(
          command.sessionId,
          command.generation,
          "tool_call_emitted",
          `tool-call:${command.operationId.slice("tool-result:".length)}`,
        );
        if (!parent || parent.kind !== "browser_send" || parent.turnId !== command.turnId
          || parent.historyRevision !== session.historyRevision || parent.state !== "accepted"
          || !emitted || emitted.command.parentOperationId !== command.parentOperationId
          || emitted.command.turnId !== command.turnId) {
          throw new Error("Session actor tool result requires an emitted call on the accepted browser turn");
        }
      }
      if (operation()) throw new Error("Session actor operation id is already registered");
      const uncertain = this.database.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM session_operation
        WHERE session_id = ? AND state = 'uncertain'
      `).get(command.sessionId)?.count ?? 0;
      if (uncertain > 0) {
        throw new Error("Session actor requires reconciliation before another external effect");
      }
      this.database.query(`
        INSERT INTO session_operation VALUES (?, ?, ?, ?, ?, ?, 'intent', NULL)
      `).run(
        command.sessionId,
        command.generation,
        command.operationId,
        command.turnId,
        command.historyRevision,
        command.operationKind,
      );
      return;
    }
    if (command.type === "operation_accepted" || command.type === "operation_completed"
      || command.type === "operation_uncertain") {
      const pending = operation();
      if (!pending || pending.turnId !== command.turnId
        || pending.historyRevision !== session.historyRevision) {
        throw new Error("Session actor operation ownership or revision mismatch");
      }
      if (command.type === "operation_accepted") {
        if (pending.state !== "intent") throw new Error("Session actor operation acceptance is out of order");
        this.database.query(`
          UPDATE session_operation SET state = 'accepted'
          WHERE session_id = ? AND generation = ? AND operation_id = ?
        `).run(command.sessionId, command.generation, command.operationId);
      } else if (command.type === "operation_completed") {
        if (pending.state !== "accepted" || !command.resultRef) {
          throw new Error("Session actor operation result is out of order or unreferenced");
        }
        this.database.query(`
          UPDATE session_operation SET state = 'completed', result_ref = ?
          WHERE session_id = ? AND generation = ? AND operation_id = ?
        `).run(command.resultRef, command.sessionId, command.generation, command.operationId);
      } else {
        if (pending.state !== "intent" && pending.state !== "accepted") {
          throw new Error("Session actor operation cannot become uncertain after completion");
        }
        this.database.query(`
          UPDATE session_operation SET state = 'uncertain'
          WHERE session_id = ? AND generation = ? AND operation_id = ?
        `).run(command.sessionId, command.generation, command.operationId);
      }
      return;
    }
    if (command.type === "tool_batch_observed" || command.type === "tool_call_prepared"
      || command.type === "tool_call_emitted") {
      const parent = command.parentOperationId
        ? this.operation(command.sessionId, command.generation, command.parentOperationId)
        : null;
      const confirmed = command.type === "tool_call_prepared" || command.type === "tool_call_emitted"
        ? this.findLocalTransition(
          command.sessionId,
          command.generation,
          "tool_batch_observed",
          `batch-confirmed:${command.parentOperationId}:${command.toolBatchRevision}`,
        )
        : null;
      if (!parent || parent.kind !== "browser_send" || parent.turnId !== command.turnId
        || parent.historyRevision !== session.historyRevision
        || parent.state !== "accepted"
        || command.historyRevision !== session.historyRevision
        || !Number.isSafeInteger(command.toolBatchRevision)
        || command.toolBatchRevision! < 1) {
        throw new Error("Session actor tool call owner or revision mismatch on accepted browser turn");
      }
      if ((command.type === "tool_call_prepared" || command.type === "tool_call_emitted") && (!confirmed
        || confirmed.command.parentOperationId !== command.parentOperationId
        || confirmed.command.turnId !== command.turnId)) {
        throw new Error("Session actor tool call requires an observed batch at the same revision");
      }
      if (command.type === "tool_call_emitted") {
        const prepared = this.findLocalTransition(
          command.sessionId,
          command.generation,
          "tool_call_prepared",
          command.operationId,
        );
        if (!prepared || prepared.command.parentOperationId !== command.parentOperationId
          || prepared.command.toolBatchRevision !== command.toolBatchRevision
          || prepared.command.turnId !== command.turnId) {
          throw new Error("Session actor tool emission requires a prepared call");
        }
      }
      return;
    }
    if (command.type.startsWith("compaction_")) {
      const compacted = this.database.query<CompactionRow, [string, number, string]>(`
        SELECT state, history_revision AS historyRevision, checkpoint_ref AS checkpointRef
        FROM session_compaction
        WHERE session_id = ? AND generation = ? AND operation_id = ?
      `).get(command.sessionId, command.generation, command.operationId);
      if (command.type === "compaction_prepared") {
        if (compacted) throw new Error("Session actor checkpoint operation already exists");
        const active = this.database.query<{ count: number }, [string, number]>(`
          SELECT COUNT(*) AS count FROM session_compaction
          WHERE session_id = ? AND generation = ?
            AND state IN ('prepared', 'received', 'validated', 'persisted')
        `).get(command.sessionId, command.generation)?.count ?? 0;
        if (active > 0) throw new Error("Session actor checkpoint transaction is already active");
        this.database.query(`
          INSERT INTO session_compaction VALUES (?, ?, ?, ?, ?, 'prepared', NULL)
        `).run(command.sessionId, command.generation, command.operationId,
          command.turnId, session.historyRevision);
        return;
      }
      if (!compacted || compacted.historyRevision !== session.historyRevision) {
        throw new Error("Session actor checkpoint revision mismatch");
      }
      const expected: Record<string, CompactionRow["state"]> = {
        compaction_received: "prepared",
        compaction_validated: "received",
        compaction_persisted: "validated",
        compaction_accepted: "persisted",
      };
      if (command.type === "compaction_rejected") {
        if (!["prepared", "received", "validated"].includes(compacted.state)) {
          throw new Error("Session actor checkpoint rejection is out of order");
        }
        this.database.query(`
          UPDATE session_compaction SET state = 'rejected'
          WHERE session_id = ? AND generation = ? AND operation_id = ?
        `).run(command.sessionId, command.generation, command.operationId);
        return;
      }
      if (compacted.state !== expected[command.type]) {
        throw new Error("Session actor checkpoint transition is out of order");
      }
      if (command.type === "compaction_received" && !command.checkpointRef) {
        throw new Error("Session actor checkpoint reference is required");
      }
      if (command.type === "compaction_received") {
        this.database.query(`
          UPDATE session_compaction SET state = 'received', checkpoint_ref = ?
          WHERE session_id = ? AND generation = ? AND operation_id = ?
        `).run(command.checkpointRef!, command.sessionId, command.generation, command.operationId);
      } else {
        if (!compacted.checkpointRef) throw new Error("Session actor checkpoint is unreferenced");
        const state = command.type.slice("compaction_".length);
        this.database.query(`
          UPDATE session_compaction SET state = ?
          WHERE session_id = ? AND generation = ? AND operation_id = ?
        `).run(state, command.sessionId, command.generation, command.operationId);
        if (command.type === "compaction_accepted") {
          this.database.query(`
            UPDATE session_actor
            SET history_revision = history_revision + 1, compaction_epoch = compaction_epoch + 1
            WHERE session_id = ?
          `).run(command.sessionId);
        }
      }
      return;
    }
    if (!command.surfaceId) throw new Error("Session actor surface id is required");
    if (command.type === "surface_claimed") {
      const owner = this.database.query<{ sessionId: string; generation: number }, [string]>(`
        SELECT session_id AS sessionId, generation FROM session_surface WHERE surface_id = ?
      `).get(command.surfaceId);
      if (owner && (owner.sessionId !== command.sessionId || owner.generation !== command.generation)) {
        throw new Error("Browser surface is already owned by another session or generation");
      }
      const prior = this.database.query<{ surfaceId: string }, [string, number]>(`
        SELECT surface_id AS surfaceId FROM session_surface
        WHERE session_id = ? AND generation = ?
      `).get(command.sessionId, command.generation);
      if (prior && prior.surfaceId !== command.surfaceId) {
        throw new Error("Session actor generation already owns another browser surface");
      }
      this.database.query(`
        INSERT OR IGNORE INTO session_surface VALUES (?, ?, ?)
      `).run(command.surfaceId, command.sessionId, command.generation);
      return;
    }
    if (command.type === "surface_released") {
      const removed = this.database.query(`
        DELETE FROM session_surface
        WHERE surface_id = ? AND session_id = ? AND generation = ?
      `).run(command.surfaceId, command.sessionId, command.generation);
      if (removed.changes !== 1) throw new Error("Session actor surface release owner mismatch");
      return;
    }
    throw new Error("Session actor event type is unsupported");
  }

  private recoverInterrupted(): void {
    this.database.transaction(() => {
      const interrupted = this.database.query<OperationRow, []>(`
        SELECT session_id AS sessionId, generation, operation_id AS operationId,
          turn_id AS turnId, history_revision AS historyRevision, kind, state,
          result_ref AS resultRef
        FROM session_operation WHERE state IN ('intent', 'accepted')
        ORDER BY session_id, generation, operation_id
      `).all();
      for (const item of interrupted) {
        this.database.query(`
          UPDATE session_operation SET state = 'uncertain'
          WHERE session_id = ? AND generation = ? AND operation_id = ?
        `).run(item.sessionId, item.generation, item.operationId);
        const row = this.snapshot(item.sessionId);
        if (!row) throw new Error("Session actor journal has an orphan operation");
        const sequence = row.sequence + 1;
        this.database.query("UPDATE session_actor SET sequence = ? WHERE session_id = ?")
          .run(sequence, item.sessionId);
        const command = {
          protocolVersion: SESSION_ACTOR_PROTOCOL_VERSION,
          sessionId: item.sessionId,
          generation: item.generation,
          turnId: item.turnId,
          operationId: item.operationId,
          producerId: "recovery",
          producerSequence: sequence,
          type: "operation_uncertain",
        };
        this.database.query(`
          INSERT INTO session_event
          (session_id, generation, sequence, producer_id, producer_sequence, command_json, acknowledgement_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.sessionId,
          item.generation,
          sequence,
          "recovery",
          sequence,
          canonicalJson(command),
          JSON.stringify({ status: "accepted", sequence }),
        );
      }
    })();
  }
}

/** Per-session serial mailbox. Effects run outside this mailbox and report back as commands. */
