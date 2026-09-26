import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  resolveProjectScratchDirectory,
  sanitizeToolOutputWithSpooler,
  spoolToolOutput,
} from "../src/adapters/chatgpt-web/tool-spooler";
import {
  defaultWorkspaceState,
  ensureWorkspaceState,
  readWorkspaceState,
  writeWorkspaceState,
  resolveWorkspaceStatePath,
} from "../src/adapters/chatgpt-web/workspace-state";
import {
  scanSkillsDirectory,
  buildLazySkillsIndex,
  transformSkillsInstructionsBlock,
} from "../src/adapters/chatgpt-web/lazy-skills";
import {
  resolveSubagentWorkspace,
  resolveSubagentScratchDir,
  writeSubagentResult,
  readSubagentResult,
  listSubagentWorkspaces,
} from "../src/adapters/chatgpt-web/subagent-workspace";
import {
  evaluatePreflightBudget,
  applyPreflightPredictivePruning,
  preparePreflightInput,
  PREFLIGHT_SAFE_INLINE_CHAR_LIMIT,
} from "../src/adapters/chatgpt-web/preflight-budget";
import {
  saveTurnCheckpoint,
  listTurnCheckpoints,
  validateCompactionQuality,
  mergeCompactionIntoWorkspaceState,
  evaluateAutonomousCompactionNeeded,
} from "../src/adapters/chatgpt-web/autonomous-compaction";
import type { CodexMessage, CodexParsedRequest } from "../src/types";

describe("E2E Real Temporary Repository Workflow Verification", () => {
  let realRepoDir: string;

  beforeEach(() => {
    realRepoDir = mkdtempSync(join(tmpdir(), "codex-real-repo-"));
    // Initialize a real Git repository in the temporary workspace
    execSync("git init", { cwd: realRepoDir, stdio: "ignore" });
    execSync('git config user.name "Codex Test"', { cwd: realRepoDir, stdio: "ignore" });
    execSync('git config user.email "test@codex.local"', { cwd: realRepoDir, stdio: "ignore" });

    // Create a dummy commit
    writeFileSync(join(realRepoDir, "README.md"), "# Test Project\nTemporary testing ground for Codex ChatGPT Web harness.");
    execSync("git add README.md && git commit -m 'Initial commit'", { cwd: realRepoDir, stdio: "ignore" });
  });

  afterEach(() => {
    try {
      rmSync(realRepoDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it("Step 1: Spooling of massive tool output into real .agents/scratch/outputs/", () => {
    const scratchOutputs = resolveProjectScratchDirectory(realRepoDir);
    expect(existsSync(scratchOutputs)).toBe(true);
    expect(scratchOutputs).toBe(join(realRepoDir, ".agents", "scratch", "outputs"));

    // Generate a simulated massive command output (e.g. 120,000 characters with 1,000 lines)
    const largeOutputLines: string[] = [];
    for (let i = 1; i <= 1000; i++) {
      largeOutputLines.push(`line ${i}: compiled asset module chunk #${i} with hash 8f9b4c0e2a4d`);
    }
    const massiveOutput = largeOutputLines.join("\n");
    expect(massiveOutput.length).toBeGreaterThan(60_000);

    const spooled = spoolToolOutput(massiveOutput, { workspaceRoot: realRepoDir });

    // Assert that the returned summary is concise and structured
    expect(spooled.spooled).toBe(true);
    expect(spooled.text.length).toBeLessThan(4_000);
    expect(spooled.text).toContain("Output truncated and offloaded to disk: 1000 lines");
    expect(spooled.text).toContain(".agents/scratch/outputs/");
    expect(spooled.text).toContain("--- Head (first 15 lines) ---");
    expect(spooled.text).toContain("--- Tail (last 15 lines) ---");
    expect(spooled.text).toContain("line 1:");
    expect(spooled.text).toContain("line 1000:");

    // Verify that the actual log file was created on disk in the real repo
    const logFiles = readdirSync(scratchOutputs).filter(f => f.endsWith(".log"));
    expect(logFiles.length).toBe(1);

    const logContent = readFileSync(join(scratchOutputs, logFiles[0]), "utf-8");
    expect(logContent).toBe(massiveOutput);
  });

  it("Step 2: Workspace persistent state lifecycle (.agents/STATE.md)", () => {
    const statePath = resolveWorkspaceStatePath(realRepoDir);
    expect(statePath).toBe(join(realRepoDir, ".agents", "STATE.md"));

    // Ensure state creates template when absent
    const state = ensureWorkspaceState(realRepoDir);
    expect(existsSync(statePath)).toBe(true);
    expect(state.goal).toBe("");

    // Populate with real project mission and milestones
    state.goal = "Build high-throughput ChatGPT Web harness";
    state.activePhase = "Phase 5 Sprints T to Y";
    state.completedMilestones = [
      "Sprint T: MCP Tool Output Spooler",
      "Sprint U: Workspace State Persistence",
      "Sprint V: Lazy Skills Loading",
    ];
    state.invariantsAndDecisions = [
      "Never crash or touch Codex Desktop",
      "Inline safe limit is 65k chars",
    ];
    state.blockersAndOpenItems = [
      "Verify live end-to-end integration",
    ];
    state.nextImmediateAction = "Deploy and verify /healthz";

    writeWorkspaceState(realRepoDir, state);

    // Read back and verify complete persistence
    const reloaded = readWorkspaceState(realRepoDir);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.goal).toBe("Build high-throughput ChatGPT Web harness");
    expect(reloaded?.completedMilestones.length).toBe(3);
    expect(reloaded?.invariantsAndDecisions).toContain("Inline safe limit is 65k chars");
    expect(reloaded?.nextImmediateAction).toBe("Deploy and verify /healthz");

    // Check disk content directly
    const rawMarkdown = readFileSync(statePath, "utf-8");
    expect(rawMarkdown).toContain("# Agent Workspace State");
    expect(rawMarkdown).toContain("- [x] Sprint T: MCP Tool Output Spooler");
  });

  it("Step 3: Lazy Skills scanning and on-demand expansion in real .agents/skills/", () => {
    const skillsDir = join(realRepoDir, ".agents", "skills");
    mkdirSync(join(skillsDir, "cloud-deploy"), { recursive: true });
    mkdirSync(join(skillsDir, "db-migrate"), { recursive: true });

    // Create real SKILL.md files
    writeFileSync(
      join(skillsDir, "cloud-deploy", "SKILL.md"),
      `---\nname: cloud-deploy\ndescription: Deploys workers to Cloudflare infrastructure.\n---\n# Cloud Deploy Guide\nRun wrangler deploy.`,
    );
    writeFileSync(
      join(skillsDir, "db-migrate", "SKILL.md"),
      `---\nname: db-migrate\ndescription: Executes SQL migrations safely on production.\n---\n# DB Migration Guide\nRun prisma migrate deploy.`,
    );

    const discovered = scanSkillsDirectory(skillsDir);
    expect(discovered.length).toBe(2);
    expect(discovered.some(s => s.name === "cloud-deploy")).toBe(true);
    expect(discovered.some(s => s.name === "db-migrate")).toBe(true);

    const indexTable = buildLazySkillsIndex(discovered);
    expect(indexTable).toContain("| cloud-deploy | Deploys workers to Cloudflare infrastructure.");
    expect(indexTable).toContain("| db-migrate | Executes SQL migrations safely on production.");

    // Simulate an oversized <skills_instructions> block from Codex
    const fullBloatedXml = `
<skills_instructions>
<skill name="cloud-deploy">
<description>Deploys workers to Cloudflare infrastructure.</description>
${"Detailed deployment runbook and extensive documentation. ".repeat(200)}
</skill>
<skill name="db-migrate">
<description>Executes SQL migrations safely on production.</description>
${"Detailed database migration procedures and schema rules. ".repeat(200)}
</skill>
</skills_instructions>
`;
    expect(fullBloatedXml.length).toBeGreaterThan(15_000);

    // 1. Without invocation, transform to compact lazy table
    const compactXml = transformSkillsInstructionsBlock(fullBloatedXml, "Let's review the code.");
    expect(compactXml.length).toBeLessThan(1_500);
    expect(compactXml).toContain("## Available Skills (Load on Demand)");
    expect(compactXml).toContain("cloud-deploy");

    // 2. With explicit invocation ($cloud-deploy), only expand cloud-deploy
    const expandedXml = transformSkillsInstructionsBlock(fullBloatedXml, "Please run $cloud-deploy now.");
    expect(expandedXml).toContain('<skill name="cloud-deploy">');
    expect(expandedXml).not.toContain('<skill name="db-migrate">');
  });

  it("Step 4: Subagent workspace isolation (.agents/subagents/<id>/)", () => {
    const subagentId = "subagent-security-auditor-99";
    const subWsDir = resolveSubagentWorkspace(realRepoDir, subagentId);
    const subScratchDir = resolveSubagentScratchDir(realRepoDir, subagentId);

    expect(subWsDir).toBe(join(realRepoDir, ".agents", "subagents", subagentId));
    expect(subScratchDir).toBe(join(realRepoDir, ".agents", "subagents", subagentId, "scratch", "outputs"));
    expect(existsSync(subScratchDir)).toBe(true);

    // Simulate subagent running a tool that produces 80k output
    const subToolOutput = "ALERT: Potential vulnerability detected in auth.ts\n".repeat(1200);
    const spooled = spoolToolOutput(subToolOutput, {
      workspaceRoot: realRepoDir,
      subagentId,
    });

    expect(spooled.text).toContain(`.agents/subagents/${subagentId}/scratch/outputs/`);

    // Verify file is in subagent scratch, NOT in main repo scratch
    const subagentScratchFiles = readdirSync(subScratchDir);
    expect(subagentScratchFiles.length).toBe(1);

    const mainScratch = join(realRepoDir, ".agents", "scratch", "outputs");
    if (existsSync(mainScratch)) {
      const mainFiles = readdirSync(mainScratch);
      expect(mainFiles.length).toBe(0);
    }

    // Persist subagent structured result
    writeSubagentResult(realRepoDir, subagentId, {
      status: "completed",
      summary: "Auth token validation verified. Zero vulnerabilities found.",
      modified_files: ["src/auth.ts"],
    });

    const loadedResult = readSubagentResult(realRepoDir, subagentId);
    expect(loadedResult).not.toBeNull();
    expect(loadedResult?.status).toBe("completed");
    expect(loadedResult?.summary).toContain("Zero vulnerabilities found");

    const allSubagents = listSubagentWorkspaces(realRepoDir);
    expect(allSubagents).toContain(subagentId);
  });

  it("Step 5: Pre-flight Guardian & Predictive Pruning preventing HTTP 413 rejection", () => {
    // Construct a mock Codex request containing 5 sequential tool outputs that sum to 120k chars
    const messages: CodexMessage[] = [
      { role: "user", content: "Analyze these 5 large log dumps", timestamp: 1 },
    ];

    for (let i = 1; i <= 5; i++) {
      messages.push({
        role: "toolResult",
        toolCallId: `call_${i}`,
        toolName: "read_log_file",
        content: `Log dump ${i}:\n` + "2026-09-24 INFO Worker heartbeat healthy [ok]\n".repeat(400),
        isError: false,
        timestamp: 10 + i,
      });
    }

    const request: CodexParsedRequest = {
      modelId: "chatgpt-web:gpt-5",
      context: { messages },
      stream: true,
      options: {},
    };

    const mockCapabilities = {
      localToolsEnabled: true,
      solAvailable: false,
      extraHighAvailable: false,
      proAvailable: false,
    };

    const initialVerdict = evaluatePreflightBudget(
      request,
      mockCapabilities,
      {
        experimentalBiggerContext: false, // forces inline evaluation to test pruning
      },
    );

    expect(initialVerdict.safe).toBe(false);
    expect(initialVerdict.actionRequired).toBe("apply_pruning");
    expect(initialVerdict.prunableToolResultsCount).toBe(3); // 5 - 2 retained = 3

    // Apply preflight preparation
    const { input: preparedRequest, verdict: preparedVerdict } = preparePreflightInput(
      request,
      mockCapabilities,
      {
        experimentalBiggerContext: false,
      },
    );

    expect(preparedVerdict.actionRequired).toBe("apply_pruning");

    // Older 3 tool outputs pruned with informative tombstone
    const preparedMessages = preparedRequest.context.messages;
    expect(preparedMessages[1].role).toBe("toolResult");
    expect(preparedMessages[1].content).toContain("[Historical tool output pruned by Preflight Guardian: read_log_file completed");

    // Most recent 2 tool outputs preserved intact
    expect(preparedMessages[4].content).toContain("2026-09-24 INFO Worker heartbeat healthy");
    expect(preparedMessages[5].content).toContain("2026-09-24 INFO Worker heartbeat healthy");
  });

  it("Step 6: Autonomous compaction & turn checkpoints in real .agents/checkpoints/", () => {
    // 1. Evaluate need
    const needed = evaluateAutonomousCompactionNeeded({
      turnCount: 25,
      estimatedTokens: 90_000,
      capacityTokens: 100_000,
    });
    expect(needed).toBe(true);

    // 2. Save turn checkpoint
    const currentState = readWorkspaceState(realRepoDir);
    const checkpointFile = saveTurnCheckpoint(realRepoDir, {
      epoch: 1,
      turnCount: 25,
      stateSnapshot: currentState,
      compactSummary: "Checkpoint summary: verified tool spooler, state sync, and preflight budget in test-repo.",
      prunedFileReferences: ["src/adapters/chatgpt-web/index.ts", "src/adapters/chatgpt-web/tool-spooler.ts"],
    });

    expect(existsSync(checkpointFile)).toBe(true);

    const checkpoints = listTurnCheckpoints(realRepoDir);
    expect(checkpoints.length).toBe(1);
    expect(checkpoints[0].epoch).toBe(1);
    expect(checkpoints[0].turnCount).toBe(25);

    // 3. Quality Gate check
    const mockMessages: CodexMessage[] = [
      { role: "user", content: "Implement spooling in src/adapters/chatgpt-web/tool-spooler.ts and run tests.", timestamp: 1000 },
    ];
    const qualityValid = validateCompactionQuality(mockMessages, "Finished implementing in src/adapters/chatgpt-web/tool-spooler.ts with all tests passing.");
    expect(qualityValid.valid).toBe(true);

    // 4. Merge into .agents/STATE.md
    const updatedState = mergeCompactionIntoWorkspaceState(
      realRepoDir,
      "Finished milestone verification",
      ["Sprint W: Isolated Subagents", "Sprint X: Pre-flight Guardian", "Sprint Y: Autonomous Compaction"],
    );

    expect(updatedState.completedMilestones).toContain("Sprint Y: Autonomous Compaction");

    // Verify on disk
    const finalDiskState = readWorkspaceState(realRepoDir);
    expect(finalDiskState?.completedMilestones).toContain("Sprint Y: Autonomous Compaction");
  });
});
