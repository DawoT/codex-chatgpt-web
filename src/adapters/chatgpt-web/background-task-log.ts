import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

interface FileIdentity {
  path: string;
  dev: number;
  ino: number;
}

export interface TaskLog {
  path: string;
  fd: number;
  identity: FileIdentity;
  directories: FileIdentity[];
}

/** Reject redirected scratch directories. This is not an OS sandbox for the shell. */
export function createTaskLog(cwd: string, taskId: string): TaskLog {
  const directories: FileIdentity[] = [];
  for (const path of [cwd, join(cwd, ".codex-tmp"), join(cwd, ".codex-tmp", "tasks")]) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Task log directory must not be a symlink");
    directories.push({ path, dev: stat.dev, ino: stat.ino });
  }
  const path = join(cwd, ".codex-tmp", "tasks", `${taskId}.log`);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const stat = fstatSync(fd);
    return { path, fd, identity: { path, dev: stat.dev, ino: stat.ino }, directories };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function unchangedDirectories(log: TaskLog): boolean {
  return log.directories.every(identity => {
    const stat = lstatSync(identity.path);
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino;
  });
}

export function readTaskLogTail(log: TaskLog, maxLines: number): string {
  if (!Number.isInteger(maxLines) || maxLines < 1) throw new Error("Task log lines must be a positive integer");
  let fd: number | undefined;
  try {
    if (!unchangedDirectories(log)) return "";
    const leaf = lstatSync(log.path);
    if (!leaf.isFile() || leaf.isSymbolicLink()) return "";
    fd = openSync(log.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== log.identity.dev || stat.ino !== log.identity.ino) return "";
    const readSize = Math.min(stat.size, 128 * 1024);
    if (readSize === 0) return "";
    const position = Math.max(0, stat.size - readSize);
    const buffer = Buffer.allocUnsafe(readSize);
    const bytesRead = readSync(fd, buffer, 0, readSize, position);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    if (position > 0 && lines.length > 1) lines.shift();
    return lines.slice(-maxLines).join("\n");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Never collect a substituted artifact. Concurrent hostile directory renames remain outside this guarantee. */
export function removeTaskLog(log: TaskLog): boolean {
  try {
    if (!unchangedDirectories(log)) return false;
    const stat = lstatSync(log.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== log.identity.dev || stat.ino !== log.identity.ino) return false;
    unlinkSync(log.path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}
