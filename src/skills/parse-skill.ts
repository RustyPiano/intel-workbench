import matter from "gray-matter";

import type { SkillRecord } from "./types.js";

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

export function parseSkillFile(rawContent: string, rootDir: string, skillFile: string): SkillRecord {
  const parsed = matter(rawContent);
  const { data, content } = parsed;

  const name = typeof data.name === "string" ? data.name.trim() : "";
  const description = typeof data.description === "string" ? data.description.trim() : "";

  if (!name) {
    throw new Error("Skill metadata is missing required field: name");
  }

  if (!description) {
    throw new Error("Skill metadata is missing required field: description");
  }

  return {
    meta: {
      name,
      description,
      license: typeof data.license === "string" ? data.license : undefined,
      compatibility: typeof data.compatibility === "string" ? data.compatibility : undefined,
      metadata: typeof data.metadata === "object" && data.metadata !== null ? (data.metadata as Record<string, unknown>) : undefined,
      allowedTools: normalizeAllowedTools(data["allowed-tools"]),
      rootDir,
      skillFile,
    },
    body: content.trim(),
    resources: {
      scripts: [],
      references: [],
      assets: [],
    },
  };
}
