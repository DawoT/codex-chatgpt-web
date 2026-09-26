import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  pruneScratchDirectory,
  spoolToolOutput,
  resolveProjectScratchDirectory,
  type PruningPolicy,
} from "../src/adapters/chatgpt-web/tool-spooler";
import {
  gcSubagentWorkspaces,
  resolveSubagentWorkspace,
  resolveSubagentScratchDir,
  writeSubagentResult,
  listSubagentWorkspaces,
} from "../src/adapters/chatgpt-web/subagent-workspace";

describe("Sprint Z: Storage Hygiene, Rolling Retention & Subagent GC", () => {
  let testWorkspace: string;
  let testScratchDir: string;

  beforeEach(() => {
    testWorkspace = mkdtempSync(join(tmpdir(), "cgw-sprint-z-test-"));
    testScratchDir = join(testWorkspace, ".agents", "scratch", "outputs");
    mkdirSync(testScratchDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testWorkspace, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  describe("pruneScratchDirectory", () => {
    it("prunes files exceeding maxAgeMs (TTL)", () => {
      // Create 3 files: 2 old (48h ago) and 1 fresh
      const oldFile1 = join(testScratchDir, "tool_old1_aaa.log");
      const oldFile2 = join(testScratchDir, "tool_old2_bbb.log");
      const freshFile = join(testScratchDir, "tool_fresh_ccc.log");

      writeFileSync(oldFile1, "old log content 1");
      writeFileSync(oldFile2, "old log content 2");
      writeFileSync(freshFile, "fresh log content");

      const pastTime = (Date.now() - 48 * 3600 * 1000) / 1000;
      utimesSync(oldFile1, pastTime, pastTime);
      utimesSync(oldFile2, pastTime, pastTime);

      const policy: PruningPolicy = {
        maxAgeMs: 24 * 3600 * 1000, // 24h
        maxFiles: 100,
        maxBytes: 10 * 1024 * 1024,
      };

      const result = pruneScratchDirectory(testScratchDir, policy);
      expect(result.deletedCount).toBe(2);
      expect(existsSync(oldFile1)).toBe(false);
      expect(existsSync(oldFile2)).toBe(false);
      expect(existsSync(freshFile)).toBe(true);
      expect(result.remainingCount).toBe(1);
    });

    it("enforces maxFiles limit by removing oldest files first (FIFO)", () => {
      const now = Date.now();
      // Create 5 files with sequential timestamps
      for (let i = 1; i <= 5; i++) {
        const file = join(testScratchDir, `log_${i.toString().padStart(2, "0")}.log`);
        writeFileSync(file, `content of file ${i}`);
        const timestamp = (now - (10 - i) * 1000) / 1000;
        utimesSync(file, timestamp, timestamp);
      }

      const policy: PruningPolicy = {
        maxFiles: 3,
      };

      const result = pruneScratchDirectory(testScratchDir, policy);
      expect(result.deletedCount).toBe(2);
      expect(result.remainingCount).toBe(3);

      // Oldest 2 files (log_01, log_02) should be deleted
      expect(existsSync(join(testScratchDir, "log_01.log"))).toBe(false);
      expect(existsSync(join(testScratchDir, "log_02.log"))).toBe(false);

      // Newest 3 files should be preserved
      expect(existsSync(join(testScratchDir, "log_03.log"))).toBe(true);
      expect(existsSync(join(testScratchDir, "log_04.log"))).toBe(true);
      expect(existsSync(join(testScratchDir, "log_05.log"))).toBe(true);
    });

    it("enforces maxBytes limit by pruning oldest files until under budget", () => {
      const now = Date.now();
      // Create 4 files of 1000 bytes each (total 4000 bytes)
      for (let i = 1; i <= 4; i++) {
        const file = join(testScratchDir, `size_test_${i}.log`);
        writeFileSync(file, "x".repeat(1000));
        const timestamp = (now - (10 - i) * 1000) / 1000;
        utimesSync(file, timestamp, timestamp);
      }

      // Budget allows only 2500 bytes -> oldest 2 must be deleted to fit under 2500 bytes
      const policy: PruningPolicy = {
        maxBytes: 2500,
      };

      const result = pruneScratchDirectory(testScratchDir, policy);
      expect(result.deletedCount).toBe(2);
      expect(result.remainingCount).toBe(2);
      expect(result.remainingBytes).toBeLessThanOrEqual(2500);

      expect(existsSync(join(testScratchDir, "size_test_1.log"))).toBe(false);
      expect(existsSync(join(testScratchDir, "size_test_2.log"))).toBe(false);
      expect(existsSync(join(testScratchDir, "size_test_3.log"))).toBe(true);
      expect(existsSync(join(testScratchDir, "size_test_4.log"))).toBe(true);
    });

    it("opportunistically prunes during spoolToolOutput writes", () => {
      // Seed 5 existing log files
      const now = Date.now();
      for (let i = 1; i <= 5; i++) {
        const file = join(testScratchDir, `hist_log_${i}.log`);
        writeFileSync(file, `log entry ${i}`);
        const timestamp = (now - (10 - i) * 1000) / 1000;
        utimesSync(file, timestamp, timestamp);
      }

      // Spool a new output with maxFiles = 3 policy
      const largeOutput = "a\n".repeat(1500); // >2500 chars
      const spooled = spoolToolOutput(largeOutput, {
        workspaceRoot: testWorkspace,
        pruningPolicy: { maxFiles: 3 },
      });

      expect(spooled.spooled).toBe(true);
      const remainingLogs = readdirSync(testScratchDir).filter(f => f.endsWith(".log"));
      expect(remainingLogs.length).toBeLessThanOrEqual(3);
    });
  });

  describe("gcSubagentWorkspaces", () => {
    it("purges scratch/ directory of completed subagents while preserving result.json", () => {
      const subagentId = "subagent-task-01";
      resolveSubagentWorkspace(testWorkspace, subagentId);
      const scratchDir = resolveSubagentScratchDir(testWorkspace, subagentId);

      // Create a scratch file in subagent workspace
      writeFileSync(join(scratchDir, "tool_run.log"), "massive output log");
      expect(existsSync(join(scratchDir, "tool_run.log"))).toBe(true);

      // Write completed result
      writeSubagentResult(testWorkspace, subagentId, {
        status: "completed",
        summary: "Task finished successfully",
      });

      const report = gcSubagentWorkspaces(testWorkspace);
      expect(report.cleanedScratchDirs).toContain(subagentId);

      // Scratch log should be cleaned
      expect(existsSync(join(scratchDir, "tool_run.log"))).toBe(false);

      // result.json should be preserved
      const subWs = resolveSubagentWorkspace(testWorkspace, subagentId);
      expect(existsSync(join(subWs, "result.json"))).toBe(true);
    });

    it("retains only maxWorkspaces completed subagents, deleting oldest excess workspaces", () => {
      const now = Date.now();
      // Create 5 completed subagents
      for (let i = 1; i <= 5; i++) {
        const id = `subagent-batch-${i.toString().padStart(2, "0")}`;
        const wsDir = resolveSubagentWorkspace(testWorkspace, id);
        writeSubagentResult(testWorkspace, id, {
          status: "completed",
          summary: `Summary of ${id}`,
        });

        // Artificially space their modification times
        const timestamp = (now - (10 - i) * 1000) / 1000;
        utimesSync(wsDir, timestamp, timestamp);
      }

      expect(listSubagentWorkspaces(testWorkspace).length).toBe(5);

      // GC with maxWorkspaces = 3
      const report = gcSubagentWorkspaces(testWorkspace, { maxWorkspaces: 3 });
      expect(report.purgedWorkspaces.length).toBe(2);

      const remaining = listSubagentWorkspaces(testWorkspace);
      expect(remaining.length).toBe(3);
      expect(remaining).not.toContain("subagent-batch-01");
      expect(remaining).not.toContain("subagent-batch-02");
      expect(remaining).toContain("subagent-batch-03");
      expect(remaining).toContain("subagent-batch-04");
      expect(remaining).toContain("subagent-batch-05");
    });

    it("does not delete active or blocked subagents", () => {
      const activeId = "subagent-still-running";
      resolveSubagentWorkspace(testWorkspace, activeId);
      writeSubagentResult(testWorkspace, activeId, {
        status: "blocked",
        summary: "Waiting on user input",
      });

      const report = gcSubagentWorkspaces(testWorkspace, { maxWorkspaces: 0 });
      expect(report.purgedWorkspaces).not.toContain(activeId);
      expect(listSubagentWorkspaces(testWorkspace)).toContain(activeId);
    });
  });
});
