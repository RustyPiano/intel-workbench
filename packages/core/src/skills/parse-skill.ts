import matter from "gray-matter";

import type { SkillMeta, SkillRecord } from "./types.js";

function normalizeAllowedTools(input: unknown): string[] | undefined {
  if (typeof input === "string") {
    return input
      .split(/\s+/u)
      .map((tool) => tool.trim())
      .filter(Boolean);
  }

  if (Array.isArray(input)) {
    return input.map((tool) => String(tool).trim()).filter(Boolean);
  }

  return undefined;
}

function buildSkillMeta(data: Record<string, unknown>, rootDir: string, skillFile: string): SkillMeta {
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const description = typeof data.description === "string" ? data.description.trim() : "";

  if (!name) {
    throw new Error("Skill metadata is missing required field: name");
  }

  if (!description) {
    throw new Error("Skill metadata is missing required field: description");
  }

  return {
    name,
    description,
    license: typeof data.license === "string" ? data.license : undefined,
    compatibility: typeof data.compatibility === "string" ? data.compatibility : undefined,
    metadata: typeof data.metadata === "object" && data.metadata !== null ? (data.metadata as Record<string, unknown>) : undefined,
    allowedTools: normalizeAllowedTools(data["allowed-tools"]),
    rootDir,
    skillFile,
  };
}

export function parseSkillMetadata(rawContent: string, rootDir: string, skillFile: string): SkillMeta {
  const parsed = matter(rawContent);
  return buildSkillMeta(parsed.data as Record<string, unknown>, rootDir, skillFile);
}

export function parseSkillFile(rawContent: string, rootDir: string, skillFile: string): SkillRecord {
  const parsed = matter(rawContent);
  const { content } = parsed;

  return {
    meta: buildSkillMeta(parsed.data as Record<string, unknown>, rootDir, skillFile),
    body: content.trim(),
    resources: {
      scripts: [],
      references: [],
      assets: [],
    },
  };
}
