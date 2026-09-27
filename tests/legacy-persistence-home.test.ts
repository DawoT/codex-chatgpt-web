import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCheckpointsDirectory } from "../src/adapters/chatgpt-web/autonomous-compaction";
import { listSubagentWorkspaces, resolveSubagentWorkspace } from "../src/adapters/chatgpt-web/subagent-workspace";
import { defaultWorkspaceState, readWorkspaceState, resolveWorkspaceStatePath, serializeWorkspaceState } from "../src/adapters/chatgpt-web/workspace-state";

test("legacy persistence paths and readers consistently honor the configured bridge home", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-legacy-home-"));
  const previous = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  try {
    const stateDir = join(root, "workspaces", "default");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "STATE.md"), serializeWorkspaceState({ ...defaultWorkspaceState(), goal: "isolated fixture" }));
    mkdirSync(join(root, "subagents", "isolated-agent"), { recursive: true });
    expect(readWorkspaceState()?.goal === "isolated fixture").toBeTrue();
    expect(listSubagentWorkspaces()).toEqual(["isolated-agent"]);
    expect(resolveWorkspaceStatePath()).toBe(join(stateDir, "STATE.md"));
    expect(resolveCheckpointsDirectory()).toBe(join(root, "checkpoints", "default"));
    expect(resolveSubagentWorkspace(undefined, "isolated-agent")).toBe(join(root, "subagents", "isolated-agent"));
  } finally {
    if (previous === undefined) {
      delete process.env.CODEX_CHATGPT_WEB_HOME;
    } else {
      process.env.CODEX_CHATGPT_WEB_HOME = previous;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
