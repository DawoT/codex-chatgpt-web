import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildLazySkillsIndex,
  parseSkillFrontmatter,
  scanSkillsDirectory,
  transformSkillsInstructionsBlock,
  type SkillMetadata,
} from "../src/adapters/chatgpt-web/lazy-skills";

describe("Sprint V: Lazy Loading de Skills (.agents/skills/ & index catalog)", () => {
  function makeTempDir(): string {
    const dir = join(tmpdir(), `cgw-skills-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  test("parseSkillFrontmatter extracts name and description from YAML frontmatter", () => {
    const markdown = `---
name: playwright-e2e
description: Browser automation and End-to-End testing with Playwright
---
# Playwright Instructions
Lots of detailed instructions here...
`;
    const meta = parseSkillFrontmatter(markdown, "/path/to/playwright/SKILL.md", "playwright");
    expect(meta.name).toBe("playwright-e2e");
    expect(meta.description).toBe("Browser automation and End-to-End testing with Playwright");
    expect(meta.location).toBe("/path/to/playwright/SKILL.md");
  });

  test("parseSkillFrontmatter falls back gracefully when frontmatter is missing or partial", () => {
    const markdown = `# Simple Skill
No frontmatter here, just instructions.
`;
    const meta = parseSkillFrontmatter(markdown, "/path/to/custom-tool/SKILL.md", "custom-tool");
    expect(meta.name).toBe("custom-tool");
    expect(meta.description).toBe("Simple Skill instructions");
    expect(meta.location).toBe("/path/to/custom-tool/SKILL.md");
  });

  test("scanSkillsDirectory discovers valid skills from directory tree", () => {
    const root = makeTempDir();
    try {
      // Skill 1: with frontmatter
      const skill1Dir = join(root, "tdd");
      mkdirSync(skill1Dir, { recursive: true });
      writeFileSync(
        join(skill1Dir, "SKILL.md"),
        `---
name: tdd-methodology
description: Test-Driven Development Red-Green-Refactor
---
Detailed guide...`
      );

      // Skill 2: without frontmatter
      const skill2Dir = join(root, "git-workflow");
      mkdirSync(skill2Dir, { recursive: true });
      writeFileSync(join(skill2Dir, "SKILL.md"), `# Git Workflow\nInstructions...`);

      // Unrelated directory without SKILL.md
      mkdirSync(join(root, "other-dir"), { recursive: true });

      const skills = scanSkillsDirectory(root);
      expect(skills.length).toBe(2);

      const tddSkill = skills.find(s => s.name === "tdd-methodology");
      expect(tddSkill).toBeDefined();
      expect(tddSkill?.description).toContain("Test-Driven Development");
      expect(tddSkill?.location).toBe(join(skill1Dir, "SKILL.md"));

      const gitSkill = skills.find(s => s.name === "git-workflow");
      expect(gitSkill).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("buildLazySkillsIndex creates a clean markdown table with load-on-demand guidance", () => {
    const skills: SkillMetadata[] = [
      {
        name: "tdd",
        description: "Test-Driven Development methodology",
        location: ".agents/skills/tdd/SKILL.md",
      },
      {
        name: "cloudflare",
        description: "Cloudflare Workers & Pages deployment",
        location: ".agents/skills/cloudflare/SKILL.md",
      },
    ];

    const table = buildLazySkillsIndex(skills);
    expect(table).toContain("## Available Skills (Load on Demand)");
    expect(table).toContain("| Skill Name | Purpose | Location |");
    expect(table).toContain("| tdd | Test-Driven Development methodology | .agents/skills/tdd/SKILL.md |");
    expect(table).toContain("| cloudflare | Cloudflare Workers & Pages deployment | .agents/skills/cloudflare/SKILL.md |");
    expect(table).toContain("codex_read_file");
  });

  test("transformSkillsInstructionsBlock compacts bloated XML skills into an indexed table", () => {
    const massiveContent = "x".repeat(30_000);
    const bloatedXml = `<skills_instructions>
<skill>
<name>heavy-analysis</name>
<description>Deep analysis tool</description>
<location>/home/user/skills/heavy/SKILL.md</location>
${massiveContent}
</skill>
<skill>
<name>code-review</name>
<description>Automated code review</description>
<location>/home/user/skills/review/SKILL.md</location>
${massiveContent}
</skill>
</skills_instructions>`;

    const transformed = transformSkillsInstructionsBlock(bloatedXml);

    // Ensure it drastically shrank
    expect(transformed.length).toBeLessThan(1_500);
    expect(transformed).toContain("Available Skills (Load on Demand)");
    expect(transformed).toContain("heavy-analysis");
    expect(transformed).toContain("code-review");
    expect(transformed).not.toContain(massiveContent);
  });

  test("transformSkillsInstructionsBlock expands only the explicitly invoked skill", () => {
    const bloatedXml = `<skills_instructions>
<skill>
<name>active-skill</name>
<description>This skill was requested</description>
<location>/path/active/SKILL.md</location>
Important specific instructions for active skill.
</skill>
<skill>
<name>unused-skill</name>
<description>This skill was not requested</description>
<location>/path/unused/SKILL.md</location>
${"unused ".repeat(2000)}
</skill>
</skills_instructions>`;

    // User explicitly requested $active-skill
    const transformed = transformSkillsInstructionsBlock(bloatedXml, "Please execute $active-skill on the codebase");

    // active-skill is expanded
    expect(transformed).toContain("Important specific instructions for active skill");
    // unused-skill is only indexed
    expect(transformed).toContain("| unused-skill |");
    expect(transformed).not.toContain("unused unused unused");
  });

  test("compileChatGptWebPrompt compresses skills in history into a lazy index", async () => {
    const { compileChatGptWebPrompt } = await import("../src/adapters/chatgpt-web/prompt");
    const { CHATGPT_WEB_MODEL_ID } = await import("../src/adapters/chatgpt-web/model");

    const massiveInstructions = "instruction ".repeat(2500);
    const request = {
      modelId: CHATGPT_WEB_MODEL_ID,
      options: { reasoning: "high" },
      context: {
        messages: [
          {
            role: "developer" as const,
            content: `<skills_instructions>
<skill>
<name>heavy-dev-skill</name>
<description>Heavy development tooling</description>
<location>.agents/skills/heavy/SKILL.md</location>
${massiveInstructions}
</skill>
</skills_instructions>`,
            timestamp: 1,
          },
          {
            role: "user" as const,
            content: "What tools are available?",
            timestamp: 2,
          },
        ],
      },
    } as any;

    const compiled = compileChatGptWebPrompt(request, {
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true,
      proAvailable: true,
    }, "turn_token_test_123456789012345678");

    // The prompt should NOT contain the massive instructions
    expect(compiled.text).not.toContain(massiveInstructions);
    // The prompt SHOULD contain the lazy indexed table
    expect(compiled.text).toContain("Available Skills (Load on Demand)");
    expect(compiled.text).toContain("heavy-dev-skill");
  });

  test("transformSkillsInstructionsBlock parses Codex CLI markdown format and resolves roots", () => {
    const markdownSkills = `<skills_instructions>
## Skills
A skill is a set of local instructions to follow that is stored in a \`SKILL.md\` file. Below is the list of skills that can be used.
### Skill roots
- \`r0\` = \`/home/user/.codex/skills\`
- \`r1\` = \`/home/user/.agents/skills\`
### Available skills
- frontend-design: Guidance for distinctive visual design (file: r1/frontend-design/SKILL.md)
- cloudflare: Workers and Pages platform (file: r1/cloudflare/SKILL.md)
- imagegen: Image generation (file: r0/imagegen/SKILL.md)
</skills_instructions>`;

    const transformed = transformSkillsInstructionsBlock(markdownSkills, "Explain cloudflare workers");
    expect(transformed).toContain("Available Skills (Load on Demand)");
    expect(transformed).toContain("| frontend-design |");
    expect(transformed).toContain("/home/user/.agents/skills/frontend-design/SKILL.md");
    expect(transformed).toContain("/home/user/.codex/skills/imagegen/SKILL.md");
    expect(transformed).not.toContain("file: r1/");
    expect(transformed).not.toContain("file: r0/");
  });

  test("transformSkillsInstructionsBlock auto-expands relevant skills based on query intent", () => {
    const markdownSkills = `<skills_instructions>
## Skills
### Skill roots
- \`r1\` = \`/home/deuz/.agents/skills\`
### Available skills
- frontend-design: Guidance for distinctive, intentional visual design (file: r1/frontend-design/SKILL.md)
- cloudflare: Workers and Pages platform (file: r1/cloudflare/SKILL.md)
</skills_instructions>`;

    // Query triggers "frontend-design" relevance pattern
    const transformed = transformSkillsInstructionsBlock(markdownSkills, "crea una landing de test de programacion");
    expect(transformed).toContain("Active Skill: frontend-design");
    expect(transformed).toContain("/home/deuz/.agents/skills/frontend-design/SKILL.md");
    expect(transformed).toContain("| cloudflare |");
  });
});


