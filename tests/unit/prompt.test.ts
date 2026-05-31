import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { buildActiveSkillsBlock, buildBaseSystemPrompt, buildSystemPrompt } from "../../src/runtime/prompt.js";
import type { SkillMeta, SkillRecord } from "../../src/skills/types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-prompt-"));
  tempRoots.push(root);
  return root;
}

function makeSkillMeta(overrides: Partial<SkillMeta> = {}): SkillMeta {
  return {
    name: overrides.name ?? "demo-skill",
    description: overrides.description ?? "A demo skill",
    rootDir: overrides.rootDir ?? "/tmp/skills/demo-skill",
    skillFile: overrides.skillFile ?? "/tmp/skills/demo-skill/SKILL.md",
    compatibility: overrides.compatibility,
    allowedTools: overrides.allowedTools,
    metadata: overrides.metadata,
    license: overrides.license,
  };
}

function makeSkillRecord(overrides: Partial<SkillRecord> = {}): SkillRecord {
  const meta = overrides.meta ?? makeSkillMeta();
  return {
    meta,
    body: overrides.body ?? "Skill body content.",
    resources: overrides.resources ?? {
      scripts: [],
      references: [],
      assets: [],
    },
  };
}

describe("buildBaseSystemPrompt", () => {
  test("excludes <active_skills> block", async () => {
    const root = await createWorkspace();
    const prompt = await buildBaseSystemPrompt({
      workspaceRoot: root,
      availableSkills: [makeSkillMeta()],
    });

    expect(prompt).not.toContain("<active_skills>");
    expect(prompt).not.toContain("</active_skills>");
  });

  test("includes workspace root and skill catalog", async () => {
    const root = await createWorkspace();
    const prompt = await buildBaseSystemPrompt({
      workspaceRoot: root,
      availableSkills: [makeSkillMeta({ name: "alpha", description: "Alpha skill" })],
    });

    expect(prompt).toContain(`Workspace root: ${root}`);
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("alpha");
  });

  test("instructs the model to avoid exposing secrets without prescribing config workflow", async () => {
    const root = await createWorkspace();
    const prompt = await buildBaseSystemPrompt({
      workspaceRoot: root,
      availableSkills: [],
    });

    expect(prompt).toContain("Avoid exposing secrets or sensitive configuration values");
    expect(prompt).toContain("Report only the status or names of required settings");
    expect(prompt).not.toContain("do not inspect the workspace just to explain documented configuration or usage");
  });

  test("redacts secrets from AGENTS.md before injecting into base prompt", async () => {
    const root = await createWorkspace();
    const secret = "sk-abcd1234efgh5678";
    await writeFile(
      path.join(root, "AGENTS.md"),
      `# Project notes\n\nUse the api with token sk-abcd1234efgh5678 when needed.\n`,
      "utf8",
    );

    const prompt = await buildBaseSystemPrompt({
      workspaceRoot: root,
      availableSkills: [],
    });

    expect(prompt).toContain("<agents_instructions>");
    expect(prompt).not.toContain(secret);
    expect(prompt).toContain("[REDACTED]");
  });

  test("omits <agents_instructions> when AGENTS.md is missing", async () => {
    const root = await createWorkspace();
    const prompt = await buildBaseSystemPrompt({
      workspaceRoot: root,
      availableSkills: [],
    });

    expect(prompt).not.toContain("<agents_instructions>");
  });
});

describe("buildActiveSkillsBlock", () => {
  test("returns empty string when no skills are active", () => {
    expect(buildActiveSkillsBlock([])).toBe("");
  });

  test("wraps active skills inside <active_skills> tags", () => {
    const record = makeSkillRecord({
      meta: makeSkillMeta({ name: "writer", description: "Write things" }),
      body: "Detailed skill body.",
    });

    const block = buildActiveSkillsBlock([record]);

    expect(block.startsWith("<active_skills>")).toBe(true);
    expect(block.endsWith("</active_skills>")).toBe(true);
    expect(block).toContain("Detailed skill body.");
    expect(block).toContain('name="writer"');
  });
});

describe("buildSystemPrompt (compat wrapper)", () => {
  test("returns base prompt only when no active skills", async () => {
    const root = await createWorkspace();
    const base = await buildBaseSystemPrompt({
      workspaceRoot: root,
      availableSkills: [],
    });
    const combined = await buildSystemPrompt({
      workspaceRoot: root,
      availableSkills: [],
      activeSkills: [],
    });

    expect(combined).toBe(base);
  });

  test("appends active skills block when provided", async () => {
    const root = await createWorkspace();
    const skill = makeSkillRecord({
      meta: makeSkillMeta({ name: "writer", description: "Write things" }),
    });
    const base = await buildBaseSystemPrompt({
      workspaceRoot: root,
      availableSkills: [skill.meta],
    });
    const block = buildActiveSkillsBlock([skill]);

    const combined = await buildSystemPrompt({
      workspaceRoot: root,
      availableSkills: [skill.meta],
      activeSkills: [skill],
    });

    expect(combined).toBe(`${base}\n${block}`);
    expect(combined).toContain("<active_skills>");
  });
});
