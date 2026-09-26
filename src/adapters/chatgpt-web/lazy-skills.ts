import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface SkillMetadata {
  name: string;
  description: string;
  location: string;
}

export interface ParsedSkillBlock {
  name: string;
  description: string;
  location: string;
  rawText: string;
}

export function parseSkillFrontmatter(
  content: string,
  filePath: string,
  fallbackName?: string,
): SkillMetadata {
  const defaultName = fallbackName || basename(dirname(filePath)) || "custom-skill";
  let name = defaultName;
  let description = `${defaultName.charAt(0).toUpperCase() + defaultName.slice(1)} skill instructions`;

  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (frontmatterMatch) {
    const yaml = frontmatterMatch[1];
    const nameMatch = yaml.match(/^name:\s*(.+)$/m);
    if (nameMatch) {
      name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
    }
    const descMatch = yaml.match(/^description:\s*(.+)$/m);
    if (descMatch) {
      description = descMatch[1].trim().replace(/^["']|["']$/g, "");
    }
  } else {
    // Attempt to extract title from first markdown heading
    const headingMatch = content.match(/^#+\s*(.+)$/m);
    if (headingMatch) {
      const heading = headingMatch[1].trim();
      description = `${heading} instructions`;
    }
  }

  return {
    name,
    description,
    location: filePath,
  };
}

export function scanSkillsDirectory(dirPath: string): SkillMetadata[] {
  if (!existsSync(dirPath)) return [];

  const results: SkillMetadata[] = [];

  try {
    const entries = readdirSync(dirPath);
    for (const entry of entries) {
      const entryPath = join(dirPath, entry);
      try {
        const stat = statSync(entryPath);
        if (stat.isDirectory()) {
          const skillMd = join(entryPath, "SKILL.md");
          if (existsSync(skillMd)) {
            const content = readFileSync(skillMd, "utf-8");
            results.push(parseSkillFrontmatter(content, skillMd, entry));
          }
        }
      } catch {
        // Skip unreadable files or dirs
      }
    }
  } catch {
    // Skip unreadable parent dir
  }

  return results;
}

export function buildLazySkillsIndex(skills: readonly SkillMetadata[]): string {
  if (skills.length === 0) return "";

  const lines: string[] = [
    "## Available Skills (Load on Demand)",
    "> The following skills are available in the project and environment. To use a skill, invoke `codex_read_file` on its `Location` before taking task actions. Only load skills directly relevant to the current request.",
    "",
    "| Skill Name | Purpose | Location |",
    "|---|---|---|",
  ];

  for (const skill of skills) {
    // Escape pipe symbols in descriptions
    const cleanDesc = skill.description.replace(/\|/g, "\\|").trim();
    lines.push(`| ${skill.name} | ${cleanDesc} | ${skill.location} |`);
  }

  lines.push("");
  return lines.join("\n");
}

function parseSkillsFromXml(xml: string): ParsedSkillBlock[] {
  const blocks: ParsedSkillBlock[] = [];
  const skillRegex = /<skill(?:\s+name="([^"]+)")?>([\s\S]*?)<\/skill>/gi;
  let match: RegExpExecArray | null;

  while ((match = skillRegex.exec(xml)) !== null) {
    const rawText = match[0];
    const attrName = match[1];
    const inner = match[2];

    const nameMatch = inner.match(/<name>([^<>\r\n]+)<\/name>/i);
    const descMatch = inner.match(/<description>([^<>\r\n]+)<\/description>/i);
    const locMatch = inner.match(/<location>([^<>\r\n]+)<\/location>/i);

    const name = attrName?.trim() || nameMatch?.[1]?.trim() || "unknown-skill";
    const description = descMatch?.[1]?.trim() || "Skill instructions";
    const location = locMatch?.[1]?.trim() || `.agents/skills/${name}/SKILL.md`;

    blocks.push({
      name,
      description,
      location,
      rawText,
    });
  }

  return blocks;
}

export function parseSkillsFromMarkdown(content: string): ParsedSkillBlock[] {
  const blocks: ParsedSkillBlock[] = [];
  const roots: Record<string, string> = {};
  const rootRegex = /-\s*`?([a-zA-Z0-9_-]+)`?\s*=\s*`?([^\`\r\n]+)`?/g;
  let rm: RegExpExecArray | null;
  while ((rm = rootRegex.exec(content)) !== null) {
    roots[rm[1]] = rm[2].trim();
  }

  const skillsSecMatch = content.match(/### Available skills\s*([\s\S]*?)(?:<\/skills_instructions>|$)/i);
  if (!skillsSecMatch) return blocks;

  const section = skillsSecMatch[1];
  const itemRegex = /^[ \t]*-\s+([a-zA-Z0-9_\-\.]+):\s*([\s\S]*?)\s*\(file:\s*([^\)\r\n]+)\)/gm;
  let sm: RegExpExecArray | null;
  while ((sm = itemRegex.exec(section)) !== null) {
    const name = sm[1].trim();
    const description = sm[2].trim();
    const fpath = sm[3].trim();
    const parts = fpath.split("/");
    const rootAlias = parts[0];
    const subpath = parts.slice(1).join("/");
    const location = roots[rootAlias] ? join(roots[rootAlias], subpath) : fpath;
    blocks.push({
      name,
      description,
      location,
      rawText: sm[0],
    });
  }

  return blocks;
}

export function parseSkillsFromTable(content: string): ParsedSkillBlock[] {
  const blocks: ParsedSkillBlock[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;
    const rawCells = trimmed.slice(1, -1).split(/(?<!\\)\|/);
    if (rawCells.length < 3) continue;
    const name = rawCells[0]!.trim();
    if (!name || name === "Skill Name" || name.startsWith("---") || name.startsWith(":---")) {
      continue;
    }
    const description = rawCells[1]!.trim().replace(/\\\|/g, "|");
    const location = rawCells[2]!.trim();
    blocks.push({
      name,
      description,
      location,
      rawText: line,
    });
  }
  return blocks;
}

export function parseSkills(content: string): ParsedSkillBlock[] {
  const xmlBlocks = parseSkillsFromXml(content);
  if (xmlBlocks.length > 0) return xmlBlocks;
  const tableBlocks = parseSkillsFromTable(content);
  if (tableBlocks.length > 0) return tableBlocks;
  return parseSkillsFromMarkdown(content);
}

function isSkillExplicitlyRequested(skillName: string, query?: string): boolean {
  if (!query) return false;
  const normalized = query.toLowerCase();
  const name = skillName.toLowerCase();

  return (
    normalized.includes(`$${name}`) ||
    normalized.includes(`@${name}`) ||
    normalized.includes(`/skill ${name}`) ||
    normalized.includes(`use skill ${name}`) ||
    normalized.includes(`skill: ${name}`)
  );
}

function isSkillRelevant(_skillName: string, _query?: string): boolean {
  // Automatic keyword hijacking disabled to eliminate prompt bloat.
  // Skills remain in the compact catalog unless explicitly requested ($skill, use skill, etc.).
  return false;
}

export function transformSkillsInstructionsBlock(
  content: string,
  userInstruction?: string,
  options?: { isContinuation?: boolean },
): string {
  if (!content.includes("<skills_instructions>")) {
    return content;
  }

  const skills = parseSkills(content);
  if (skills.length === 0) return content;

  // In continuation turns within a retained conversation, the full catalog was already established.
  // Unless a skill was explicitly requested, omit the redundant 70+ row table to eliminate prompt bloat.
  if (options?.isContinuation) {
    const requested = skills.filter(skill => isSkillExplicitlyRequested(skill.name, userInstruction));
    if (requested.length === 0) {
      return [
        "<skills_instructions>",
        "<!-- Skills catalog established in turn 1. Invoke codex_read_file on demand if a skill is needed. -->",
        "</skills_instructions>",
      ].join("\n");
    }
  }

  const expanded: string[] = [];
  const indexed: SkillMetadata[] = [];
  let autoExpandedCount = 0;
  const MAX_AUTO_EXPANDED_SKILLS = 2;
  const MAX_SKILL_EXPANDED_CHARS = 7_000;

  for (const skill of skills) {
    const isExplicit = isSkillExplicitlyRequested(skill.name, userInstruction);
    const isRel = !isExplicit && autoExpandedCount < MAX_AUTO_EXPANDED_SKILLS && isSkillRelevant(skill.name, userInstruction);

    if (isExplicit || isRel) {
      if (isRel) autoExpandedCount++;
      let expandedBlock: string | null = null;
      if (existsSync(skill.location)) {
        try {
          let fileText = readFileSync(skill.location, "utf-8").trim();
          if (fileText.length > MAX_SKILL_EXPANDED_CHARS) {
            fileText = fileText.slice(0, MAX_SKILL_EXPANDED_CHARS) + "\n\n...[Skill instructions truncated for prompt economy]...";
          }
          expandedBlock = [
            `### Active Skill: ${skill.name} (${skill.location})`,
            fileText,
          ].join("\n");
        } catch {
          expandedBlock = null;
        }
      }
      if (expandedBlock) {
        expanded.push(expandedBlock);
      } else if (skill.rawText.startsWith("<skill")) {
        expanded.push(skill.rawText);
      } else {
        expanded.push(`- ${skill.name}: ${skill.description} (file: ${skill.location})`);
      }
    } else {
      indexed.push({
        name: skill.name,
        description: skill.description,
        location: skill.location,
      });
    }
  }

  const parts: string[] = ["<skills_instructions>"];

  if (expanded.length > 0) {
    parts.push(
      "<!-- Active and relevant skills expanded inline for immediate guidance -->",
      ...expanded,
      "",
    );
  }

  if (indexed.length > 0) {
    parts.push(buildLazySkillsIndex(indexed));
  }

  parts.push("</skills_instructions>");
  return parts.join("\n");
}
