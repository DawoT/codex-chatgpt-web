import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

export interface WorkspaceState {
  goal: string;
  activePhase: string;
  completedMilestones: string[];
  invariantsAndDecisions: string[];
  blockersAndOpenItems: string[];
  nextImmediateAction: string;
  lastUpdatedIso: string;
  customSections?: Record<string, string>;
}

export function defaultWorkspaceState(): WorkspaceState {
  return {
    goal: "",
    activePhase: "",
    completedMilestones: [],
    invariantsAndDecisions: [],
    blockersAndOpenItems: [],
    nextImmediateAction: "",
    lastUpdatedIso: new Date().toISOString(),
  };
}

export function resolveWorkspaceStatePath(workspaceRoot?: string): string {
  if (workspaceRoot && typeof workspaceRoot === "string") {
    try {
      const agentsDir = join(workspaceRoot, ".agents");
      mkdirSync(agentsDir, { recursive: true });
      return join(agentsDir, "STATE.md");
    } catch {
      // Unwritable workspace root; fall through to home storage
    }
  }

  const fallbackDir = join(homedir(), ".codex-chatgpt-web", "workspaces", "default");
  try {
    mkdirSync(fallbackDir, { recursive: true });
  } catch {
    // Ignore fallback directory creation errors
  }
  return join(fallbackDir, "STATE.md");
}

export function resolveStateLockPath(workspaceRoot?: string): string {
  const statePath = resolveWorkspaceStatePath(workspaceRoot);
  return join(dirname(statePath), ".state.lock");
}

export interface StateLockOptions {
  timeoutMs?: number;
  retryIntervalMs?: number;
  staleLockTtlMs?: number;
}

function tryAcquireLockSync(lockPath: string, staleLockTtlMs: number): boolean {
  try {
    const fd = openSync(lockPath, "wx");
    const payload = JSON.stringify({ pid: process.pid, createdAt: Date.now() });
    writeFileSync(fd, payload, "utf-8");
    closeSync(fd);
    return true;
  } catch (error: unknown) {
    const code = error !== null && typeof error === "object" && "code" in error
      ? (error as { code: unknown }).code
      : undefined;

    if (code === "EEXIST") {
      // Check if stale by mtime
      try {
        const st = statSync(lockPath);
        const age = Date.now() - st.mtimeMs;
        if (age > staleLockTtlMs) {
          try { unlinkSync(lockPath); } catch {}
          return tryAcquireLockSync(lockPath, staleLockTtlMs);
        }
        // Check if owning PID is dead
        try {
          const raw = readFileSync(lockPath, "utf-8");
          const parsed = JSON.parse(raw);
          if (typeof parsed?.pid === "number") {
            try {
              process.kill(parsed.pid, 0);
            } catch (killErr: unknown) {
              const killCode = killErr !== null && typeof killErr === "object" && "code" in killErr
                ? (killErr as { code: unknown }).code
                : undefined;
              if (killCode === "ESRCH") {
                try { unlinkSync(lockPath); } catch {}
                return tryAcquireLockSync(lockPath, staleLockTtlMs);
              }
            }
          }
        } catch {}
      } catch {}
      return false;
    }
    throw error;
  }
}

export async function withStateLock<T>(
  workspaceRoot: string,
  action: () => Promise<T> | T,
  options: StateLockOptions = {},
): Promise<T> {
  const lockPath = resolveStateLockPath(workspaceRoot);
  const dir = dirname(lockPath);
  mkdirSync(dir, { recursive: true });

  const timeoutMs = options.timeoutMs ?? 5_000;
  const retryIntervalMs = options.retryIntervalMs ?? 25;
  const staleLockTtlMs = options.staleLockTtlMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;

  let acquired = false;
  while (!acquired) {
    acquired = tryAcquireLockSync(lockPath, staleLockTtlMs);
    if (!acquired) {
      if (Date.now() >= deadline) {
        throw new Error(`Timeout after ${timeoutMs}ms waiting to acquire state lock: ${lockPath}`);
      }
      await new Promise(res => setTimeout(res, retryIntervalMs));
    }
  }

  try {
    return await action();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {}
  }
}

export function withStateLockSync<T>(
  workspaceRoot: string,
  action: () => T,
  options: StateLockOptions = {},
): T {
  const lockPath = resolveStateLockPath(workspaceRoot);
  const dir = dirname(lockPath);
  mkdirSync(dir, { recursive: true });

  const timeoutMs = options.timeoutMs ?? 5_000;
  const retryIntervalMs = options.retryIntervalMs ?? 10;
  const staleLockTtlMs = options.staleLockTtlMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;

  let acquired = false;
  while (!acquired) {
    acquired = tryAcquireLockSync(lockPath, staleLockTtlMs);
    if (!acquired) {
      if (Date.now() >= deadline) {
        throw new Error(`Timeout after ${timeoutMs}ms waiting to acquire state lock: ${lockPath}`);
      }
      const waitTarget = Date.now() + retryIntervalMs;
      while (Date.now() < waitTarget) {
        // Synchronous spin wait
      }
    }
  }

  try {
    return action();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {}
  }
}

export async function updateWorkspaceState(
  workspaceRoot: string,
  updater: (current: WorkspaceState) => WorkspaceState | Promise<WorkspaceState>,
  options: StateLockOptions = {},
): Promise<WorkspaceState> {
  return withStateLock(
    workspaceRoot,
    async () => {
      const current = readWorkspaceState(workspaceRoot) ?? defaultWorkspaceState();
      const updated = await updater(current);
      updated.lastUpdatedIso = new Date().toISOString();
      writeWorkspaceState(workspaceRoot, updated);
      return updated;
    },
    options,
  );
}

export function serializeWorkspaceState(state: WorkspaceState): string {
  const lines: string[] = [
    "# Agent Workspace State",
    "",
    `> **Last Updated**: ${state.lastUpdatedIso || new Date().toISOString()}`,
    "",
    "## Goal & Mission",
    state.goal ? state.goal.trim() : "No goal defined yet.",
    "",
    "## Active Phase",
    state.activePhase ? state.activePhase.trim() : "None.",
    "",
    "## Completed Milestones",
  ];

  if (state.completedMilestones.length === 0) {
    lines.push("- (No completed milestones recorded)");
  } else {
    for (const item of state.completedMilestones) {
      lines.push(`- [x] ${item.trim()}`);
    }
  }

  lines.push("", "## Critical Decisions & Invariants");
  if (state.invariantsAndDecisions.length === 0) {
    lines.push("- (None recorded)");
  } else {
    for (const item of state.invariantsAndDecisions) {
      lines.push(`- ${item.trim()}`);
    }
  }

  lines.push("", "## Blockers & Open Items");
  if (state.blockersAndOpenItems.length === 0) {
    lines.push("- None.");
  } else {
    for (const item of state.blockersAndOpenItems) {
      lines.push(`- [ ] ${item.trim()}`);
    }
  }

  lines.push("", "## Next Immediate Action");
  lines.push(state.nextImmediateAction ? state.nextImmediateAction.trim() : "Await instructions.");
  lines.push("");

  return lines.join("\n");
}

function cleanListItem(line: string): string {
  let cleaned = line.replace(/^\s*[-*+]\s+/, "").trim();
  cleaned = cleaned.replace(/^\[[ xX]\]\s+/, "").trim();
  return cleaned;
}

export function parseWorkspaceState(markdown: string): WorkspaceState {
  const state = defaultWorkspaceState();
  if (!markdown || typeof markdown !== "string") return state;

  const sections = markdown.split(/\n(?=##\s+)/);

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    const lines = trimmed.split("\n");
    const headerMatch = lines[0].match(/^##\s+(.*)$/);
    if (!headerMatch) {
      // Check top-level block for Last Updated
      const dateMatch = trimmed.match(/>\s*\*\*Last Updated\*\*:\s*([^\n\r]+)/i);
      if (dateMatch) {
        state.lastUpdatedIso = dateMatch[1].trim();
      }
      continue;
    }

    const header = headerMatch[1].trim().toLowerCase();
    const contentLines = lines.slice(1).map(l => l.trim()).filter(Boolean);

    if (header.includes("goal") || header.includes("mission")) {
      state.goal = contentLines.filter(l => !l.startsWith(">")).join("\n").trim();
    } else if (header.includes("active phase") || header.includes("phase")) {
      state.activePhase = contentLines.join("\n").trim();
    } else if (header.includes("completed")) {
      state.completedMilestones = contentLines
        .filter(l => l.startsWith("-") || l.startsWith("*"))
        .map(cleanListItem)
        .filter(item => !item.startsWith("(No completed milestones"));
    } else if (header.includes("decisions") || header.includes("invariants")) {
      state.invariantsAndDecisions = contentLines
        .filter(l => l.startsWith("-") || l.startsWith("*"))
        .map(cleanListItem)
        .filter(item => !item.startsWith("(None recorded"));
    } else if (header.includes("blockers") || header.includes("open items")) {
      state.blockersAndOpenItems = contentLines
        .filter(l => l.startsWith("-") || l.startsWith("*"))
        .map(cleanListItem)
        .filter(item => !item.toLowerCase().startsWith("none"));
    } else if (header.includes("next") || header.includes("immediate")) {
      state.nextImmediateAction = contentLines.join("\n").trim();
    }
  }

  return state;
}

export function readWorkspaceState(workspaceRoot?: string): WorkspaceState | null {
  const filePath = resolveWorkspaceStatePath(workspaceRoot);
  if (!existsSync(filePath)) return null;

  try {
    const content = readFileSync(filePath, "utf-8");
    return parseWorkspaceState(content);
  } catch {
    return null;
  }
}

export function writeWorkspaceState(workspaceRoot: string, state: WorkspaceState): void {
  const filePath = resolveWorkspaceStatePath(workspaceRoot);
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const content = serializeWorkspaceState(state);
  const rand = randomBytes(4).toString("hex");
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${rand}`;

  try {
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, filePath);
  } catch (error) {
    // If atomic rename fails (e.g. across mount points), direct write as fallback
    try {
      writeFileSync(filePath, content, "utf-8");
    } catch {
      throw error;
    }
  }
}

export function ensureWorkspaceState(
  workspaceRoot?: string,
  defaults?: Partial<WorkspaceState>,
): WorkspaceState {
  const existing = readWorkspaceState(workspaceRoot);
  if (existing) return existing;

  const targetPath = resolveWorkspaceStatePath(workspaceRoot);
  const state: WorkspaceState = {
    ...defaultWorkspaceState(),
    ...defaults,
    lastUpdatedIso: new Date().toISOString(),
  };

  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(targetPath, serializeWorkspaceState(state), "utf-8");
  return state;
}
