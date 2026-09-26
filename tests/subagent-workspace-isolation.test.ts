import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cleanupSubagentWorkspace,
  listSubagentWorkspaces,
  readSubagentResult,
  resolveSubagentScratchDir,
  resolveSubagentWorkspace,
  writeSubagentResult,
  type SubagentWorkspaceInfo,
} from "../src/adapters/chatgpt-web/subagent-workspace";
import { spoolToolOutput } from "../src/adapters/chatgpt-web/tool-spooler";
import type { SubagentStructuredResult } from "../src/adapters/chatgpt-web/subagent-protocol";

describe("Sprint W: Subagentes Aislados con Workspace Local (.agents/subagents/<id>/)", () => {
  function makeTempWorkspace(): string {
    const root = join(tmpdir(), `cgw-subagent-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(root, { recursive: true });
    return root;
  }

  test("resolveSubagentWorkspace creates isolated directory and scratch outputs", () => {
    const workspace = makeTempWorkspace();
    try {
      const subagentId = "sub_worker_alpha";
      const subDir = resolveSubagentWorkspace(workspace, subagentId);

      expect(subDir).toBe(join(workspace, ".agents", "subagents", subagentId));
      expect(existsSync(subDir)).toBe(true);

      const scratchDir = resolveSubagentScratchDir(workspace, subagentId);
      expect(scratchDir).toBe(join(subDir, "scratch", "outputs"));
      expect(existsSync(scratchDir)).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("resolveSubagentWorkspace falls back safely when workspace is missing or invalid", () => {
    const fallback = resolveSubagentWorkspace(undefined, "sub_fallback_1");
    expect(fallback).toContain(".codex-chatgpt-web");
    expect(fallback).toContain("sub_fallback_1");
  });

  test("writeSubagentResult and readSubagentResult atomically persist and load result.json", () => {
    const workspace = makeTempWorkspace();
    try {
      const subagentId = "sub_writer_test";
      const result: SubagentStructuredResult = {
        status: "completed",
        summary: "Isolated task finished with all tests passing.",
        modified_files: ["src/feature.ts", "tests/feature.test.ts"],
        created_artifacts: ["reports/coverage.json"],
      };

      writeSubagentResult(workspace, subagentId, result);

      const loaded = readSubagentResult(workspace, subagentId);
      expect(loaded).not.toBeNull();
      expect(loaded?.status).toBe("completed");
      expect(loaded?.summary).toBe(result.summary);
      expect(loaded?.modified_files).toEqual(result.modified_files);
      expect(loaded?.created_artifacts).toEqual(result.created_artifacts);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("readSubagentResult returns null when result.json does not exist or is malformed", () => {
    const workspace = makeTempWorkspace();
    try {
      expect(readSubagentResult(workspace, "nonexistent")).toBeNull();

      // Write malformed file
      const subDir = resolveSubagentWorkspace(workspace, "bad_json");
      writeFileSync(join(subDir, "result.json"), "{ invalid json");
      expect(readSubagentResult(workspace, "bad_json")).toBeNull();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("listSubagentWorkspaces lists all registered subagent IDs under .agents/subagents", () => {
    const workspace = makeTempWorkspace();
    try {
      resolveSubagentWorkspace(workspace, "sub_agent_1");
      resolveSubagentWorkspace(workspace, "sub_agent_2");
      resolveSubagentWorkspace(workspace, "sub_agent_3");

      const list = listSubagentWorkspaces(workspace);
      expect(list.length).toBe(3);
      expect(list).toContain("sub_agent_1");
      expect(list).toContain("sub_agent_2");
      expect(list).toContain("sub_agent_3");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("cleanupSubagentWorkspace removes temporary scratch files while preserving result and artifacts", () => {
    const workspace = makeTempWorkspace();
    try {
      const subagentId = "sub_cleanup_target";
      const subDir = resolveSubagentWorkspace(workspace, subagentId);
      const scratchDir = resolveSubagentScratchDir(workspace, subagentId);

      // Create scratch file
      writeFileSync(join(scratchDir, "temp_execution.log"), "verbose output logs...");

      // Create declared artifact
      const artifactPath = join(subDir, "important_artifact.txt");
      writeFileSync(artifactPath, "artifact contents");

      // Write result
      writeSubagentResult(workspace, subagentId, {
        status: "completed",
        summary: "Done",
        created_artifacts: [artifactPath],
      });

      cleanupSubagentWorkspace(workspace, subagentId);

      // Scratch temp log should be removed or scratch dir cleaned
      expect(existsSync(join(scratchDir, "temp_execution.log"))).toBe(false);

      // Result and declared artifact should be preserved
      expect(existsSync(join(subDir, "result.json"))).toBe(true);
      expect(existsSync(artifactPath)).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("spoolToolOutput directs log files to subagent scratch space when subagentId is provided", () => {
    const workspace = makeTempWorkspace();
    try {
      const subagentId = "sub_spool_test";
      const oversizedOutput = "Line of output\n".repeat(250);

      const spooled = spoolToolOutput(oversizedOutput, {
        workspaceRoot: workspace,
        subagentId,
        toolName: "test_tool",
        callId: "call_abc123",
      });

      expect(spooled.spooled).toBe(true);
      expect(spooled.filePath).toBeDefined();
      expect(spooled.filePath).toContain(".agents/subagents/sub_spool_test/scratch/outputs");
      expect(existsSync(spooled.filePath!)).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
