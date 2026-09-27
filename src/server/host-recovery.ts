import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { HostProtocolError } from "./host-state";

interface Admission {
  version: 1;
  scope: string;
  turnId: string;
  requestDigest: string;
  admittedAt: number;
  order: number;
}

interface Completion {
  version: 1;
  scope: string;
  turnId: string;
  sequence: number;
  responseId: string;
  completedAt: number;
}

interface Cancellation {
  version: 1;
  scope: string;
  turnId: string;
  state: "requested" | "settled";
  observedAt: number;
}

export interface HostRecoveryStatus {
  scope: "bridge-model-only";
  turn_id: string | null;
  state: "unobserved" | "admitted" | "model-completed" | "cancelled";
  cancellation: "requested" | "settled" | null;
  last_completed_sequence: number | null;
  last_completed_response_id: string | null;
  replay_allowed: false;
}

const MAX_RECORD_BYTES = 8192;
const MAX_TURNS = 4096;
const MAX_DIRECTORY_ENTRIES = 32768;

function fileDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Durable model metadata only. No capability, prompt, result body, or replay authority. */
export class HostRecoveryStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  admitTurn(scope: string, turnId: string, requestDigest: string): void {
    this.validateIdentity(scope, turnId);
    if (!/^[a-f0-9]{64}$/.test(requestDigest)) throw new HostProtocolError(400, "Invalid host request digest");
    const directory = this.prepare(scope, true)!;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const admissions = this.listAdmissions(directory, scope);
      if (admissions.length >= MAX_TURNS) {
        throw new HostProtocolError(429, "Host recovery turn capacity reached");
      }
      if (admissions.some(claim => claim.turnId === turnId)
        || this.readCompletion(directory, scope, turnId)
        || this.readCancellation(directory, scope, turnId)) {
        throw new HostProtocolError(409, "Host turn was already admitted; inspect recovery before new work");
      }
      const order = admissions.reduce((highest, claim) => Math.max(highest, claim.order), 0) + 1;
      const claim: Admission = {
        version: 1,
        scope,
        turnId,
        requestDigest,
        admittedAt: Date.now(),
        order,
      };
      try {
        this.publishClaim(this.claimPath(directory, order), claim, directory);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    throw new HostProtocolError(409, "Host recovery admission is busy; retry with a new user turn");
  }

  assertAdmitted(scope: string, turnId: string): void {
    this.validateIdentity(scope, turnId);
    const directory = this.prepare(scope, false);
    if (!directory || !this.readAdmission(directory, scope, turnId)) {
      throw new Error("Host recovery admission is missing; model execution blocked");
    }
  }

  complete(scope: string, turnId: string, sequence: number, responseId: string): void {
    this.validateIdentity(scope, turnId);
    if (!Number.isSafeInteger(sequence) || sequence < 1 || typeof responseId !== "string"
      || responseId.length < 1 || responseId.length > 256 || /[\x00-\x1f]/.test(responseId)) {
      throw new Error("Invalid host recovery completion");
    }
    const directory = this.prepare(scope, false);
    if (!directory) throw new Error("Host recovery admission is missing");
    const claim = this.readAdmission(directory, scope, turnId);
    if (!claim) throw new Error("Host recovery admission is missing");
    const current = this.readCompletion(directory, scope, turnId);
    if (current) {
      if (current.sequence > sequence) throw new Error("Host recovery completion moved backwards");
      if (current.sequence === sequence) {
        if (current.responseId !== responseId) throw new Error("Host recovery completion identity changed");
        return;
      }
    }
    const completion: Completion = {
      version: 1,
      scope,
      turnId,
      sequence,
      responseId,
      completedAt: Date.now(),
    };
    this.replaceAtomic(this.path(directory, turnId, "completed"), completion, directory);
  }

  markCancelled(scope: string, turnId: string, state: "requested" | "settled"): void {
    this.validateIdentity(scope, turnId);
    const directory = this.prepare(scope, false);
    if (!directory || !this.readAdmission(directory, scope, turnId)) return;
    const current = this.readCancellation(directory, scope, turnId);
    if (current?.state === "settled" || current?.state === state) return;
    const cancellation: Cancellation = {
      version: 1,
      scope,
      turnId,
      state,
      observedAt: Date.now(),
    };
    this.replaceAtomic(this.path(directory, turnId, "cancelled"), cancellation, directory);
  }

  inspectLatest(scope: string): HostRecoveryStatus {
    this.validateIdentity(scope);
    const directory = this.prepare(scope, false);
    const empty: HostRecoveryStatus = {
      scope: "bridge-model-only",
      turn_id: null,
      state: "unobserved",
      cancellation: null,
      last_completed_sequence: null,
      last_completed_response_id: null,
      replay_allowed: false,
    };
    if (!directory) return empty;
    const entries = readdirSync(directory);
    const admissions = this.listAdmissions(directory, scope, entries);
    const digests = new Set(admissions.map(claim => fileDigest(claim.turnId)));
    for (const name of entries) {
      if (name.endsWith(".completed.json") || name.endsWith(".cancelled.json")) {
        if (!digests.has(name.slice(0, 64))) throw new Error("Orphan host recovery outcome");
      }
    }
    const latest = admissions.at(-1);
    if (!latest) return empty;
    const completion = this.readCompletion(directory, scope, latest.turnId);
    const cancellation = this.readCancellation(directory, scope, latest.turnId);
    return {
      scope: "bridge-model-only",
      turn_id: latest.turnId,
      state: cancellation ? "cancelled" : completion ? "model-completed" : "admitted",
      cancellation: cancellation?.state ?? null,
      last_completed_sequence: completion?.sequence ?? null,
      last_completed_response_id: completion?.responseId ?? null,
      replay_allowed: false,
    };
  }

  private validateIdentity(scope: string, turnId?: string): void {
    if (!/^[a-f0-9]{64}$/.test(scope)
      || (turnId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(turnId))) {
      throw new HostProtocolError(400, "Invalid host recovery identity");
    }
  }

  private path(directory: string, turnId: string, kind: "completed" | "cancelled"): string {
    return join(directory, `${fileDigest(turnId)}.${kind}.json`);
  }

  private claimPath(directory: string, order: number): string {
    return join(directory, `${String(order).padStart(16, "0")}.claim.json`);
  }

  private listAdmissions(directory: string, scope: string, entries = readdirSync(directory)): Admission[] {
    if (entries.length > MAX_DIRECTORY_ENTRIES) throw new Error("Host recovery directory scan limit reached");
    const admissions: Admission[] = [];
    const seenTurns = new Set<string>();
    for (const name of entries) {
      if (!name.endsWith(".claim.json")) continue;
      const match = /^([0-9]{16})\.claim\.json$/.exec(name);
      const claim = match ? this.readRecord(join(directory, name)) as Admission | undefined : undefined;
      if (!claim || claim.version !== 1 || claim.scope !== scope
        || !/^[A-Za-z0-9_-]{1,128}$/.test(claim.turnId)
        || !/^[a-f0-9]{64}$/.test(claim.requestDigest)
        || !Number.isSafeInteger(claim.admittedAt)
        || claim.order !== Number(match![1]) || seenTurns.has(claim.turnId)) {
        throw new Error("Invalid host recovery admission");
      }
      seenTurns.add(claim.turnId);
      admissions.push(claim);
      if (admissions.length > MAX_TURNS) throw new Error("Host recovery turn capacity exceeded");
    }
    admissions.sort((a, b) => a.order - b.order);
    return admissions;
  }

  private prepare(scope: string, create: boolean): string | undefined {
    const parent = dirname(this.root);
    this.assertDirectory(parent, false);
    if (create) {
      this.createDirectory(this.root);
      this.createDirectory(join(this.root, scope));
    } else {
      try {
        this.assertDirectory(this.root, true);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    }
    const directory = join(this.root, scope);
    if (!create) {
      try {
        this.assertDirectory(directory, true);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    }
    return directory;
  }

  private createDirectory(path: string): void {
    try {
      mkdirSync(path, { mode: 0o700 });
      this.syncDirectory(dirname(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    this.assertDirectory(path, true);
  }

  private assertDirectory(path: string, privateMode: boolean): void {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()
      || (process.platform !== "win32" && (info.uid !== process.getuid?.()
        || (privateMode && (info.mode & 0o077) !== 0)))) {
      throw new Error("Host recovery storage is not a private owned directory");
    }
  }

  private writeExclusive(path: string, value: unknown, directory: string): void {
    const bytes = Buffer.from(JSON.stringify(value) + "\n");
    if (bytes.length > MAX_RECORD_BYTES) throw new Error("Host recovery record is too large");
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.syncDirectory(directory);
  }

  private publishClaim(path: string, claim: Admission, directory: string): void {
    const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
    this.writeExclusive(temporary, claim, directory);
    try {
      linkSync(temporary, path);
      this.syncDirectory(directory);
    } finally {
      unlinkSync(temporary);
      this.syncDirectory(directory);
    }
  }

  private replaceAtomic(path: string, value: unknown, directory: string): void {
    const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
    this.writeExclusive(temporary, value, directory);
    renameSync(temporary, path);
    this.syncDirectory(directory);
  }

  private readAdmission(directory: string, scope: string, turnId: string): Admission | undefined {
    return this.listAdmissions(directory, scope).find(claim => claim.turnId === turnId);
  }

  private readCompletion(directory: string, scope: string, turnId: string): Completion | undefined {
    const completion = this.readRecord(this.path(directory, turnId, "completed")) as Completion | undefined;
    if (completion && (completion.version !== 1 || completion.scope !== scope || completion.turnId !== turnId
      || !Number.isSafeInteger(completion.sequence) || completion.sequence < 1
      || typeof completion.responseId !== "string" || completion.responseId.length < 1
      || completion.responseId.length > 256 || /[\x00-\x1f]/.test(completion.responseId)
      || !Number.isSafeInteger(completion.completedAt))) {
      throw new Error("Invalid host recovery completion");
    }
    return completion;
  }

  private readCancellation(directory: string, scope: string, turnId: string): Cancellation | undefined {
    const cancellation = this.readRecord(this.path(directory, turnId, "cancelled")) as Cancellation | undefined;
    if (cancellation && (cancellation.version !== 1 || cancellation.scope !== scope
      || cancellation.turnId !== turnId || !["requested", "settled"].includes(cancellation.state)
      || !Number.isSafeInteger(cancellation.observedAt))) {
      throw new Error("Invalid host recovery cancellation");
    }
    return cancellation;
  }

  private readRecord(path: string): unknown | undefined {
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > MAX_RECORD_BYTES) throw new Error("Invalid host recovery record file");
      return JSON.parse(readFileSync(fd, "utf8"));
    } finally {
      closeSync(fd);
    }
  }

  private syncDirectory(path: string): void {
    if (process.platform === "win32") return;
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
