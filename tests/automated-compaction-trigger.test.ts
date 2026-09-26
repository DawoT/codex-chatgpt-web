import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CodexMessage } from "../src/types";
import {
  evaluateAutonomousCompactionNeeded,
  saveTurnCheckpoint,
  listTurnCheckpoints,
  validateCompactionQuality,
  mergeCompactionIntoWorkspaceState,
  type TurnCheckpoint,
  type AutonomousCompactionContext,
} from "../src/adapters/chatgpt-web/autonomous-compaction";
import {
  readWorkspaceState,
  writeWorkspaceState,
  defaultWorkspaceState,
} from "../src/adapters/chatgpt-web/workspace-state";

describe("Sprint Y: Autonomous Memory Compaction & Turn Checkpoints", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cgw-sprint-y-test-"));
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("evaluateAutonomousCompactionNeeded", () => {
    it("returns false when context pressure and turn count are within safe bounds", () => {
      const context: AutonomousCompactionContext = {
        turnCount: 5,
        estimatedTokens: 30_000,
        capacityTokens: 100_000,
        consecutiveUncompactedTurns: 5,
      };
      expect(evaluateAutonomousCompactionNeeded(context)).toBe(false);
    });

    it("triggers compaction when estimated tokens exceed 85% of capacity", () => {
      const context: AutonomousCompactionContext = {
        turnCount: 10,
        estimatedTokens: 86_000,
        capacityTokens: 100_000,
        consecutiveUncompactedTurns: 10,
      };
      expect(evaluateAutonomousCompactionNeeded(context)).toBe(true);
    });

    it("triggers compaction when consecutive uncompacted turns reach 20 turns limit", () => {
      const context: AutonomousCompactionContext = {
        turnCount: 22,
        estimatedTokens: 40_000,
        capacityTokens: 100_000,
        consecutiveUncompactedTurns: 20,
      };
      expect(evaluateAutonomousCompactionNeeded(context)).toBe(true);
    });

    it("triggers compaction when actionRequired is trigger_compaction", () => {
      const context: AutonomousCompactionContext = {
        turnCount: 8,
        estimatedTokens: 50_000,
        capacityTokens: 100_000,
        actionRequired: "trigger_compaction",
      };
      expect(evaluateAutonomousCompactionNeeded(context)).toBe(true);
    });
  });

  describe("saveTurnCheckpoint and listTurnCheckpoints", () => {
    it("atomically saves checkpoint JSON file under .agents/checkpoints/", () => {
      const checkpoint: Omit<TurnCheckpoint, "timestamp"> = {
        epoch: 1,
        turnCount: 15,
        stateSnapshot: defaultWorkspaceState(),
        compactSummary: "Sprint T & U successfully completed with state retention.",
        prunedFileReferences: ["src/adapters/chatgpt-web/tool-spooler.ts"],
      };

      const filePath = saveTurnCheckpoint(testDir, checkpoint);
      expect(existsSync(filePath)).toBe(true);

      const content = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(content.epoch).toBe(1);
      expect(content.turnCount).toBe(15);
      expect(content.compactSummary).toContain("Sprint T & U");
      expect(content.timestamp).toBeDefined();
    });

    it("lists checkpoints ordered descending by epoch and timestamp", () => {
      for (let i = 1; i <= 3; i++) {
        saveTurnCheckpoint(testDir, {
          epoch: i,
          turnCount: i * 10,
          stateSnapshot: null,
          compactSummary: `Checkpoint for epoch ${i}`,
          prunedFileReferences: [],
        });
      }

      const checkpoints = listTurnCheckpoints(testDir);
      expect(checkpoints.length).toBe(3);
      expect(checkpoints[0].epoch).toBe(3);
      expect(checkpoints[1].epoch).toBe(2);
      expect(checkpoints[2].epoch).toBe(1);
    });

    it("enforces retention limit by rotating and deleting oldest checkpoints", () => {
      const maxRetention = 3;
      for (let i = 1; i <= 6; i++) {
        saveTurnCheckpoint(
          testDir,
          {
            epoch: i,
            turnCount: i * 5,
            stateSnapshot: null,
            compactSummary: `Summary epoch ${i}`,
            prunedFileReferences: [],
          },
          maxRetention,
        );
      }

      const checkpoints = listTurnCheckpoints(testDir);
      expect(checkpoints.length).toBe(3);
      const epochs = checkpoints.map(c => c.epoch);
      expect(epochs).toEqual([6, 5, 4]);

      const checkpointDir = join(testDir, ".agents", "checkpoints");
      const files = readdirSync(checkpointDir).filter(f => f.endsWith(".json"));
      expect(files.length).toBe(3);
    });
  });

  describe("validateCompactionQuality (Quality Gate)", () => {
    it("fails validation if summary is empty or too brief", () => {
      const messages: CodexMessage[] = [
        { role: "user", content: "Implement spooling in src/adapters/tool-spooler.ts", timestamp: 1000 },
      ];
      const result = validateCompactionQuality(messages, "Done.");
      expect(result.valid).toBe(false);
      expect(result.missingInvariants).toContain("Summary is too short or empty (minimum 50 chars required)");
    });

    it("fails validation if critical files modified in conversation are omitted in summary", () => {
      const messages: CodexMessage[] = [
        {
          role: "user",
          content: "Modify src/adapters/chatgpt-web/tool-spooler.ts and tests/tool-spooler.test.ts to support head/tail.",
          timestamp: 1001,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "I have edited src/adapters/chatgpt-web/tool-spooler.ts with spooling logic." }],
          timestamp: 1002,
        },
      ];

      const incompleteSummary =
        "The conversation completed work on some tool output features, but doesn't mention which files were modified.";

      const result = validateCompactionQuality(messages, incompleteSummary);
      expect(result.valid).toBe(false);
      expect(result.missingInvariants.some(inv => inv.includes("tool-spooler.ts"))).toBe(true);
    });

    it("passes validation when summary accurately references all key files and decisions", () => {
      const messages: CodexMessage[] = [
        {
          role: "user",
          content: "Update src/adapters/chatgpt-web/tool-spooler.ts and tests/tool-output-spooler.test.ts",
          timestamp: 1003,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Completed editing src/adapters/chatgpt-web/tool-spooler.ts with head/tail offload." }],
          timestamp: 1004,
        },
      ];

      const robustSummary =
        "Successfully updated src/adapters/chatgpt-web/tool-spooler.ts with head/tail offload and added coverage in tests/tool-output-spooler.test.ts passing 100%.";

      const result = validateCompactionQuality(messages, robustSummary);
      expect(result.valid).toBe(true);
      expect(result.missingInvariants).toEqual([]);
      expect(result.detectedFiles).toContain("src/adapters/chatgpt-web/tool-spooler.ts");
    });
  });

  describe("mergeCompactionIntoWorkspaceState", () => {
    it("merges new milestones into .agents/STATE.md without losing prior completed items", () => {
      const initialState = defaultWorkspaceState();
      initialState.goal = "Build robust ChatGPT Web MCP harness";
      initialState.activePhase = "Sprint U";
      initialState.completedMilestones = ["Sprint T: Tool Output Spooler"];
      initialState.invariantsAndDecisions = ["Preserve canonical 9 MCP tools"];

      writeWorkspaceState(testDir, initialState);

      const summary = "Completed Sprint U persistent state in .agents/STATE.md.";
      const newMilestones = ["Sprint U: Persistent Workspace State (.agents/STATE.md)"];

      const updatedState = mergeCompactionIntoWorkspaceState(testDir, summary, newMilestones);

      expect(updatedState.completedMilestones).toContain("Sprint T: Tool Output Spooler");
      expect(updatedState.completedMilestones).toContain("Sprint U: Persistent Workspace State (.agents/STATE.md)");
      expect(updatedState.invariantsAndDecisions).toContain("Preserve canonical 9 MCP tools");

      // Verify re-reading from disk reflects the merged state
      const reloaded = readWorkspaceState(testDir);
      expect(reloaded).not.toBeNull();
      expect(reloaded?.completedMilestones.length).toBe(2);
    });

    it("does not insert duplicate milestones if already present", () => {
      const initialState = defaultWorkspaceState();
      initialState.completedMilestones = ["Sprint T: Spooler"];
      writeWorkspaceState(testDir, initialState);

      const updatedState = mergeCompactionIntoWorkspaceState(
        testDir,
        "Finished additional work",
        ["Sprint T: Spooler", "Sprint V: Lazy Skills"],
      );

      expect(updatedState.completedMilestones.length).toBe(2);
      expect(updatedState.completedMilestones).toEqual(["Sprint T: Spooler", "Sprint V: Lazy Skills"]);
    });
  });
});
