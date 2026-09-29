/**
 * Content-addressed store for browser operation results. A persisted result
 * file is the completion evidence that lets startup recovery distinguish a
 * finished uncertain operation from one that must be abandoned.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface SessionResult {
  sessionId: string;
  generation: number;
  turnId: string;
  operationId: string;
  text: string;
}

interface StoredResult extends SessionResult {
  textSha256: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function resultRef(result: Pick<SessionResult, "sessionId" | "generation" | "turnId" | "operationId">): string {
  return digest(JSON.stringify([
    result.sessionId,
    result.generation,
    result.turnId,
    result.operationId,
  ]));
}

function sameResult(left: SessionResult, right: SessionResult): boolean {
  return left.sessionId === right.sessionId
    && left.generation === right.generation
    && left.turnId === right.turnId
    && left.operationId === right.operationId
    && left.text === right.text;
}

/** Immutable browser outcomes. The operation identity determines the file name. */
export class SessionResultStore {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || (process.platform !== "win32" && (
        metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0
      ))) {
      throw new Error("Session result store requires a private owned directory");
    }
  }

  referenceFor(identity: Pick<SessionResult, "sessionId" | "generation" | "turnId" | "operationId">): string {
    return resultRef(identity);
  }

  put(result: SessionResult): string {
    const ref = resultRef(result);
    const target = join(this.directory, `${ref}.json`);
    const stored: StoredResult = {
      ...result,
      textSha256: digest(result.text),
    };
    try {
      const prior = this.get(ref);
      if (!sameResult(prior, result)) {
        throw new Error("Session operation has a conflicting result");
      }
      return ref;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = join(this.directory, `.${ref}.${randomUUID()}.tmp`);
    try {
      const descriptor = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify(stored));
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      try {
        linkSync(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const prior = this.get(ref);
        if (!sameResult(prior, result)) {
          throw new Error("Session operation has a conflicting result");
        }
      }
    } finally {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (process.platform !== "win32") chmodSync(target, 0o600);
    if (process.platform !== "win32") {
      const directoryDescriptor = openSync(this.directory, "r");
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    }
    return ref;
  }

  get(ref: string): SessionResult {
    if (!/^[a-f0-9]{64}$/.test(ref)) {
      throw new Error("Session result reference is invalid");
    }
    const path = join(this.directory, `${ref}.json`);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()
      || (process.platform !== "win32" && (
        metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0
      ))) {
      throw new Error("Session result must be a private owned regular file");
    }
    const parsed = JSON.parse(readFileSync(path, "utf8")) as StoredResult;
    if (typeof parsed.sessionId !== "string" || !Number.isSafeInteger(parsed.generation)
      || typeof parsed.turnId !== "string" || typeof parsed.operationId !== "string"
      || typeof parsed.text !== "string" || typeof parsed.textSha256 !== "string"
      || resultRef(parsed) !== ref || digest(parsed.text) !== parsed.textSha256) {
      throw new Error("Session result integrity check failed");
    }
    const { textSha256: _unused, ...result } = parsed;
    return result;
  }
}
