import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureWorkspaceState,
  parseWorkspaceState,
  readWorkspaceState,
  resolveWorkspaceStatePath,
  serializeWorkspaceState,
  writeWorkspaceState,
  type WorkspaceState,
} from "../src/adapters/chatgpt-web/workspace-state";

describe("Sprint U: Persistent Workspace State (.agents/STATE.md)", () => {
  function makeTempWorkspace(): string {
    const root = join(tmpdir(), `cgw-state-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(root, { recursive: true });
    return root;
  }

  test("resolveWorkspaceStatePath targets .agents/STATE.md in workspace root", () => {
    const workspace = makeTempWorkspace();
    try {
      const statePath = resolveWorkspaceStatePath(workspace);
      expect(statePath).toBe(join(workspace, ".agents", "STATE.md"));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("resolveWorkspaceStatePath falls back cleanly when workspace is missing or unwritable", () => {
    const fallback = resolveWorkspaceStatePath(undefined);
    expect(fallback).toContain(".codex-chatgpt-web");
    expect(fallback).toContain("STATE.md");
  });

  test("serializeWorkspaceState and parseWorkspaceState provide round-trip fidelity", () => {
    const original: WorkspaceState = {
      goal: "Implement contextual resilience and local spooling",
      activePhase: "Sprint U: Persistent State",
      completedMilestones: [
        "Sprint T: MCP Tool Output Offloading",
        "Bundle verification & deployment",
      ],
      invariantsAndDecisions: [
        "Never kill Codex Desktop processes",
        "Tool threshold set at 2500 chars",
      ],
      blockersAndOpenItems: [
        "Lazy loading of skills scheduled for Sprint V",
      ],
      nextImmediateAction: "Run TDD test suite for Sprint U",
      lastUpdatedIso: "2026-09-24T21:50:00.000Z",
    };

    const markdown = serializeWorkspaceState(original);
    expect(markdown).toContain("# Agent Workspace State");
    expect(markdown).toContain("Sprint U: Persistent State");
    expect(markdown).toContain("- [x] Sprint T: MCP Tool Output Offloading");
    expect(markdown).toContain("- [ ] Lazy loading of skills scheduled for Sprint V");

    const parsed = parseWorkspaceState(markdown);
    expect(parsed.goal).toBe(original.goal);
    expect(parsed.activePhase).toBe(original.activePhase);
    expect(parsed.completedMilestones).toEqual(original.completedMilestones);
    expect(parsed.invariantsAndDecisions).toEqual(original.invariantsAndDecisions);
    expect(parsed.blockersAndOpenItems).toEqual(original.blockersAndOpenItems);
    expect(parsed.nextImmediateAction).toBe(original.nextImmediateAction);
    expect(parsed.lastUpdatedIso).toBe(original.lastUpdatedIso);
  });

  test("parseWorkspaceState gracefully handles partial, malformed, or missing sections", () => {
    const partialMarkdown = `
# Agent Workspace State

## Goal & Mission
Simple goal description

## Completed Milestones
- [x] Done item A
- Plain item B
`;
    const parsed = parseWorkspaceState(partialMarkdown);
    expect(parsed.goal).toBe("Simple goal description");
    expect(parsed.completedMilestones).toContain("Done item A");
    expect(parsed.completedMilestones).toContain("Plain item B");
    expect(parsed.activePhase).toBe("");
    expect(parsed.invariantsAndDecisions).toEqual([]);
    expect(parsed.blockersAndOpenItems).toEqual([]);
    expect(parsed.nextImmediateAction).toBe("");
  });

  test("writeWorkspaceState atomically persists .agents/STATE.md to disk", () => {
    const workspace = makeTempWorkspace();
    try {
      const state: WorkspaceState = {
        goal: "Test Atomic Write",
        activePhase: "Testing",
        completedMilestones: ["Step 1"],
        invariantsAndDecisions: ["Decision 1"],
        blockersAndOpenItems: [],
        nextImmediateAction: "Assert file exists",
        lastUpdatedIso: new Date().toISOString(),
      };

      writeWorkspaceState(workspace, state);

      const targetFile = join(workspace, ".agents", "STATE.md");
      expect(existsSync(targetFile)).toBe(true);

      const loaded = readWorkspaceState(workspace);
      expect(loaded).not.toBeNull();
      expect(loaded?.goal).toBe("Test Atomic Write");
      expect(loaded?.completedMilestones).toEqual(["Step 1"]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("ensureWorkspaceState initializes default template if file does not exist", () => {
    const workspace = makeTempWorkspace();
    try {
      const state = ensureWorkspaceState(workspace, {
        goal: "Default Goal",
        activePhase: "Phase 1",
      });

      expect(state.goal).toBe("Default Goal");
      expect(state.activePhase).toBe("Phase 1");

      const targetFile = join(workspace, ".agents", "STATE.md");
      expect(existsSync(targetFile)).toBe(true);

      const content = readFileSync(targetFile, "utf-8");
      expect(content).toContain("Default Goal");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("readWorkspaceState returns null when .agents/STATE.md does not exist", () => {
    const workspace = makeTempWorkspace();
    try {
      const state = readWorkspaceState(workspace);
      expect(state).toBeNull();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("compileChatGptWebPrompt instructs compaction to retain persistent workspace state", async () => {
    const { compileChatGptWebPrompt } = await import("../src/adapters/chatgpt-web/prompt");
    const { CHATGPT_WEB_MODEL_ID } = await import("../src/adapters/chatgpt-web/model");
    const compactionRequest = {
      modelId: CHATGPT_WEB_MODEL_ID,
      _compactionRequest: true,
      options: { reasoning: "high" },
      context: {
        messages: [
          { role: "user" as const, content: "Initial task", timestamp: 1 },
          { role: "assistant" as const, content: [{ type: "text" as const, text: "Working..." }], timestamp: 2 },
          { role: "user" as const, content: "Summarize status now", timestamp: 3 },
        ],
      },
    } as any;

    const compiled = compileChatGptWebPrompt(compactionRequest, {
      localToolsEnabled: false,
      solAvailable: true,
      extraHighAvailable: true,
      proAvailable: true,
    });

    expect(compiled.text).toContain("CRITICAL WORKSPACE STATE RETENTION");
    expect(compiled.text).toContain(".agents/STATE.md");
  });
});

