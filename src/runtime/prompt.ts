import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { renderSkillCatalog, renderSkillContent } from "../skills/catalog.js";
import type { SkillMeta, SkillRecord } from "../skills/types.js";

import { redactSensitiveText } from "./trace.js";

async function maybeReadAgentsInstructions(workspaceRoot: string): Promise<string | null> {
  const candidate = path.join(workspaceRoot, "AGENTS.md");

  try {
    await access(candidate);
    return readFile(candidate, "utf8");
  } catch {
    return null;
  }
}

export async function buildBaseSystemPrompt(options: {
  workspaceRoot: string;
  availableSkills: SkillMeta[];
}): Promise<string> {
  const agentsInstructions = await maybeReadAgentsInstructions(options.workspaceRoot);
  const sanitizedInstructions = agentsInstructions ? redactSensitiveText(agentsInstructions.trim()) : null;

  return [
    "You are running inside the mini-agent runtime.",
    "Rules:",
    "1. Plan before executing.",
    "2. Read files before editing them when content is needed.",
    "3. Confirm target paths before modifying files.",
    "4. Prefer activate_skill when a skill is relevant.",
    "5. Never invent tool results.",
    "6. Explain failures and provide the next step.",
    "",
    `Workspace root: ${options.workspaceRoot}`,
    "",
    renderSkillCatalog(options.availableSkills),
    sanitizedInstructions ? `\n<agents_instructions>\n${sanitizedInstructions}\n</agents_instructions>` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildActiveSkillsBlock(activeSkills: SkillRecord[]): string {
  if (activeSkills.length === 0) {
    return "";
  }

  return `<active_skills>\n${activeSkills.map((skill) => renderSkillContent(skill)).join("\n")}\n</active_skills>`;
}

export async function buildSystemPrompt(options: {
  workspaceRoot: string;
  availableSkills: SkillMeta[];
  activeSkills: SkillRecord[];
}): Promise<string> {
  const base = await buildBaseSystemPrompt({
    workspaceRoot: options.workspaceRoot,
    availableSkills: options.availableSkills,
  });
  const activeBlock = buildActiveSkillsBlock(options.activeSkills);
  return activeBlock ? `${base}\n${activeBlock}` : base;
}
