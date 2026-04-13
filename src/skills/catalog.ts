import type { SkillMeta, SkillRecord } from "./types.js";

function wrapTag(tag: string, content: string): string {
  return `<${tag}>${content}</${tag}>`;
}

export function renderSkillCatalog(skills: SkillMeta[]): string {
  if (skills.length === 0) {
    return "<available_skills></available_skills>";
  }

  const items = skills
    .map((skill) =>
      [
        "<skill>",
        wrapTag("name", skill.name),
        wrapTag("description", skill.description),
        skill.compatibility ? wrapTag("compatibility", skill.compatibility) : "",
        skill.allowedTools?.length ? wrapTag("allowed_tools", skill.allowedTools.join(" ")) : "",
        "</skill>",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");

  return `<available_skills>\n${items}\n</available_skills>`;
}

export function renderSkillContent(record: SkillRecord): string {
  const resourceItems = [
    ...record.resources.scripts.map((file) => `<file>${file}</file>`),
    ...record.resources.references.map((file) => `<file>${file}</file>`),
    ...record.resources.assets.map((file) => `<file>${file}</file>`),
  ].join("\n");

  return [
    `<skill_content name="${record.meta.name}">`,
    record.body,
    "",
    `Skill directory: ${record.meta.rootDir}`,
    record.meta.compatibility ? `Compatibility: ${record.meta.compatibility}` : "",
    record.meta.allowedTools?.length ? `Allowed tools: ${record.meta.allowedTools.join(" ")}` : "",
    "<skill_resources>",
    resourceItems,
    "</skill_resources>",
    "</skill_content>",
  ]
    .filter(Boolean)
    .join("\n");
}
