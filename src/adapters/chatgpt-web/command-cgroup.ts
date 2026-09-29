import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CommandCgroup {
  procsPath: string;
  kill(): boolean;
  release(): void;
}

export const CGROUP_SHELL_COMMAND =
  'printf "%s\\n" "$$" > "$CODEX_CHILD_CGROUP_PROCS" || exit 125; exec /bin/bash -c "$CODEX_CHILD_COMMAND"';

export function commandCgroupEnv(cgroup: CommandCgroup, command: string): Record<string, string> {
  return { CODEX_CHILD_CGROUP_PROCS: cgroup.procsPath, CODEX_CHILD_COMMAND: command };
}

/** Optional Linux cgroup v2 containment for descendants that leave the process group. */
export function createCommandCgroup(): CommandCgroup | undefined {
  if (process.platform !== "linux") return undefined;
  let path: string | undefined;
  try {
    const current = readFileSync("/proc/self/cgroup", "utf8")
      .split("\n")
      .find((line) => line.startsWith("0::"))
      ?.slice(3);
    if (!current?.startsWith("/") || current.includes("..")) return undefined;
    const parent = join("/sys/fs/cgroup", current);
    path = join(parent, `codex-command-${randomBytes(12).toString("hex")}`);
    mkdirSync(path, { mode: 0o700 });
    if (!existsSync(join(path, "cgroup.kill"))) {
      rmdirSync(path);
      return undefined;
    }
    accessSync(join(path, "cgroup.procs"), constants.W_OK);
  } catch {
    if (path) {
      try {
        rmdirSync(path);
      } catch {}
    }
    return undefined;
  }
  if (!path) return undefined;

  let released = false;
  return {
    procsPath: join(path, "cgroup.procs"),
    kill() {
      try {
        writeFileSync(join(path, "cgroup.kill"), "1");
        return true;
      } catch {
        return false;
      }
    },
    release() {
      if (released) return;
      released = true;
      let attempts = 0;
      const remove = () => {
        try {
          rmdirSync(path);
        } catch {
          attempts += 1;
          if (attempts < 20) setTimeout(remove, 100).unref();
        }
      };
      remove();
    },
  };
}
