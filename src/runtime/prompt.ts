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
    "- Read a file before editing it when you need its current contents (edit matches against existing text).",
    "- Use activate_skill to load a relevant skill before doing the work it covers.",
    "- When a step fails, explain what happened and give the next step.",
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
