import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { renderSkillCatalog, renderSkillContent } from "../skills/catalog.js";
import type { SkillMeta, SkillRecord } from "../skills/types.js";

async function maybeReadAgentsInstructions(workspaceRoot: string): Promise<string | null> {
  const candidate = path.join(workspaceRoot, "AGENTS.md");

  try {
    await access(candidate);
    return readFile(candidate, "utf8");
  } catch {
    return null;
  }
}

export async function buildSystemPrompt(options: {
  workspaceRoot: string;
  availableSkills: SkillMeta[];
  activeSkills: SkillRecord[];
}): Promise<string> {
  const agentsInstructions = await maybeReadAgentsInstructions(options.workspaceRoot);

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
    agentsInstructions ? `\n<agents_instructions>\n${agentsInstructions.trim()}\n</agents_instructions>` : "",
    options.activeSkills.length
      ? `\n<active_skills>\n${options.activeSkills.map((skill) => renderSkillContent(skill)).join("\n")}\n</active_skills>`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
