import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

interface SkillEval {
  id: unknown;
  kind: unknown;
  category: unknown;
  should_activate: unknown;
  requires_files: unknown;
  prompt: unknown;
  expected_output: unknown;
  required_markers: unknown;
  forbidden_markers: unknown;
  files: unknown;
}

const REQUIRED_CATEGORIES: Record<string, string[]> = {
  "av-dialogue-insight": [
    "short-meeting-report",
    "oversized-media-planning",
    "missing-mm-config",
    "negative-generic-image-caption",
  ],
  "intel-bulletin": ["sources-to-bulletin", "task-crud", "uncertain-facts", "negative-plain-extraction"],
};

async function loadEvalFile(skillName: string): Promise<{ skill_name?: unknown; evals?: unknown }> {
  const file = path.join(process.cwd(), ".agents", "skills", skillName, "evals", "evals.json");
  return JSON.parse(await readFile(file, "utf8")) as { skill_name?: unknown; evals?: unknown };
}

async function expectEvalItem(item: SkillEval): Promise<void> {
  expect(typeof item.id).toBe("string");
  expect(item.id).not.toHaveLength(0);
  expect(item.kind === "positive" || item.kind === "negative").toBe(true);
  expect(typeof item.category).toBe("string");
  expect(item.category).not.toHaveLength(0);
  expect(typeof item.should_activate).toBe("boolean");
  expect(typeof item.requires_files).toBe("boolean");
  expect(typeof item.prompt).toBe("string");
  expect(item.prompt).not.toHaveLength(0);
  expect(typeof item.expected_output).toBe("string");
  expect(item.expected_output).not.toHaveLength(0);
  expect(Array.isArray(item.files)).toBe(true);
  expect(Array.isArray(item.required_markers)).toBe(true);
  expect(Array.isArray(item.forbidden_markers)).toBe(true);
  for (const marker of item.required_markers as unknown[]) {
    expect(typeof marker).toBe("string");
  }
  for (const marker of item.forbidden_markers as unknown[]) {
    expect(typeof marker).toBe("string");
  }

  if (item.kind === "positive") {
    expect(item.should_activate).toBe(true);
  }
  if (item.kind === "negative") {
    expect(item.should_activate).toBe(false);
  }
  if (item.requires_files) {
    expect((item.files as unknown[]).length).toBeGreaterThan(0);
  }
  for (const file of item.files as unknown[]) {
    expect(typeof file).toBe("string");
    await access(path.join(process.cwd(), file as string));
  }
}

describe("skill eval schemas", () => {
  test.each(["av-dialogue-insight", "intel-bulletin"])("%s evals are valid and balanced", async (skillName) => {
    const parsed = await loadEvalFile(skillName);
    expect(parsed.skill_name).toBe(skillName);
    expect(Array.isArray(parsed.evals)).toBe(true);

    const evals = parsed.evals as SkillEval[];
    const ids = new Set<string>();
    for (const item of evals) {
      await expectEvalItem(item);
      expect(ids.has(item.id as string)).toBe(false);
      ids.add(item.id as string);
    }
    expect(evals.some((item) => item.kind === "positive")).toBe(true);
    expect(evals.some((item) => item.kind === "negative")).toBe(true);
    expect(evals.map((item) => item.category).sort()).toEqual(REQUIRED_CATEGORIES[skillName].sort());
  });
});
